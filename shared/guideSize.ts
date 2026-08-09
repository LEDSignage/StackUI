import type { ApiPrompt } from './types.ts';

/**
 * Work around ComfyUI's guide-frame crash without touching your numbers.
 *
 * MiniMaxH3ImageToVideo builds its empty latent with `height // 16`, and the
 * model pads that to the patch size — but the start/end frame is encoded and
 * patchified with no padding at all. Where `size / 16` lands on an odd number
 * the two disagree and torch refuses the reshape, six seconds in, with a
 * message about tensor shapes and nothing you could act on. 1920x1080 is one
 * such size, which is how standard a size has to be to hit this.
 *
 * So the job goes out at the next multiple of 32 and the extra pixels are cut
 * off the finished file — see /api/fit. You type 1080 and you get 1080.
 *
 * Only when a guide frame is actually attached: without one the crashing code
 * never runs, and rounding would change the output for no reason.
 */

/** ComfyUI's own step for these inputs, and what the patchify needs. */
const GRID = 32;

const up = (n: number) => Math.ceil(n / GRID) * GRID;

export type SizeFix = {
  /** What was asked for. */
  width: number;
  height: number;
  /** What was submitted. */
  sentWidth: number;
  sentHeight: number;
};

/**
 * Rewrites the prompt in place and reports what it changed, or null if nothing
 * needed changing.
 */
export function fixGuideSize(prompt: ApiPrompt): SizeFix | null {
  for (const node of Object.values(prompt)) {
    if (node.class_type !== 'MiniMaxH3ImageToVideo') continue;

    const hasGuide = node.inputs.first_frame !== undefined || node.inputs.last_frame !== undefined;
    if (!hasGuide) continue;

    const width = Number(node.inputs.width);
    const height = Number(node.inputs.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue;

    const sentWidth = up(width);
    const sentHeight = up(height);
    if (sentWidth === width && sentHeight === height) continue;

    node.inputs.width = sentWidth;
    node.inputs.height = sentHeight;
    return { width, height, sentWidth, sentHeight };
  }
  return null;
}
