import { useRef } from 'react';
import type { CompileIssue, Module, Tile } from '@shared/types.ts';
import { summarise } from '@shared/validate.ts';
import type { TileRunState } from '../lib/useRun.ts';
import { ParamControl } from './ParamControl.tsx';

type Props = {
  tile: Tile;
  module: Module | undefined;
  /** Whole-line state — the tile only renders it, it cannot change it. */
  bypassed: boolean;
  issues: CompileIssue[];
  runState: TileRunState;
  progress: number | undefined;
  onPatch: (patch: Partial<Tile>) => void;
  onParam: (name: string, value: unknown) => void;
  /** Is this param on the job page? Drives the "add to page" toggle. */
  onPage: (name: string) => boolean;
  onTogglePage: (name: string, label: string) => void;
  onRemove: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
};

export function TileView({
  tile,
  module,
  bypassed,
  issues,
  runState,
  progress,
  onPatch,
  onParam,
  onPage,
  onTogglePage,
  onRemove,
  onDragStart,
  onDragEnd,
}: Props) {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const name = tile.label ?? module?.name ?? tile.moduleId;

  const root = useRef<HTMLDivElement>(null);

  /**
   * Drag the whole module, not the handle. Chrome's default drag image is the
   * element the drag started on — grab the grip and you drag a 30px square,
   * which tells you nothing about what you are moving.
   */
  const startDrag = (e: React.DragEvent) => {
    const el = root.current;
    if (el) {
      const r = el.getBoundingClientRect();
      e.dataTransfer.setDragImage(el, e.clientX - r.left, e.clientY - r.top);
    }
    onDragStart(e);
  };

  const classes = [
    'tile',
    bypassed && 'is-bypassed',
    errors.length > 0 && 'has-error',
    warnings.length > 0 && errors.length === 0 && 'has-warning',
    `run-${runState}`,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} ref={root}>
      {progress !== undefined && runState === 'running' && (
        <div className="tile-progress" style={{ width: `${Math.round(progress * 100)}%` }} />
      )}

      {/* Not a <button>. Chrome will not reliably start a native drag from a
          form control — the control's own mousedown handling wins and dragstart
          never fires. This cost an afternoon; leave it as a div.

          It spans the tile's full height so there is a large, obvious thing to
          grab rather than a 15px glyph. */}
      <div
        className="grip"
        draggable
        role="button"
        tabIndex={0}
        onDragStart={startDrag}
        onDragEnd={onDragEnd}
        title="Drag to move"
        aria-label="Drag to move"
      >
        <span className="grip-dots">⠿</span>
      </div>

      <div className="tile-main">
        {/* The whole header is a drag source, not just the grip. The grip is the
            affordance; making it the only target means a 30px strip is the only
            way to move a tile, which is needlessly precise. */}
        <div
          className="tile-head"
          draggable
          onDragStart={startDrag}
          onDragEnd={onDragEnd}
        >
          <div className="tile-title" onClick={() => onPatch({ collapsed: !tile.collapsed })}>
            <span className="tile-name">{name}</span>
            {tile.collapsed && module && (
              <span className="tile-summary">{summarise(module, tile.params)}</span>
            )}
          </div>

          <span className={`run-dot run-${runState}`} title={runState} />

          <button
            className="chevron"
            onClick={() => onPatch({ collapsed: !tile.collapsed })}
            aria-label={tile.collapsed ? 'Expand' : 'Collapse'}
          >
            {tile.collapsed ? '▸' : '▾'}
          </button>
        </div>

        {(errors.length > 0 || warnings.length > 0) && (
          <ul className="tile-issues">
            {[...errors, ...warnings].map((issue, i) => (
              <li key={i} className={issue.severity}>
                {issue.message}
              </li>
            ))}
          </ul>
        )}

        {!tile.collapsed && (
          <div className="tile-body">
            {module ? (
              <>
                {module.params.length > 0 ? (
                  <div className="params">
                    {module.params.map((param) => (
                      <div className="param-wrap" key={param.name}>
                        <ParamControl
                          param={param}
                          value={tile.params[param.name]}
                          onChange={(v) => onParam(param.name, v)}
                        />
                        <button
                          className={`onpage ${onPage(param.name) ? 'onpage-on' : ''}`}
                          onClick={() => onTogglePage(param.name, param.label)}
                          title={
                            onPage(param.name)
                              ? 'Showing on the job page. Click to remove.'
                              : 'Show this on the job page'
                          }
                        >
                          {onPage(param.name) ? '✓ on page' : '+ add to page'}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted">No exposed parameters.</p>
                )}

                <div className="tile-foot">
                  <span className="muted">
                    {module.description ??
                      `${Object.keys(module.nodes).length} node${
                        Object.keys(module.nodes).length === 1 ? '' : 's'
                      } · ${[...new Set(Object.values(module.nodes).map((n) => n.class_type))].join(', ')}`}
                  </span>
                  <span className="ports">
                    {module.inPorts.map((p) => p.name).join(', ') || '—'} →{' '}
                    {module.outPorts.map((p) => p.name).join(', ') || '—'}
                  </span>
                  <button className="link danger" onClick={onRemove}>
                    remove
                  </button>
                </div>
              </>
            ) : (
              <p className="error">
                No module <code>{tile.moduleId}</code> in <code>modules/</code>.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
