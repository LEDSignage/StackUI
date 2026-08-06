/**
 * Run state. Spec §3.
 *
 * Every websocket message identifies a *node*. The tileMap from the compile
 * step is the only thing that turns that back into a tile, so a run holds the
 * map it was submitted with — not the current one, which may already have
 * drifted if the user kept editing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  collectFiles,
  connectWs,
  fetchHistory,
  interrupt as sendInterrupt,
  PromptError,
  queuePrompt,
  type ComfyMessage,
  type HistoryEntry,
  type OutputFile,
} from './comfy.ts';
import type { ApiPrompt } from '@shared/types.ts';

/**
 * Editing this file changes how many hooks `useRun` calls, and React Fast
 * Refresh will happily hot-swap the code while keeping the old component's
 * hook state — which throws "change in the order of Hooks" and leaves the
 * whole UI inert until a manual reload. Force a real reload instead.
 */
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());

export type TileRunState = 'idle' | 'pending' | 'running' | 'cached' | 'done' | 'error';

export type RunState = {
  promptId: string | null;
  status: 'idle' | 'queued' | 'running' | 'done' | 'error' | 'interrupted';
  /** tile id → state */
  tiles: Record<string, TileRunState>;
  /** tile id → 0..1 */
  progress: Record<string, number>;
  /** tile id → message */
  errors: Record<string, string>;
  files: Array<OutputFile & { nodeId: string; key: string }>;
  startedAt: number | null;
  finishedAt: number | null;
  queueRemaining: number;
  message: string | null;
};

const initial: RunState = {
  promptId: null,
  status: 'idle',
  tiles: {},
  progress: {},
  errors: {},
  files: [],
  startedAt: null,
  finishedAt: null,
  queueRemaining: 0,
  message: null,
};

/**
 * The run in flight, remembered across a reload.
 *
 * Generation takes minutes. Refreshing the page — or closing the laptop lid and
 * coming back — used to lose the job entirely: it carried on generating on the
 * box and wrote its file, but the page had no idea and showed nothing. The
 * prompt id is all that is needed to pick it up again, because /history is the
 * authority for everything else.
 */
const IN_FLIGHT = 'stack-ui:run';

