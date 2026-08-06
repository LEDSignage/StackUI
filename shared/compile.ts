/**
 * The compile step. Spec §5.
 *
 * Input:  a Stack plus the module library.
 * Output: API-format JSON, plus a node_id → tile_id map.
 *
 * This is the whole project. Everything downstream depends on it being right.
 */

import {
  isNodeRef,
  isPortRef,
  type ApiPrompt,
  type Carry,
  type CarryEntry,
  type CompileIssue,
  type CompileResult,
  type Module,
  type ModuleLibrary,
  type NamedCarryEntry,
  type Stack,
  type Tile,
} from './types.ts';

export type CompileOptions = {
  /**
   * Append a terminal node bound to the last IMAGE in the carry when the stack
   * has nothing terminal. Off by default — a warning is cheaper than a surprise.
   */
  autoSave?: boolean;
  /** class_type used by autoSave. */
  autoSaveClass?: string;
};

export function compile(
  stack: Stack,
  library: ModuleLibrary,
  options: CompileOptions = {},
): CompileResult {
  let nodeCounter = 0;
  const carry: Carry = new Map();
  const prompt: ApiPrompt = {};
  const tileMap: Record<string, string> = {};
  const issues: CompileIssue[] = [];
  const carryAtLine: Record<string, NamedCarryEntry[]> = {};

  let sawTerminal = false;

  for (const line of stack.lines) {
    // parallel: everyone on the line sees the same starting state
    const lineCarry: Carry = new Map(carry);
    const pending: Carry = new Map();

    carryAtLine[line.id] = snapshot(lineCarry);

    for (const tile of line.tiles) {
      const module = library[tile.moduleId];

      if (!module) {
        issues.push({
          tileId: tile.id,
          severity: 'error',
          code: 'unknown-module',
          message: `No module "${tile.moduleId}" in the library.`,
        });
        continue;
      }

      if (line.bypassed) {
        applyBypass(tile, module, lineCarry, pending, issues);
        continue;
      }

      if (module.terminal) sawTerminal = true;

      // Pass 1: allocate a global id for every node in the module, so
      // intra-module refs can point forwards as well as backwards.
      const localToGlobal: Record<string, string> = {};
      for (const localId of Object.keys(module.nodes)) {
        const gid = String(++nodeCounter);
        localToGlobal[localId] = gid;
        tileMap[gid] = tile.id;
      }

      // Pass 2: resolve inputs.
      for (const [localId, node] of Object.entries(module.nodes)) {
        const gid = localToGlobal[localId]!;
        const inputs: Record<string, unknown> = {};

        for (const [inputName, value] of Object.entries(node.inputs)) {
          if (isPortRef(value)) {
            const src = resolvePort(lineCarry, value.$port, module);
            if (!src) {
              // An optional port that nothing provides is simply left unwired —
              // ComfyUI runs the node without it. Only required ports are errors.
              if (module.inPorts.find((p) => p.name === value.$port)?.optional) continue;
              issues.push({
                tileId: tile.id,
                severity: 'error',
                code: 'unresolved-port',
                message: `"${module.name}" needs "${value.$port}" but nothing upstream provides it.`,
              });
              continue;
            }
            inputs[inputName] = [src.nodeId, src.outIndex];
          } else if (isNodeRef(value)) {
            const target = localToGlobal[value.$node];
            if (!target) {
              issues.push({
                tileId: tile.id,
                severity: 'error',
                code: 'bad-node-ref',
                message: `"${module.name}" references local node "${value.$node}", which it does not define.`,
              });
              continue;
            }
            inputs[inputName] = [target, value.out ?? 0];
          } else {
            inputs[inputName] = value;
          }
        }

        prompt[gid] = { class_type: node.class_type, inputs };
      }

      // Pass 3: params overwrite whatever the module's graph declared.
      for (const param of module.params) {
        const gid = localToGlobal[param.target.node];
        if (!gid) {
          issues.push({
            tileId: tile.id,
            severity: 'error',
            code: 'bad-node-ref',
            message: `Param "${param.name}" targets local node "${param.target.node}", which "${module.name}" does not define.`,
          });
          continue;
        }
        const v = tile.params[param.name] ?? param.default;

        // An empty file slot is never valid. ComfyUI resolves "" to the input
        // folder itself and then fails deep inside a video decoder with a
        // permission error, which tells you nothing about the real problem.
        if (param.type === 'IMAGE_UPLOAD' && (v === '' || v === undefined || v === null)) {
          issues.push({
            tileId: tile.id,
            severity: 'error',
            code: 'empty-file',
            message: `"${module.name}" has no file chosen for "${param.label}".`,
          });
        }

        prompt[gid]!.inputs[param.target.input] = v;
      }

      // Pass 4: publish out-ports.
      for (const port of module.outPorts) {
        const src = resolveOutPort(module, port.name, localToGlobal);
        if (!src) {
          issues.push({
            tileId: tile.id,
            severity: 'error',
            code: 'missing-output',
            message: `"${module.name}" declares out-port "${port.name}" but does not say which node backs it.`,
          });
          continue;
        }
        pending.set(port.name, { ...src, type: port.type });
      }

      if (line.mode === 'wired') {
        // next tile on this line sees what we just produced
        for (const [k, v] of pending) lineCarry.set(k, v);
        pending.clear();
      }
    }

    for (const [k, v] of pending) carry.set(k, v);
  }

  if (!sawTerminal) {
    if (options.autoSave) {
      const image = lastOfType(carry, 'IMAGE');
      if (image) {
        const gid = String(++nodeCounter);
        prompt[gid] = {
          class_type: options.autoSaveClass ?? 'SaveImage',
          inputs: {
            images: [image.nodeId, image.outIndex],
            filename_prefix: 'StackUI',
          },
        };
        sawTerminal = true;
      }
    }
    if (!sawTerminal) {
      issues.push({
        severity: 'warning',
        code: 'no-terminal',
        message:
          'Nothing in this stack saves or previews a result — ComfyUI has nothing to execute toward.',
      });
    }
  }

  return {
    prompt,
    tileMap,
    carryAtLine,
    finalCarry: snapshot(carry),
    issues,
    ok: !issues.some((i) => i.severity === 'error'),
  };
}

