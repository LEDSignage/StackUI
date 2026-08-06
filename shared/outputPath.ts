import { resolve, sep } from 'node:path';

/**
 * The absolute path of a file inside the output folder, or null if it is not
 * one.
 *
 * Resolve first, then check where you landed. Screening the input for ".."
 * looks equivalent and is not: an absolute path, a drive letter, or a mix of
 * separators all get past that check — and the caller is asking us to delete
 * whatever comes back.
 *
 * Lives here rather than in the server so it can be tested without starting a
 * listener.
 */
export function insideOutput(dir: string, subfolder: string, filename: string): string | null {
  const root = resolve(dir);
  const target = resolve(root, subfolder, filename);
  return target !== root && target.startsWith(root + sep) ? target : null;
}
