import { useCallback, useEffect, useState } from 'react';
import { deleteMedia, fetchMedia, type MediaFile } from '../lib/api.ts';
import { viewUrl } from '../lib/comfy.ts';

/**
 * Everything ComfyUI has made, newest first.
 *
 * The job page only ever shows the last result, which is fine while you are
 * working and useless the moment you want the clip from three runs ago. This is
 * that: a grid you can play, download from, and delete in.
 *
 * Deleting is real and immediate — the file leaves the disk. So it asks first,
 * and the button is absent entirely when the output folder is on another
 * machine and the server could not honour it anyway.
 */
export function MediaBrowser({
  onClose,
  refreshKey,
}: {
  /** Given, it renders as a sheet over the page with a Close button. Omitted,
      it renders bare, to sit inside a column that is already on screen. */
  onClose?: () => void;
  refreshKey?: unknown;
}) {
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [writable, setWritable] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'video' | 'image'>('all');
  /** The file awaiting a second click on Delete. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchMedia();
      setFiles(res.files);
      setWritable(res.writable);
      setState('ready');
    } catch (err) {
      setError((err as Error).message);
      setState('failed');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Escape closes, as it does everywhere else a panel covers the page.
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shown = filter === 'all' ? files : files.filter((f) => f.kind === filter);

  const remove = async (file: MediaFile) => {
    const key = keyOf(file);
    if (confirming !== key) return setConfirming(key);
    setConfirming(null);
    try {
      await deleteMedia(file);
      setFiles((current) => current.filter((f) => keyOf(f) !== key));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const body = (
    <div className={onClose ? 'media-panel' : 'media-inline'} onClick={(e) => e.stopPropagation()}>
        <div className="media-head">
          {onClose && <span className="panel-label">Library</span>}

          <div className="modeswitch">
            {(['all', 'video', 'image'] as const).map((f) => (
              <button
                key={f}
                className={`mode ${filter === f ? 'mode-on' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? 'All' : f === 'video' ? 'Videos' : 'Images'}
              </button>
            ))}
          </div>

          <span className="muted small">
            {state === 'ready' && `${shown.length} file${shown.length === 1 ? '' : 's'}`}
          </span>

          <span className="spacer" />

          <button className="ghost" onClick={() => void load()}>
            Refresh
          </button>
          {onClose && (
            <button className="ghost" onClick={onClose}>
              Close
            </button>
          )}
        </div>

        {error && <p className="error">{error}</p>}

        {state === 'loading' && <p className="muted">Reading the output folder…</p>}
        {state === 'failed' && <p className="error">Could not read the output folder.</p>}
        {state === 'ready' && shown.length === 0 && <p className="muted">Nothing here yet.</p>}

        {!writable && state === 'ready' && files.length > 0 && (
          <p className="muted small">
            The output folder is on another machine, so files can be played and downloaded but not
            deleted from here.
          </p>
        )}

        <div className="media-grid">
          {shown.map((file) => {
            const url = viewUrl(file);
            const key = keyOf(file);
            return (
              <figure className="media-item" key={key}>
                {/* No autoplay and no preload: a folder of twenty clips would
                    otherwise pull every one of them down at once. */}
                {file.kind === 'video' ? (
                  <video src={url} controls preload="none" className="media-thumb" />
                ) : (
                  <img src={url} alt="" loading="lazy" className="media-thumb" />
                )}
                <figcaption className="media-caption">
                  <span className="mono small" title={file.filename}>
                    {file.filename}
                  </span>
                  {/* Zero means the listing came from ComfyUI, which reports
                      neither. Better blank than a made-up 1970. */}
                  <span className="muted small">
                    {file.modified ? `${when(file.modified)} · ${mb(file.size)}` : ' '}
                  </span>
                </figcaption>
                <div className="media-actions">
                  <a className="ghost" href={url} download={file.filename}>
                    Download
                  </a>
                  {writable && (
                    <button
                      className={confirming === key ? 'stop' : 'ghost'}
                      onClick={() => void remove(file)}
                      onBlur={() => setConfirming((c) => (c === key ? null : c))}
                    >
                      {confirming === key ? 'Delete for good?' : 'Delete'}
                    </button>
                  )}
                </div>
              </figure>
            );
          })}
        </div>
    </div>
  );

  return onClose ? (
    <div className="media" onClick={onClose}>
      {body}
    </div>
  ) : (
    body
  );
}

const keyOf = (f: MediaFile) => `${f.subfolder}/${f.filename}`;

const mb = (bytes: number) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Relative for anything recent, because "2 minutes ago" is what you want. */
function when(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} hr ago`;
  return new Date(ms).toLocaleDateString();
}
