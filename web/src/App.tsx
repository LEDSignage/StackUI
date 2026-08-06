import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Module, ModuleLibrary, Stack } from '@shared/types.ts';
import { compile } from '@shared/compile.ts';
import { compose } from '@shared/script.ts';
import { indexIssues, toCarry } from '@shared/validate.ts';
import { resolvePort } from '@shared/compile.ts';
import { fetchModules, fetchStack, fetchStacks, saveStack, type StackSummary } from './lib/api.ts';
import { fetchObjectInfo, fetchVram, freeMemory, type ObjectInfo, type VramStats } from './lib/comfy.ts';
import type { DragPayload } from './lib/drag.ts';
import { useRun } from './lib/useRun.ts';
import * as ops from './lib/stackOps.ts';
import { UNTITLED } from './lib/stackOps.ts';
import { StackView, type DropTarget } from './components/StackView.tsx';
import { ModuleLibraryPanel } from './components/ModuleLibraryPanel.tsx';
import { OutputPanel } from './components/OutputPanel.tsx';
import { DragLog } from './components/DragLog.tsx';
import { UseScreen } from './components/UseScreen.tsx';
import { dragDebug } from './lib/dragDebug.ts';

type Mode = 'simple' | 'stack';

const LAST_STACK = 'stack-ui:last';

