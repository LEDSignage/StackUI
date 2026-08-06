import { useEffect, useRef, useState } from 'react';
import type { CompileIssue, Line, Module, ModuleLibrary, Stack, Tile } from '@shared/types.ts';
import type { RunState } from '../lib/useRun.ts';
import type { DragPayload } from '../lib/drag.ts';
import { beginDrag } from '../lib/drag.ts';
import { TileView } from './TileView.tsx';

/**
 * A drop is only permitted if the target prevents the default on dragover —
 * and, in Firefox, on dragenter too. Miss either and the browser silently
 * refuses the drop: dragover keeps firing, the target lights up, and nothing
 * lands.
 */
function acceptIf(ok: boolean, setOver: (v: boolean) => void) {
  return (e: React.DragEvent) => {
    if (!ok) return;
    e.preventDefault();
    setOver(true);
  };
}

export type DropTarget =
  | { kind: 'new-line'; index: number }
  | { kind: 'in-line'; lineId: string; position: number };

type Props = {
  stack: Stack;
  library: ModuleLibrary;
  issuesByTile: Record<string, CompileIssue[]>;
  run: RunState;
  drag: DragPayload | null;
  /** Is this target valid for the module being dragged? Undefined = no drag. */
  validity: (target: DropTarget, module: Module) => { ok: boolean; missing: string[] };
  onDrag: (p: DragPayload | null) => void;
  onDrop: (target: DropTarget) => void;
  onPatchTile: (tileId: string, patch: Partial<Tile>) => void;
  onParam: (tileId: string, name: string, value: unknown) => void;
  onRemoveTile: (tileId: string) => void;
  onLineMode: (lineId: string, mode: 'parallel' | 'wired') => void;
  onLineBypass: (lineId: string, bypassed: boolean) => void;
  onPage: (tileId: string, param: string) => boolean;
  onTogglePage: (tileId: string, param: string, label: string) => void;
};

export function StackView(props: Props) {
  const { stack, library, drag } = props;
  // A line drag reorders whole lines; only module/tile drags care about ports.
  const dragging = drag && drag.kind !== 'line' ? library[drag.moduleId] : undefined;
  const draggingLine = drag?.kind === 'line' ? drag.lineId : null;

  /** Which line the cursor is over during a line drag, and how far to slide. */
  const [hoverLine, setHoverLine] = useState<number | null>(null);
  const [lineDelta, setLineDelta] = useState(0);

  const movingIdx = draggingLine ? stack.lines.findIndex((l) => l.id === draggingLine) : -1;

  /**
   * Lines slide out of the way, exactly as modules do — nothing to aim at.
   *
   * Modules can shift by a clean 100% because they share width evenly. Lines
   * have different heights, so the distance is the dragged line's own height
   * plus the gap, measured when the drag passes over.
   */
  const lineShift = (i: number): number => {
    if (movingIdx === -1 || hoverLine === null || !lineDelta) return 0;
    if (i === movingIdx) return 0;
    if (movingIdx < hoverLine && i > movingIdx && i <= hoverLine) return -lineDelta;
    if (movingIdx > hoverLine && i >= hoverLine && i < movingIdx) return lineDelta;
    return 0;
  };

  const onLineHover = (index: number | null) => {
    if (movingIdx === -1 || index === movingIdx) {
      setHoverLine(null);
      return;
    }
    if (index !== null && !lineDelta) {
      const el = document.querySelector<HTMLElement>(`[data-line-id="${draggingLine}"]`);
      const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gap-line')) || 22;
      if (el) setLineDelta(el.getBoundingClientRect().height + gap);
    }
    setHoverLine(index);
  };

  // Clear the slide state whenever a drag ends.
  useEffect(() => {
    if (!draggingLine) {
      setHoverLine(null);
      setLineDelta(0);
    }
  }, [draggingLine]);

  if (stack.lines.length === 0) {
    return (
      <div className="stack">
        <EmptyDrop {...props} module={dragging} />
      </div>
    );
  }

  return (
    <div className="stack">
      <DragHint {...props} module={dragging} />
      {stack.lines.map((line, i) => (
        <div key={line.id}>
          <LineGap {...props} index={i} module={dragging} first={i === 0} />
          <LineView
            {...props}
            line={line}
            index={i}
            module={dragging}
            shiftY={lineShift(i)}
            lifted={i === movingIdx && hoverLine !== null}
            onLineHover={onLineHover}
          />
        </div>
      ))}
      <LineGap {...props} index={stack.lines.length} module={dragging} />
    </div>
  );
}

