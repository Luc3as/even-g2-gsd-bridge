import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename } from "node:path";
import { parseLine } from "./jsonl.js";
import { readProgress, formatProgress } from "./progress.js";
import { memoByStat } from "./statcache.js";

/**
 * A project the bridge can attach to: one gsd sessions dir → one logical
 * session on the glasses. sessionId is the dir slug (stable, opaque).
 */
export interface Project {
  /** Opaque even-terminal sessionId = the sessions-dir slug. */
  sessionId: string;
  /** Absolute project working directory (authoritative, from the jsonl). */
  cwd: string;
  /** Display name = basename(cwd). */
  name: string;
  /** tmux session name (sersám-compatible: non [A-Za-z0-9_-] → _). */
  tmuxName: string;
  /** Newest transcript file for this project (the active run). */
  newestJsonl: string | null;
  /** mtime of newestJsonl (ms), 0 if none. */
  mtimeMs: number;
  model?: string;
  title: string;
}

/** sersám's sname(): tr -c 'A-Za-z0-9_-' '_'. Must match so tmux targets line up. */
export function tmuxNameFor(cwd: string): string {
  return basename(cwd).replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Read a transcript's project cwd. gsd-native carries it on the {type:"session"}
 * first line; Claude-Code has no session line and leads with meta entries
 * (queue-operation/summary) that lack cwd, then message entries that carry it.
 * So scan a head window for the first entry exposing cwd — parseLine lifts CC's
 * top-level cwd onto the normalized RawEntry, so one read serves both formats.
 * Returns "" if none found (unreadable/foreign file → project skipped upstream).
 */
function readCwd(path: string, max = 16384): string {
  let head: string;
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(max);
      const n = readSync(fd, buf, 0, max, 0);
      head = buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
  // Drop the last split element: it may be a partial line at the window edge.
  const lines = head.split("\n").slice(0, -1);
  for (const line of lines) {
    const e = parseLine(line);
    if (e?.cwd) return e.cwd;
  }
  return "";
}

/**
 * Read a short title hint: the LATEST user prompt text. Scans a tail window so
 * the project-list subtitle tracks the newest command, not the session's first
 * one — the list is sorted by activity, so a frozen first-prompt subtitle reads
 * as stale ("even-g2 still shows the old command"). Lines are walked back-to-
 * front; the first user message found is the most recent. A partial line at the
 * window's leading edge just fails to parse and is skipped.
 */
function readTitleHint(path: string): string {
  try {
    const size = statSync(path).size;
    const window = 131072; // 128 KiB tail is enough to hold the last turn
    const start = Math.max(0, size - window);
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(size - start);
      const n = readSync(fd, buf, 0, buf.length, start);
      const lines = buf.subarray(0, n).toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const e = parseLine(lines[i]!);
        if (e?.type === "message" && e.message?.role === "user") {
          const c = e.message.content;
          const text =
            typeof c === "string"
              ? c
              : Array.isArray(c)
                ? (c.find((b: any) => b?.type === "text")?.text ?? "")
                : "";
          const clean = String(text).replace(/\s+/g, " ").trim();
          if (clean) return clean.slice(0, 48);
        }
        if (e?.type === "custom_message" && typeof e.content === "string") {
          const m = e.content.match(/S\d+|M\d+|auto-mode|slice|task/i);
          if (m) return `auto: ${m[0]}`;
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    /* ignore */
  }
  return "";
}

/** Live auto-mode progress as a subtitle, or "" when the project has no active
 * milestone (or the db is absent/unreadable — best-effort, never throws). */
function autoProgressSubtitle(cwd: string): string {
  const p = readProgress(cwd);
  return p ? formatProgress(p) : "";
}

// Newest-transcript scan cache per session dir. A full readdir+stat over every
// jsonl (~4.5k files across the stores) is most of an idle tick, so between full
// scans only the cached newest file is re-stat'd. The dir's own mtime moves on
// any create/delete, so a rotated-in file is caught on the very next tick (its
// first sight starts at EOF, so missing it would drop that turn's answer). An
// OLDER sibling resumed and appended to (newest flips without a dir mtime move)
// is caught by the periodic full rescan.
const FULL_RESCAN_MS = 10_000;
interface NewestScan {
  scannedAt: number;
  dirMtimeMs: number;
  best: { path: string; mtimeMs: number } | null;
}
const newestScans = new Map<string, NewestScan>();

function newestJsonlIn(dir: string, dirMtimeMs: number, now: number): { path: string; mtimeMs: number } | null {
  const hit = newestScans.get(dir);
  if (hit && hit.dirMtimeMs === dirMtimeMs && now - hit.scannedAt < FULL_RESCAN_MS) {
    if (!hit.best) return null;
    try {
      return { path: hit.best.path, mtimeMs: statSync(hit.best.path).mtimeMs };
    } catch {
      /* vanished without a dir mtime move (overlay fs?) → full scan */
    }
  }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const p = join(dir, f);
    const st = statSync(p);
    if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs };
  }
  newestScans.set(dir, { scannedAt: now, dirMtimeMs, best });
  return best;
}

