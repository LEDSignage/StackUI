import type { Preset, Stack } from '@shared/types.ts';

/**
 * One-click setups, above the controls they fill in.
 *
 * Most of what makes a good clip is the wording of the prompt, and re-typing a
 * careful paragraph every time is how it stops being careful. These are those
 * paragraphs, kept with the pipeline, behind a button.
 *
 * A preset is a starting point, not a mode: it writes values into the ordinary
 * controls and then gets out of the way, so anything can be edited afterwards.
 * The one whose values are all still in place is marked, which is only a
 * reflection of the fields — edit the prompt and the mark goes.
 */
export function PresetBar({
  presets,
  stack,
  onApply,
}: {
  presets: Preset[];
  stack: Stack;
  onApply: (preset: Preset) => void;
}) {
  const tiles = stack.lines.flatMap((l) => l.tiles);
  const applied = (p: Preset) =>
    p.values.every((v) => tiles.find((t) => t.id === v.tileId)?.params[v.param] === v.value);

  return (
    <section className="use-group">
      <h3 className="use-group-title">Start from</h3>
      <div className="presets">
        {presets.map((p) => (
          <button
            key={p.id}
            className={`preset ${applied(p) ? 'preset-on' : ''}`}
            onClick={() => onApply(p)}
            title={p.hint ?? ''}
          >
            {p.label}
          </button>
        ))}
      </div>
    </section>
  );
}
