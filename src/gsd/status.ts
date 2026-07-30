import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readProgress, type Progress, type UnitStatus } from "./progress.js";
import { readMilestoneMetrics, readStopReason } from "./metrics.js";
import { readAutoState, classifyDisplayState, latestSeriousNotification, type AutoLiveness, type DisplayState } from "./auto.js";

/**
 * Build the ≤6-line × ≤52-char lens dashboard frame the glasses show when the
 * wearer asks for "status"/"dashboard"/"progress". Everything is read from
 * artifacts gsd already writes — gsd.db (progress, liveness, metrics) and
 * STATE.md (blocker / next action) — so the frame is instant and needs no live
 * tmux session. Read-only; each unreadable source omits its line(s).
 *
 * Frame (running state):
 *   M013 ▶RUN · 63% · S 2/4 · T 2/4
 *   ✓ S01-S02
 *   ● S03 Restructure order cards
 *     ✓T01 ✓T02 ●T03 ○T04
 *   ▶ T03 Tablet search collapse · +4m
 *   $2.50 · 1.0M tok · 18m
 *
 * Line 5 precedence: STATE.md blocker > stop reason (when ⚠STOP) > active task
 * (elapsed suffix only while the run is live) > STATE.md Next:. Only a `running`
 * run paints "▶ task"; a stopped/paused run would falsely imply work in flight,
 * so it shows its stop reason (or, with no recorded reason, the line-1 tag alone).
 */

/**
 * Lens line width. Measured off the app-export mirror (IMG_2379): a 40-char line
 * left a wide right margin and a full-width line reached ~55 columns at the text
 * box edge, so 40 was clipping far too early ("only a few characters per line").
 * 52 uses most of the real width while keeping a margin, so the firmware never
 * hard-truncates mid-word — the only `…` comes from our own clip(). Viewport is
 * ~8 lines tall, so a ≤6-line card fits with headroom.
 */
const WIDTH = 52;

/** Display-state tag for line 1. All four glyphs are full-size geometric BMP
 * glyphs proven to paint on the 576x288 lens (▶ ⏸ ⚠ ○ — see KNOWLEDGE). */
const TAG: Record<DisplayState, string> = {
  running: "▶RUN",
  paused: "⏸PAUSE",
  stopped: "⚠STOP",
  idle: "○IDLE",
};

/**
 * Extract the "## Next Action" body (first non-empty line) from STATE.md, or the
 * first "## Blockers" line when a blocker is present (a blocker is the more urgent
 * thing to show). Returns null when neither is informative.
 */
function nextOrBlocker(state: string): { label: string; text: string } | null {
  const blockers = section(state, "Blockers");
  if (blockers && !/^-?\s*none\.?$/i.test(blockers)) {
    return { label: "Blocked", text: blockers };
  }
  const next = section(state, "Next Action");
  if (next) return { label: "Next", text: next };
  return null;
}

