import { useCallback, useEffect, useRef, useState } from 'react';

/** Neither column is worth using below this. */
const MIN = 500;
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
    return Number.isFinite(saved) && saved >= MIN ? saved : null;
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
        // The gap between the columns belongs to neither, so the right column's
        // floor has to account for it.
        const max = box.width - MIN - 16;
        if (max < MIN) return;
        setWidth(Math.max(MIN, Math.min(max, e.clientX - box.left)));
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
   * Give the window back the space when it shrinks.
   *
   * A width set on a wide monitor would otherwise leave no room for the result
   * on a laptop, and the grid would push the second column off the edge.
   */
  useEffect(() => {
    if (width === null) return;
    const fit = () => {
      const box = containerRef.current?.getBoundingClientRect();
      if (!box) return;
      const max = box.width - MIN - 16;
      if (max >= MIN && width > max) setWidth(max);
    };
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
