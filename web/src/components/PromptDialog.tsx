import { useEffect, useState } from 'react';
import type { MediaFile, RunRecord } from '../lib/api.ts';
import { viewUrl } from '../lib/comfy.ts';
import { VideoPlayer } from './VideoPlayer.tsx';

/**
 * What made this clip, at a size you can actually read.
 *
 * This began as a panel inside the library tile, which put four paragraphs of
 * prompt into a box 180px wide — technically the information, practically
 * useless. It is the whole point of the feature, so it gets the room: the clip
 * beside its own wording, selectable, with the settings that went with it.
 *
 * "Use this prompt" is the reason anyone opens it. Finding the wording that
 * worked three renders ago is only half the job; getting it back into the box
 * is the other half.
 */
export function PromptDialog({
  file,
  record,
  onClose,
  onUse,
}: {
  file: MediaFile;
  record: RunRecord | { error: string } | null;
  onClose: () => void;
  /** Absent when there is nowhere sensible to put it. */
  onUse?: (prompt: string) => void;
}) {
  const [copied, setCopied] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = async (text: string, i: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(i);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* no clipboard permission — the text is selectable anyway */
    }
  };

  const prompts = record && 'prompts' in record ? record.prompts : [];

  return (
    <div className="media" onClick={onClose}>
      <div className="prompt-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="prompt-head">
          <span className="panel-label">{file.filename}</span>
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="prompt-body">
          <div className="prompt-clip">
            {file.kind === 'video' ? (
              <VideoPlayer src={viewUrl(file)} />
            ) : (
              <img src={viewUrl(file)} alt="" />
            )}
            {record && 'settings' in record && (
              <div className="prompt-settings mono small">
                {Object.entries(record.settings).map(([k, v]) => (
                  <span key={k}>
                    <b>{k}</b> {String(v)}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="prompt-text">
            {!record && <p className="muted">Reading the file…</p>}
            {record && 'error' in record && <p className="error">{record.error}</p>}
            {record && 'prompts' in record && prompts.length === 0 && (
              <p className="muted">This file carries no prompt text.</p>
            )}

            {prompts.map((text, i) => (
              <div className="prompt-block" key={i}>
                {/* Read-only, but selectable — copying a paragraph out by hand
                    is the fallback when the clipboard is not permitted. */}
                <textarea className="param-input param-textarea" readOnly value={text} />
                <div className="prompt-block-actions">
                  <button className="ghost" onClick={() => void copy(text, i)}>
                    {copied === i ? 'Copied' : 'Copy'}
                  </button>
                  {onUse && (
                    <button
                      className="primary"
                      onClick={() => {
                        onUse(text);
                        onClose();
                      }}
                    >
                      Use this prompt
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
