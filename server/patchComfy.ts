import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Keep ComfyUI's MiniMax guide-frame fix in place.
 *
 * ComfyUI pads the main video latent to the model's patch size and does not do
 * the same to the start/end-frame latent, so any dimension where `size / 16`
 * lands on an odd number dies in a reshape before the model runs. 1920x1080 is
 * one of them. The fix is one line; the problem is that a ComfyUI update puts
 * the original file back and the crash returns with no warning.
 *
 * So it is checked and reapplied every time this server starts. It is another
 * application's source, so: one line only, a .bak kept beside it, and if the
 * code no longer looks the way this expects it does nothing at all and says so
 * rather than guessing.
 *
 * ComfyUI reads the file at its own startup, so a patch applied while it is
 * running takes effect on its next restart. The log says as much.
 */

/** The line to patch, with whatever indentation it happens to have. */
const TARGET = /(?<indent>[ \t]*)r = patchify_video\(z\.to\(torch\.float32\), self\.patch_size\)/;

const FIX = 'z = comfy.ldm.common_dit.pad_to_patch_size(z, self.patch_size)';

export type PatchResult =
  | { state: 'patched'; file: string }
  | { state: 'already'; file: string }
  | { state: 'not-found' }
  | { state: 'changed'; file: string }
  | { state: 'failed'; error: string };

/** Where ComfyUI might be, on the machine this server is running on. */
function candidates(): string[] {
  const local = process.env.LOCALAPPDATA;
  return [
    process.env.COMFY_DIR,
    local && join(local, 'Comfy-Desktop', 'ComfyUI-Installs'),
    local && join(local, 'Programs', '@comfyorgcomfyui-electron'),
    'C:\\ComfyUI',
    join(process.env.HOME ?? '', 'ComfyUI'),
  ].filter((p): p is string => Boolean(p) && existsSync(p!));
}

/** Depth-limited search: the installs live a few levels down, not twenty. */
async function findModel(root: string, depth = 6): Promise<string | null> {
  if (depth < 0) return null;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.venv') continue;
    const here = join(root, entry.name);
    if (entry.name === 'minimax' && existsSync(join(here, 'model.py'))) {
      // Confirm it is the one we mean, not some other minimax folder.
      if (dirname(dirname(here)).endsWith('comfy')) return join(here, 'model.py');
      if (here.includes(join('comfy', 'ldm'))) return join(here, 'model.py');
    }
    const found = await findModel(here, depth - 1);
    if (found) return found;
  }
  return null;
}

export async function patchComfy(): Promise<PatchResult> {
  try {
    let file: string | null = null;
    for (const root of candidates()) {
      file = await findModel(root);
      if (file) break;
    }
    if (!file) return { state: 'not-found' };

    const text = await readFile(file, 'utf8');
    if (text.includes('pad_to_patch_size(z,')) return { state: 'already', file };

    const match = TARGET.exec(text);
    if (!match) return { state: 'changed', file };

    const indent = match.groups?.indent ?? '        ';
    const patched = text.replace(TARGET, `${indent}${FIX}\n${match[0]}`);

    const backup = `${file}.stackui.bak`;
    if (!existsSync(backup)) await copyFile(file, backup);
    await writeFile(file, patched, 'utf8');
    return { state: 'patched', file };
  } catch (err) {
    return { state: 'failed', error: (err as Error).message };
  }
}

/** One line on startup, saying what it found and what it did. */
export function describe(result: PatchResult): string {
  switch (result.state) {
    case 'patched':
      return `ComfyUI guide-frame fix  →  applied to ${result.file}\n                            restart ComfyUI for it to take effect`;
    case 'already':
      return 'ComfyUI guide-frame fix  →  already in place';
    case 'not-found':
      return 'ComfyUI guide-frame fix  →  ComfyUI not found on this machine (set COMFY_DIR)';
    case 'changed':
      return `ComfyUI guide-frame fix  →  skipped: ${result.file} no longer matches, left untouched`;
    case 'failed':
      return `ComfyUI guide-frame fix  →  failed: ${result.error}`;
  }
}
