/**
 * Immutable edits to a Stack. Every one returns a new Stack, and every one
 * runs `prune` so empty lines never linger after a drag.
 */

import {
  SCHEMA_VERSION,
  type InputKind,
  type Line,
  type LineMode,
  type Module,
  type Stack,
  type Tile,
} from '@shared/types.ts';

import { shortId as uid } from './uid.ts';

/** The name that means "not saved yet" — see the autosave guard in App. */
export const UNTITLED = 'Untitled stack';

export function emptyStack(name: string = UNTITLED): Stack {
  return { schemaVersion: SCHEMA_VERSION, id: uid(), name, lines: [] };
}

export function newTile(module: Module): Tile {
  return { id: uid(), moduleId: module.id, params: {}, collapsed: true };
}

export function newLine(tiles: Tile[]): Line {
  return { id: uid(), mode: 'parallel', bypassed: false, tiles };
}

/** Drop target 1: a new line at `index`. */
export function insertLine(stack: Stack, index: number, tile: Tile): Stack {
  const lines = [...stack.lines];
  lines.splice(clamp(index, 0, lines.length), 0, newLine([tile]));
  return prune({ ...stack, lines });
}

/** Drop target 2: into an existing line, at `position` among its tiles. */
export function insertIntoLine(stack: Stack, lineId: string, position: number, tile: Tile): Stack {
  return prune({
    ...stack,
    lines: stack.lines.map((line) => {
      if (line.id !== lineId) return line;
      const tiles = [...line.tiles];
      tiles.splice(clamp(position, 0, tiles.length), 0, tile);
      return { ...line, tiles };
    }),
  });
}

export function removeTile(stack: Stack, tileId: string): Stack {
  return prune({
    ...stack,
    lines: stack.lines.map((l) => ({ ...l, tiles: l.tiles.filter((t) => t.id !== tileId) })),
  });
}

/** Move an existing tile to a new line at `index`. */
export function moveToNewLine(stack: Stack, tileId: string, index: number): Stack {
  const tile = findTile(stack, tileId);
  if (!tile) return stack;
  // Remove first, then correct the index for any line that vanished above us.
  const fromLine = stack.lines.findIndex((l) => l.tiles.some((t) => t.id === tileId));
  const collapses = stack.lines[fromLine]?.tiles.length === 1 && fromLine < index;
  const removed = removeTile(stack, tileId);
  return insertLine(removed, collapses ? index - 1 : index, tile);
}

/** Move an existing tile into a line (possibly its own — that is a reorder). */
export function moveToLine(stack: Stack, tileId: string, lineId: string, position: number): Stack {
  const tile = findTile(stack, tileId);
  if (!tile) return stack;
  const sameLine = stack.lines.find((l) => l.id === lineId)?.tiles.some((t) => t.id === tileId);
  const before = sameLine
    ? stack.lines.find((l) => l.id === lineId)!.tiles.findIndex((t) => t.id === tileId)
    : -1;
  const removed = removeTile(stack, tileId);
  // Removing a tile left of the target shifts the target one place down.
  const adjusted = before !== -1 && before < position ? position - 1 : position;
  // The line may have been pruned if it held only this tile.
  if (!removed.lines.some((l) => l.id === lineId)) return insertLine(removed, removed.lines.length, tile);
  return insertIntoLine(removed, lineId, adjusted, tile);
}

export function updateTile(stack: Stack, tileId: string, patch: Partial<Tile>): Stack {
  return {
    ...stack,
    lines: stack.lines.map((l) => ({
      ...l,
      tiles: l.tiles.map((t) => (t.id === tileId ? { ...t, ...patch } : t)),
    })),
  };
}

export function setParam(stack: Stack, tileId: string, name: string, value: unknown): Stack {
  const tile = findTile(stack, tileId);
  if (!tile) return stack;
  return updateTile(stack, tileId, { params: { ...tile.params, [name]: value } });
}

export function setLineMode(stack: Stack, lineId: string, mode: LineMode): Stack {
  return { ...stack, lines: stack.lines.map((l) => (l.id === lineId ? { ...l, mode } : l)) };
}

/**
 * Put a setting on the job page, or take it off. This is the page builder: the
 * Use screen shows exactly the controls listed here, in this order.
 */
export function toggleControl(stack: Stack, tileId: string, param: string, label: string): Stack {
  const existing = stack.controls ?? [];
  const on = existing.some((c) => c.tileId === tileId && c.param === param);
  const controls = on
    ? existing.filter((c) => !(c.tileId === tileId && c.param === param))
    : [...existing, { label, tileId, param }];
  return { ...stack, controls };
}

export function isOnPage(stack: Stack, tileId: string, param: string): boolean {
  return (stack.controls ?? []).some((c) => c.tileId === tileId && c.param === param);
}

export function setLineBypass(stack: Stack, lineId: string, bypassed: boolean): Stack {
  return { ...stack, lines: stack.lines.map((l) => (l.id === lineId ? { ...l, bypassed } : l)) };
}

