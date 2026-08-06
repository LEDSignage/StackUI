/**
 * Random ids that work over plain HTTP.
 *
 * `crypto.randomUUID()` is restricted to secure contexts. Browsers make an
 * exception for localhost, so it works throughout development and then throws
 * the moment the app is served from a LAN address over http — at module load,
 * before React mounts, giving a blank page with no visible error.
 *
 * `crypto.getRandomValues` has no such restriction, so use that when it is
 * there and fall back to Math.random only if it is not. These ids name tiles
 * and identify a websocket client; they are not security-sensitive.
 */

const hex = (n: number) => n.toString(16).padStart(2, '0');

function randomBytes(count: number): number[] {
  const out = new Uint8Array(count);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < count; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return [...out];
}

/** A UUID-shaped string. Uses the platform's own generator where allowed. */
export function uuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    try {
      return globalThis.crypto.randomUUID();
    } catch {
      /* secure-context restriction — fall through */
    }
  }
  const b = randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variant
  const s = b.map(hex).join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** A short id, for naming tiles and lines. */
export const shortId = () => uuid().slice(0, 8);