// ── Bypass ──────────────────────────────────────────────────────────────────

/**
 * A tile on a bypassed line emits no nodes. Its passThrough map aliases carry
 * entries so downstream tiles still resolve. Without passThrough, downstream
 * consumers of its outputs will fail — flag it here rather than at submit time.
 */
function applyBypass(
  tile: Tile,
  module: Module,
  lineCarry: Carry,
  pending: Carry,
  issues: CompileIssue[],
): void {
  const through = module.passThrough ?? {};

  for (const [inName, outName] of Object.entries(through)) {
    const src = lineCarry.get(inName);
    if (src) pending.set(outName, src);
  }

  const unbridged = module.outPorts.filter((p) => !Object.values(through).includes(p.name));
  if (unbridged.length > 0) {
    issues.push({
      tileId: tile.id,
      severity: 'warning',
      code: 'bypass-unsafe',
      message: `Bypassed "${module.name}" no longer provides ${unbridged
        .map((p) => `"${p.name}"`)
        .join(', ')}. Anything downstream that needs it will fail.`,
    });
  }
}

// ── Port resolution ─────────────────────────────────────────────────────────

/**
 * Name first. If the name is absent, fall back to a *unique* type match in the
 * carry — one IMAGE in scope and a module wanting an IMAGE is unambiguous.
 * Two IMAGEs under different names is ambiguous, and we treat ambiguity as
 * unresolved rather than guessing. Spec §6.
 */
export function resolvePort(
  carry: Carry,
  portName: string,
  module: Module,
): CarryEntry | null {
  const byName = carry.get(portName);
  if (byName) return byName;

  const declared = module.inPorts.find((p) => p.name === portName);
  if (!declared) return null;

  const sameType = [...carry.values()].filter((e) => e.type === declared.type);
  return sameType.length === 1 ? sameType[0]! : null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolveOutPort(
  module: Module,
  portName: string,
  localToGlobal: Record<string, string>,
): { nodeId: string; outIndex: number } | null {
  const declared = module.outputs?.[portName];
  if (declared) {
    const gid = localToGlobal[declared.node];
    return gid ? { nodeId: gid, outIndex: declared.out ?? 0 } : null;
  }
  // Single-node module: unambiguous, don't make the author write it out.
  const localIds = Object.keys(module.nodes);
  if (localIds.length === 1) {
    return { nodeId: localToGlobal[localIds[0]!]!, outIndex: 0 };
  }
  return null;
}

function snapshot(carry: Carry): NamedCarryEntry[] {
  return [...carry.entries()].map(([name, e]) => ({ ...e, name }));
}

function lastOfType(carry: Carry, type: string): CarryEntry | undefined {
  let found: CarryEntry | undefined;
  for (const e of carry.values()) if (e.type === type) found = e;
  return found;
}
