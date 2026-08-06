/**
 * Turn every node class ComfyUI has installed into a Stack UI module.
 *
 *   node scripts/generate-modules.mjs
 *
 * The goal is that nothing ever requires the node editor: if ComfyUI can do it,
 * it is a tile you can drag. Hand-written modules in modules/ stay as curated
 * presets and take precedence; these are the raw, complete set.
 *
 * Port naming uses ComfyUI's own input names — `positive`, `negative`, `model`,
 * `samples`. An earlier version named ports after their *type*, which produced
 * "conditioning" and "conditioning2" on KSampler and destroyed the one thing
 * you need to know about them: which is which.
 *
 * The cost is that ComfyUI's names are inconsistent for the same type —
 * VAEDecode calls its latent input "samples", KSampler calls it "latent_image".
 * That is fine, because the compiler falls back to matching on type when the
 * name is absent, and reports an error rather than guessing when two candidates
 * of that type are in scope. A clear name beats a convenient one.
 */

import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT_DIR = join(ROOT, 'modules', 'generated');
const SOURCE = process.env.COMFY_URL ?? 'http://10.130.91.138:8188';

/** Types that are settings you type in, not connections between nodes. */
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN']);

/**
 * Nothing is skipped by name.
 *
 * This used to drop inputs called `prompt`, `unique_id`, `extra_pnginfo` and
 * friends, on the assumption they were the ones ComfyUI injects itself. They
 * are — but ComfyUI declares those under `hidden`, which this generator never
 * reads. So the only thing the list achieved was deleting the real, required
 * `prompt` input from every node that has one, MiniMaxH3ImageToVideo included.
 */
const SKIP_INPUTS = new Set([]);

