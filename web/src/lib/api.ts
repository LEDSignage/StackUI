/** The Stack UI server's own API — modules and stacks on disk. Spec §8. */

import type { Module, Stack } from '@shared/types.ts';
import { migrate } from '@shared/migrate.ts';

export async function fetchModules(): Promise<Module[]> {
  return json<Module[]>('/api/modules');
}

export type StackSummary = {
  id: string;
  name: string;
  lines: number;
  /** What the pipeline is for. Falls back to its name. */
  job: string;
  /** Which model it uses, if it says. */
  model: string | null;
};

export async function fetchStacks(): Promise<StackSummary[]> {
  return json<StackSummary[]>('/api/stacks');
}

export async function fetchStack(id: string): Promise<Stack> {
  // Migrate on load, so a stack written by an older version keeps opening.
  return migrate(await json<unknown>(`/api/stacks/${id}`));
}

export async function saveStack(stack: Stack): Promise<void> {
  const res = await fetch(`/api/stacks/${stack.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(stack),
  });
  if (!res.ok) throw new Error(`Save failed: ${res.status}`);
}

export async function deleteStack(id: string): Promise<void> {
  await fetch(`/api/stacks/${id}`, { method: 'DELETE' });
}

// ── Media ───────────────────────────────────────────────────────────────────

export type MediaFile = {
  filename: string;
  subfolder: string;
  type: 'output';
  kind: 'image' | 'video';
  /** Bytes. */
  size: number;
  /** Epoch milliseconds. */
  modified: number;
};

/** Everything ComfyUI has made, newest first. */
export async function fetchMedia(): Promise<{ writable: boolean; files: MediaFile[] }> {
  return json('/api/media');
}

export async function deleteMedia(file: MediaFile): Promise<void> {
  const res = await fetch('/api/media', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.filename, subfolder: file.subfolder }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Delete failed: ${res.status}`);
  }
}

async function json<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}