export default function App() {
  const [modules, setModules] = useState<Module[]>([]);
  const [objectInfo, setObjectInfo] = useState<ObjectInfo | null>(null);
  const [connection, setConnection] = useState<{ state: 'connecting' | 'up' | 'down'; detail: string }>({
    state: 'connecting',
    detail: '',
  });
  const [stack, setStack] = useState<Stack>(() => ops.emptyStack());
  const [stacks, setStacks] = useState<StackSummary[]>([]);
  const [drag, setDrag] = useState<DragPayload | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [mode, setMode] = useState<Mode>('stack');

  const { run, wsOpen, elapsed, start, interrupt } = useRun();

  /** Clear the card before queueing. See freeMemory for why this matters. */
  const [clearFirst, setClearFirst] = useState(true);
  const [vram, setVram] = useState<VramStats | null>(null);

  useEffect(() => {
    const read = () => void fetchVram().then(setVram);
    read();
    const t = setInterval(read, 5000);
    return () => clearInterval(t);
  }, []);

  // ── Load ──────────────────────────────────────────────────────────────────

  const loadModules = useCallback(async () => {
    setModules(await fetchModules().catch(() => []));
  }, []);

  const connect = useCallback(async () => {
    setConnection({ state: 'connecting', detail: '' });
    try {
      const info = await fetchObjectInfo();
      setObjectInfo(info);
      setConnection({ state: 'up', detail: `${Object.keys(info).length} node classes` });
    } catch (err) {
      setObjectInfo(null);
      setConnection({ state: 'down', detail: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    void loadModules();
    void connect();
    void fetchStacks().then(setStacks).catch(() => {});
    const last = localStorage.getItem(LAST_STACK);
    if (last) void fetchStack(last).then(setStack).catch(() => {});
  }, [loadModules, connect]);

  /**
   * Fill in enum options from /object_info. A module says which node input the
   * options live on; the actual list depends on what is installed on the box,
   * so it cannot be baked into the module file.
   */
  const library: ModuleLibrary = useMemo(() => {
    const out: ModuleLibrary = {};
    for (const m of modules) {
      out[m.id] = objectInfo ? { ...m, params: m.params.map((p) => withOptions(p, objectInfo)) } : m;
    }
    return out;
  }, [modules, objectInfo]);

  // ── Compile, on every edit ────────────────────────────────────────────────

  /**
   * Follow the stack: one with controls is meant to be used, one without is
   * meant to be built. Defaulting to Use unconditionally showed an empty screen
   * whenever the open stack had no controls, which reads as "nothing is there".
   * Keyed on the id, so switching mode by hand is not undone on every edit.
   */
  useEffect(() => {
    setMode(stack.lines.length > 0 ? 'simple' : 'stack');
  }, [stack.id, stack.lines.length > 0]);

  // ── Frame rate conversion ─────────────────────────────────────────────────

  const [convertStatus, setConvertStatus] = useState<'idle' | 'working' | 'done' | 'failed'>('idle');
  const [convertedUrl, setConvertedUrl] = useState<string | null>(null);
  const convertFps = stack.output?.convertFps ?? 0;

  /**
   * Re-time the finished clip when the toggle is on.
   *
   * Runs after the fact rather than in the graph, because the models generate at
   * their own fixed rates and no integer frame multiplier gets 24 to 30. The
   * server does the ffmpeg pass; see /api/convert-fps.
   */
  useEffect(() => {
    const file = run.files[run.files.length - 1];
    if (run.status !== 'done' || !file || !convertFps) {
      setConvertStatus('idle');
      setConvertedUrl(null);
      return;
    }
    if (!/\.(mp4|webm|mov|mkv)$/i.test(file.filename)) return;

    let cancelled = false;
    setConvertStatus('working');
    setConvertedUrl(null);

    void fetch('/api/convert-fps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.filename,
        subfolder: file.subfolder ?? '',
        type: file.type ?? 'output',
        fps: convertFps,
      }),
    })
      .then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(new Error(e.error)))))
      .then((body: { url: string }) => {
        if (cancelled) return;
        setConvertedUrl(body.url);
        setConvertStatus('done');
      })
      .catch(() => {
        if (!cancelled) setConvertStatus('failed');
      });

    return () => {
      cancelled = true;
    };
  }, [run.status, run.files, convertFps]);

  // ── Job / model selectors ─────────────────────────────────────────────────

  const jobs = useMemo(() => [...new Set(stacks.map((s) => s.job))].sort(), [stacks]);
  const currentJob = useMemo(
    () => stacks.find((s) => s.id === stack.id)?.job ?? stack.job ?? stack.name,
    [stacks, stack],
  );
  const modelsForJob = useMemo(
    () => stacks.filter((s) => s.job === currentJob),
    [stacks, currentJob],
  );

  const result = useMemo(() => compile(stack, library), [stack, library]);
  const issues = useMemo(() => indexIssues(result), [result]);
  const errorCount = result.issues.filter((i) => i.severity === 'error').length;

  // ── Persist ───────────────────────────────────────────────────────────────

  const saveTimer = useRef<number>(0);
  useEffect(() => {
    if (stack.lines.length === 0) return;
    // Don't litter stacks/ with "Untitled stack" files. A stack becomes a saved
    // job once it has a name; before that it is scratch work.
    if (stack.name === UNTITLED) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void saveStack(stack)
        .then(() => localStorage.setItem(LAST_STACK, stack.id))
        .catch(() => {});
    }, 600);
    return () => clearTimeout(saveTimer.current);
  }, [stack]);

  // ── Drop validity ─────────────────────────────────────────────────────────

  const validity = useCallback(
    (target: DropTarget, module: Module) => {
      const entries =
        target.kind === 'new-line'
          ? target.index >= stack.lines.length
            ? result.finalCarry
            : (result.carryAtLine[stack.lines[target.index]!.id] ?? [])
          : (result.carryAtLine[target.lineId] ?? []);

      const carry = toCarry(entries);
      // Optional ports never block a drop — see checkPorts in shared/validate.
      const missing = module.inPorts
        .filter((p) => !p.optional && resolvePort(carry, p.name, module) === null)
        .map((p) => p.name);
      return { ok: missing.length === 0, missing };
    },
    [stack, result],
  );

  const onDrop = useCallback(
    (target: DropTarget) => {
      if (!drag) return;
      setStack((prev) => {
        if (drag.kind === 'line') {
          // Lines only reorder — dropping one onto another line is meaningless.
          return target.kind === 'new-line' ? ops.moveLine(prev, drag.lineId, target.index) : prev;
        }
        if (drag.kind === 'module') {
          const module = library[drag.moduleId];
          if (!module) return prev;
          const tile = ops.newTile(module);
          return target.kind === 'new-line'
            ? ops.insertLine(prev, target.index, tile)
            : ops.insertIntoLine(prev, target.lineId, target.position, tile);
        }
        return target.kind === 'new-line'
          ? ops.moveToNewLine(prev, drag.tileId, target.index)
          : ops.moveToLine(prev, drag.tileId, target.lineId, target.position);
      });
      setDrag(null);
    },
    [drag, library],
  );

  // ── Queue ─────────────────────────────────────────────────────────────────

  const onQueue = useCallback(() => {
    if (!result.ok) return;
    void (async () => {
      // Unload first, so a big model is not loading into a card that is already
      // full — that spills into system RAM and the run stalls silently.
      if (clearFirst) await freeMemory().catch(() => {});
      await start(result.prompt, result.tileMap).catch(() => {
        /* useRun already put it on the tiles */
      });
    })();
  }, [result, start, clearFirst]);

  const activeTileName = useMemo(() => {
    const tileId = Object.entries(run.tiles).find(([, s]) => s === 'running')?.[0];
    if (!tileId) return null;
    const tile = ops.findTile(stack, tileId);
    return tile ? (tile.label ?? library[tile.moduleId]?.name ?? tile.moduleId) : null;
  }, [run.tiles, stack, library]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="app" onDragEnd={() => setDrag(null)}>
      <header className="header">
        <input
          className="stack-name"
          value={stack.name}
          onChange={(e) => setStack((s) => ({ ...s, name: e.target.value }))}
        />

        {/* Job, then model. Several stacks can do the same job with different
            models, and switching model means loading that stack. */}
        <select
          className="stack-picker"
          value={currentJob}
          onChange={(e) => {
            const job = e.target.value;
            if (job === '__new') return setStack(ops.emptyStack());
            const first = stacks.find((s) => s.job === job);
            if (first) void fetchStack(first.id).then(setStack);
          }}
          title="What do you want to make?"
        >
          {jobs.map((j) => (
            <option key={j} value={j}>
              {j}
            </option>
          ))}
          <option value="__new">＋ New pipeline</option>
        </select>

        <select
          className="stack-picker"
          value={stack.id}
          disabled={modelsForJob.length < 2}
          onChange={(e) => {
            // Switching model within a job should feel like flipping a switch,
            // not opening a different document — carry the settings across.
            void fetchStack(e.target.value).then((next) =>
              setStack((current) => {
                const carried = ops.carryControls(current, next);
                // Keep the composed prompt in step with the carried script.
                return carried.script
                  ? ops.setParam(
                      carried,
                      carried.script.target.tileId,
                      carried.script.target.param,
                      compose(carried.script),
                    )
                  : carried;
              }),
            );
          }}
          title={
            modelsForJob.length < 2
              ? 'Only one model available for this job'
              : 'Which model should do the work?'
          }
        >
          {modelsForJob.length === 0 && <option value={stack.id}>{stack.model ?? '—'}</option>}
          {modelsForJob.map((s) => (
            <option key={s.id} value={s.id}>
              {s.model ?? s.name}
            </option>
          ))}
        </select>

        <div className="modeswitch">
          <button
            className={`mode ${mode === 'simple' ? 'mode-on' : ''}`}
            onClick={() => setMode('simple')}
            title="Just the controls that matter, and the result"
          >
            Use
          </button>
          <button
            className={`mode ${mode === 'stack' ? 'mode-on' : ''}`}
            onClick={() => setMode('stack')}
            title="Build and edit the pipeline"
          >
            Build
          </button>
        </div>

        <span className="spacer" />

        <button
          className={`status status-${connection.state}`}
          onClick={() => void connect()}
          title={connection.detail || 'Click to retry'}
        >
          <span className="status-dot" />
          {connection.state === 'up'
            ? `ComfyUI · ${connection.detail}`
            : connection.state === 'connecting'
              ? 'Connecting…'
              : 'ComfyUI unreachable'}
        </button>
        <span className={`ws ${wsOpen ? 'ws-on' : ''}`} title={wsOpen ? 'Live' : 'No websocket'}>
          ws
        </span>
        <button
          className="ghost small"
          onClick={() => dragDebug.toggle()}
          title="Show what the browser actually fires during a drag"
        >
          drag log
        </button>
      </header>

      {mode === 'simple' ? (
        <div className="main">
          <UseScreen
            stack={stack}
            library={library}
            run={run}
            elapsed={elapsed}
            canQueue={result.ok && Object.keys(result.prompt).length > 0}
            issues={result.issues}
            onParam={(id, name, value) => setStack((s) => ops.setParam(s, id, name, value))}
            onQueue={onQueue}
            onInterrupt={() => void interrupt()}
            clearFirst={clearFirst}
            onClearFirst={setClearFirst}
            vram={vram}
            onBuild={() => setMode('stack')}
            activeTileName={activeTileName}
            /* Only offered where the model cannot reach the rate you want on
               its own. LTX takes any frame_rate, so its page has no `output`
               block and no toggle; H3 is locked to 24fps, so its page does. */
            convert={
              stack.output
                ? {
                    enabled: convertFps > 0,
                    fps: convertFps || 30,
                    status: convertStatus,
                    url: convertedUrl,
                  }
                : undefined
            }
            onAddInput={stack.inputs ? (kind) => setStack((st) => ops.addInput(st, kind)) : undefined}
            onScript={
              stack.script
                ? (script) =>
                    // Editing the script rewrites the prompt param it targets,
                    // so the compiled graph always carries the assembled text.
                    setStack((st) => {
                      const withScript = { ...st, script };
                      return ops.setParam(
                        withScript,
                        script.target.tileId,
                        script.target.param,
                        compose(script),
                      );
                    })
                : undefined
            }
            onRemoveInput={stack.inputs ? (g) => setStack((st) => ops.removeInput(st, g)) : undefined}
            onConvertFps={
              stack.output
                ? (on) =>
                    setStack((s) => ({ ...s, output: { ...s.output, convertFps: on ? 30 : 0 } }))
                : undefined
            }
          />
        </div>
      ) : (
      <div className="main">
        <ModuleLibraryPanel
          modules={modules}
          onDrag={setDrag}
          onRefresh={() => {
            void loadModules();
            void connect();
          }}
        />

        <div className="canvas">
          <StackView
            stack={stack}
            library={library}
            issuesByTile={issues.byTile}
            run={run}
            drag={drag}
            validity={validity}
            onDrag={setDrag}
            onDrop={onDrop}
            onPatchTile={(id, patch) => setStack((s) => ops.updateTile(s, id, patch))}
            onParam={(id, name, value) => setStack((s) => ops.setParam(s, id, name, value))}
            onRemoveTile={(id) => setStack((s) => ops.removeTile(s, id))}
            onLineMode={(id, m) => setStack((s) => ops.setLineMode(s, id, m))}
            onLineBypass={(id, bypassed) => setStack((s) => ops.setLineBypass(s, id, bypassed))}
            onPage={(tileId, param) => ops.isOnPage(stack, tileId, param)}
            onTogglePage={(tileId, param, label) =>
              setStack((s) => ops.toggleControl(s, tileId, param, label))
            }
          />
        </div>
      </div>
      )}

      {mode === 'stack' && (
        <OutputPanel
          run={run}
          elapsed={elapsed}
          canQueue={result.ok && Object.keys(result.prompt).length > 0}
          stackIssues={issues.stack}
          errorCount={errorCount}
          onQueue={onQueue}
          onInterrupt={() => void interrupt()}
          onShowJson={() => setShowJson(true)}
          activeTileName={activeTileName}
        />
      )}

      <DragLog />

      {showJson && (
        <div className="modal" onClick={() => setShowJson(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <strong>API-format prompt</strong>
              <button
                className="ghost"
                onClick={() => void navigator.clipboard.writeText(JSON.stringify(result.prompt, null, 2))}
              >
                Copy
              </button>
              <button className="ghost" onClick={() => setShowJson(false)}>
                Close
              </button>
            </div>
            <pre className="modal-json">{JSON.stringify(result.prompt, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Pull a param's dropdown options off /object_info when the module asks for it.
 *
 * Two declaration forms, both live here:
 *   ["euler", "heun", …]              — the old bare list
 *   ["COMBO", { options: [...] }]     — the newer named COMBO
 * Keeps whatever the module file baked in if neither is present.
 */
function withOptions(param: Module['params'][number], info: ObjectInfo) {
  if (!param.optionsFrom) return param;
  const node = info[param.optionsFrom.class_type];
  const spec =
    node?.input?.required?.[param.optionsFrom.input] ?? node?.input?.optional?.[param.optionsFrom.input];
  if (!spec) return param;

  const raw = Array.isArray(spec[0]) ? spec[0] : (spec[1] as { options?: unknown } | undefined)?.options;
  if (!Array.isArray(raw)) return param;

  // A dynamic combo lists { key, inputs } objects rather than strings.
  const options = raw
    .map((o) => (o && typeof o === 'object' && 'key' in o ? (o as { key: unknown }).key : o))
    .filter((o): o is string => typeof o === 'string');

  return options.length ? { ...param, options } : param;
}
