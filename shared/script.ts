/**
 * Assembling a shot list into the single prompt string a model expects.
 *
 * The format follows ComfyUI's own MiniMax H3 template, which is the only
 * evidence available about what H3 was trained to read:
 *
 *   <overall look, palette, mood>
 *
 *   Timeline:
 *   [0s-1s] first shot
 *   [1s-2.5s] second shot
 *
 *   <transition rules>
 *
 *   Audio: <soundtrack>
 *
 * Empty sections are left out entirely rather than emitted as empty headings.
 */

import type { Script, Shot } from './types.ts';

/** Seconds as the template writes them: whole numbers bare, otherwise one dp. */
const t = (n: number) => (Number.isInteger(n) ? `${n}s` : `${n.toFixed(1)}s`);

export const shotLine = (s: Shot) => `[${t(s.from)}-${t(s.to)}] ${s.text.trim()}`;

export function compose(script: Script): string {
  const parts: string[] = [];

  if (script.vision.trim()) parts.push(script.vision.trim());

  const shots = script.shots.filter((s) => s.text.trim());
  if (shots.length) parts.push(['Timeline:', ...shots.map(shotLine)].join('\n'));

  if (script.rules?.trim()) parts.push(script.rules.trim());
  if (script.audio?.trim()) parts.push(`Audio: ${script.audio.trim()}`);

  return parts.join('\n\n');
}

/** Total run time implied by the shot list, for checking against the clip length. */
export const scriptDuration = (script: Script) =>
  script.shots.reduce((max, s) => Math.max(max, s.to), 0);

/** A sensible next shot: starts where the last one ended. */
export function nextShot(script: Script): Shot {
  const last = script.shots[script.shots.length - 1];
  const from = last ? last.to : 0;
  return { from, to: from + 2, text: '' };
}
