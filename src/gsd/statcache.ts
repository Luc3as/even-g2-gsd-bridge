import { statSync } from "node:fs";

/**
 * Memoize a value derived from a set of files on their stat signature
 * (mtime+size). The tailer re-derives every project's cwd/title/progress/
 * liveness/blocker state on every tick (500ms) across ~80 session dirs and
 * ~30 project .gsd dirs, and nearly none of it changes tick-to-tick — before this
 * cache one tick cost about as long as the interval and pegged a core at idle.
 * A stat per input file is the only per-tick cost on a hit. A missing file
 * signs as "-" so appear/disappear invalidates too. Cached values are shared by
 * reference: callers must treat them as read-only.
 */
const cache = new Map<string, { sig: string; value: unknown }>();

function sigOf(paths: string[]): string {
  let sig = "";
  for (const p of paths) {
    try {
      const st = statSync(p);
      sig += `${st.mtimeMs}:${st.size}|`;
    } catch {
      sig += "-|";
    }
  }
  return sig;
}

export function memoByStat<T>(paths: string[], compute: () => T): T {
  const key = paths.join("\0");
  const sig = sigOf(paths);
  const hit = cache.get(key);
  if (hit && hit.sig === sig) return hit.value as T;
  const value = compute();
  cache.set(key, { sig, value });
  return value;
}

/** Test seam: drop every memoized value. */
export function clearStatCache(): void {
  cache.clear();
}
