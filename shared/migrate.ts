/**
 * Stack migrations. Spec §4 put a schemaVersion on Stack from day one; this is
 * what earns it.
 *
 * Applied on load, both server and client side, so a stack written by an older
 * version keeps opening.
 */

import { SCHEMA_VERSION, type Line, type Stack, type Tile } from './types.ts';

type LooseTile = Tile & { bypassed?: boolean };
type LooseLine = Omit<Line, 'bypassed' | 'tiles'> & { bypassed?: boolean; tiles: LooseTile[] };
type LooseStack = Omit<Stack, 'lines'> & { lines: LooseLine[] };

export function migrate(raw: unknown): Stack {
  const stack = raw as LooseStack;
  const version = stack.schemaVersion ?? 1;

  let lines = stack.lines ?? [];

  // 1 → 2: bypass moved from the tile to the line. A line counts as bypassed
  // if any tile on it was, which is the only reading that preserves intent.
  if (version < 2) {
    lines = lines.map((line) => ({
      ...line,
      bypassed: line.bypassed ?? line.tiles.some((t) => t.bypassed === true),
      tiles: line.tiles.map(({ bypassed, ...tile }) => {
        void bypassed;
        return tile;
      }),
    }));
  }

  return {
    ...stack,
    schemaVersion: SCHEMA_VERSION,
    ...(stack.controls ? { controls: stack.controls } : {}),
    ...(stack.job ? { job: stack.job } : {}),
    ...(stack.model ? { model: stack.model } : {}),
    ...(stack.output ? { output: stack.output } : {}),
    ...(stack.inputs ? { inputs: stack.inputs } : {}),
    ...(stack.script ? { script: stack.script } : {}),
    lines: lines.map((line) => ({
      id: line.id,
      mode: line.mode ?? 'parallel',
      bypassed: line.bypassed ?? false,
      tiles: line.tiles.map((t) => ({
        id: t.id,
        moduleId: t.moduleId,
        ...(t.label !== undefined ? { label: t.label } : {}),
        params: t.params ?? {},
        collapsed: t.collapsed ?? true,
      })),
    })),
  };
}
