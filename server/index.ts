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
import { readdir, readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Module, Stack } from '../shared/types.ts';
import { loadEnvFile } from '../shared/env.ts';

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