// ── Drag hint ───────────────────────────────────────────────────────────────

/**
 * Refusing every drop target without saying why is the worst thing this UI can
 * do — it just looks broken. Tooltips do not render during an HTML5 drag, so
 * the explanation has to be on the page.
 */
function DragHint({ stack, module, validity }: Props & { module: Module | undefined }) {
  // Always rendered, never mounted mid-drag. Mutating the DOM during dragstart
  // can make Chrome abandon the drag outright, and this banner appearing was the
  // one structural difference between a line drag (worked) and a tile drag
  // (died immediately). It is positioned out of flow so it cannot reflow the
  // stack either.
  if (!module) return <div className="drag-hint drag-hint-idle" aria-hidden="true" />;

  const anyValid =
    stack.lines.some((_, i) => validity({ kind: 'new-line', index: i }, module).ok) ||
    validity({ kind: 'new-line', index: stack.lines.length }, module).ok ||
    stack.lines.some((l) => validity({ kind: 'in-line', lineId: l.id, position: 0 }, module).ok);

  // Only worth saying something when a drop is impossible. When it works, the
  // modules sliding out of the way already say where it will land, and a banner
  // telling you to aim at a bar that no longer exists is worse than silence.
  if (anyValid) return <div className="drag-hint drag-hint-idle" aria-hidden="true" />;

  const missing = validity({ kind: 'new-line', index: stack.lines.length }, module).missing;
  return (
    <div className="drag-hint drag-hint-bad">
      <strong>{module.name}</strong> needs {missing.map((m) => `"${m}"`).join(', ')}, and nothing in
      this stack provides {missing.length === 1 ? 'it' : 'them'} yet. Add whatever produces{' '}
      {missing.length === 1 ? 'that' : 'those'} first.
    </div>
  );
}

// ── Empty stack ─────────────────────────────────────────────────────────────

/**
 * The whole placeholder is the drop target. It says "drag a module here", so
 * "here" had better mean the box and not a 22px sliver above it.
 */
function EmptyDrop({ module, validity, onDrop }: Props & { module: Module | undefined }) {
  const [over, setOver] = useState(false);
  const check = module ? validity({ kind: 'new-line', index: 0 }, module) : null;
  const ok = check?.ok ?? false;

  return (
    <div
      className={`empty ${module ? (ok ? 'empty-ok' : 'empty-bad') : ''} ${over ? 'empty-over' : ''}`}
      onDragEnter={acceptIf(ok, setOver)}
      onDragOver={acceptIf(ok, setOver)}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (ok) onDrop({ kind: 'new-line', index: 0 });
      }}
    >
      {!module
        ? 'Drag a module here to start a stack.'
        : ok
          ? 'Drop to add it.'
          : `Needs ${check?.missing.join(', ')} — nothing upstream provides that yet.`}
    </div>
  );
}

// ── Drop target 1: between lines ────────────────────────────────────────────

function LineGap({
  index,
  module,
  drag,
  validity,
  onDrop,
  first,
}: Props & {
  index: number;
  module: Module | undefined;
  first?: boolean;
}) {
  const [over, setOver] = useState(false);
  const check = module ? validity({ kind: 'new-line', index }, module) : null;
  /**
   * Only for a *new* module arriving from the library, where "put this on its
   * own line" is a real choice that nothing else can express.
   *
   * Not for reordering. Moving a module or a line is shown by things sliding
   * out of the way; a bar to aim at would be a second, worse mechanism for the
   * same job.
   */
  const active = drag?.kind === 'module' && Boolean(module);
  const ok = check?.ok ?? false;

  if (!active) return <div className={`gap ${first ? 'gap-first' : ''}`} />;

  return (
    <div
      className={`gap gap-active ${ok ? 'gap-ok' : 'gap-bad'} ${over ? 'gap-over' : ''}`}
      onDragEnter={acceptIf(ok, setOver)}
      onDragOver={acceptIf(ok, setOver)}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (ok) onDrop({ kind: 'new-line', index });
      }}
      title={ok ? 'New line here' : `Needs ${check?.missing.join(', ')}`}
    >
      <div className="gap-bar" />
    </div>
  );
}

// ── A line ──────────────────────────────────────────────────────────────────

