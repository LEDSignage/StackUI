import { useEffect, useRef } from 'react';

/**
 * A yes/no question, in the app's own styling.
 *
 * `window.confirm` would do the job, but it says OK and Cancel — which is the
 * wrong pair for "are you throwing this away?" — and it freezes the page while
 * it is open. This one names the consequence and can be dismissed with Escape.
 *
 * No is focused on open, so a stray Return does not agree on your behalf.
 */
export function Confirm({
  title,
  detail,
  yes = 'Yes',
  no = 'No',
  onYes,
  onNo,
}: {
  title: string;
  detail?: string;
  yes?: string;
  no?: string;
  onYes: () => void;
  onNo: () => void;
}) {
  const noButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    noButton.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onNo();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onNo]);

  return (
    <div className="media" onClick={onNo}>
      <div className="confirm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="panel-label">{title}</div>
        {detail && <p className="muted small">{detail}</p>}
        <div className="confirm-actions">
          <button className="ghost" ref={noButton} onClick={onNo}>
            {no}
          </button>
          <button className="primary" onClick={onYes}>
            {yes}
          </button>
        </div>
      </div>
    </div>
  );
}
