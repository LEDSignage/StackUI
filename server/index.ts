/**
 * The Stack UI server.
 *
 * Two jobs, both small:
 *   1. Proxy everything under /comfy to the ComfyUI box. This sidesteps CORS
 *      entirely — the browser only ever talks to this origin, so ComfyUI does
 *      not need --enable-cors-header and does not know we exist.
 *   2. Read and write modules/ and stacks/ as plain JSON files on disk, so
 *      editing a module in a text editor stays a supported workflow.
 */

import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile, unlink, mkdir, stat, rename, copyFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Module, Stack } from '../shared/types.ts';
import { loadEnvFile } from '../shared/env.ts';
import { insideOutput } from '../shared/outputPath.ts';
import { patchComfy, describe as describePatch } from './patchComfy.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MODULES_DIR = join(ROOT, 'modules');
const STACKS_DIR = join(ROOT, 'stacks');
const DIST_DIR = join(ROOT, 'dist');
/** Where re-timed videos land. Derived files, safe to delete. */
const CONVERTED_DIR = join(ROOT, 'storage', 'converted');

loadEnvFile(join(ROOT, '.env'));

const PORT = Number(process.env.PORT ?? 8790);
// Loopback by default: the normal deployment runs on the same machine as
// ComfyUI. Point it elsewhere with COMFY_URL — in a .env, or in the
// environment. Nothing about one particular box belongs in the source.
const COMFY_URL = process.env.COMFY_URL ?? 'http://127.0.0.1:8188';

const app = express();

// ── ComfyUI proxy ───────────────────────────────────────────────────────────
//
// This MUST be mounted before any body parser. A parser consumes the request
// stream, and the proxy then forwards a request whose body has already been
// drained — ComfyUI sits waiting for bytes that never arrive and POST /prompt
// hangs until the timeout. GETs are unaffected, which makes it look like the
// connection is fine right up until you queue something.

