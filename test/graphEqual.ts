/**
 * Structural comparison of two API-format prompts.
 *
 * Node ids are arbitrary — ours are allocated in stack order, ComfyUI's come
 * from whatever order you dropped nodes on the canvas. So a byte diff is
 * useless and a graph comparison is what actually answers "did I compile the
 * same thing".
 *
 * Each node gets a canonical signature: its class_type plus its inputs, with
 * every link replaced by the recursive signature of what it points at. Two
 * graphs match when their signature multisets match.
 */

import type { ApiPrompt } from '../shared/types.ts';

export function signature(prompt: ApiPrompt, nodeId: string, seen = new Set<string>()): string {
  if (seen.has(nodeId)) return `<cycle:${nodeId}>`;
  const node = prompt[nodeId];
  if (!node) return `<missing:${nodeId}>`;

  const next = new Set(seen).add(nodeId);
  const inputs = Object.keys(node.inputs)
    .sort()
    .map((key) => {
      const value = node.inputs[key];
      if (isLink(value)) return `${key}=→(${signature(prompt, String(value[0]), next)}#${value[1]})`;
      return `${key}=${JSON.stringify(normalise(value))}`;
    });

  return `${node.class_type}(${inputs.join(',')})`;
}

export function signatures(prompt: ApiPrompt): string[] {
  return Object.keys(prompt)
    .map((id) => signature(prompt, id))
    .sort();
}

export function graphDiff(a: ApiPrompt, b: ApiPrompt): { onlyInA: string[]; onlyInB: string[] } {
  const sa = signatures(a);
  const sb = signatures(b);
  const remaining = [...sb];
  const onlyInA: string[] = [];
  for (const sig of sa) {
    const i = remaining.indexOf(sig);
    if (i === -1) onlyInA.push(sig);
    else remaining.splice(i, 1);
  }
  return { onlyInA, onlyInB: remaining };
}

function isLink(v: unknown): v is [string | number, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[1] === 'number' &&
    (typeof v[0] === 'string' || typeof v[0] === 'number');
}

/** 3 and 3.0 are the same number to ComfyUI; so are "3" and 3 for a widget. */
function normalise(v: unknown): unknown {
  if (typeof v === 'number') return Number(v.toFixed(6));
  return v;
}
