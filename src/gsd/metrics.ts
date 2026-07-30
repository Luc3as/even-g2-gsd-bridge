import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.js";

/**
 * READ-ONLY milestone metrics (cost, tokens, elapsed) from a project's
 * `.gsd/gsd.db`, for line 6 of the lens dashboard frame ($ · tok · elapsed)
 * and the active-task elapsed suffix on line 5. Same access contract as
 * `readProgress` (progress.ts): the desk `gsd` owns the write connection; the
 * bridge opens `readOnly` and must never write. A different concern than
 * progress parsing (D002), hence a separate module.
 *
 * Sources (schema live-verified on the Yummy gsd.db, 2026-07-28):
 *   audit_events    — `type = 'unit-metrics-snapshot'` rows; `payload_json`
 *                     carries `{unitId, cost, tokens: {total, …}}` per completed
 *                     unit. No milestone column — scoping is by payload unitId.
 *                     `tokens.total` is GSD's own definition (input + output +
 *                     cacheWrite, cacheRead excluded) — use as-is, never re-derive.
 *   unit_dispatches — one row per dispatched unit with ISO `started_at`/`ended_at`
 *                     and a real `milestone_id` column. Accumulates stale
 *                     never-closed rows (`ended_at IS NULL`) from dead runs, so
 *                     open rows are only trusted when the caller says the run is
 *                     live, and then only the newest one (MAX(id)).
 *
 * Snapshots are written per COMPLETED unit, so mid-unit cost is invisible: the
 * sums honestly show completed-unit totals and never extrapolate (R010).
 */

export interface MilestoneMetrics {
  /** Summed `cost` (USD) across the milestone's unit-metrics-snapshot rows. */
  costUsd: number;
  /** Summed `tokens.total` across the same rows. */
  tokensTotal: number;
  /**
   * Milestone wall-clock ms: sum of closed dispatch durations, plus the age of
   * the single newest open dispatch when `live`. Not calendar span — units run
   * back-to-back so the sum is the honest "time spent".
   */
  elapsedMs: number;
  /**
   * Age (ms) of the newest open dispatch — the unit in flight — or null when
   * not `live` or nothing is open. Feeds the line-5 `+4m` suffix.
   */
  activeElapsedMs: number | null;
}

/** Payload unitId belongs to the milestone: exact or path-prefixed ("M013" or
 * "M013/…"), never a longer id sharing the prefix (M0130 must not match M013). */
function unitInMilestone(unitId: unknown, milestoneId: string): boolean {
  return typeof unitId === "string" && (unitId === milestoneId || unitId.startsWith(milestoneId + "/"));
}

/**
 * Read cost/token/elapsed totals for one milestone, or null when the db is
 * missing, locked, or unreadable (including absent tables on older gsd
 * schemas). Never throws — the lens omits its metrics line instead of lying.
 *
 * `live` must be true only when auto-mode liveness is running/quiet: it gates
 * whether the newest open dispatch row counts as "in flight now" (a stale open
 * row from a dead run would otherwise show a week-long counter). `now` is
 * injectable for tests.
 */
