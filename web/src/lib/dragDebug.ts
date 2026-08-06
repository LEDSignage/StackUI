/**
 * Dev-only drag tracing.
 *
 * Synthetic DragEvents do not behave like real ones — three separate drag bugs
 * in this project passed every in-page test while real dragging was broken. So
 * when a drag misbehaves, do not reason about it: turn this on and look at what
 * the browser actually fired.
 *
 * Toggle with the "drag log" button in the header, or `dragDebug.enable()` in
 * the console. Entries are also on `window.__dragLog` for inspection.
 */

export type DragLogEntry = { t: number; type: string; target: string; note?: string };

const MAX = 200;

class DragDebug {
  entries: DragLogEntry[] = [];
  enabled = false;
  private listeners = new Set<() => void>();
  private attached = false;

  enable() {
    this.enabled = true;
    this.attach();
    this.emit();
  }

  disable() {
    this.enabled = false;
    this.emit();
  }

  toggle() {
    this.enabled ? this.disable() : this.enable();
  }

  clear() {
    this.entries = [];
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  log(type: string, target: string, note?: string) {
    if (!this.enabled) return;
    this.entries.push({ t: Date.now(), type, target, note });
    if (this.entries.length > MAX) this.entries.shift();
    (window as unknown as { __dragLog: DragLogEntry[] }).__dragLog = this.entries;
    this.emit();
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  /**
   * Capture-phase listeners on the document, so we see every event the browser
   * dispatched — including ones a component never handled, which is precisely
   * the case worth knowing about.
   */
  private attach() {
    if (this.attached) return;
    this.attached = true;
    for (const type of ['dragstart', 'dragover', 'dragenter', 'dragleave', 'drop', 'dragend'] as const) {
      document.addEventListener(
        type,
        (e) => {
          const el = e.target as HTMLElement;
          const desc = el?.className
            ? `.${String(el.className).trim().split(/\s+/).slice(0, 2).join('.')}`
            : (el?.tagName ?? '?');
          // dragover fires continuously; collapse repeats onto one line.
          const last = this.entries[this.entries.length - 1];
          if (last && last.type === type && last.target === desc) {
            last.note = `×${Number((last.note ?? '×1').slice(1)) + 1}`;
            this.emit();
            return;
          }
          this.log(type, desc);
        },
        true,
      );
    }
  }
}

export const dragDebug = new DragDebug();
