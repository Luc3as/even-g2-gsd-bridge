import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.js";
import { memoByStat } from "./statcache.js";

/**
 * READ-ONLY view of a project's GSD auto-mode progress, for surfacing on the
 * glasses. The desk `gsd` owns the write connection to `.gsd/gsd.db`; the bridge
 * is a separate process and MUST NOT write. SQLite WAL mode allows any number of
 * concurrent readers alongside the single writer, so a `readOnly` connection is
 * safe and never contends for the write lock. We cannot use the `gsd_*` MCP tools
 * here: those bind to the workflow server's own cwd, not the arbitrary project a
 * glasses session is viewing.
 *
 * Schema (confirmed live): exactly one `milestones` row has status='active'; that
 * is the target. `slices`/`tasks` status ∈ {pending, complete}, keyed by
 * milestone_id (+ slice_id). Slice/task order is by `id` (S01, S02, … / T01 …),
 * which is zero-padded so lexicographic sort is correct; `sequence` is unreliable
 * (many zeros).
 */

/** One slice's or task's id + raw DB status ("complete", "pending", "skipped", …). */
export interface UnitStatus {
  id: string;
  status: string;
}

export interface Progress {
  milestoneId: string;
  slicesDone: number;
  slicesTotal: number;
  /** First pending slice — what auto-mode is working now. null when all done. */
  activeSliceId: string | null;
  /** Title of the active slice, for the richer live-stream line. */
  activeSliceTitle: string | null;
  tasksDone: number;
  tasksTotal: number;
  /** First pending task in the active slice — the unit in flight. null if none. */
  activeTaskId: string | null;
  /** Title of the active task. */
  activeTaskTitle: string | null;
  /** Every slice of the milestone, ordered by id, with raw DB status — the
   * dashboard's ✓-range line needs individual statuses, not just counts. */
  slices: UnitStatus[];
  /** Tasks of the ACTIVE slice only, ordered by id (glyph row ✓T01 ●T02 ○T03).
   * Empty when no slice is active. */
  tasks: UnitStatus[];
}

/**
 * Read the active-milestone progress for a project, or null when there is no db,
 * no active milestone, or the read fails. Never throws — a broken/locked db must
 * degrade to "no progress shown", not crash the tailer.
 */
export function readProgress(cwd: string): Progress | null {
  const dbPath = join(cwd, ".gsd", "gsd.db");
  if (!existsSync(dbPath)) return null;
  // Memoized on the db + WAL stat signature (gsd runs WAL, so a write lands in
  // -wal first and the main file's mtime only moves on checkpoint).
  return memoByStat([dbPath, dbPath + "-wal"], () => queryProgress(cwd, dbPath));
}

function queryProgress(cwd: string, dbPath: string): Progress | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const m = db
      .prepare("SELECT id FROM milestones WHERE status = 'active' ORDER BY id LIMIT 1")
      .get() as { id: string } | undefined;
    if (!m) return null;

    const slices = db
      .prepare("SELECT id, title, status FROM slices WHERE milestone_id = ? ORDER BY id")
      .all(m.id) as { id: string; title: string; status: string }[];
    const slicesDone = slices.filter((s) => s.status === "complete").length;
    const activeSlice = slices.find((s) => s.status !== "complete") ?? null;

    let tasksDone = 0;
    let tasksTotal = 0;
    let activeTask: { id: string; title: string } | null = null;
    let tasks: { id: string; title: string; status: string }[] = [];
    if (activeSlice) {
      tasks = db
        .prepare("SELECT id, title, status FROM tasks WHERE milestone_id = ? AND slice_id = ? ORDER BY id")
        .all(m.id, activeSlice.id) as { id: string; title: string; status: string }[];
      tasksTotal = tasks.length;
      tasksDone = tasks.filter((t) => t.status === "complete").length;
      const pending = tasks.find((t) => t.status !== "complete");
      if (pending) activeTask = { id: pending.id, title: pending.title };
    }

    return {
      milestoneId: m.id,
      slicesDone,
      slicesTotal: slices.length,
      activeSliceId: activeSlice ? activeSlice.id : null,
      activeSliceTitle: activeSlice ? activeSlice.title : null,
      tasksDone,
      tasksTotal,
      activeTaskId: activeTask ? activeTask.id : null,
      activeTaskTitle: activeTask ? activeTask.title : null,
      slices: slices.map((s) => ({ id: s.id, status: s.status })),
      tasks: tasks.map((t) => ({ id: t.id, status: t.status })),
    };
  } catch (err) {
    log.debug("progress", `read failed for ${cwd}: ${(err as Error).message}`);
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* best effort */
    }
  }
}

// GSD's auto-mode heartbeat TTL. GSD hardcodes HEARTBEAT_TTL_SECONDS=60
// (db/auto-workers.js) and does not export it to foreign readers, so we mirror
// the constant here. IMPORTANT (proven live on Yummy 2026-07-28): the worker
// heartbeat is stamped only at the TOP of each auto-loop iteration — once per
// UNIT, i.e. every ~4-8 minutes — never during unit execution. So during a
// perfectly healthy run the heartbeat is stale for most of every unit, and a
// stale beat alone must NOT be read as "stopped" (that false alarm is exactly
// the lie the wearer saw). GSD's own stale-worker logic pairs the lapsed TTL
// with an OS pid check (auto/loop.js isDeadLocalLeaseHolder); we do the same.
const HEARTBEAT_TTL_MS = 60_000;