export function readMilestoneMetrics(
  cwd: string,
  milestoneId: string,
  opts: { now?: number; live?: boolean } = {},
): MilestoneMetrics | null {
  const now = opts.now ?? Date.now();
  const dbPath = join(cwd, ".gsd", "gsd.db");
  if (!existsSync(dbPath)) return null;

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });

    // Cost + tokens. SQL LIKE is a cheap prefilter only (it would also match
    // M0130 for M013); the JS check is the authoritative scope. Malformed rows
    // are skipped per-row: wrong numbers must never reach the lens.
    let costUsd = 0;
    let tokensTotal = 0;
    const snapshots = db
      .prepare(
        "SELECT payload_json FROM audit_events " +
          "WHERE type = 'unit-metrics-snapshot' AND payload_json LIKE '%\"unitId\":\"' || ? || '%'",
      )
      .all(milestoneId) as { payload_json: string }[];
    for (const row of snapshots) {
      try {
        const p = JSON.parse(row.payload_json) as { unitId?: unknown; cost?: unknown; tokens?: { total?: unknown } };
        if (!unitInMilestone(p.unitId, milestoneId)) continue;
        const cost = p.cost;
        const total = p.tokens?.total;
        if (typeof cost !== "number" || !Number.isFinite(cost)) continue;
        if (typeof total !== "number" || !Number.isFinite(total)) continue;
        costUsd += cost;
        tokensTotal += total;
      } catch {
        /* malformed payload → skip the row */
      }
    }

    // Elapsed. Closed rows always count (failed attempts too — that time was
    // spent). Open rows are stale leftovers of dead runs EXCEPT the newest one
    // while the run is live: that is the unit in flight.
    let elapsedMs = 0;
    let activeElapsedMs: number | null = null;
    const dispatches = db
      .prepare("SELECT id, started_at, ended_at FROM unit_dispatches WHERE milestone_id = ? ORDER BY id")
      .all(milestoneId) as { id: number; started_at: string | null; ended_at: string | null }[];
    let newestOpen: { id: number; startedMs: number } | null = null;
    for (const d of dispatches) {
      const started = d.started_at === null ? NaN : Date.parse(d.started_at);
      if (Number.isNaN(started)) continue; // unparseable → skip
      if (d.ended_at === null) {
        if (newestOpen === null || d.id > newestOpen.id) newestOpen = { id: d.id, startedMs: started };
        continue;
      }
      const ended = Date.parse(d.ended_at);
      if (Number.isNaN(ended) || ended < started) continue; // unparseable/negative → skip
      elapsedMs += ended - started;
    }
    if (opts.live && newestOpen) {
      activeElapsedMs = Math.max(0, now - newestOpen.startedMs);
      elapsedMs += activeElapsedMs;
    }

    return { costUsd, tokensTotal, elapsedMs, activeElapsedMs };
  } catch (err) {
    log.debug("metrics", `read failed for ${cwd}: ${(err as Error).message}`);
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
 * The machine-written stop reason for the newest *failed* dispatch of a
 * milestone. `error_summary` is the human-readable sentence; `exit_reason` is
 * the terser enum/code fallback (caller prefers summary, falls back to reason).
 */
export interface StopReason {
  exitReason: string | null;
  errorSummary: string | null;
}

/** Trim a db string, coercing empty/whitespace-only/non-string to null so a
 * blank column never surfaces as a reason (R010: omit, never invent). */
function nonEmpty(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * Read the stop reason of the newest `status='failed'` dispatch for one
 * milestone, or null when the db is missing/unreadable, there is no failed
 * dispatch, or both reason columns are blank. Same READ-ONLY, never-throws,
 * `finally close()` contract as `readMilestoneMetrics`.
 *
 * Only a `failed` row carries an authoritative reason: open (crashed) rows and
 * `completed` rows have none, and the newest dispatch overall may be an open
 * crashed row with a NULL reason — so the query filters to `failed` and takes
 * the newest of those by id, never `MAX(id)` overall (R010).
 */
export function readStopReason(cwd: string, milestoneId: string): StopReason | null {
  const dbPath = join(cwd, ".gsd", "gsd.db");
  if (!existsSync(dbPath)) return null;

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare(
        "SELECT exit_reason, error_summary FROM unit_dispatches " +
          "WHERE milestone_id = ? AND status = 'failed' ORDER BY id DESC LIMIT 1",
      )
      .get(milestoneId) as { exit_reason: unknown; error_summary: unknown } | undefined;
    if (!row) return null; // no failed dispatch → no reason
    const exitReason = nonEmpty(row.exit_reason);
    const errorSummary = nonEmpty(row.error_summary);
    if (exitReason === null && errorSummary === null) return null; // failed row, but both blank
    return { exitReason, errorSummary };
  } catch (err) {
    log.debug("metrics", `stop-reason read failed for ${cwd}: ${(err as Error).message}`);
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* best effort */
    }
  }
}
