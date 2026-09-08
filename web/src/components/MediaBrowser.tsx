import { useCallback, useEffect, useState } from 'react';
import { deleteMedia, fetchMedia, fetchRunRecord, type MediaFile, type RunRecord } from '../lib/api.ts';
import { viewUrl } from '../lib/comfy.ts';
import { Confirm } from './Confirm.tsx';
import { VideoPlayer } from './VideoPlayer.tsx';
import { PromptDialog } from './PromptDialog.tsx';

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
  onUsePrompt,
}: {
  refreshKey?: unknown;
  /** Whether it is filling the window rather than sitting in the right pane. */
  full?: boolean;
  onFull?: (full: boolean) => void;
  /** Put a prompt back into the job page. */
  onUsePrompt?: (prompt: string) => void;
}) {
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [writable, setWritable] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'video' | 'image'>('all');
  /** The file the delete dialogue is asking about. */
  const [confirming, setConfirming] = useState<MediaFile | null>(null);
  /** The file whose prompt is open, and what it said. */
  const [showing, setShowing] = useState<MediaFile | null>(null);
  const [record, setRecord] = useState<RunRecord | { error: string } | null>(null);
  /** Read what made this clip, out of the clip. */
  const openPrompt = async (file: MediaFile) => {
    setShowing(file);
    setRecord(null);
    try {
      setRecord(await fetchRunRecord(file));
    } catch (err) {
      setRecord({ error: (err as Error).message });
    }
  };


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

          {/* Re-reading the folder is enough: a file whose content changed has
              a new modification time, so its URL changes and the browser
              fetches it again. One that has not changed stays cached, which is
              what keeps a hundred-clip library from stampeding ComfyUI. */}
          <button className="ghost" onClick={() => void load()} title="Re-read the output folder">
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
            // Versioned by the file's own timestamp, so only a file that has
            // actually changed gets a new URL. A single nonce across the whole
            // library made every clip reload at once and buried ComfyUI.
            const url = viewUrl(file);
            const key = keyOf(file);
            return (
              <figure className="media-item" key={key}>
                {/* Our own controls — see VideoPlayer. Chrome collapses the
                    native bar into an overflow menu at tile width, leaving the
                    menu and nothing else. */}
                {file.kind === 'video' ? (
                  <VideoPlayer src={url} className="media-thumb" />
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
                {/* Icons, not words. Three labelled buttons do not fit a tile
                    and the third was clipped off the card entirely; drawn at
                    this size all three sit on one row with room to spare, and
                    the name lives in the tooltip. */}
                <div className="media-actions">
                  <a className="icon-btn" href={url} download={file.filename} title="Download">
                    <IconDownload />
                  </a>
                  {file.kind === 'video' && (
                    <button
                      className="icon-btn"
                      onClick={() => void openPrompt(file)}
                      title="The prompt that made this"
                    >
                      <IconPrompt />
                    </button>
                  )}
                  {writable && (
                    <button
                      className="icon-btn icon-danger"
                      onClick={() => setConfirming(file)}
                      title="Delete this file"
                    >
                      <IconTrash />
                    </button>
                  )}
                </div>
              </figure>
            );
          })}
        </div>

        {showing && (
          <PromptDialog
            file={showing}
            record={record}
            onClose={() => setShowing(null)}
            onUse={onUsePrompt}
          />
        )}

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

/*
 * Drawn rather than typed — the same reason as the player's controls. A glyph
 * font is a dependency on whatever happens to be installed, and the last set of
 * characters rendered as empty boxes.
 */
const icon = { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const IconDownload = () => (
  <svg {...icon} aria-hidden>
    <path d="M8 2v8M4.5 7l3.5 3 3.5-3M2.5 13.5h11" />
  </svg>
);

const IconPrompt = () => (
  <svg {...icon} aria-hidden>
    <path d="M3 3.5h10M3 6.5h10M3 9.5h7M3 12.5h4" />
  </svg>
);

const IconTrash = () => (
  <svg {...icon} aria-hidden>
    <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.5 6.5v5M9.5 6.5v5" />
  </svg>
);
