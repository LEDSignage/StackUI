import { useRef } from 'react';
import type {
  CompileIssue,
  Module,
  ModuleLibrary,
  Param,
  Stack,
  StackControl,
  InputKind,
  Script,
} from '@shared/types.ts';
import { isVideo, viewUrl } from '../lib/comfy.ts';
import type { RunState } from '../lib/useRun.ts';
import { ParamControl } from './ParamControl.tsx';
import { InputBar } from './InputBar.tsx';
import { ScriptEditor } from './ScriptEditor.tsx';
import { MediaBrowser } from './MediaBrowser.tsx';
import { useSplit } from '../lib/useSplit.ts';

type Props = {
  stack: Stack;
  library: ModuleLibrary;
  run: RunState;
  elapsed: number;
  canQueue: boolean;
  issues: CompileIssue[];
  onParam: (tileId: string, name: string, value: unknown) => void;
  onQueue: () => void;
  onInterrupt: () => void;
  onBuild: () => void;
  activeTileName: string | null;
  /** Present when this job can re-time its output; absent hides the toggle. */
  convert?: {
    enabled: boolean;
    fps: number;
    status: 'idle' | 'working' | 'done' | 'failed';
    /** The re-timed file, once there is one. */
    url: string | null;
  };
  onConvertFps?: (enabled: boolean) => void;
  /** Present when the pipeline declares a repeatable input. */
  onAddInput?: (kind: InputKind) => void;
  onRemoveInput?: (group: string) => void;
  onScript?: (script: Script) => void;
  /** Clear the card before queueing. */
  clearFirst?: boolean;
  onClearFirst?: (on: boolean) => void;
  vram?: { total: number; free: number } | null;
  /** Which half of the right pane is showing. */
  pane: RightPane;
  onPane: (pane: RightPane) => void;
};

export type RightPane = 'result' | 'library';

/**
 * A job page: the controls this pipeline chose to expose, and the result.
 *
 * It shows exactly what the stack declares in `controls`, in that order, and
 * nothing else. An earlier version tried to be one adaptive screen covering
 * every job, greying out panels a given pipeline had no use for — which meant
 * most of the screen was dead weight telling you what you *couldn't* do. A page
 * per job with only its own controls is the better trade.
 *
 * Build mode is where the controls get chosen; see the "add to page" toggles on
 * the tile parameters.
 */
