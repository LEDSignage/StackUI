import { useEffect, useState } from 'react';
import { dragDebug } from '../lib/dragDebug.ts';

/**
 * A live readout of what the browser actually dispatched during a drag. Off by
 * default; the header button turns it on. See lib/dragDebug.ts for why this
 * exists rather than being debugged by reading the code.
 */
export function DragLog() {
  const [, bump] = useState(0);
  useEffect(() => dragDebug.subscribe(() => bump((n) => n + 1)), []);

  if (!dragDebug.enabled) return null;

  const entries = dragDebug.entries.slice(-14);

  return (
    <div className="draglog">
      <div className="draglog-head">
        <strong>drag events</strong>
        <button className="link" onClick={() => dragDebug.clear()}>
          clear
        </button>
        <button className="link" onClick={() => dragDebug.disable()}>
          close
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="muted small">Try a drag. Every event the browser fires shows up here.</p>
      ) : (
        <ol className="draglog-list">
          {entries.map((e, i) => (
            <li key={i}>
              <span className={`draglog-type draglog-${e.type}`}>{e.type}</span>
              <span className="muted">{e.target}</span>
              {e.note && <span className="muted">{e.note}</span>}
            </li>
          ))}
        </ol>
      )}
      <p className="muted small">
        A working drop reads: <code>dragstart</code> → <code>dragover</code> → <code>drop</code> →{' '}
        <code>dragend</code>. No <code>dragstart</code> means the handle never began a drag. No{' '}
        <code>drop</code> after <code>dragover</code> means the browser refused the drop.
      </p>
    </div>
  );
}