/** Test seam: forget every cached newest-transcript scan. */
export function clearNewestScans(): void {
  newestScans.clear();
}

/**
 * Enumerate all attachable projects under the sessions dir, filtered to the
 * configured project roots. cwd is read from each transcript's session line
 * (the slug is lossy and must not be reverse-decoded).
 */
export function listProjects(sessionsDirs: string[], projectRoots: string[]): Project[] {
  // Merge across every session store (interactive ~/.gsd/sessions +
  // auto-mode ~/.gsd/agent/sessions). A project can appear in both; key by cwd
  // and keep whichever transcript is newest so live activity always wins.
  const byCwd = new Map<string, Project>();
  const now = Date.now();
  for (const sessionsDir of sessionsDirs) {
    if (!existsSync(sessionsDir)) continue;
    for (const slug of readdirSync(sessionsDir)) {
      const dir = join(sessionsDir, slug);
      let st;
      try {
        st = statSync(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const newest = newestJsonlIn(dir, st.mtimeMs, now);
      if (!newest) continue;
      // Head (cwd) + tail (latest prompt) reads are memoized on the transcript's
      // stat signature: an idle transcript costs one stat per tick, not 144 KiB
      // of reads + JSON parsing.
      const { cwd, hint } = memoByStat([newest.path], () => {
        const c = readCwd(newest.path);
        return { cwd: c, hint: c ? readTitleHint(newest.path) : "" };
      });
      if (!cwd) continue;
      // Skip worktree/internal dirs and anything outside the allowed roots.
      if (!projectRoots.some((root) => cwd === root || cwd.startsWith(root + "/"))) continue;
      if (cwd.includes("/.gsd/worktrees/") || cwd.includes("/.gsd-worktrees/")) continue;
      const existing = byCwd.get(cwd);
      if (existing && existing.mtimeMs >= newest.mtimeMs) continue; // older store loses
      byCwd.set(cwd, {
        sessionId: slug,
        cwd,
        name: basename(cwd),
        tmuxName: tmuxNameFor(cwd),
        newestJsonl: newest.path,
        mtimeMs: newest.mtimeMs,
        // A project mid auto-mode milestone shows live GSD progress as its
        // subtitle (that is the most relevant "what's happening" for the wearer);
        // otherwise the latest user prompt. DB read is read-only + best-effort.
        title: autoProgressSubtitle(cwd) || hint || basename(cwd),
      });
    }
  }
  // Most-recently-active first — mirrors sersám's live-on-top feel.
  return [...byCwd.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Enumerate projects that exist on disk under a root but have never run gsd
 * (no sessions dir yet), so the glasses can cold-start any project. These carry
 * a synthetic URL-safe sessionId and no transcript; the first prompt spawns gsd.
 */
export function listColdProjects(sessionsDirs: string[], projectRoots: string[]): Project[] {
  const sessionedCwds = new Set(listProjects(sessionsDirs, projectRoots).map((p) => p.cwd));
  const cold: Project[] = [];
  for (const root of projectRoots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue; // root missing/unreadable
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue; // hidden dirs are not projects
      const cwd = join(root, name);
      if (sessionedCwds.has(cwd)) continue; // already listed as a live/known session
      let st;
      try {
        st = statSync(cwd);
        if (!st.isDirectory()) continue;
      } catch {
        continue;
      }
      cold.push({
        sessionId: "cold_" + Buffer.from(cwd).toString("base64url"),
        cwd,
        name,
        tmuxName: tmuxNameFor(cwd),
        newestJsonl: null,
        // Dir mtime so recently-touched projects surface first (Even App
        // hard-caps the visible list at 10 entries — order is everything).
        mtimeMs: st.mtimeMs,
        title: name,
      });
    }
  }
  cold.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return cold;
}

/** Sessioned projects first (most-recent on top), then cold-start projects. */
export function listAttachable(sessionsDirs: string[], projectRoots: string[]): Project[] {
  return [...listProjects(sessionsDirs, projectRoots), ...listColdProjects(sessionsDirs, projectRoots)];
}

export function findProject(
  sessionsDirs: string[],
  projectRoots: string[],
  sessionId: string,
): Project | null {
  return listAttachable(sessionsDirs, projectRoots).find((p) => p.sessionId === sessionId) ?? null;
}