export function UseScreen({
  stack,
  library,
  run,
  elapsed,
  canQueue,
  issues,
  onParam,
  onQueue,
  onInterrupt,
  onBuild,
  activeTileName,
  convert,
  onConvertFps,
  onAddInput,
  onRemoveInput,
  onScript,
  clearFirst,
  onClearFirst,
  vram,
  pane,
  onPane,
}: Props) {
  const busy = run.status === 'queued' || run.status === 'running';

  const inner = useRef<HTMLDivElement>(null);
  const split = useSplit(inner);

  /** Write a control's value, plus any params it keeps in step with. */
  const write = (control: StackControl, value: unknown) => {
    onParam(control.tileId, control.param, value);
    for (const m of control.also ?? []) onParam(m.tileId, m.param, value);
  };
  const errors = issues.filter((i) => i.severity === 'error');
  const file = run.files[run.files.length - 1];
  const progress = overall(run);

  // Show the re-timed file when there is one, otherwise the original.
  const shownUrl = !file ? null : (convert?.status === 'done' && convert.url) || viewUrl(file);

  /**
   * Whether the shot list is deciding the clip length.
   *
   * Having a script is not enough — it has to have shots in it. Keying off the
   * script alone turned the Seconds box into a readout on a page with an empty
   * shot list, so there was no way to say how long the clip should be at all.
   */
  const shotsDriveLength = (stack.script?.shots.length ?? 0) > 0;

  const scriptTarget = stack.script?.target;
  const fields = (stack.controls ?? [])
    .filter((c) => !(scriptTarget && c.tileId === scriptTarget.tileId && c.param === scriptTarget.param))
    .map((c) => {
      const tile = stack.lines.flatMap((l) => l.tiles).find((t) => t.id === c.tileId);
      const module: Module | undefined = tile ? library[tile.moduleId] : undefined;
      const param = module?.params.find((p) => p.name === c.param);
      return tile && param ? { control: c, tile, param } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return (
    <div className="use">
      <div
        className={`use-inner ${split.dragging ? 'is-dragging' : ''}`}
        ref={inner}
        /* A width set by dragging overrides the default proportion; before
           that the columns stay fluid, so a narrow window is not held to a
           split chosen on a wide one. */
        style={
          split.width === null
            ? undefined
            : /* Three tracks: settings, handle, result — the handle is a grid
                 child, so a two-track template would push the result out. */
              { gridTemplateColumns: `${split.width}px 0 minmax(0, 1fr)` }
        }
      >
      <div className="use-controls">
        {stack.inputs && onAddInput && onRemoveInput && (
          <InputBar
            spec={stack.inputs}
            stack={stack}
            library={library}
            onParam={onParam}
            onAdd={onAddInput}
            onRemove={onRemoveInput}
          />
        )}
        {stack.script && onScript && (
          <ScriptEditor
            script={stack.script}
            clipSeconds={clipSeconds(stack, library)}
            onChange={onScript}
          />
        )}
        {fields.length === 0 && !stack.script ? (
          <div className="panel">
            <div className="panel-label">No controls yet</div>
            <p className="muted small">
              This pipeline hasn’t chosen anything to put on its page. Open <strong>Build</strong>,
              expand a tile, and press <em>add to page</em> next to any setting you want here.
            </p>
            <button className="ghost" onClick={onBuild}>
              Open Build
            </button>
          </div>
        ) : (
          groupBy(fields).map(([group, items]) => (
            <section className="use-group" key={group}>
              <h3 className="use-group-title">{group}</h3>
              <div className="use-group-body">
                {items.map(({ control, tile, param }) => (
                  <div
                    /* A derived value carries its "from your shots" note on the
                       same line, so it needs the room a number box does not. */
                    className={`panel panel-${
                      control.seconds && shotsDriveLength ? 'medium' : sizeOf(param)
                    }`}
                    key={`${control.tileId}.${control.param}`}
                    /* Hints are tooltips, not a line of text under every
                       control. Four visible hints cost four lines and pushed
                       the page past one screen. */
                    title={control.hint ?? ''}
                  >
                    <div className="panel-label">
                      {control.label}
                      {control.hint && <span className="panel-why">?</span>}
                    </div>
                    {control.seconds && shotsDriveLength ? (
                      /* Derived, not typed. The shot list already says how long
                         the video is; a second box saying something different
                         is how a five second shot list ended up inside a ten
                         second clip with the model left to fill the gap. */
                      <DerivedSeconds
                        frames={Number(tile.params[param.name] ?? param.default ?? 0)}
                        spec={control.seconds}
                        fps={resolveFps(control.seconds.fps, stack, library)}
                      />
                    ) : control.seconds ? (
                      <SecondsControl
                        spec={control.seconds}
                        frames={Number(tile.params[param.name] ?? param.default ?? 0)}
                        fps={resolveFps(control.seconds.fps, stack, library)}
                        onChange={(f) => write(control, f)}
                      />
                    ) : (
                      <ParamControl
                        param={{ ...param, label: '' }}
                        value={tile.params[param.name]}
                        onChange={(v) => write(control, v)}
                      />
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))
        )}

        {errors.length > 0 && (
          <ul className="use-errors">
            {errors.map((e, i) => (
              <li key={i} className="error">
                {e.message}
              </li>
            ))}
          </ul>
        )}

        <div className="use-actions">
          <button className="primary big" disabled={!canQueue || busy} onClick={onQueue}>
            {busy ? 'Working…' : 'Generate'}
          </button>

          {/* Only while running. A greyed-out Stop sitting there permanently
              reads as "this job is still going" — which is exactly the wrong
              signal, and worse than not showing the control at all. */}
          {busy && (
            <button className="stop big" onClick={onInterrupt}>
              ■ Stop
            </button>
          )}

          {run.startedAt && <span className="muted mono">{elapsed.toFixed(0)}s</span>}

          <span className="spacer" />

          {onClearFirst && (
            <label
              className="fps-toggle"
              title="Unloads every model and clears the card before starting. Costs a reload, but stops a big model spilling into system RAM and crawling."
            >
              <input
                type="checkbox"
                checked={Boolean(clearFirst)}
                onChange={(e) => onClearFirst(e.target.checked)}
              />
              Clear GPU first
            </label>
          )}

          {vram && (
            <span
              className={`vram ${vram.free / vram.total < 0.15 ? 'vram-low' : ''}`}
              title="Free VRAM on the card"
            >
              {(vram.free / 1073741824).toFixed(1)} / {(vram.total / 1073741824).toFixed(0)} GB free
            </span>
          )}
        </div>

        {busy && (
          <div className="use-progress">
            <div className="use-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
            <span className="use-progress-label">{activeTileName ?? 'starting…'}</span>
          </div>
        )}

        {run.status === 'error' && <p className="error">{run.message}</p>}
      </div>

      {/* Drag to set the split; double-click to put it back. */}
      <div
        className="split-handle"
        onPointerDown={split.onPointerDown}
        onDoubleClick={split.reset}
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize — double-click to reset"
      >
        <span className="split-grip" />
      </div>

      {/* The right half of the screen. It holds the last result, and doubles as
          the output library — the same pane, two tabs, so finding an older clip
          does not mean covering the settings you are working on. */}
      <div className="use-result">
        <div className="use-result-head">
          <div className="modeswitch">
            <button
              className={`mode ${pane === 'result' ? 'mode-on' : ''}`}
              onClick={() => onPane('result')}
            >
              Result
            </button>
            <button
              className={`mode ${pane === 'library' ? 'mode-on' : ''}`}
              onClick={() => onPane('library')}
            >
              Library
            </button>
          </div>
          {pane === 'result' && onConvertFps && (
            <label className="fps-toggle" title="Re-times the finished clip with motion-compensated interpolation. The added frames are invented, so fast motion can smear.">
              <input
                type="checkbox"
                checked={Boolean(convert?.enabled)}
                onChange={(e) => onConvertFps(e.target.checked)}
              />
              Convert to {convert?.fps ?? 30}fps
              {convert?.status === 'working' && <span className="muted small"> — converting…</span>}
              {convert?.status === 'failed' && <span className="error small"> — failed</span>}
              {convert?.status === 'done' && <span className="ok small"> — showing {convert.fps}fps</span>}
            </label>
          )}
        </div>
        {pane === 'library' ? (
          <MediaBrowser refreshKey={run.files.length} />
        ) : (
          <>
            <div className="use-output">
              {shownUrl ? (
                isVideo(file!) ? (
                  <video src={shownUrl} controls loop autoPlay className="use-media" />
                ) : (
                  <img src={shownUrl} alt="" className="use-media" />
                )
              ) : (
                <span className="muted">{busy ? 'Generating…' : 'Nothing yet'}</span>
              )}
            </div>
            {file && (
              <div className="use-output-bar">
                <span className="muted mono small">{file.filename}</span>
                <a className="ghost" href={shownUrl ?? viewUrl(file)} download={file.filename}>
                  Download
                </a>
              </div>
            )}
          </>
        )}
      </div>
      </div>
    </div>
  );
}

/** The clip length in seconds, so the shot list can be checked against it. */
function clipSeconds(stack: Stack, library: ModuleLibrary): number {
  const c = stack.controls?.find((x) => x.seconds);
  if (!c?.seconds) return 0;
  const tile = stack.lines.flatMap((l) => l.tiles).find((t) => t.id === c.tileId);
  const fallback = library[tile?.moduleId ?? '']?.params.find((p) => p.name === c.param)?.default;
  const frames = Number(tile?.params[c.param] ?? fallback ?? 0);
  const fps = resolveFps(c.seconds.fps, stack, library);
  return Math.round((frames - c.seconds.offset) / fps);
}

// ── Seconds ─────────────────────────────────────────────────────────────────

type SecondsSpec = NonNullable<StackControl['seconds']>;

/** The rate to divide by: a fixed number, or whatever another control holds. */
function resolveFps(fps: SecondsSpec['fps'], stack: Stack, library: ModuleLibrary): number {
  if (typeof fps === 'number') return fps || 1;
  const tile = stack.lines.flatMap((l) => l.tiles).find((t) => t.id === fps.tileId);
  const fallback = library[tile?.moduleId ?? '']?.params.find((p) => p.name === fps.param)?.default;
  return Number(tile?.params[fps.param] ?? fallback ?? 1) || 1;
}

/** Snap to the model's legal frame grid: step × n + offset. */
const snap = (frames: number, { step, offset }: SecondsSpec) =>
  Math.max(offset, Math.round((frames - offset) / step) * step + offset);

/**
 * Asks for seconds, stores frames. Frames are never shown.
 *
 * Each model only accepts frame counts on its own grid, so the stored value is
 * snapped — which can make the real duration a few hundredths of a second off
 * what was typed. That is not worth mentioning on screen; showing the frame
 * count and the grid arithmetic just made the control confusing.
 */
/**
 * The clip length, read off the shot list rather than typed.
 *
 * Shows the real figure, not the rounded one. The frame grid means the clip is
 * usually a fraction longer than the shots — 5s of shots at 24fps on H3's 17n+5
 * grid is 5.04s — and pretending otherwise would have the readout disagree with
 * the file you get back.
 */
function DerivedSeconds({ frames, spec, fps }: { frames: number; spec: SecondsSpec; fps: number }) {
  const seconds = (frames - spec.offset) / fps;
  const shown = Math.round(seconds * 100) / 100;
  return (
    <div className="derived" title="Set by the shot list. Add or extend a shot to make the clip longer.">
      <span className="derived-value">{shown}s</span>
      <span className="muted small">from your shots</span>
    </div>
  );
}

function SecondsControl({
  spec,
  frames,
  fps,
  onChange,
}: {
  spec: SecondsSpec;
  frames: number;
  fps: number;
  onChange: (frames: number) => void;
}) {
  const seconds = (frames - spec.offset) / fps;

  return (
    // Whole seconds only. Nobody asks for 5.1 seconds of video, and the frame
    // grid means the stored length is approximate anyway — showing the decimal
    // just exposed arithmetic nobody wanted to see.
    <input
      type="number"
      className="param-input"
      min={1}
      step={1}
      value={Math.max(1, Math.round(seconds))}
      onChange={(e) => {
        const secs = parseInt(e.target.value, 10);
        if (!Number.isFinite(secs) || secs < 1) return;
        onChange(snap(secs * fps + spec.offset, spec));
      }}
    />
  );
}

/**
 * How much room a control deserves.
 *   full   — a prompt, which is the thing you spend most time in
 *   medium — an image drop zone; two sit side by side, since start and end
 *            frames are a pair and belong next to each other
 *   small  — a width or a frame rate. A number does not need a page-wide box.
 */
function sizeOf(p: Param): 'full' | 'medium' | 'small' {
  if (p.type === 'STRING' && p.multiline) return 'full';
  if (p.type === 'IMAGE_UPLOAD') return 'medium';
  if (p.type === 'INT' || p.type === 'FLOAT') return 'small';
  return 'medium';
}

type Field = { control: { label: string; group?: string }; tile: unknown; param: Param };

/**
 * Group the controls under their section headings, in the order the sections
 * first appear. Anything ungrouped collects in a trailing "Settings" — which is
 * where the page builder's "add to page" button drops things until they are
 * given a home.
 */
function groupBy<T extends Field>(fields: T[]): [string, T[]][] {
  const order: string[] = [];
  const bins = new Map<string, T[]>();
  for (const f of fields) {
    const g = f.control.group ?? 'Settings';
    if (!bins.has(g)) {
      bins.set(g, []);
      order.push(g);
    }
    bins.get(g)!.push(f);
  }
  return order.map((g) => [g, bins.get(g)!]);
}

function overall(run: RunState): number {
  const states = Object.values(run.tiles);
  if (!states.length) return 0;
  const done = states.filter((s) => s === 'done' || s === 'cached').length;
  const running = Object.entries(run.tiles).find(([, s]) => s === 'running')?.[0];
  return Math.min(1, (done + (running ? (run.progress[running] ?? 0) : 0)) / states.length);
}
