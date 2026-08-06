import type { Script, Shot } from '@shared/types.ts';
import { compose, nextShot, scriptDuration } from '@shared/script.ts';

type Props = {
  script: Script;
  /** Seconds the clip will actually be, so an over-long shot list can be flagged. */
  clipSeconds: number;
  onChange: (script: Script) => void;
};

/**
 * The shot list.
 *
 * One box for the overall vision, then one per shot with its timecode, then the
 * soundtrack and any rules. All of it assembles into the single prompt string the
 * model reads — see shared/script.ts — so the model still gets what it expects
 * while you edit it as separate thoughts rather than one wall of text.
 */
export function ScriptEditor({ script, clipSeconds, onChange }: Props) {
  const set = (patch: Partial<Script>) => onChange({ ...script, ...patch });
  const setShot = (i: number, patch: Partial<Shot>) =>
    set({ shots: script.shots.map((s, n) => (n === i ? { ...s, ...patch } : s)) });

  const runs = scriptDuration(script);
  const over = clipSeconds > 0 && runs > clipSeconds + 0.01;

  return (
    <section className="use-group">
      {/* The Add button lives in the heading, not at the foot of the list. At the
          foot it sat below the fold on anything but a tall window, which made it
          look as though shots could only be removed. */}
      <h3 className="use-group-title script-head">
        <span>
          The script
          <span className="input-count">
            {script.shots.length} shot{script.shots.length === 1 ? '' : 's'} · {runs}s
            {clipSeconds > 0 && ` of ${clipSeconds}s`}
          </span>
        </span>
        <button
          className="add-shot"
          onClick={() => set({ shots: [...script.shots, nextShot(script)] })}
        >
          + Add shot
        </button>
      </h3>

      <div className="script">
        <div className="panel panel-full">
          <div className="panel-label">The overall vision</div>
          <textarea
            className="param-input param-textarea"
            rows={2}
            placeholder="Look, palette, mood — what the whole thing feels like."
            value={script.vision}
            onChange={(e) => set({ vision: e.target.value })}
          />
        </div>

        {script.shots.map((shot, i) => (
          <div className="shot" key={i}>
            <div className="shot-head">
              <span className="shot-n">Shot {i + 1}</span>
              <input
                type="number"
                className="param-input shot-time"
                min={0}
                step={0.5}
                value={shot.from}
                onChange={(e) => setShot(i, { from: Number(e.target.value) })}
                title="Starts at (seconds)"
              />
              <span className="shot-dash">–</span>
              <input
                type="number"
                className="param-input shot-time"
                min={0}
                step={0.5}
                value={shot.to}
                onChange={(e) => setShot(i, { to: Number(e.target.value) })}
                title="Ends at (seconds)"
              />
              <span className="muted small">s</span>
              <span className="spacer" />
              <button
                className="link danger"
                onClick={() => set({ shots: script.shots.filter((_, n) => n !== i) })}
              >
                remove
              </button>
            </div>
            <textarea
              className="param-input param-textarea"
              rows={2}
              placeholder="What happens in this shot."
              value={shot.text}
              onChange={(e) => setShot(i, { text: e.target.value })}
            />
          </div>
        ))}

        {/* A second one after the last shot, for when you are working down the
            list rather than reaching for the heading. */}
        <button
          className="add-shot add-shot-inline"
          onClick={() => set({ shots: [...script.shots, nextShot(script)] })}
        >
          + Add shot
        </button>

        {over && (
          <p className="warning small script-warn">
            The shots run to {runs}s but the clip is {clipSeconds}s. Anything past the end will not
            be generated.
          </p>
        )}

        <div className="panel panel-full">
          <div className="panel-label">Sound</div>
          <textarea
            className="param-input param-textarea"
            rows={2}
            placeholder="What the soundtrack does. H3 generates audio as well as picture."
            value={script.audio ?? ''}
            onChange={(e) => set({ audio: e.target.value })}
          />
        </div>

        <div className="panel panel-full">
          <div className="panel-label">Rules and things to avoid</div>
          <textarea
            className="param-input param-textarea"
            rows={2}
            placeholder="Hard cuts only, no dissolves, no subtitle bars, text must be legible…"
            value={script.rules ?? ''}
            onChange={(e) => set({ rules: e.target.value })}
          />
        </div>

        <details className="script-preview">
          <summary className="muted small">See the prompt this makes</summary>
          <pre className="mono small">{compose(script) || '(empty)'}</pre>
        </details>
      </div>
    </section>
  );
}
