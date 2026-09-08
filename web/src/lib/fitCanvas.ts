import type { CanvasFit, Stack } from '@shared/types.ts';

/** H3's own default is 1344x768. Keep to about that many pixels. */
const DEFAULT_PIXELS = 1344 * 768;

/**
 * The output size that matches an image's shape.
 *
 * Both sides land on a multiple of 32, which is what the model's latent grid
 * and its patchify step need — and what a start frame in particular needs, see
 * shared/guideSize.ts.
 *
 * Pixel count is held roughly constant rather than a fixed long edge, so a tall
 * portrait poster and a wide banner cost about the same to render and both sit
 * inside the budget the model works well within.
 */
export function fitToAspect(
  imageWidth: number,
  imageHeight: number,
  pixels = DEFAULT_PIXELS,
): { width: number; height: number } | null {
  if (!(imageWidth > 0) || !(imageHeight > 0)) return null;
  const aspect = imageWidth / imageHeight;

  /**
   * Search rather than scale.
   *
   * Scaling to the budget and snapping each side to 32 leaves the shape up to
   * two percent out, because the two roundings are independent. Trying every
   * legal width and keeping the best pairing finds the sizes where the ratio
   * comes out exact — 16:9 is 1536x864, not the 1344x768 that scaling lands on
   * — and settles for a near miss only when there is no exact one.
   *
   * Shape is weighted far above size: a poster at the wrong aspect is visibly
   * squeezed, while a render twenty percent off the pixel budget is only
   * slightly slower.
   */
  let best: { width: number; height: number; score: number } | null = null;

  for (let width = 512; width <= 2048; width += 32) {
    const height = Math.max(32, Math.round(width / aspect / 32) * 32);
    if (height < 512 || height > 2048) continue;

    const shapeError = Math.abs(width / height / aspect - 1);
    const sizeError = Math.abs(Math.log((width * height) / pixels));
    const score = shapeError * 100 + sizeError;

    if (!best || score < best.score) best = { width, height, score };
  }

  return best ? { width: best.width, height: best.height } : null;
}

/** The natural size of an image already uploaded to ComfyUI's input folder. */
export function measureUpload(filename: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (!filename) return resolve(null);
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = `/comfy/view?filename=${encodeURIComponent(filename)}&subfolder=&type=input`;
  });
}

export type { CanvasFit };

/**
 * The stack with its canvas already sized from the artwork.
 *
 * The effect that watches the upload does the same thing, but it cannot be
 * relied on: measuring means downloading the poster, which takes seconds over
 * the network, and pressing Generate before that lands submitted the previous
 * size. Doing it here as well makes the submitted graph correct regardless of
 * timing — the effect keeps the fields honest on screen, this keeps the render
 * honest.
 *
 * Returns the stack unchanged when there is nothing to do, so callers can use
 * it unconditionally.
 */
export async function withFittedCanvas(
  stack: Stack,
  setParam: (s: Stack, tileId: string, param: string, value: unknown) => Stack,
  inputKindOf: (tileId: string) => string | null,
): Promise<Stack> {
  const fit = stack.canvas;
  if (!fit) return stack;

  const source = stack.lines
    .flatMap((l) => l.tiles)
    .find((tile) => inputKindOf(tile.id) === fit.from.inputKind);
  const filename = String(source?.params[fit.from.param] ?? '');
  if (!filename) return stack;

  const size = await measureUpload(filename);
  if (!size) return stack;

  const box = fitToAspect(size.width, size.height, fit.pixels);
  if (!box) return stack;

  const out = setParam(stack, fit.width.tileId, fit.width.param, box.width);
  return setParam(out, fit.height.tileId, fit.height.param, box.height);
}