const comfyProxy = createProxyMiddleware({
  target: COMFY_URL,
  changeOrigin: true,
  ws: true,
  pathRewrite: { '^/comfy': '' },
  // No timeout. These apply to the websocket as well as to requests, and a
  // websocket carrying progress is legitimately silent for minutes at a time —
  // loading a 19.5 GB model emits nothing at all. A 120s limit culled the live
  // connection mid-load, and every message sent during the gap was lost:
  // progress, the result, and the completion that turns "Working…" off. The run
  // finished perfectly on the box while the page waited forever.
  proxyTimeout: 0,
  timeout: 0,
  on: {
    /**
     * Strip the browser's cross-origin headers.
     *
     * ComfyUI refuses any request carrying an `Origin` that does not match the
     * host it is listening on — a CSRF guard. Our page is served from :8790 and
     * ComfyUI is on :8188, so every POST the browser makes arrives with a
     * mismatched Origin and comes back 403. Uploads were the visible casualty.
     *
     * This hop is server to server, not a browser cross-origin request, so the
     * headers carry no meaning here and removing them makes the request look
     * like exactly what it is. Same reason `Referer` goes: ComfyUI checks it
     * the same way when Origin is absent.
     */
    proxyReq(proxyReq) {
      proxyReq.removeHeader('origin');
      proxyReq.removeHeader('referer');
    },

    /**
     * And again for the websocket, which takes its own path.
     *
     * Missing this left the live connection 403ing and reconnecting on a
     * backoff loop for as long as the page was open — a warning per attempt in
     * ComfyUI's log, and no progress in the UI, while ordinary requests worked
     * fine and made it look like the socket was the only thing broken.
     */
    proxyReqWs(proxyReq) {
      proxyReq.removeHeader('origin');
      proxyReq.removeHeader('referer');
    },
    error(err, _req, res) {
      const message = `Cannot reach ComfyUI at ${COMFY_URL} — ${err.message}`;
      if ('writeHead' in res && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
    },
  },
});

app.use('/comfy', comfyProxy);

// Body parsing applies only to our own API, mounted after the proxy above.
app.use(express.json({ limit: '32mb' }));

// ── Config ──────────────────────────────────────────────────────────────────

app.get('/api/config', (_req, res) => {
  res.json({ comfyUrl: COMFY_URL });
});

// ── Modules ─────────────────────────────────────────────────────────────────

app.get('/api/modules', async (_req, res) => {
  try {
    res.json(await loadAll<Module>(MODULES_DIR));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.put('/api/modules/:id', async (req, res) => {
  const id = safeId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad module id.' });
  await mkdir(MODULES_DIR, { recursive: true });
  await writeFile(join(MODULES_DIR, `${id}.json`), JSON.stringify(req.body, null, 2), 'utf8');
  res.json({ ok: true });
});

// ── Stacks ──────────────────────────────────────────────────────────────────

app.get('/api/stacks', async (_req, res) => {
  try {
    const stacks = await loadAll<Stack>(STACKS_DIR);
    res.json(
      stacks.map((s) => ({
        id: s.id,
        name: s.name,
        lines: s.lines.length,
        // Drives the job and model selectors without loading every stack.
        job: s.job ?? s.name,
        model: s.model ?? null,
      })),
    );
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/stacks/:id', async (req, res) => {
  const id = safeId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad stack id.' });
  try {
    const raw = await readFile(join(STACKS_DIR, `${id}.json`), 'utf8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(404).json({ error: `No stack "${id}".` });
  }
});

/**
 * Save a stack.
 *
 * These files are the work: the prompts, the sizes, the shot lists. The page
 * autosaves on every keystroke, so this endpoint is hit constantly, and two
 * things that were true of it are not acceptable for something holding work.
 *
 * It wrote whatever it was given. A body that was not a stack — an empty
 * object from a failed serialisation, a truncated request — replaced a working
 * pipeline with junk, and the only sign was the page coming back empty later.
 *
 * And it wrote in place. writeFile truncates first, so a crash or a full disk
 * mid-write leaves a half-written file that no longer parses, and the stack is
 * simply gone.
 */
// POST as well as PUT: a page being closed can only flush its last edit with
// navigator.sendBeacon, which is POST-only and cannot be talked out of it.
app.all('/api/stacks/:id', async (req, res, next) => {
  if (req.method !== 'PUT' && req.method !== 'POST') return next();
  const id = safeId(String(req.params.id));
  if (!id) return res.status(400).json({ error: 'Bad stack id.' });

  const body = req.body as Stack | undefined;
  if (!body || typeof body !== 'object' || !Array.isArray(body.lines) || typeof body.id !== 'string') {
    return res.status(400).json({ error: 'That is not a stack — refusing to overwrite the saved one.' });
  }

  await mkdir(STACKS_DIR, { recursive: true });
  const path = join(STACKS_DIR, `${id}.json`);

  // Keep the previous version. One bad save is then recoverable by hand, which
  // it was not before.
  if (existsSync(path)) {
    await copyFile(path, `${path}.bak`).catch(() => {});
  }

  // Write beside it and rename: rename is atomic, so the file on disk is
  // either the old one or the new one and never half of either. The temp name
  // deliberately does not end in .json — loadAll takes every .json in the
  // folder, and a stray one once showed up in the app as a duplicate pipeline.
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(body, null, 2), 'utf8');
  await rename(tmp, path);

  res.json({ ok: true });
});

app.delete('/api/stacks/:id', async (req, res) => {
  const id = safeId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad stack id.' });
  try {
    await unlink(join(STACKS_DIR, `${id}.json`));
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: `No stack "${id}".` });
  }
});

// ── Media library ───────────────────────────────────────────────────────────
//
// ComfyUI can list its output folder but cannot tell you when a file was made,
// how big it is, or delete one. Reading the folder ourselves gives all three —
// and Stack UI normally runs on the ComfyUI machine, so the folder is local.
//
// Where it is comes from ComfyUI itself: /internal/folder_paths reports model
// directories, and the shared ones sit inside the output folder, so the parent
// of any ".../output/<something>" is the folder we want. COMFY_OUTPUT overrides
// it when that guess is wrong.

let outputDir: string | null | undefined;

async function findOutputDir(): Promise<string | null> {
  // Only a *found* directory is remembered. Caching the failure meant that a
  // Stack UI started a few seconds before ComfyUI asked once, got nothing, and
  // spent the rest of its life on the read-only fallback listing — no sizes, no
  // dates, no subfolders, no delete, and every render you had just made missing
  // from the library.
  if (outputDir) return outputDir;

  const configured = process.env.COMFY_OUTPUT;
  if (configured && existsSync(configured)) return (outputDir = configured);

  try {
    const res = await fetch(`${COMFY_URL}/internal/folder_paths`);
    const paths = (await res.json()) as Record<string, string[]>;
    for (const list of Object.values(paths)) {
      for (const p of list) {
        const match = /^(.*[\\/]output)[\\/]/.exec(p);
        if (match && existsSync(match[1]!)) return (outputDir = match[1]!);
      }
    }
  } catch {
    /* box not up yet — ask again next time */
  }
  return null;
}

const VIDEO = /\.(mp4|webm|mov|mkv|avi|gif)$/i;
const IMAGE = /\.(png|jpe?g|webp|bmp|tiff?)$/i;

/**
 * The listing ComfyUI can give us, for when the folder is on another machine.
 *
 * Entries look like `clip_00004_.mp4 [output]`, newest first, with no size and
 * no date — so those come back as zero and the browser hides them rather than
 * inventing a timestamp. Enough to find and download a file; not enough to
 * delete one, which is why this path reports writable: false.
 */
async function listViaComfy(): Promise<unknown[]> {
  try {
    const res = await fetch(`${COMFY_URL}/internal/files/output`);
    if (!res.ok) return [];
    const raw = (await res.json()) as string[];
    return raw.flatMap((entry) => {
      const path = entry.replace(/\s*\[[^\]]*\]\s*$/, '');
      const kind = VIDEO.test(path) ? 'video' : IMAGE.test(path) ? 'image' : null;
      if (!kind) return [];
      const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
      return [
        {
          filename: cut === -1 ? path : path.slice(cut + 1),
          subfolder: cut === -1 ? '' : path.slice(0, cut),
          type: 'output',
          kind,
          size: 0,
          modified: 0,
        },
      ];
    });
  } catch {
    return [];
  }
}

/**
 * Everything ComfyUI has produced, newest first.
 *
 * `writable` is false when the folder is not on this machine — a development
 * copy talking to the box across the network can still list and play files
 * through the proxy, but must not offer a delete button it cannot honour.
 */
app.get('/api/media', async (_req, res) => {
  const dir = await findOutputDir();
  if (!dir) return res.json({ writable: false, files: await listViaComfy() });

  const files: unknown[] = [];

  // One level of subfolders. ComfyUI writes into named subfolders when a node
  // asks it to, and deeper nesting is not something it produces on its own.
  const scan = async (sub: string) => {
    let entries: Dirent[];
    try {
      entries = await readdir(join(dir, sub), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!sub) await scan(entry.name);
        continue;
      }
      const kind = VIDEO.test(entry.name) ? 'video' : IMAGE.test(entry.name) ? 'image' : null;
      if (!kind) continue;
      try {
        const info = await stat(join(dir, sub, entry.name));
        files.push({
          filename: entry.name,
          subfolder: sub,
          type: 'output',
          kind,
          size: info.size,
          modified: info.mtimeMs,
        });
      } catch {
        /* vanished between listing and stat */
      }
    }
  };

  await scan('');
  files.sort((a, b) => (b as { modified: number }).modified - (a as { modified: number }).modified);
  res.json({ writable: true, files });
});

app.delete('/api/media', async (req, res) => {
  const dir = await findOutputDir();
  if (!dir) return res.status(409).json({ error: 'The output folder is not on this machine.' });

  const { filename, subfolder = '' } = req.body ?? {};
  if (typeof filename !== 'string' || typeof subfolder !== 'string') {
    return res.status(400).json({ error: 'Bad request.' });
  }

  const target = insideOutput(dir, subfolder, filename);
  if (!target) return res.status(400).json({ error: 'Outside the output folder.' });

  try {
    await unlink(target);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// ── Frame rate conversion ───────────────────────────────────────────────────

/**
 * Re-time a finished video to a different frame rate.
 *
 * A model that only generates at 24fps cannot be coaxed to 30 by an integer
 * frame multiplier, so this pulls the file back from ComfyUI and runs ffmpeg's
 * motion-compensated interpolation, which can synthesise frames at any
 * timestamp and therefore hit any target rate.
 *
 * Converted files are cached by name and rate, so asking twice is free.
 */
app.post('/api/convert-fps', async (req, res) => {
  const { filename, subfolder = '', type = 'output', fps } = req.body ?? {};

  if (typeof filename !== 'string' || !filename || filename.includes('..')) {
    return res.status(400).json({ error: 'Bad filename.' });
  }
  const rate = Number(fps);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 240) {
    return res.status(400).json({ error: 'Bad fps.' });
  }

  const out = `${rate}fps-${filename.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  const outPath = join(CONVERTED_DIR, out);
  await mkdir(CONVERTED_DIR, { recursive: true });

  if (existsSync(outPath)) return res.json({ url: `/converted/${encodeURIComponent(out)}`, cached: true });

  const q = new URLSearchParams({ filename, subfolder, type });
  const source = `${COMFY_URL}/view?${q}`;

  try {
    await runFfmpeg([
      '-y',
      '-i',
      source,
      '-filter:v',
      `minterpolate=fps=${rate}:mi_mode=mci:mc_mode=aobmc:vsbmc=1`,
      '-c:a',
      'copy',
      outPath,
    ]);
  } catch (err) {
    return res.status(500).json({ error: `ffmpeg failed: ${(err as Error).message}` });
  }

  res.json({ url: `/converted/${encodeURIComponent(out)}`, cached: false });
});

/**
 * Crop a finished video to an exact size.
 *
 * The other half of the guide-frame workaround: the job is submitted at a size
 * ComfyUI can survive — the next multiple of 32 — and the extra pixels come
 * off here, so what you asked for is what you get. A centre crop rather than a
 * scale, because there is nothing to gain from resampling every frame to lose
 * eight rows.
 */
app.post('/api/fit', async (req, res) => {
  const { filename, subfolder = '', type = 'output', width, height } = req.body ?? {};

  if (typeof filename !== 'string' || !filename || filename.includes('..')) {
    return res.status(400).json({ error: 'Bad filename.' });
  }
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 16 || h < 16 || w > 8192 || h > 8192) {
    return res.status(400).json({ error: 'Bad size.' });
  }

  const out = `${w}x${h}-${filename.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  const outPath = join(CONVERTED_DIR, out);
  await mkdir(CONVERTED_DIR, { recursive: true });

  if (existsSync(outPath)) return res.json({ url: `/converted/${encodeURIComponent(out)}`, cached: true });

  const q = new URLSearchParams({ filename, subfolder, type });
  try {
    await runFfmpeg([
      '-y',
      '-i',
      `${COMFY_URL}/view?${q}`,
      // min() so a video already at or below the target is left alone rather
      // than the crop failing outright.
      '-filter:v',
      `crop=min(iw\\,${w}):min(ih\\,${h}):(iw-min(iw\\,${w}))/2:(ih-min(ih\\,${h}))/2`,
      '-c:a',
      'copy',
      outPath,
    ]);
  } catch (err) {
    return res.status(500).json({ error: `ffmpeg failed: ${(err as Error).message}` });
  }

  res.json({ url: `/converted/${encodeURIComponent(out)}`, cached: false });
});

/**
 * Where ffmpeg is, or null.
 *
 * PATH first, then the places Windows installers actually put it. Spawning
 * "ffmpeg" and hoping was fine until it was not: with ffmpeg absent, both the
 * frame-rate conversion and the 1080p crop failed with `spawn ffmpeg ENOENT`,
 * which says nothing about what to install or where to put it.
 *
 * FFMPEG_PATH overrides everything, for an install somewhere of your own.
 */
let ffmpegPath: string | null | undefined;

function findFfmpeg(): string | null {
  if (ffmpegPath !== undefined) return ffmpegPath;

  const configured = process.env.FFMPEG_PATH;
  if (configured) return (ffmpegPath = existsSync(configured) ? configured : null);

  const local = process.env.LOCALAPPDATA ?? '';
  const candidates = [
    // Alongside Stack UI, for a copy dropped in by hand.
    join(ROOT, 'ffmpeg', 'ffmpeg.exe'),
    join(ROOT, 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    // winget's shim directory, and Chocolatey.
    join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
    'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
  ];
  for (const c of candidates) if (existsSync(c)) return (ffmpegPath = c);

  // Not found anywhere known — fall back to the bare name so a PATH install
  // still works, and let the spawn error say so if it does not.
  return (ffmpegPath = null);
}

/** The one message worth showing when ffmpeg is simply not installed. */
const NO_FFMPEG =
  'ffmpeg is not installed on the ComfyUI machine, so video cannot be re-timed or cropped. ' +
  'Install it (winget install Gyan.FFmpeg), or set FFMPEG_PATH to point at ffmpeg.exe.';

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(findFfmpeg() ?? 'ffmpeg', args, { windowsHide: true });
    let tail = '';
    // ffmpeg reports progress on stderr; keep only the end for the error message.
    proc.stderr.on('data', (d) => {
      tail = (tail + String(d)).slice(-1500);
    });
    // ENOENT here means ffmpeg is not there at all, which is worth saying in
    // words rather than passing on a spawn error.
    proc.on('error', (e) =>
      reject(new Error((e as NodeJS.ErrnoException).code === 'ENOENT' ? NO_FFMPEG : `could not start ffmpeg — ${e.message}`)),
    );
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(tail.split('\n').slice(-4).join(' ').trim())),
    );
  });
}