export type AutoDbLiveness = "running" | "quiet" | "stopped";

export interface AutoDbState {
  liveness: AutoDbLiveness;
  /** ms since the last observed evidence of progress (heartbeat or unit/activity
   * artifact write). Only meaningful for "quiet"; null otherwise. */
  quietForMs: number | null;
}

/** Signal-0 pid probe: ESRCH → dead; EPERM → alive but unsignalable (still alive). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Newest evidence-of-progress mtime GSD leaves on disk during a run, in epoch ms,
 * or null when nothing is readable. Two sources, both written mid-run when the DB
 * heartbeat is silent:
 *   .gsd/runtime/units/*.json — unit runtime records, touched at dispatch/progress/
 *                               finalize (a handful of files; stat each).
 *   .gsd/activity/NNN-*.jsonl — per-unit transcripts, appended as the unit's agent
 *                               works. Files are numbered; parse the prefix and
 *                               stat only the highest-numbered one (lexicographic
 *                               sort breaks at 999→1000).
 */
function newestArtifactMtime(cwd: string): number | null {
  let newest: number | null = null;
  const consider = (ms: number) => {
    if (newest === null || ms > newest) newest = ms;
  };
  try {
    const unitsDir = join(cwd, ".gsd", "runtime", "units");
    for (const name of readdirSync(unitsDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        consider(statSync(join(unitsDir, name)).mtimeMs);
      } catch {
        /* file vanished mid-scan */
      }
    }
  } catch {
    /* no units dir */
  }
  try {
    const actDir = join(cwd, ".gsd", "activity");
    let bestNum = -1;
    let bestName: string | null = null;
    for (const name of readdirSync(actDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const num = parseInt(name, 10);
      if (Number.isNaN(num) || num <= bestNum) continue;
      bestNum = num;
      bestName = name;
    }
    if (bestName) consider(statSync(join(actDir, bestName)).mtimeMs);
  } catch {
    /* no activity dir */
  }
  return newest;
}

/**
 * Authoritative auto-mode liveness from GSD's `workers` table, or null when it
 * can't be read (no db, no workers table, read error) so the caller can fall back
 * to the lock-file reader. Match on `project_root_realpath` (GSD stores the
 * resolved realpath) and take the freshest active row — the table accumulates
 * stale `stopping` rows, so filtering to `active` + newest heartbeat keeps an old
 * row from masking a live run and vice-versa.
 *
 * Three-state verdict — "stopped" only on hard evidence, so the lens never lies:
 *   fresh active row (heartbeat within TTL)     → "running"
 *   stale active row, worker pid ALIVE          → "quiet"  (unit executing; the
 *     heartbeat only ticks at unit boundaries — see HEARTBEAT_TTL_MS note. The
 *     age of the freshest progress evidence is reported as quietForMs so callers
 *     can raise a soft stall warning when it grows absurd, instead of a false
 *     definitive "stopped".)
 *   no active row, or stale + worker pid DEAD   → "stopped"
 *   no db / no workers table / read failure     → null (caller falls back to lock)
 *
 * Never throws — mirrors readProgress: a broken/locked db degrades to null.
 * `alive` is injectable for tests.
 */
export function readAutoLiveness(cwd: string, now = Date.now(), alive: (pid: number) => boolean = pidAlive): AutoDbState | null {
  const dbPath = join(cwd, ".gsd", "gsd.db");
  if (!existsSync(dbPath)) return null;

  // GSD keys workers by the resolved realpath; resolve cwd the same way so a
  // symlinked project path still matches. Fall back to the raw cwd if realpath
  // fails (e.g. a path that no longer exists), matching how GSD degrades.
  let root = cwd;
  try {
    root = realpathSync(cwd);
  } catch {
    /* keep raw cwd */
  }

  // The row fetch (and a read failure) is memoized on the db + WAL stat
  // signature; the time/pid verdict below is re-derived every call since it
  // moves without a db write.
  const row = memoByStat([dbPath, dbPath + "-wal", root], () => queryWorkerRow(cwd, dbPath, root));
  if (row === null) return null;
  if (!row) return { liveness: "stopped", quietForMs: null }; // no live worker (only stopping/crashed, or none)
  const beat = Date.parse(row.last_heartbeat_at);
  if (Number.isNaN(beat)) return { liveness: "stopped", quietForMs: null }; // unparseable timestamp → treat as not-live
  if (now - beat <= HEARTBEAT_TTL_MS) return { liveness: "running", quietForMs: null };
  // Stale beat: only a dead worker process makes that "stopped"; an alive one
  // is mid-unit (the loop stamps the beat once per unit). No/invalid pid on the
  // row → can't verify life → treat as stopped, matching GSD's own janitor.
  if (typeof row.pid !== "number" || !Number.isInteger(row.pid) || row.pid <= 0 || !alive(row.pid)) {
    return { liveness: "stopped", quietForMs: null };
  }
  const lastSeen = Math.max(beat, newestArtifactMtime(cwd) ?? 0);
  return { liveness: "quiet", quietForMs: Math.max(0, now - lastSeen) };
}

type WorkerRow = { last_heartbeat_at: string; pid: number | null };

/** Freshest active workers row for the project root: undefined when there is
 * none, null when the db can't be read (no workers table on older gsd / a fresh
 * project, or a read error) so the caller keeps its lock-file verdict. */
function queryWorkerRow(cwd: string, dbPath: string, root: string): WorkerRow | undefined | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return db
      .prepare(
        "SELECT last_heartbeat_at, pid FROM workers " +
          "WHERE project_root_realpath = ? AND status = 'active' " +
          "ORDER BY last_heartbeat_at DESC LIMIT 1",
      )
      .get(root) as WorkerRow | undefined;
  } catch (err) {
    log.debug("progress", `liveness read failed for ${cwd}: ${(err as Error).message}`);
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* best effort */
    }
  }
}

