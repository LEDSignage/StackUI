/**
 * Do our pipelines still match what ComfyUI has installed?
 *
 *   npx tsx scripts/check-against-comfy.ts
 *
 * A ComfyUI update can rename a node, add a required input, or drop one, and
 * the first you hear of it is a rejected prompt saying "required input is
 * missing" with no indication of which pipeline or which tile. This compiles
 * every stack and checks it against the live /object_info.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../shared/compile.ts';
import { migrate } from '../shared/migrate.ts';
import { loadEnvFile } from '../shared/env.ts';
import type { Module, ModuleLibrary } from '../shared/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFile(join(ROOT, '.env'));
const COMFY = process.env.COMFY_URL ?? 'http://127.0.0.1:8188';

function library(dir = join(ROOT, 'modules'), lib: ModuleLibrary = {}): ModuleLibrary {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) library(full, lib);
    else if (e.name.endsWith('.json')) {
      const m = JSON.parse(readFileSync(full, 'utf8')) as Module;
      lib[m.id] = m;
    }
  }
  return lib;
}

const info: Record<string, { input?: { required?: Record<string, unknown> } }> = await (
  await fetch(`${COMFY}/object_info`)
).json();
console.log(`ComfyUI has ${Object.keys(info).length} node classes\n`);

const lib = library();
let problems = 0;

for (const file of readdirSync(join(ROOT, 'stacks')).filter((f) => f.endsWith('.json'))) {
  const stack = migrate(JSON.parse(readFileSync(join(ROOT, 'stacks', file), 'utf8')));
  const { prompt, issues } = compile(stack, lib);

  const errors = issues.filter((i) => i.severity === 'error');
  const found: string[] = [];

  for (const [id, node] of Object.entries(prompt)) {
    const def = info[node.class_type];
    if (!def) {
      found.push(`node ${id}: ComfyUI has no "${node.class_type}" any more`);
      continue;
    }
    for (const name of Object.keys(def.input?.required ?? {})) {
      if (!(name in node.inputs)) {
        found.push(`node ${id} (${node.class_type}): missing required input "${name}"`);
      }
    }
    for (const name of Object.keys(node.inputs)) {
      // Autogrow inputs are declared under a group name, so a dotted input is
      // expected not to appear in `required` — see the H3 reference node.
      if (name.includes('.')) continue;
      const known =
        name in (def.input?.required ?? {}) ||
        name in ((def as { input?: { optional?: Record<string, unknown> } }).input?.optional ?? {});
      if (!known) found.push(`node ${id} (${node.class_type}): sends "${name}", which it no longer accepts`);
    }
  }

  const label = file.padEnd(22);
  if (!found.length && !errors.length) {
    console.log(`${label} ok`);
  } else {
    problems++;
    console.log(`${label} PROBLEMS`);
    for (const e of errors) console.log(`   compile: ${e.message}`);
    for (const f of found) console.log(`   ${f}`);
  }
}

console.log(problems ? `\n${problems} stack(s) need attention.` : '\nAll stacks match this ComfyUI.');
