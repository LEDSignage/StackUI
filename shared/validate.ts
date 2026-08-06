/**
 * Validation. Spec §6.
 *
 * Runs on every edit, not just on queue. The carry is computable statically at
 * each line boundary, so drop validity needs no execution — just a compile.
 */

import { compile, resolvePort } from './compile.ts';
import type {
  Carry,
  CompileIssue,
  CompileResult,
  Module,
  ModuleLibrary,
  NamedCarryEntry,
  Stack,
} from './types.ts';

/** Issues keyed by tile id, plus the ones that belong to the stack as a whole. */
export type IssueIndex = {
  byTile: Record<string, CompileIssue[]>;
  stack: CompileIssue[];
};

export function indexIssues(result: CompileResult): IssueIndex {
  const byTile: Record<string, CompileIssue[]> = {};
  const stack: CompileIssue[] = [];
  for (const issue of result.issues) {
    if (issue.tileId) (byTile[issue.tileId] ??= []).push(issue);
    else stack.push(issue);
  }
  return { byTile, stack };
}

// ── Drop validity ───────────────────────────────────────────────────────────

/**
 * A tile may drop at a position only if every required in-port resolves from
 * the carry there.
 *
 * `insertBefore` is an index into `stack.lines`; the carry used is the one that
 * would be visible to a new line at that position. Dropping onto an existing
 * line uses that line's own starting carry (parallel) — a wired line's later
 * slots see more, but refusing the stricter case is the safe default and the
 * user can flip the mode.
 */
export function canDropNewLine(
  stack: Stack,
  library: ModuleLibrary,
  module: Module,
  insertBefore: number,
): { ok: boolean; missing: string[] } {
  const carry = carryBeforeLineIndex(stack, library, insertBefore);
  return checkPorts(module, carry);
}

export function canDropOnLine(
  stack: Stack,
  library: ModuleLibrary,
  module: Module,
  lineId: string,
): { ok: boolean; missing: string[] } {
  const result = compile(stack, library);
  const carry = toCarry(result.carryAtLine[lineId] ?? []);
  return checkPorts(module, carry);
}

function checkPorts(module: Module, carry: Carry): { ok: boolean; missing: string[] } {
  // Optional ports never block a drop — the module runs without them.
  const missing = module.inPorts
    .filter((p) => !p.optional && resolvePort(carry, p.name, module) === null)
    .map((p) => p.name);
  return { ok: missing.length === 0, missing };
}

/**
 * The carry as it stands *before* line index `i` — i.e. what a new line
 * inserted at that position would see. `i === stack.lines.length` gives the
 * final carry.
 */
export function carryBeforeLineIndex(
  stack: Stack,
  library: ModuleLibrary,
  i: number,
): Carry {
  if (i >= stack.lines.length) {
    return toCarry(compile(stack, library).finalCarry);
  }
  const line = stack.lines[i];
  if (!line) return new Map();
  const result = compile(stack, library);
  return toCarry(result.carryAtLine[line.id] ?? []);
}

export function toCarry(entries: NamedCarryEntry[]): Carry {
  return new Map(entries.map((e) => [e.name, { nodeId: e.nodeId, outIndex: e.outIndex, type: e.type }]));
}

// ── Summary line ────────────────────────────────────────────────────────────

/**
 * The collapsed-tile summary. `wan2.2-i2v · 720p · 81f`, not
 * `Video generation module`. Spec §7.
 */
export function summarise(module: Module, params: Record<string, unknown>): string {
  const names = module.summary ?? module.params.slice(0, 3).map((p) => p.name);
  const parts: string[] = [];
  for (const name of names) {
    const param = module.params.find((p) => p.name === name);
    if (!param) continue;
    const v = params[name] ?? param.default;
    if (v === undefined || v === null || v === '') continue;
    parts.push(formatValue(v));
  }
  return parts.join(' · ');
}

function formatValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  const s = String(v);
  return s.length > 32 ? s.slice(0, 31) + '…' : s;
}
