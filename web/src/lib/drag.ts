/**
 * Drag payloads. Spec §7.
 *
 * `dataTransfer` is unreadable during dragover in most browsers, and drop
 * validity has to be known *during* the drag to show valid targets. So the
 * payload lives in React state and dataTransfer only carries a marker.
 */

export type DragPayload =
  | { kind: 'module'; moduleId: string }
  | { kind: 'tile'; tileId: string; moduleId: string }
  | { kind: 'line'; lineId: string };

export const DRAG_MIME = 'application/x-stack-ui';

export function beginDrag(e: React.DragEvent, payload: DragPayload): void {
  // 'copyMove', not 'copy'/'move'. If a drop target sets a dropEffect that the
  // source's effectAllowed does not permit, the browser cancels the drop
  // silently — dragover still fires so the target lights up, but `drop` never
  // arrives and the tile just vanishes. Allowing both makes the two impossible
  // to get out of step.
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
  // Some browsers need a text/plain fallback to start a drag at all.
  e.dataTransfer.setData('text/plain', payload.kind === 'line' ? payload.lineId : payload.moduleId);
}
