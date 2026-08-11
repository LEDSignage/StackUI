/**
 * One run through the whole chain, exactly as the page does it.
 *
 * Compile the shipped start/end-frame pipeline, apply the guide-size
 * workaround, and submit through Stack UI's proxy — not straight to ComfyUI —
 * so the proxy, the Origin stripping, the compiler fixes and ComfyUI's patched
 * guide path are all on the hook. One step: the failures this is watching for
 * all happen before sampling.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { compile } from './shared/compile.ts';
import { migrate } from './shared/migrate.ts';
import { fixGuideSize } from './shared/guideSize.ts';

const UI = 'http://10.130.91.138:8790';

const lib = {};
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = `${d}/${e.name}`;
    if (e.isDirectory()) walk(f);
    else if (e.name.endsWith('.json')) {
      const m = JSON.parse(readFileSync(f, 'utf8'));
      lib[m.id] = m;
    }
  }
};
walk('modules');

const guide = (await (await fetch(`${UI}/comfy/internal/files/input`)).json())
  .map((s) => s.replace(/\s*\[[^\]]*\]\s*$/, ''))
  .find((s) => /\.(png|jpe?g|webp)$/i.test(s));

const stack = migrate(JSON.parse(readFileSync('stacks/video-h3.json', 'utf8')));
const { ok, prompt, issues } = compile(stack, lib);
console.log('compiles:', ok, '| warnings:', issues.filter((i) => i.severity === 'warning').map((i) => i.code).join(', ') || 'none');
if (!ok) {
  console.log('errors:', issues.filter((i) => i.severity === 'error').map((i) => i.message));
  process.exit(1);
}

for (const node of Object.values(prompt)) {
  if (node.class_type === 'MiniMaxH3ImageToVideo') {
    node.inputs.width = 1920;
    node.inputs.height = 1080; // the size that crashed this morning
    node.inputs.length = 39;
    node.inputs.prompt = 'a still menu board, no motion';
  }
  if (node.class_type === 'BasicScheduler') node.inputs.steps = 1;
  if (node.class_type === 'LoadImage') node.inputs.image = guide;
}

const fix = fixGuideSize(prompt);
console.log('guide-size workaround:', fix ? `${fix.width}x${fix.height} submitted as ${fix.sentWidth}x${fix.sentHeight}` : 'not needed');

const res = await fetch(`${UI}/comfy/prompt`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: UI },
  body: JSON.stringify({ prompt }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.log('REJECTED:', JSON.stringify(body).slice(0, 400));
  process.exit(1);
}
console.log('accepted, prompt', body.prompt_id.slice(0, 8));

for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const h = await (await fetch(`${UI}/comfy/history/${body.prompt_id}`)).json().catch(() => ({}));
  const entry = h[body.prompt_id];
  if (!entry?.status) continue;
  if (entry.status.status_str === 'error') {
    const err = (entry.status.messages || []).find((m) => m[0] === 'execution_error');
    console.log('FAILED:', err ? err[1].exception_message.split('\n')[0] : 'unknown');
    process.exit(1);
  }
  if (entry.status.completed) {
    const files = Object.values(entry.outputs ?? {})
      .flatMap((o) => Object.values(o).flat())
      .filter((f) => f?.filename);
    console.log('SUCCESS —', files.map((f) => `${f.subfolder ? f.subfolder + '/' : ''}${f.filename}`).join(', '));
    process.exit(0);
  }
}
console.log('timed out waiting');
process.exit(1);