const main = async () => {
  process.stdout.write(`Reading ${SOURCE}/object_info … `);
  const res = await fetch(`${SOURCE}/object_info`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const info = await res.json();
  console.log(`${Object.keys(info).length} node classes`);

  // Never leave a stale generated module behind — a renamed class would linger
  // and a stack could still reference something ComfyUI no longer has.
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const curated = new Set(
    (await readdir(join(ROOT, 'modules')))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, '')),
  );

  let written = 0;
  const skipped = [];

  for (const [classType, def] of Object.entries(info)) {
    try {
      const module = build(classType, def);
      if (!module) {
        skipped.push([classType, 'nothing to expose']);
        continue;
      }
      await writeFile(join(OUT_DIR, `${module.id}.json`), JSON.stringify(module, null, 2) + '\n', 'utf8');
      written++;
    } catch (err) {
      skipped.push([classType, err.message]);
    }
  }

  console.log(`\nWrote ${written} modules to modules/generated/`);
  console.log(`Curated modules kept in modules/: ${curated.size}`);
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length}:`);
    for (const [c, why] of skipped.slice(0, 25)) console.log(`  ${c} — ${why}`);
    if (skipped.length > 25) console.log(`  … and ${skipped.length - 25} more`);
  }
};

/** A safe, stable file/module id. */
const idFor = (classType) => `gen.${classType.replace(/[^A-Za-z0-9._-]/g, '_')}`;

/** ComfyUI's own name, tidied: "latent_image" -> latent_image, "Positive" -> positive. */
const portName = (name) => String(name).toLowerCase().replace(/[^a-z0-9_]/g, '_') || 'value';

/**
 * ComfyUI declares dropdowns two ways, and both must be recognised as widgets
 * rather than connections:
 *
 *   old: ["euler", "heun", …]                       — a bare list of choices
 *   new: ["COMBO", { options: [...] }]               — a named COMBO type
 *
 * Missing the second form made `SaveVideo`'s codec and format into input ports,
 * and gave the LTX text-encoder loader three ports and no settings at all.
 */
function isCombo(spec) {
  const t = spec?.[0];
  if (Array.isArray(t)) return true;
  return typeof t === 'string' && (t === 'COMBO' || t.startsWith('COMFY_DYNAMICCOMBO'));
}

/**
 * The choices, as plain strings.
 *
 * A dynamic combo lists objects rather than strings — `{ key: "h264", inputs:
 * {...} }` — where the nested inputs are extra settings that appear only when
 * that choice is picked. We take the keys and ignore the nested settings, which
 * is why the defaults chosen here are always the "auto" style option that needs
 * none. Putting the raw object into the graph made SaveVideo fail with a missing
 * argument, since an object is not a codec name.
 */
function comboOptions(spec) {
  const raw = Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o) => (o && typeof o === 'object' && 'key' in o ? o.key : o))
    .filter((o) => typeof o === 'string');
}

function isConnection(spec) {
  const t = spec?.[0];
  if (isCombo(spec)) return false;
  if (typeof t !== 'string') return false;
  if (WIDGET_TYPES.has(t)) return false;
  return true;
}

function build(classType, def) {
  const required = def?.input?.required ?? {};
  const optional = def?.input?.optional ?? {};

  const nodes = { n: { class_type: classType, inputs: {} } };
  const inPorts = [];
  const params = [];
  const usedPortNames = new Map();
  const usedParamNames = new Set();

  /** Unique port name per module: image, image2, image3 … */
  const uniquePort = (base) => {
    const n = (usedPortNames.get(base) ?? 0) + 1;
    usedPortNames.set(base, n);
    return n === 1 ? base : `${base}${n}`;
  };

  for (const [group, inputs] of [
    ['required', required],
    ['optional', optional],
  ]) {
    for (const [inputName, spec] of Object.entries(inputs)) {
      if (SKIP_INPUTS.has(inputName)) continue;
      if (!Array.isArray(spec)) continue;

      const opts = (typeof spec[1] === 'object' && spec[1]) || {};

      if (isConnection(spec)) {
        // Optional connections are kept, flagged optional so they never block a
        // drop. Dropping them entirely was wrong: start/end-frame images are
        // declared optional by ComfyUI, so a node like MiniMaxH3ImageToVideo
        // ended up with no way to receive an image at all.
        const name = uniquePort(portName(inputName));
        inPorts.push({
          name,
          type: String(spec[0]),
          ...(group === 'optional' ? { optional: true } : {}),
        });
        nodes.n.inputs[inputName] = { $port: name };
        continue;
      }

      const param = buildParam(classType, inputName, spec, opts);
      if (!param) continue;
      if (usedParamNames.has(param.name)) continue;
      usedParamNames.add(param.name);
      params.push(param);
      nodes.n.inputs[inputName] = param.default;
    }
  }

  const outputs = {};
  const outPorts = [];
  const outTypes = def?.output ?? [];
  const outNames = def?.output_name ?? [];
  outTypes.forEach((type, i) => {
    // Prefer ComfyUI's own output name when it is not just the type again,
    // so MASK vs IMAGE on LoadImage stays distinguishable.
    const raw = outNames[i] && String(outNames[i]).toUpperCase() !== String(type).toUpperCase()
      ? outNames[i]
      : type;
    const name = uniquePortOut(outputs, portName(raw));
    outPorts.push({ name, type: String(type) });
    outputs[name] = { node: 'n', out: i };
  });

  if (inPorts.length === 0 && params.length === 0 && outPorts.length === 0) return null;

  const module = {
    id: idFor(classType),
    name: def?.display_name || classType,
    category: def?.category ? `ComfyUI / ${def.category}` : 'ComfyUI / uncategorised',
    description: `${classType}${def?.description ? ` — ${String(def.description).split('\n')[0]}` : ''}`,
    inPorts,
    outPorts,
    params,
    nodes,
  };

  if (Object.keys(outputs).length) module.outputs = outputs;
  if (def?.output_node) module.terminal = true;

  // Anything that takes a type and gives the same type back can be bypassed
  // safely — an upscaler, a LoRA loader, a conditioning tweak.
  const through = {};
  for (const inp of inPorts.filter((p) => !p.optional)) {
    const match = outPorts.find((o) => o.type === inp.type && !Object.values(through).includes(o.name));
    if (match) through[inp.name] = match.name;
  }
  if (Object.keys(through).length) module.passThrough = through;

  if (params.length) module.summary = params.slice(0, 3).map((p) => p.name);

  return module;
}

function uniquePortOut(outputs, base) {
  if (!outputs[base]) return base;
  let i = 2;
  while (outputs[`${base}${i}`]) i++;
  return `${base}${i}`;
}

function buildParam(classType, inputName, spec, opts) {
  const t = spec[0];
  const label = inputName.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const base = { name: inputName, label, target: { node: 'n', input: inputName } };

  // A list of choices, in either declaration form. The options are also read
  // live from ComfyUI at load time, so installing a model shows up without
  // regenerating; the baked list is the fallback when the box is unreachable.
  if (isCombo(spec)) {
    const choices = comboOptions(spec);
    return {
      ...base,
      type: 'ENUM',
      default: opts.default ?? choices[0] ?? '',
      ...(choices.length ? { options: choices } : {}),
      optionsFrom: { class_type: classType, input: inputName },
    };
  }

  switch (t) {
    case 'INT':
      return {
        ...base,
        type: 'INT',
        default: numberOr(opts.default, 0),
        ...(Number.isFinite(opts.min) ? { min: opts.min } : {}),
        ...(Number.isFinite(opts.max) && opts.max < Number.MAX_SAFE_INTEGER ? { max: opts.max } : {}),
        ...(Number.isFinite(opts.step) ? { step: opts.step } : {}),
      };
    case 'FLOAT':
      return {
        ...base,
        type: 'FLOAT',
        default: numberOr(opts.default, 0),
        ...(Number.isFinite(opts.min) ? { min: opts.min } : {}),
        ...(Number.isFinite(opts.max) ? { max: opts.max } : {}),
        ...(Number.isFinite(opts.step) ? { step: opts.step } : {}),
      };
    case 'BOOLEAN':
      return { ...base, type: 'BOOLEAN', default: Boolean(opts.default ?? false) };
    case 'STRING':
      return {
        ...base,
        type: 'STRING',
        default: typeof opts.default === 'string' ? opts.default : '',
        ...(opts.multiline ? { multiline: true } : {}),
      };
    default:
      return null;
  }
}

const numberOr = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

await main();
