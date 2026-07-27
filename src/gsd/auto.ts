import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.js";

/**
 * READ-ONLY view of a project's GSD auto-mode liveness and failure channel, for
 * surfacing crashes/stops on the glasses. The desk `gsd` owns every write here;
 * the bridge only reads the artifacts gsd already emits:
 *
 *   .gsd/auto.lock          — present only while an auto-run holds it. Carries the
 *                             owning pid + the unit it is on. pid alive → running;
 *                             pid dead + lock still present → the run died mid-unit
 *                             (crash/kill) without releasing the lock. This is the
 *                             authoritative liveness signal — far better than the
 *                             jsonl-mtime guess, which can't tell "finished" from
 *                             "died" (both just stop writing).
 *   .gsd/notifications.jsonl — gsd's own structured failure channel. One JSON
 *                             object per line {id, ts, severity, message, source}.
 *                             severity ∈ info | warning | error. The wearer misses
 *                             these because the bridge never surfaced them; this
 *                             reader lifts the serious ones so the tailer can push
 *                             an alarm.
 *
 * Nothing here throws — a missing/locked/corrupt artifact degrades to "no signal",
 * never crashes the tailer.
 */

export type AutoLiveness = "running" | "stopped" | "none";

export interface AutoState {
  liveness: AutoLiveness;
  /** Unit the run is on / died on (e.g. "M013/S02"), when the lock carries it. */
  unitId: string | null;
  /** Unit type (e.g. "run-uat", "execute-task"), when the lock carries it. */
  unitType: string | null;
  /** Owning pid, when the lock carries it. */
  pid: number | null;
}

interface LockShape {
  pid?: number;
  unitType?: string;
  unitId?: string;
}

function pidAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering a
    // signal: it throws ESRCH when no such process exists (dead), EPERM when it
    // exists but we can't signal it (alive, different owner — still "alive").
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read auto-mode liveness for a project. "running" = lock held by a live pid;
 * "stopped" = lock present but its pid is dead (died mid-unit); "none" = no lock
 * (not in auto-mode). unitId/unitType/pid are lifted from the lock when present.
 */
export function readAutoState(cwd: string): AutoState {
  const lockPath = join(cwd, ".gsd", "auto.lock");
  if (!existsSync(lockPath)) return { liveness: "none", unitId: null, unitType: null, pid: null };
  let lock: LockShape;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8")) as LockShape;
  } catch (err) {
    // A half-written lock (gsd writes atomically via a .tmp rename, so this is
    // rare) is not a liveness signal — treat as no decisive state.
    log.debug("auto", `lock parse failed for ${cwd}: ${(err as Error).message}`);
    return { liveness: "none", unitId: null, unitType: null, pid: null };
  }
  const pid = typeof lock.pid === "number" ? lock.pid : null;
  const unitId = typeof lock.unitId === "string" ? lock.unitId : null;
  const unitType = typeof lock.unitType === "string" ? lock.unitType : null;
  // No pid in the lock → can't judge liveness; assume running (a lock exists).
  const liveness: AutoLiveness = pid == null ? "running" : pidAlive(pid) ? "running" : "stopped";
  return { liveness, unitId, unitType, pid };
}

export interface Notification {
  id: string;
  ts: string;
  severity: "info" | "warning" | "error";
  message: string;
  source: string;
}

// Warnings are noisy (routine idle-recovery, heartbeat catch-up). Only the
// pause/halt/blocker family is a real "auto-mode stopped or is stuck" signal the
// wearer needs mid-drive; the rest ([engine] gate failed … "continuing", file-
// change audits) are recovered in-run and would be alarm fatigue. `error`
// severity is always surfaced (all 10 observed were genuine safety/cap/collision
// halts), so this filter only gates warnings.
const SERIOUS_WARNING =
  /\b(paus\w+|paused|blocker|blocked|pre-execution checks failed|hit per-unit cap|another auto-mode session)\b/i;

function isSerious(n: Notification): boolean {
  if (n.severity === "error") return true;
  if (n.severity === "warning") return SERIOUS_WARNING.test(n.message);
  return false;
}

/** Tail-read the last N lines of a file without loading the whole thing. */
function tailLines(path: string, maxBytes = 65536): string[] {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - maxBytes);
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(size - start);
      const n = readSync(fd, buf, 0, buf.length, start);
      return buf.subarray(0, n).toString("utf8").split("\n");
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}

/**
 * The most recent SERIOUS (error, or pause/halt-class warning) notification for a
 * project, or null when there are none. Reads only the tail of the log. Note gsd
 * leaves `read:false` even on consumed entries, so callers must dedup by `id`,
 * not the read flag (see watch.ts alarm dedup).
 */
export function latestSeriousNotification(cwd: string): Notification | null {
  const path = join(cwd, ".gsd", "notifications.jsonl");
  if (!existsSync(path)) return null;
  const lines = tailLines(path);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let n: Notification;
    try {
      n = JSON.parse(line) as Notification;
    } catch {
      continue; // partial line at the window's leading edge
    }
    if (n && typeof n.id === "string" && isSerious(n)) return n;
  }
  return null;
}