/** Move a whole line to a new position. `index` is into the pre-move array. */
export function moveLine(stack: Stack, lineId: string, index: number): Stack {
  const from = stack.lines.findIndex((l) => l.id === lineId);
  if (from === -1) return stack;
  const lines = [...stack.lines];
  const [line] = lines.splice(from, 1);
  // Removing shifts everything below it up one.
  lines.splice(clamp(from < index ? index - 1 : index, 0, lines.length), 0, line!);
  return { ...stack, lines };
}

// ── Repeatable inputs ───────────────────────────────────────────────────────
//
// Tiles belonging to one input are named `in.<group>.<i>`, so the group can be
// found again to list, edit or remove it. Marking them by id keeps it out of the
// Tile type — nothing else in the app needs to know these are special.

const INPUT_RE = /^in\.([A-Za-z0-9]+)\.([A-Za-z0-9]+)\.(\d+)$/;

export type InputRef = { kind: string; group: string };

export const inputRefOf = (tileId: string): InputRef | null => {
  const m = INPUT_RE.exec(tileId);
  return m ? { kind: m[1]!, group: m[2]! } : null;
};

/** Every input in the stack, in the order they appear. */
export function inputList(stack: Stack): InputRef[] {
  const seen: InputRef[] = [];
  for (const line of stack.lines) {
    for (const tile of line.tiles) {
      const ref = inputRefOf(tile.id);
      if (ref && !seen.some((s) => s.group === ref.group)) seen.push(ref);
    }
  }
  return seen;
}

export function inputTile(stack: Stack, ref: InputRef, index: number): Tile | undefined {
  return findTile(stack, `in.${ref.kind}.${ref.group}.${index}`);
}

/** Append one more input of this kind, as new lines just above its anchor. */
export function addInput(stack: Stack, kind: InputKind): Stack {
  const at = stack.lines.findIndex((l) => l.tiles.some((t) => t.id === kind.beforeTile));
  if (at === -1) return stack;

  const group = uid();
  const lines = [...stack.lines];
  // A slot may need its own loader — see loaderByIndex on InputKind.
  const existing = inputCount(stack, kind.id);
  kind.template.forEach((t, i) => {
    const moduleId = i === 0 ? (kind.loaderByIndex?.[existing] ?? t.moduleId) : t.moduleId;
    lines.splice(at + i, 0, {
      id: uid(),
      mode: 'parallel',
      bypassed: false,
      tiles: [
        {
          id: `in.${kind.id}.${group}.${i}`,
          moduleId,
          params: { ...(t.params ?? {}) },
          collapsed: true,
        },
      ],
    });
  });
  return { ...stack, lines };
}

export function removeInput(stack: Stack, group: string): Stack {
  return prune({
    ...stack,
    lines: stack.lines.map((l) => ({
      ...l,
      tiles: l.tiles.filter((t) => inputRefOf(t.id)?.group !== group),
    })),
  });
}

/** How many of this kind exist, for the ceiling check. */
export const inputCount = (stack: Stack, kindId: string) =>
  inputList(stack).filter((r) => r.kind === kindId).length;

/**
 * Carry what you were working on across a model switch.
 *
 * Two modes of one model are two stacks, because they need different weights and
 * a different node. That is an implementation detail: switching model should not
 * quietly hand you the other stack's saved prompt and lose what you just typed.
 *
 * Matching is by control *label*, not tile or param name — "Width" means the
 * same thing on both pages while targeting a different tile. Anything the
 * destination does not offer is simply dropped.
 */
export function carryControls(from: Stack, to: Stack): Stack {
  const source = from.controls ?? [];
  const dest = to.controls ?? [];
  if (!source.length || !dest.length) return to;

  let out = to;
  for (const target of dest) {
    const match = source.find((c) => c.label.toLowerCase() === target.label.toLowerCase());
    if (!match) continue;

    // A duration is stored as a frame count on the model's own grid — LTX takes
    // 8n+1, H3 takes 17n+5 — so the raw number means nothing on the other side.
    // Leave the destination's own valid length alone.
    if (match.seconds || target.seconds) continue;

    const value = findTile(from, match.tileId)?.params[match.param];
    if (value === undefined || value === '') continue;

    out = setParam(out, target.tileId, target.param, value);
    for (const also of target.also ?? []) out = setParam(out, also.tileId, also.param, value);
  }

  // The script is the prompt in another shape. Carry it whole when both sides
  // have one, retargeted at the destination's own prompt param.
  if (from.script && to.script) {
    const script = { ...from.script, target: to.script.target };
    out = { ...out, script };
  }

  return out;
}

export function findTile(stack: Stack, tileId: string): Tile | undefined {
  for (const line of stack.lines) {
    const t = line.tiles.find((x) => x.id === tileId);
    if (t) return t;
  }
  return undefined;
}

export function allTiles(stack: Stack): Tile[] {
  return stack.lines.flatMap((l) => l.tiles);
}

/** Drop lines that no longer hold any tiles. */
function prune(stack: Stack): Stack {
  const lines = stack.lines.filter((l) => l.tiles.length > 0);
  return lines.length === stack.lines.length ? stack : { ...stack, lines };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
