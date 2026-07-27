import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.js";

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
}

/**
 * Read the active-milestone progress for a project, or null when there is no db,
 * no active milestone, or the read fails. Never throws — a broken/locked db must
 * degrade to "no progress shown", not crash the tailer.
 */
export function readProgress(cwd: string): Progress | null {
  const dbPath = join(cwd, ".gsd", "gsd.db");
  if (!existsSync(dbPath)) return null;

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
    if (activeSlice) {
      const tasks = db
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
