import { useCallback, useEffect, useState } from 'react';
import { deleteMedia, fetchMedia, type MediaFile } from '../lib/api.ts';
import { viewUrl } from '../lib/comfy.ts';
import { Confirm } from './Confirm.tsx';

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
  refreshKey,
  full,
  onFull,
}: {
  refreshKey?: unknown;
  /** Whether it is filling the window rather than sitting in the right pane. */
  full?: boolean;
  onFull?: (full: boolean) => void;
}) {
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [writable, setWritable] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'video' | 'image'>('all');
  /** The file the delete dialogue is asking about. */
  const [confirming, setConfirming] = useState<MediaFile | null>(null);

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

  // Escape leaves full screen, as it does in every other viewer.
  useEffect(() => {
    if (!full || !onFull) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onFull(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full, onFull]);

  const shown = filter === 'all' ? files : files.filter((f) => f.kind === filter);

  const remove = async (file: MediaFile) => {
    setConfirming(null);
    try {
      await deleteMedia(file);
      setFiles((current) => current.filter((f) => keyOf(f) !== keyOf(file)));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className={`media-inline ${full ? 'is-full' : ''}`}>
        <div className="media-head">
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
          {onFull && (
            <button
              className="ghost"
              onClick={() => onFull(!full)}
              title={full ? 'Back to the side panel — or press Escape' : 'Fill the window'}
            >
              {full ? 'Exit full screen' : 'Full screen'}
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
                    <button className="ghost" onClick={() => setConfirming(file)}>
                      Delete
                    </button>
                  )}
                </div>
              </figure>
            );
          })}
        </div>

        {confirming && (
          <Confirm
            title="Delete this file?"
            detail={`${confirming.filename} is removed from the output folder for good. This cannot be undone.`}
            yes="Delete"
            onYes={() => void remove(confirming)}
            onNo={() => setConfirming(null)}
          />
        )}
    </div>
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