/**
 * Compact one-line progress string for the 576x288 lens. `▶` is a proven-visible
 * geometric glyph (see KNOWLEDGE). Examples:
 *   "M013 ▶ S05 · 4/8 slices · T2/5"   (active slice with tasks)
 *   "M013 ▶ S05 · 4/8 slices"          (active slice, no tasks planned yet)
 *   "M013 ✓ 8/8 slices"                (all slices done, milestone finishing)
 */
export function formatProgress(p: Progress): string {
  if (!p.activeSliceId) {
    return `${p.milestoneId} ✓ ${p.slicesDone}/${p.slicesTotal} slices`;
  }
  const base = `${p.milestoneId} ▶ ${p.activeSliceId} · ${p.slicesDone}/${p.slicesTotal} slices`;
  return p.tasksTotal > 0 ? `${base} · T${p.tasksDone}/${p.tasksTotal}` : base;
}

/** Trim a slice/task title to fit one lens line; keeps the head, adds `…`. */
function clip(s: string, max = 40): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/**
 * Bridge-side wall-clock elapsed since the current count-state was first seen,
 * as `+2m14s` / `+45s`. This is honest motion the bridge CAN produce: it is not
 * the auto-run's real task start (which the bridge, a foreign db reader, cannot
 * see) but the age of the current slice/task snapshot on the wire — enough to
 * show the wearer that work is live and not stalled between completions.
 */
export function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `+${s}s`;
  return `+${Math.floor(s / 60)}m${s % 60}s`;
}

/**
 * Richer multi-line progress for the live SSE stream (full-width text frame, not
 * the length-capped list subtitle). Adds the active slice + task titles so the
 * wearer sees WHAT auto-mode is on, not just counts. Elapsed/ETA are deliberately
 * omitted: those need runtime state (metrics ledger, auto-start time) the bridge
 * — a foreign reader of the db — cannot see, and `created_at` is plan time, not
 * run start, so surfacing it would mislead.
 *   "M011 ▶ S01 · 0/4 slices\nShared layout & routes scaffold\nT1/2 · Scaffold routes"
 *   "M011 ▶ S01 · 0/4 slices · +2m14s\n…"   (elapsedMs given — live ticker)
 *   "M013 ✓ 4/4 slices — milestone finishing"
 *
 * `elapsedMs`, when >0, appends a bridge-side elapsed ticker to the count line so
 * a re-push during a long-running task visibly moves even when counts are static
 * (see fmtElapsed). Omit it for the initial push on a count change.
 */
export function formatProgressRich(p: Progress, elapsedMs = 0): string {
  if (!p.activeSliceId) {
    return `${p.milestoneId} ✓ ${p.slicesDone}/${p.slicesTotal} slices — milestone finishing`;
  }
  const tick = elapsedMs > 0 ? ` · ${fmtElapsed(elapsedMs)}` : "";
  const lines = [`${p.milestoneId} ▶ ${p.activeSliceId} · ${p.slicesDone}/${p.slicesTotal} slices${tick}`];
  if (p.activeSliceTitle) lines.push(clip(p.activeSliceTitle));
  if (p.tasksTotal > 0) {
    const taskLine = `T${p.tasksDone}/${p.tasksTotal}`;
    lines.push(p.activeTaskTitle ? `${taskLine} · ${clip(p.activeTaskTitle)}` : taskLine);
  }
  return lines.join("\n");
}

/**
 * Stable signature of the counts that matter for change detection, so the live
 * tailer only pushes an SSE update when progress actually advances (not every
 * tick). Milestone id included so a milestone rollover always emits.
 */
export function progressSignature(p: Progress): string {
  return `${p.milestoneId}:${p.slicesDone}/${p.slicesTotal}:${p.activeSliceId ?? "-"}:${p.tasksDone}/${p.tasksTotal}:${p.activeTaskId ?? "-"}`;
}
