import { useState } from 'react';
import { isVideo, viewUrl } from '../lib/comfy.ts';
import type { RunState } from '../lib/useRun.ts';
import type { CompileIssue } from '@shared/types.ts';

type Props = {
  run: RunState;
  elapsed: number;
  canQueue: boolean;
  stackIssues: CompileIssue[];
  errorCount: number;
  onQueue: () => void;
  onInterrupt: () => void;
  onShowJson: () => void;
  activeTileName: string | null;
};

export function OutputPanel({
  run,
  elapsed,
  canQueue,
  stackIssues,
  errorCount,
  onQueue,
  onInterrupt,
  onShowJson,
  activeTileName,
}: Props) {
  const [index, setIndex] = useState(0);
  const files = run.files;
  const file = files[Math.min(index, Math.max(0, files.length - 1))];
  const busy = run.status === 'queued' || run.status === 'running';

  return (
    <footer className="output">
      <div className="output-bar">
        <button className="primary" disabled={!canQueue || busy} onClick={onQueue}>
          {busy ? 'Running…' : 'Queue'}
        </button>
        {busy && (
          <button className="ghost" onClick={onInterrupt}>
            Interrupt
          </button>
        )}
        <button className="ghost" onClick={onShowJson}>
          View JSON
        </button>

        <span className="output-status">
          {errorCount > 0 && <span className="error">{errorCount} error{errorCount === 1 ? '' : 's'}</span>}
          {errorCount === 0 && stackIssues.length > 0 && (
            <span className="warning">{stackIssues[0]!.message}</span>
          )}
          {busy && activeTileName && <span className="muted">{activeTileName}</span>}
          {run.status === 'error' && <span className="error">{run.message}</span>}
          {run.status === 'done' && <span className="ok">done</span>}
        </span>

        <span className="spacer" />
        {run.startedAt && <span className="muted mono">{elapsed.toFixed(0)}s</span>}
        {run.queueRemaining > 0 && <span className="muted">queue {run.queueRemaining}</span>}
      </div>

      {files.length > 0 && file && (
        <div className="output-view">
          {isVideo(file) ? (
            <video
              src={viewUrl(file)}
              controls
              loop
              playsInline
              controlsList="nodownload noremoteplayback"
              disablePictureInPicture
              className="output-media"
            />
          ) : (
            <img src={viewUrl(file)} alt={file.filename} className="output-media" />
          )}

          <div className="output-side">
            <div className="output-name mono">{file.filename}</div>
            {files.length > 1 && (
              <div className="output-nav">
                <button className="ghost" onClick={() => setIndex((i) => Math.max(0, i - 1))}>
                  ‹
                </button>
                <span className="muted">
                  {Math.min(index, files.length - 1) + 1} / {files.length}
                </span>
                <button className="ghost" onClick={() => setIndex((i) => Math.min(files.length - 1, i + 1))}>
                  ›
                </button>
              </div>
            )}
            <a className="ghost" href={viewUrl(file)} download={file.filename}>
              Download
            </a>
          </div>
        </div>
      )}
    </footer>
  );
}
