import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename } from "node:path";
import { parseLine } from "./jsonl.js";

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

/** Read just the first line of a file cheaply (session meta lives there). */
function readFirstLine(path: string, max = 4096): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    const s = buf.subarray(0, n).toString("utf8");
    const nl = s.indexOf("\n");
    return nl >= 0 ? s.slice(0, nl) : s;
  } finally {
    closeSync(fd);
  }
}

/** Read a short title hint: first user prompt text, scanning a small window. */
function readTitleHint(path: string): string {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(65536);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const chunk = buf.subarray(0, n).toString("utf8");
      for (const line of chunk.split("\n")) {
        const e = parseLine(line);
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

function newestJsonlIn(dir: string): { path: string; mtimeMs: number } | null {
  let best: { path: string; mtimeMs: number } | null = null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const p = join(dir, f);
    const st = statSync(p);
    if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs };
  }
  return best;
}

/**
 * Enumerate all attachable projects under the sessions dir, filtered to the
 * configured project roots. cwd is read from each transcript's session line
 * (the slug is lossy and must not be reverse-decoded).
 */
export function listProjects(sessionsDir: string, projectRoots: string[]): Project[] {
  if (!existsSync(sessionsDir)) return [];
  const projects: Project[] = [];
  for (const slug of readdirSync(sessionsDir)) {
    const dir = join(sessionsDir, slug);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const newest = newestJsonlIn(dir);
    if (!newest) continue;
    let cwd = "";
    let model: string | undefined;
    try {
      const first = parseLine(readFirstLine(newest.path));
      if (first?.type === "session") cwd = first.cwd ?? "";
    } catch {
      /* skip unreadable */
    }
    if (!cwd) continue;
    // Skip worktree/internal dirs and anything outside the allowed roots.
    if (!projectRoots.some((root) => cwd === root || cwd.startsWith(root + "/"))) continue;
    if (cwd.includes("/.gsd/worktrees/")) continue;
    projects.push({
      sessionId: slug,
      cwd,
      name: basename(cwd),
      tmuxName: tmuxNameFor(cwd),
      newestJsonl: newest.path,
      mtimeMs: newest.mtimeMs,
      model,
      title: readTitleHint(newest.path) || basename(cwd),
    });
  }
  // Most-recently-active first — mirrors sersám's live-on-top feel.
  projects.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return projects;
}

/**
 * Enumerate projects that exist on disk under a root but have never run gsd
 * (no sessions dir yet), so the glasses can cold-start any project. These carry
 * a synthetic URL-safe sessionId and no transcript; the first prompt spawns gsd.
 */
export function listColdProjects(sessionsDir: string, projectRoots: string[]): Project[] {
  const sessionedCwds = new Set(listProjects(sessionsDir, projectRoots).map((p) => p.cwd));
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
      try {
        if (!statSync(cwd).isDirectory()) continue;
      } catch {
        continue;
      }
      cold.push({
        sessionId: "cold_" + Buffer.from(cwd).toString("base64url"),
        cwd,
        name,
        tmuxName: tmuxNameFor(cwd),
        newestJsonl: null,
        mtimeMs: 0,
        title: name,
      });
    }
  }
  cold.sort((a, b) => a.name.localeCompare(b.name));
  return cold;
}

/** Sessioned projects first (most-recent on top), then cold-start projects. */
export function listAttachable(sessionsDir: string, projectRoots: string[]): Project[] {
  return [...listProjects(sessionsDir, projectRoots), ...listColdProjects(sessionsDir, projectRoots)];
}

export function findProject(
  sessionsDir: string,
  projectRoots: string[],
  sessionId: string,
): Project | null {
  return listAttachable(sessionsDir, projectRoots).find((p) => p.sessionId === sessionId) ?? null;
}