/** First non-empty content line under a "## <name>" heading. */
function section(state: string, name: string): string | null {
  const re = new RegExp(`^##\\s+${name}\\s*$`, "im");
  const m = re.exec(state);
  if (!m) return null;
  const rest = state.slice(m.index + m[0].length).split("\n");
  for (const line of rest) {
    if (/^##\s/.test(line)) break; // hit the next heading
    const t = line.replace(/^[-*]\s*/, "").trim();
    if (t) return t;
  }
  return null;
}

/** Whitespace-normalizing clip to one lens line; keeps the head, adds `…`. */
export function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Length-only clip that preserves leading indent (the task glyph row). */
function rawClip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Line-1 percent: slice-weighted completion. The active slice contributes its
 * task fraction; degrades to slices-only when the active slice has no tasks.
 */
function pct(p: Progress): number {
  if (!p.slicesTotal) return 0;
  const frac = p.slicesDone + (p.tasksTotal ? p.tasksDone / p.tasksTotal : 0);
  return Math.round((100 * frac) / p.slicesTotal);
}

/**
 * Compress completed slice ids into ranges: `✓ S01-S05 S07`. The completed set
 * can be non-contiguous (skipped slices satisfy deps), so consecutive numeric
 * suffixes collapse to `A-B` and gaps stay separate. Null when zero complete.
 */
function sliceRange(slices: UnitStatus[]): string | null {
  const done = slices.filter((s) => s.status === "complete").map((s) => s.id);
  if (done.length === 0) return null;
  const num = (id: string) => parseInt(id.replace(/^\D+/, ""), 10);
  const parts: string[] = [];
  let start = 0;
  for (let i = 1; i <= done.length; i++) {
    if (i === done.length || num(done[i]!) !== num(done[i - 1]!) + 1) {
      parts.push(i - start > 1 ? `${done[start]}-${done[i - 1]}` : done[start]!);
      start = i;
    }
  }
  return `✓ ${parts.join(" ")}`;
}

/** Glyph row for the active slice's tasks: `  ✓T01 ✓T02 ●T03 ○T04`. */
function taskRow(tasks: UnitStatus[], activeId: string | null): string | null {
  if (tasks.length === 0) return null;
  const glyph = (t: UnitStatus) => (t.status === "complete" ? "✓" : t.id === activeId ? "●" : "○");
  return "  " + tasks.map((t) => `${glyph(t)}${t.id}`).join(" ");
}

/** Line-5 elapsed suffix: `+45s` / `+4m` / `+2h14m` (coarser than fmtElapsed's live ticker). */
function fmtAgo(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `+${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `+${m}m`;
  return `+${Math.floor(m / 60)}h${m % 60}m`;
}

/**
 * The truthful stop reason for a ⚠STOP run, sourced from the right channel per
 * stop sub-type, or null when nothing authoritative is recorded (R010: omit,
 * never invent — the line-1 tag then stands alone).
 *
 *   hard-dead (liveness "stopped") — the newest failed dispatch's DB reason is
 *     authoritative (error_summary is the human sentence, exit_reason the terser
 *     fallback); if that row is absent/blank, fall back to a serious notification.
 *   credit-death / stall (liveness "quiet" past the ceiling) — the process died
 *     mid-unit without ever writing a failed row, so any failed row on disk is a
 *     STALE leftover of an earlier attempt: never trust the DB here, only a fresh
 *     serious notification.
 *
 * Each source degrades independently (readStopReason / latestSeriousNotification
 * both return null on any read error), so one dead source never blanks the card.
 */
export function stopReason(cwd: string, milestoneId: string, liveness: AutoLiveness): string | null {
  if (liveness === "stopped") {
    const sr = readStopReason(cwd, milestoneId);
    const dbReason = sr?.errorSummary ?? sr?.exitReason ?? null;
    if (dbReason) return dbReason;
  }
  return latestSeriousNotification(cwd)?.message ?? null;
}

/** `$263` above ten dollars, cents below — small real costs must not round to $0. */
function fmtCost(usd: number): string {
  return usd >= 10 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`;
}

function fmtTok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M tok`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k tok`;
  return `${n} tok`;
}

