/**
 * Compile a stack file and submit it, straight from the terminal.
 *
 *   npx tsx scripts/run-stack.ts stacks/video-ltx.json
 *   npx tsx scripts/run-stack.ts stacks/video-ltx.json --dry
 *
 * Exists because building a new pipeline is a loop of "submit, read ComfyUI's
 * complaint, fix one input" — and doing that through the browser is far slower
 * than doing it here. Reports the same issues the UI would show on tiles, then
 * whatever ComfyUI says.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../shared/compile.ts';
import { migrate } from '../shared/migrate.ts';
import type { Module, ModuleLibrary } from '../shared/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const COMFY = process.env.COMFY_URL ?? 'http://10.130.91.138:8188';

const file = process.argv[2];
const dry = process.argv.includes('--dry');
if (!file) {
  console.error('usage: run-stack.ts <stack.json> [--dry]');
  process.exit(1);
}

function loadLibrary(dir = join(ROOT, 'modules'), lib: ModuleLibrary = {}): ModuleLibrary {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) loadLibrary(full, lib);
    else if (entry.name.endsWith('.json')) {
      const m = JSON.parse(readFileSync(full, 'utf8')) as Module;
      lib[m.id] = m;
    }
  }
  return lib;
}

const library = loadLibrary();
const stack = migrate(JSON.parse(readFileSync(join(ROOT, file), 'utf8')));
const result = compile(stack, library);

console.log(`${stack.name}: ${stack.lines.length} lines, ${Object.keys(result.prompt).length} nodes`);

if (result.issues.length) {
  console.log('\nIssues:');
  for (const i of result.issues) {
    const tile = i.tileId ? ` [${i.tileId}]` : '';
    console.log(`  ${i.severity}${tile} ${i.message}`);
  }
}
if (!result.ok) {
  console.log('\nNot submitting — errors above.');
  process.exit(1);
}
if (dry) {
  console.log('\n' + JSON.stringify(result.prompt, null, 2));
  process.exit(0);
}

const res = await fetch(`${COMFY}/prompt`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: result.prompt, client_id: 'run-stack' }),
});
const body = await res.json().catch(() => ({}));

if (!res.ok) {
  console.log(`\nComfyUI rejected it (${res.status}):`);
  console.log('  ' + (body?.error?.message ?? body?.error ?? 'unknown'));
  for (const [nodeId, detail] of Object.entries(body?.node_errors ?? {})) {
    const tileId = result.tileMap[nodeId];
    const cls = result.prompt[nodeId]?.class_type;
    console.log(`\n  node ${nodeId} (${cls}) — tile ${tileId}`);
    for (const e of (detail as { errors?: { message: string; details: string }[] }).errors ?? []) {
      console.log(`    ${e.message}: ${e.details}`);
    }
  }
  process.exit(1);
}

console.log(`\nQueued: ${body.prompt_id}`);

// Poll until it lands, so the exit code means something.
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const h = await fetch(`${COMFY}/history/${body.prompt_id}`).then((r) => r.json()).catch(() => ({}));
  const entry = h?.[body.prompt_id];
  if (!entry) continue;
  const status = entry.status?.status_str ?? '?';
  console.log(`Finished: ${status}`);
  for (const [nodeId, out] of Object.entries(entry.outputs ?? {})) {
    console.log(`  node ${nodeId}: ${JSON.stringify(out).slice(0, 300)}`);
  }
  if (status !== 'success') {
    const msgs = (entry.status?.messages ?? []) as [string, Record<string, unknown>][];
    for (const [kind, data] of msgs) {
      if (kind === 'execution_error') console.log('\n  ERROR: ' + JSON.stringify(data, null, 2).slice(0, 1200));
    }
    process.exit(1);
  }
  process.exit(0);
}
console.log('Timed out waiting for it to finish.');
