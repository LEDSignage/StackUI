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
import { readdir, readFile, writeFile, unlink, mkdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Module, Stack } from '../shared/types.ts';
import { loadEnvFile } from '../shared/env.ts';
import { insideOutput } from '../shared/outputPath.ts';

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

app.put('/api/stacks/:id', async (req, res) => {
  const id = safeId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad stack id.' });
  await mkdir(STACKS_DIR, { recursive: true });
  await writeFile(join(STACKS_DIR, `${id}.json`), JSON.stringify(req.body, null, 2), 'utf8');
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
  if (outputDir !== undefined) return outputDir;

  const configured = process.env.COMFY_OUTPUT;
  if (configured) return (outputDir = existsSync(configured) ? configured : null);

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
    /* box unreachable — fall through */
  }
  return (outputDir = null);
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

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { windowsHide: true });
    let tail = '';
    // ffmpeg reports progress on stderr; keep only the end for the error message.
    proc.stderr.on('data', (d) => {
      tail = (tail + String(d)).slice(-1500);
    });
    proc.on('error', (e) => reject(new Error(`could not start ffmpeg — ${e.message}`)));
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
});
