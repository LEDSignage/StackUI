import { useMemo, useState } from 'react';
import type { Module } from '@shared/types.ts';
import { beginDrag, type DragPayload } from '../lib/drag.ts';

type Props = {
  modules: Module[];
  onDrag: (p: DragPayload | null) => void;
  onRefresh: () => void;
};

export function ModuleLibraryPanel({ modules, onDrag, onRefresh }: Props) {
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = modules.filter(
      (m) =>
        !q ||
        m.name.toLowerCase().includes(q) ||
        m.category.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        Object.values(m.nodes).some((n) => n.class_type.toLowerCase().includes(q)),
    );
    const by = new Map<string, Module[]>();
    for (const m of matched.sort((a, b) => a.name.localeCompare(b.name))) {
      const list = by.get(m.category) ?? [];
      list.push(m);
      by.set(m.category, list);
    }
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [modules, query]);

  return (
    <aside className="library">
      <div className="library-head">
        <strong>Modules</strong>
        <button className="link" onClick={onRefresh} title="Re-read modules/ from disk">
          reload
        </button>
      </div>

      <input
        className="library-search"
        placeholder="Search…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {modules.length === 0 && (
        <p className="muted small">
          Nothing in <code>modules/</code> yet. Drop JSON files there and hit reload.
        </p>
      )}

      {groups.map(([category, items]) => (
        <div key={category} className="library-group">
          <div className="library-category">{category}</div>
          {items.map((m) => (
            <div
              key={m.id}
              className="library-item"
              draggable
              onDragStart={(e) => {
                const payload = { kind: 'module' as const, moduleId: m.id };
                beginDrag(e, payload);
                onDrag(payload);
              }}
              onDragEnd={() => onDrag(null)}
              title={m.description ?? m.id}
            >
              <span className="library-name">{m.name}</span>
              <span className="library-ports">
                {m.inPorts.map((p) => p.type).join(' ') || '—'} →{' '}
                {m.outPorts.map((p) => p.type).join(' ') || '—'}
              </span>
            </div>
          ))}
        </div>
      ))}
    </aside>
  );
}
