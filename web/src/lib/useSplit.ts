import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * How far the divider travels either side of centre.
 *
 * The limit is on the movement, not on the columns: the handle starts halfway
 * and can go 250px left or 250px right of that, whatever the window is. A
 * minimum measured from the screen edges instead would let the divider swing
 * almost the full width on a big monitor, which is not what a limit is for.
 */
const RANGE = 250;
const KEY = 'stack-ui:split';

/**
 * A draggable divider between the settings and the result.
 *
 * Returns the left column's width in pixels, or null while the split is still
 * at its default proportion — the grid keeps its `fr` sizing until you actually
 * drag something, so a narrow window is not forced to honour a width chosen on
 * a wide one.
 *
 * The drag listens on the window rather than the handle, because a fast drag
 * outruns the pointer and leaves the handle behind; on the window it keeps up
 * however far the cursor gets. Pointer capture would do the same, but this also
 * survives the pointer leaving the browser entirely.
 */
export function useSplit(containerRef: React.RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState<number | null>(() => {
    const saved = Number(localStorage.getItem(KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : null;
  });
  const [dragging, setDragging] = useState(false);
  const raf = useRef(0);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;

    const move = (e: PointerEvent) => {
      // One update per frame. A pointermove can fire far more often than that,
      // and re-laying out two columns on every one of them is visible as lag.
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(() => {
        const box = containerRef.current?.getBoundingClientRect();
        if (!box) return;
        // Centre, plus or minus RANGE — and never past the window itself on a
        // display narrow enough that half of it is less than RANGE.
        const centre = box.width / 2;
        const lo = Math.max(120, centre - RANGE);
        const hi = Math.min(box.width - 120, centre + RANGE);
        setWidth(Math.max(lo, Math.min(hi, e.clientX - box.left)));
      });
    };

    const up = () => setDragging(false);

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    // Without this a drag across the video selects text and shows a ghost.
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    return () => {
      cancelAnimationFrame(raf.current);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [dragging, containerRef]);

  useEffect(() => {
    if (width !== null) localStorage.setItem(KEY, String(Math.round(width)));
  }, [width]);

  /**
   * Keep the divider within range of centre when the window changes size.
   *
   * Centre moves when the window does, so a split that was 200px left of it on
   * a wide monitor could be most of the way across a narrow one. Re-clamping
   * against the new centre keeps the same limit meaningful at any size.
   */
  useEffect(() => {
    if (width === null) return;
    const fit = () => {
      const box = containerRef.current?.getBoundingClientRect();
      if (!box || !box.width) return;
      const centre = box.width / 2;
      const lo = Math.max(120, centre - RANGE);
      const hi = Math.min(box.width - 120, centre + RANGE);
      const clamped = Math.max(lo, Math.min(hi, width));
      if (Math.abs(clamped - width) > 0.5) setWidth(clamped);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [width, containerRef]);

  /** Double-click the handle to go back to the default proportion. */
  const reset = useCallback(() => {
    localStorage.removeItem(KEY);
    setWidth(null);
  }, []);

  return { width, dragging, onPointerDown, reset };
}