export function useRun() {
  const [run, setRun] = useState<RunState>(() => {
    const id = localStorage.getItem(IN_FLIGHT);
    return id ? { ...initial, promptId: id, status: 'running', startedAt: Date.now() } : initial;
  });
  const [wsOpen, setWsOpen] = useState(false);

  /** The map the *current* run was submitted with. */
  const tileMapRef = useRef<Record<string, string>>({});
  // Seeded from the restored run, so websocket messages for a job that was
  // already in flight before the reload are still recognised as ours.
  const promptIdRef = useRef<string | null>(localStorage.getItem(IN_FLIGHT));
  /**
   * Execution can start before POST /prompt has returned, so the first few
   * messages arrive while we still do not know our own prompt id. Holding them
   * here and replaying once the id lands is the difference between the first
   * node showing progress and it sitting on 'pending' for the whole run.
   */
  const awaitingId = useRef(false);
  const buffered = useRef<ComfyMessage[]>([]);

  const handle = useCallback((msg: ComfyMessage) => {
    if (awaitingId.current) {
      buffered.current.push(msg);
      return;
    }
    apply(msg);
  }, []);

  const apply = useCallback((msg: ComfyMessage) => {
    const tileOf = (nodeId: string | null | undefined) =>
      nodeId == null ? null : (tileMapRef.current[nodeId] ?? null);

    setRun((prev) => {
      switch (msg.type) {
        case 'status': {
          const remaining = msg.data?.status?.exec_info?.queue_remaining ?? prev.queueRemaining;
          return { ...prev, queueRemaining: remaining };
        }

        case 'execution_start': {
          if (msg.data.prompt_id !== promptIdRef.current) return prev;
          return { ...prev, status: 'running', startedAt: Date.now(), finishedAt: null };
        }

        // 0.30.1 emits this alongside the `executing: null` that ends a run.
        case 'execution_success': {
          if (msg.data.prompt_id !== promptIdRef.current) return prev;
          return { ...prev, status: 'done', tiles: settle(prev.tiles), finishedAt: Date.now() };
        }

        case 'executing': {
          if (msg.data.prompt_id && msg.data.prompt_id !== promptIdRef.current) return prev;
          if (msg.data.node === null) {
            // node: null means the whole prompt finished.
            return { ...prev, status: 'done', tiles: settle(prev.tiles), finishedAt: Date.now() };
          }
          const tile = tileOf(msg.data.node);
          if (!tile) return prev;
          const tiles = { ...prev.tiles };
          for (const [id, s] of Object.entries(tiles)) if (s === 'running') tiles[id] = 'done';
          tiles[tile] = 'running';
          return { ...prev, status: 'running', tiles };
        }

        case 'progress': {
          const tile = tileOf(msg.data.node);
          if (!tile || !msg.data.max) return prev;
          return { ...prev, progress: { ...prev.progress, [tile]: msg.data.value / msg.data.max } };
        }

        case 'executed': {
          const tile = tileOf(msg.data.node);
          const files = [...prev.files];
          for (const [key, value] of Object.entries(msg.data.output ?? {})) {
            if (!Array.isArray(value)) continue;
            for (const item of value) {
              if (item && typeof item === 'object' && 'filename' in item) {
                files.push({ ...(item as OutputFile), nodeId: msg.data.node, key });
              }
            }
          }
          return {
            ...prev,
            files,
            tiles: tile ? { ...prev.tiles, [tile]: 'done' } : prev.tiles,
          };
        }

        case 'execution_cached': {
          const tiles = { ...prev.tiles };
          for (const nodeId of msg.data.nodes ?? []) {
            const tile = tileOf(nodeId);
            if (tile && tiles[tile] !== 'running') tiles[tile] = 'cached';
          }
          return { ...prev, tiles };
        }

        case 'execution_error': {
          const tile = tileOf(msg.data.node_id);
          const message = msg.data.exception_message ?? 'Execution failed.';
          return {
            ...prev,
            status: 'error',
            finishedAt: Date.now(),
            message,
            tiles: tile ? { ...prev.tiles, [tile]: 'error' } : prev.tiles,
            errors: tile ? { ...prev.errors, [tile]: message } : prev.errors,
          };
        }

        case 'execution_interrupted': {
          return { ...prev, status: 'interrupted', finishedAt: Date.now(), message: 'Interrupted.' };
        }

        default:
          return prev;
      }
    });
  }, []);

  useEffect(() => connectWs(handle, setWsOpen), [handle]);

  /**
   * Adopt a job that is already running on the box.
   *
   * Covers the cases the stored prompt id cannot: a run started from another
   * tab, from ComfyUI itself, or before this page ever loaded. Without it the
   * page sits idle and empty while the GPU is plainly busy, which reads as the
   * app having lost track of everything.
   */
  useEffect(() => {
    if (run.status !== 'idle') return;
    let cancelled = false;

    const look = async () => {
      const q = await fetch('/comfy/queue')
        .then((r) => r.json())
        .catch(() => null);
      const running = q?.queue_running?.[0];
      if (cancelled || !running) return;

      const id = String(running[1]);
      promptIdRef.current = id;
      localStorage.setItem(IN_FLIGHT, id);
      setRun((prev) =>
        prev.status === 'idle'
          ? { ...initial, promptId: id, status: 'running', startedAt: Date.now() }
          : prev,
      );
    };

    void look();
    const t = setInterval(look, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [run.status]);

  /**
   * Show the most recent result on load.
   *
   * Without this, a run that finished while the page was closed, reloaded, or
   * simply not listening leaves an empty output window — the file exists, the
   * job succeeded, and the app shows nothing. The last thing the box made is
   * almost always the thing you want to look at.
   */
  useEffect(() => {
    if (run.status !== 'idle' || run.files.length || localStorage.getItem(IN_FLIGHT)) return;
    let cancelled = false;

    void fetch('/comfy/history?max_items=1')
      .then((r) => r.json())
      .then((all: Record<string, HistoryEntry>) => {
        if (cancelled) return;
        const entry = Object.values(all ?? {})[0];
        if (!entry || entry.status?.status_str !== 'success') return;
        const files = collectFiles(entry);
        if (files.length) setRun((prev) => (prev.status === 'idle' ? { ...prev, files } : prev));
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  /** Replay whatever arrived before we knew our prompt id. */
  const flush = useCallback(() => {
    awaitingId.current = false;
    const queued = buffered.current;
    buffered.current = [];
    for (const msg of queued) apply(msg);
  }, [apply]);

  /**
   * The websocket can miss the tail of a run (a reconnect mid-execution, a
   * missed `executed`). /history is the authority once a run finishes.
   */
  useEffect(() => {
    if (run.status !== 'done' || !run.promptId) return;
    let cancelled = false;
    const id = run.promptId;
    (async () => {
      const entry = await fetchHistory(id).catch(() => null);
      if (cancelled || !entry) return;
      const files = collectFiles(entry);
      if (files.length) setRun((prev) => (prev.promptId === id ? { ...prev, files } : prev));
    })();
    return () => {
      cancelled = true;
    };
  }, [run.status, run.promptId]);

  /**
   * Poll while a run is in flight, so a failure still surfaces if the websocket
   * missed it.
   *
   * Relying on `execution_error` alone means a dropped or reconnected socket
   * leaves the page saying "Working…" indefinitely for a job that died seconds
   * ago — with the real reason sitting in /history the whole time.
   */
  useEffect(() => {
    const id = run.promptId;
    if (!id || (run.status !== 'queued' && run.status !== 'running')) return;

    let cancelled = false;
    const timer = setInterval(async () => {
      const entry = await fetchHistory(id).catch(() => null);
      if (cancelled || !entry?.status) return;

      const failed = entry.status.status_str === 'error';
      if (!failed && !entry.status.completed) return;

      setRun((prev) => {
        if (prev.promptId !== id) return prev;
        if (!failed) {
          return { ...prev, status: 'done', tiles: settle(prev.tiles), finishedAt: Date.now(), files: collectFiles(entry) };
        }
        const { message, nodeId } = errorFrom(entry);
        const tileId = nodeId ? tileMapRef.current[nodeId] : undefined;
        return {
          ...prev,
          status: 'error',
          message,
          finishedAt: Date.now(),
          tiles: tileId ? { ...prev.tiles, [tileId]: 'error' } : prev.tiles,
          errors: tileId ? { ...prev.errors, [tileId]: message } : prev.errors,
        };
      });
    }, 4000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [run.promptId, run.status]);

  const start = useCallback(async (prompt: ApiPrompt, tileMap: Record<string, string>) => {
    tileMapRef.current = tileMap;
    promptIdRef.current = null;
    awaitingId.current = true;
    buffered.current = [];

    const tiles: Record<string, TileRunState> = {};
    for (const tileId of new Set(Object.values(tileMap))) tiles[tileId] = 'pending';
    setRun({ ...initial, tiles, status: 'queued', startedAt: Date.now() });

    try {
      const res = await queuePrompt(prompt);
      promptIdRef.current = res.prompt_id;
      localStorage.setItem(IN_FLIGHT, res.prompt_id);
      setRun((prev) => ({ ...prev, promptId: res.prompt_id }));
      flush();
      return res;
    } catch (err) {
      flush();
      // Validation failures come back keyed by node id — attribute them to tiles.
      const errors: Record<string, string> = {};
      if (err instanceof PromptError) {
        for (const [nodeId, detail] of Object.entries(err.nodeErrors)) {
          const tileId = tileMap[nodeId];
          if (tileId) errors[tileId] = describeNodeError(detail);
        }
      }
      setRun((prev) => ({
        ...prev,
        status: 'error',
        message: (err as Error).message,
        errors,
        finishedAt: Date.now(),
      }));
      throw err;
    }
  }, []);

  const interrupt = useCallback(() => sendInterrupt(), []);
  const reset = useCallback(() => setRun(initial), []);

  // Forget the in-flight marker once the run is over, so a later reload does
  // not resurrect a finished job.
  useEffect(() => {
    if (['done', 'error', 'interrupted'].includes(run.status)) localStorage.removeItem(IN_FLIGHT);
  }, [run.status]);

  const elapsed = useElapsed(run.startedAt, run.finishedAt);

  return useMemo(
    () => ({ run, wsOpen, elapsed, start, interrupt, reset }),
    [run, wsOpen, elapsed, start, interrupt, reset],
  );
}

/**
 * A finished run leaves nothing in flight. Anything still 'running' is done,
 * and anything still 'pending' either ran or was served from cache — either
 * way it is not waiting on us any more.
 */
function settle(tiles: Record<string, TileRunState>): Record<string, TileRunState> {
  const out = { ...tiles };
  for (const [id, s] of Object.entries(out)) {
    if (s === 'running' || s === 'pending') out[id] = 'done';
  }
  return out;
}

/** Pull the failure out of a history entry, for when the websocket missed it. */
function errorFrom(entry: HistoryEntry): { message: string; nodeId?: string } {
  const messages = (entry.status?.messages ?? []) as [string, Record<string, unknown>][];
  for (const [kind, data] of messages) {
    if (kind !== 'execution_error') continue;
    const node = data.node_id != null ? String(data.node_id) : undefined;
    const type = data.node_type ? `${data.node_type}: ` : '';
    return { message: `${type}${String(data.exception_message ?? 'Execution failed.')}`.trim(), nodeId: node };
  }
  return { message: 'ComfyUI reported an error but gave no detail.' };
}

function describeNodeError(detail: unknown): string {
  const errors = (detail as any)?.errors;
  if (Array.isArray(errors) && errors.length) {
    return errors.map((e: any) => `${e.details ?? ''} ${e.message ?? ''}`.trim()).join('; ');
  }
  return typeof detail === 'string' ? detail : JSON.stringify(detail);
}

/** Ticks once a second while a run is live, then freezes. */
function useElapsed(startedAt: number | null, finishedAt: number | null): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!startedAt || finishedAt) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [startedAt, finishedAt]);
  if (!startedAt) return 0;
  return ((finishedAt ?? Date.now()) - startedAt) / 1000;
}
