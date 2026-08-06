/**
 * Read `.env` into the environment, if there is one.
 *
 * Addresses differ per machine — ComfyUI is on the loopback when Stack UI runs
 * on the GPU box, and across the network when you are developing from a
 * workstation. That belongs in an untracked file next to the code, not baked
 * into the source, where it once was and had to be changed in five places.
 *
 * `process.loadEnvFile` is Node's own, so there is no dependency. It throws
 * when the file is absent, which is the normal case.
 */
export function loadEnvFile(path: string): void {
  try {
    process.loadEnvFile(path);
  } catch {
    /* no .env — defaults apply */
  }
}