/** Milestone elapsed for line 6: `2h 14m` / `14m`. */
function fmtDur(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Assemble the dashboard frame for a project cwd. `name` is the project's
 * display name (basename), used only on the no-milestone degrade card. Never
 * throws — the outer catch is a last resort (this sits on the /prompt route);
 * every source reader already degrades to null on its own.
 */
export function buildStatusCard(cwd: string, name: string): string {
  try {
    return buildFrame(cwd, name);
  } catch {
    return `GSD status · ${name}\nNo active GSD milestone.`;
  }
}

function buildFrame(cwd: string, name: string): string {
  const prog = readProgress(cwd);
  // No progress → no frame to draw; say so plainly rather than a bare title.
  if (!prog) return `GSD status · ${name}\nNo active GSD milestone.`;

  const auto = readAutoState(cwd);

  // STATE.md drives both the line-1 pause tag (a blocker means paused) and the
  // line-5 blocker/Next: swap, so read it once, up front. Best-effort — an
  // unreadable STATE.md just loses those two contributions.
  let state = "";
  try {
    const statePath = join(cwd, ".gsd", "STATE.md");
    if (existsSync(statePath)) state = readFileSync(statePath, "utf8");
  } catch {
    /* unreadable STATE.md just loses its lines */
  }
  const nb = state ? nextOrBlocker(state) : null;
  const blocked = nb?.label === "Blocked";

  // A blocker in current-state STATE.md is the disk-only "intentionally halted"
  // signal the card trusts; live pause/cap notifications are edge-detected by the
  // watch alarm, not this steady-state pull. `live` (metrics + elapsed suffix)
  // is running-only: paused/stopped must not accrue an in-flight counter.
  const disp = classifyDisplayState(auto, blocked);
  const live = disp === "running";
  const metrics = readMilestoneMetrics(cwd, prog.milestoneId, { live });

  const lines: string[] = [];

  // Line 1: milestone + display-state tag + weighted percent + slice/task counts.
  let l1 = `${prog.milestoneId} ${TAG[disp]} · ${pct(prog)}% · S ${prog.slicesDone}/${prog.slicesTotal}`;
  if (prog.tasksTotal > 0) l1 += ` · T ${prog.tasksDone}/${prog.tasksTotal}`;
  lines.push(clip(l1, WIDTH));

  // Line 2: completed-slice range. Omitted when nothing is complete.
  const range = sliceRange(prog.slices);
  if (range) lines.push(clip(range, WIDTH));

  // Line 3: active slice. Omitted when all slices are done.
  if (prog.activeSliceId) {
    lines.push(clip(`● ${prog.activeSliceId}${prog.activeSliceTitle ? ` ${prog.activeSliceTitle}` : ""}`, WIDTH));
  }

  // Line 4: task glyph row (indent preserved, so no whitespace-normalizing clip).
  const row = taskRow(prog.tasks, prog.activeTaskId);
  if (row) lines.push(rawClip(row, WIDTH));

  // Line 5: blocker > stop reason > active task > Next:. nb/blocked computed up front.
  if (blocked && nb) {
    lines.push(clip(`⚠ Blocked: ${nb.text}`, WIDTH));
  } else if (disp === "stopped") {
    // A dead/hung run must never paint a "▶ task" line (that implies work in
    // flight). Show why it stopped from the right channel, or — with no recorded
    // reason — nothing, letting the line-1 ⚠STOP tag stand alone (R010).
    const reason = stopReason(cwd, prog.milestoneId, auto.liveness);
    if (reason) lines.push(clip(`⚠ ${reason}`, WIDTH));
  } else if (prog.activeTaskId && disp === "running") {
    // Elapsed suffix only while running — a stale open dispatch from a dead or
    // paused run would otherwise show a runaway counter (R010).
    const suffix = live && metrics?.activeElapsedMs != null ? ` · ${fmtAgo(metrics.activeElapsedMs)}` : "";
    const base = `▶ ${prog.activeTaskId}${prog.activeTaskTitle ? ` ${prog.activeTaskTitle}` : ""}`;
    lines.push(clip(base, WIDTH - suffix.length) + suffix);
  } else if (nb) {
    lines.push(clip(`Next: ${nb.text}`, WIDTH));
  }

  // Line 6: $ · tok · elapsed. Metrics unreadable → line omitted, never a lie.
  if (metrics) {
    lines.push(clip(`${fmtCost(metrics.costUsd)} · ${fmtTok(metrics.tokensTotal)} · ${fmtDur(metrics.elapsedMs)}`, WIDTH));
  }

  return lines.join("\n");
}
