/**
 * The ComfyUI client. Spec §3.
 *
 * Everything goes through our own server at /comfy/* — see server/index.ts for
 * why. The endpoint names below are ComfyUI's, unprefixed.
 */

import type { ApiPrompt } from '@shared/types.ts';
import { uuid } from './uid.ts';

const BASE = '/comfy';

export const clientId = uuid();

// ── /object_info ────────────────────────────────────────────────────────────

/**
 * One node class as ComfyUI describes it. Input specs are tuples whose first
 * element is either a type name (string) or a list of enum options (array).
 */
export type InputSpec = [string | string[], Record<string, unknown>?];

export type NodeInfo = {
  input: { required?: Record<string, InputSpec>; optional?: Record<string, InputSpec> };
  output: string[];
  output_name?: string[];
  display_name?: string;
  category?: string;
  description?: string;
};

export type ObjectInfo = Record<string, NodeInfo>;

/** Uppercase string type = a connection. Everything else is a widget. */
export function isConnection(spec: InputSpec): boolean {
  const t = spec[0];
  if (Array.isArray(t)) return false; // enum list → dropdown
  return !['INT', 'FLOAT', 'STRING', 'BOOLEAN'].includes(t);
}

export async function fetchObjectInfo(): Promise<ObjectInfo> {
  return getJson<ObjectInfo>('/object_info');
}

export async function fetchSystemStats(): Promise<unknown> {
  return getJson('/system_stats');
}

// ── /prompt ─────────────────────────────────────────────────────────────────

export type QueueResponse = {
  prompt_id: string;
  number: number;
  node_errors: Record<string, unknown>;
};

export async function queuePrompt(prompt: ApiPrompt): Promise<QueueResponse> {
  const res = await fetch(`${BASE}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: clientId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // ComfyUI puts validation detail in `error` and `node_errors`.
    throw new PromptError(body);
  }
  return body as QueueResponse;
}

export class PromptError extends Error {
  nodeErrors: Record<string, unknown>;
  constructor(body: any) {
    super(body?.error?.message ?? body?.error ?? 'ComfyUI rejected the prompt.');
    this.name = 'PromptError';
    this.nodeErrors = body?.node_errors ?? {};
  }
}

export async function interrupt(): Promise<void> {
  await fetch(`${BASE}/interrupt`, { method: 'POST' });
}

/**
 * Unload every model and release VRAM.
 *
 * ComfyUI keeps models resident and only frees when something else needs the
 * room, which is fine until the next model is 19.5 GB and the card is already
 * full — then it spills to system RAM and the run crawls with no indication
 * that anything is wrong. Calling this first makes the starting state known.
 */
export async function freeMemory(): Promise<void> {
  await fetch(`${BASE}/free`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unload_models: true, free_memory: true }),
  });
}

export type VramStats = { total: number; free: number };

export async function fetchVram(): Promise<VramStats | null> {
  try {
    const s = (await getJson<{ devices?: { vram_total: number; vram_free: number }[] }>(
      '/system_stats',
    )).devices?.[0];
    return s ? { total: s.vram_total, free: s.vram_free } : null;
  } catch {
    return null;
  }
}

// ── /history ────────────────────────────────────────────────────────────────

export type OutputFile = { filename: string; subfolder: string; type: string };

/** Outputs for one node. Keys vary by pack — `images`, `gifs`, `videos`, … */
export type NodeOutputs = Record<string, unknown>;

export type HistoryEntry = {
  prompt: unknown;
  outputs: Record<string, NodeOutputs>;
  status?: { completed: boolean; status_str: string; messages: unknown[] };
};

export async function fetchHistory(promptId: string): Promise<HistoryEntry | null> {
  const all = await getJson<Record<string, HistoryEntry>>(`/history/${promptId}`);
  return all[promptId] ?? null;
}

/**
 * Pull every file out of a history entry, whatever key the node pack used.
 * Do not assume `images` — iterate. Spec §3, §11.
 */
export function collectFiles(entry: HistoryEntry): Array<OutputFile & { nodeId: string; key: string }> {
  const files: Array<OutputFile & { nodeId: string; key: string }> = [];
  for (const [nodeId, outputs] of Object.entries(entry.outputs ?? {})) {
    for (const [key, value] of Object.entries(outputs)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (item && typeof item === 'object' && 'filename' in item) {
          files.push({ ...(item as OutputFile), nodeId, key });
        }
      }
    }
  }
  return files;
}

// ── /view ───────────────────────────────────────────────────────────────────

export function viewUrl(file: OutputFile): string {
  const q = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder ?? '',
    type: file.type ?? 'output',
  });
  return `${BASE}/view?${q}`;
}

const VIDEO = /\.(mp4|webm|mov|mkv|gif|webp)$/i;
export function isVideo(file: OutputFile): boolean {
  return VIDEO.test(file.filename) && !/\.webp$/i.test(file.filename);
}

// ── /upload/image ───────────────────────────────────────────────────────────

/** Returns the `name` you put into a LoadImage widget. */
export async function uploadImage(file: File): Promise<{ name: string; subfolder: string; type: string }> {
  const form = new FormData();
  form.append('image', file);
  form.append('overwrite', 'false');
  const res = await fetch(`${BASE}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Websocket ───────────────────────────────────────────────────────────────

export type ComfyMessage =
  | { type: 'execution_start'; data: { prompt_id: string } }
  | { type: 'executing'; data: { node: string | null; prompt_id: string } }
  | { type: 'progress'; data: { value: number; max: number; node: string | null } }
  | { type: 'executed'; data: { node: string; prompt_id: string; output: NodeOutputs } }
  | { type: 'execution_cached'; data: { nodes: string[]; prompt_id: string } }
  | { type: 'execution_error'; data: { node_id: string; exception_message: string; prompt_id: string } }
  | { type: 'execution_interrupted'; data: { node_id: string; prompt_id: string } }
  | { type: 'status'; data: { status: { exec_info: { queue_remaining: number } } } }
  | { type: string; data: any };

/**
 * Connects with the same clientId used for POST /prompt, and reconnects with
 * backoff. Returns a disposer.
 */
export function connectWs(
  onMessage: (msg: ComfyMessage) => void,
  onOpenChange?: (open: boolean) => void,
): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: number | undefined;

  const open = () => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}${BASE}/ws?clientId=${clientId}`);

    ws.onopen = () => {
      attempt = 0;
      onOpenChange?.(true);
      // No keepalive. An earlier version pinged every 20s to stop intermediaries
      // culling an idle socket, but ComfyUI parses everything a client sends as
      // JSON and logged a warning for each one — three tabs open meant a steady
      // stream of them. Nothing sits between the browser and ComfyUI except our
      // own proxy, whose timeout is now disabled, so the ping bought nothing.
      // If a socket does die, the history poll in useRun still lands the result.
    };
    ws.onmessage = (ev) => {
      // Binary frames are live previews; ignore them for now. Spec §3.
      if (typeof ev.data !== 'string') return;
      try {
        onMessage(JSON.parse(ev.data));
      } catch {
        /* not our problem */
      }
    };
    ws.onclose = () => {
      onOpenChange?.(false);
      if (closed) return;
      const delay = Math.min(1000 * 2 ** attempt++, 15_000);
      timer = window.setTimeout(open, delay);
    };
    ws.onerror = () => ws?.close();
  };

  open();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}

// ── Plumbing ────────────────────────────────────────────────────────────────

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}