function LineView(
  props: Props & {
    line: Line;
    index: number;
    module: Module | undefined;
    shiftY: number;
    lifted: boolean;
    onLineHover: (index: number | null) => void;
  },
) {
  const {
    line,
    index,
    library,
    issuesByTile,
    run,
    module,
    validity,
    onDrag,
    onDrop,
    onPatchTile,
    onParam,
    onRemoveTile,
    onLineMode,
    onLineBypass,
    shiftY,
    lifted,
    onLineHover,
  } = props;

  const lineRoot = useRef<HTMLDivElement>(null);
  const isLineDrag = props.drag?.kind === 'line';

  const wired = line.mode === 'wired';

  /** Where a drop would insert, or null if this row is not a valid target. */
  const [insertAt, setInsertAt] = useState<number | null>(null);

  /**
   * Which tile the cursor is over, or null.
   *
   * The whole module is one target — not its halves. An earlier version split
   * each tile down the middle into insert-before / insert-after, which meant
   * that when dragging tile A, the left half of its neighbour computed "insert
   * before B" — where A already was, so a no-op that highlighted nothing. Half
   * of every module was dead, and the only live feedback appeared near the
   * boundary between two tiles. Indistinguishable from the gap being the target.
   *
   * Now: hover any module, the dragged one lands on it. Every pixel is live.
   */
  const hoveredIndex = (e: React.DragEvent, row: HTMLElement): number | null => {
    const slots = [...row.querySelectorAll('.slot')] as HTMLElement[];
    for (let i = 0; i < slots.length; i++) {
      const r = slots[i]!.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right) return i;
    }
    return slots.length > 0 ? slots.length - 1 : null;
  };

  /** The tile being dragged, if it lives on this line. */
  const selfIndex =
    props.drag?.kind === 'tile'
      ? line.tiles.findIndex((t) => t.id === (props.drag as { tileId: string }).tileId)
      : -1;

  /**
   * The insert position to hand the compiler, derived from the event every time.
   * Never read from state on drop: `dragleave` fires as the pointer crosses
   * between child elements, and Chrome reports `relatedTarget` as null on drag
   * events, so any "did we really leave?" test wipes the state mid-drag.
   */
  const targetFor = (e: React.DragEvent, row: HTMLElement): { index: number; position: number } | null => {
    if (!module) return null;

    const index = hoveredIndex(e, row);
    if (index === null) return null;
    if (index === selfIndex) return null; // already there

    // `moveToLine` removes before inserting, which shifts later positions down.
    const position = selfIndex !== -1 && selfIndex < index ? index + 1 : index;
    return validity({ kind: 'in-line', lineId: line.id, position }, module).ok
      ? { index, position }
      : null;
  };

  /**
   * The whole row is the drop zone. Which side of a tile the cursor sits on
   * decides where the drop lands — there is nothing thin to hit.
   */
  const onOver = (e: React.DragEvent) => {
    const target = targetFor(e, e.currentTarget as HTMLElement);
    setInsertAt(target ? target.index : null);
    // Firefox needs dragenter prevented as well as dragover, or it refuses.
    if (target) e.preventDefault();
  };

  /**
   * Hit-testing happens on `.line-hit`, which never moves. The visual card
   * inside it is what slides. Putting the handlers on the moving element makes
   * the hovered line flip back and forth as it slides under the cursor.
   */
  const acceptLine = (e: React.DragEvent) => {
    if (!isLineDrag) return;
    e.preventDefault();
    onLineHover(index);
  };

  /**
   * Where to insert so the dragged line ends up at this line's index.
   * `moveLine` removes before inserting, so a downward move needs one more.
   */
  const movingIdx =
    props.drag?.kind === 'line'
      ? props.stack.lines.findIndex((l) => l.id === (props.drag as { lineId: string }).lineId)
      : -1;
  const dropIndex = movingIdx !== -1 && movingIdx < index ? index + 1 : index;

  return (
    <div
      className="line-hit"
      onDragEnter={acceptLine}
      onDragOver={acceptLine}
      onDrop={(e) => {
        if (!isLineDrag || movingIdx === index) return;
        e.preventDefault();
        onDrop({ kind: 'new-line', index: dropIndex });
        onLineHover(null);
      }}
    >
    <div
      ref={lineRoot}
      data-line-id={line.id}
      className={`line ${index % 2 === 1 ? 'line-alt' : ''} ${wired ? 'line-wired' : ''} ${
        line.bypassed ? 'line-bypassed' : ''
      } ${lifted ? 'line-lifted' : ''}`}
      style={shiftY ? { transform: `translateY(${shiftY}px)` } : undefined}
    >
      {/* A div, not a button — see the note on the tile grip. Spans the line's
          full height, so grabbing a line is a big target rather than a glyph. */}
      <div
        className="line-grip"
        draggable
        role="button"
        tabIndex={0}
        onDragStart={(e) => {
          const payload = { kind: 'line' as const, lineId: line.id };
          // Drag the whole line, not the 36px handle.
          if (lineRoot.current) {
            const r = lineRoot.current.getBoundingClientRect();
            e.dataTransfer.setDragImage(lineRoot.current, e.clientX - r.left, e.clientY - r.top);
          }
          beginDrag(e, payload);
          onDrag(payload);
        }}
        onDragEnd={() => onDrag(null)}
        title="Drag to move this line up or down"
        aria-label="Move line"
      >
        <span className="line-no">{index + 1}</span>
        <span className="grip-dots">⠿</span>
      </div>

      <div className="line-rail">
        <button
          className={`mode ${line.bypassed ? 'mode-bypass' : ''}`}
          onClick={() => onLineBypass(line.id, !line.bypassed)}
          title={line.bypassed ? 'This line is skipped. Click to run it again.' : 'Skip this whole line'}
        >
          {line.bypassed ? 'skipped' : 'bypass'}
        </button>

        {/* Mode is meaningless on a single tile — the two settings are identical
            there — so the control only appears once there is a choice to make. */}
        {line.tiles.length > 1 && (
          <div className="line-modes">
            <button
              className={`mode ${!wired ? 'mode-on' : ''}`}
              onClick={() => onLineMode(line.id, 'parallel')}
              title="Tiles run side by side and see the same inputs"
            >
              parallel
            </button>
            <button
              className={`mode ${wired ? 'mode-on' : ''}`}
              onClick={() => onLineMode(line.id, 'wired')}
              title="Each tile feeds the next, left to right"
            >
              wired
            </button>
          </div>
        )}
      </div>

      <div
        className="line-tiles"
        onDragEnter={onOver}
        onDragOver={onOver}
        onDragLeave={(e) => {
          // relatedTarget is null on drag events in Chrome, so this can only be
          // trusted when it is actually set. When it is not, leave the marker
          // alone — the next dragover corrects it, and dragend clears it.
          const to = e.relatedTarget as Node | null;
          if (to && !e.currentTarget.contains(to)) setInsertAt(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          // Recompute. Never trust insertAt here — see targetFor.
          const target = targetFor(e, e.currentTarget as HTMLElement);
          if (target) onDrop({ kind: 'in-line', lineId: line.id, position: target.position });
          setInsertAt(null);
        }}
      >
        {line.tiles.map((tile, i) => (
          <div className={`slot ${slotShift(i, selfIndex, insertAt)}`} key={tile.id}>
            <div className="slot-tile">
              <TileView
                tile={tile}
                module={library[tile.moduleId]}
                bypassed={line.bypassed}
                issues={issuesByTile[tile.id] ?? []}
                runState={run.tiles[tile.id] ?? 'idle'}
                progress={run.progress[tile.id]}
                onPatch={(patch) => onPatchTile(tile.id, patch)}
                onParam={(name, value) => onParam(tile.id, name, value)}
                onPage={(name) => props.onPage(tile.id, name)}
                onTogglePage={(name, label) => props.onTogglePage(tile.id, name, label)}
                onRemove={() => onRemoveTile(tile.id)}
                onDragStart={(e) => {
                  const payload = { kind: 'tile' as const, tileId: tile.id, moduleId: tile.moduleId };
                  beginDrag(e, payload);
                  onDrag(payload);
                }}
                onDragEnd={() => onDrag(null)}
              />
            </div>
            {wired && i < line.tiles.length - 1 && <span className="arrow">→</span>}
          </div>
        ))}
      </div>
    </div>
    </div>
  );
}

// Drop target 2 — a position within a line — is handled by LineView above.
// The whole module is the target, and the modules slide aside to show where the
// dragged one will land. No bars, no lines, nothing to aim at.

/**
 * How a slot should move while a drag hovers `hovered`.
 *
 * The dragged module is coming *from* `self`. Everything between it and the
 * hover point slides one place towards where the dragged module used to be,
 * which opens a gap exactly where it will land. Tiles on a line share width
 * evenly, so one place is 100% of a slot.
 */
function slotShift(i: number, self: number, hovered: number | null): string {
  if (self === -1 || hovered === null) return '';
  if (i === self) return 'slot-lifted';
  if (self < hovered && i > self && i <= hovered) return 'slot-shift-left';
  if (self > hovered && i >= hovered && i < self) return 'slot-shift-right';
  return '';
}