app.use('/converted', express.static(CONVERTED_DIR));

// ── Static (production build) ───────────────────────────────────────────────

app.use(express.static(DIST_DIR));

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Reject anything that could climb out of the directory. */
function safeId(id: string | undefined): string | null {
  return id && /^[A-Za-z0-9._-]+$/.test(id) && !id.startsWith('.') ? id : null;
}

/**
 * Reads *.json from a directory and its subdirectories.
 *
 * Recursion matters because `modules/generated/` holds one module per installed
 * ComfyUI node class — hundreds of files — kept apart from the hand-written
 * ones so it can be wiped and rebuilt without touching them.
 */
async function loadAll<T>(dir: string): Promise<T[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await loadAll<T>(full)));
      continue;
    }
    if (!entry.name.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(await readFile(full, 'utf8')) as T);
    } catch (err) {
      console.error(`Skipping ${full}: ${(err as Error).message}`);
    }
  }
  return out;
}

// ── Listen ──────────────────────────────────────────────────────────────────

const server = createServer(app);
// Websocket upgrades for /comfy/ws must be forwarded by hand.
server.on('upgrade', comfyProxy.upgrade!);

server.listen(PORT, () => {
  console.log(`Stack UI server  →  http://localhost:${PORT}`);
  console.log(`ComfyUI proxy    →  ${COMFY_URL}  (as /comfy/*)`);

  // A ComfyUI update puts the original file back and the guide-frame crash
  // returns with no warning, so it is checked on every start rather than left
  // to be rediscovered through a failed render. STACKUI_NO_PATCH=1 skips it.
  if (!process.env.STACKUI_NO_PATCH) {
    void patchComfy().then((r) => console.log(describePatch(r)));
  }
});
