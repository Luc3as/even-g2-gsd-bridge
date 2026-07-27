import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readProgress, formatProgress } from "./progress.js";
import { readAutoState } from "./auto.js";

/**
 * Build the compact status card the glasses show when the wearer asks for
 * "status" (the bridge's stand-in for `/gsd status`). Everything is read from
 * artifacts gsd already writes — STATE.md (human-readable current state), the
 * live progress db, and auto.lock — so the card is instant and needs no live tmux
 * session. Read-only; degrades to whatever it can read.
 *
 * Example (M013, auto-run live, mid-slice):
 *   GSD status · Yummy-packing-assistant
 *   ▶ auto-mode running M013/S03
 *   M013 ▶ S03 · 2/4 slices
 *   Phase: planning
 *   Next: Slice S03 has no DB tasks. Plan slice tasks…
 *
 * Example (auto-run died):
 *   GSD status · Yummy-packing-assistant
 *   ⚠ auto-mode STOPPED at M013/S02
 *   …
 */

/** Pull a single-line field like "**Active Slice:** S03: …" from STATE.md. */
function field(state: string, label: string): string | null {
  const m = state.match(new RegExp(`^\\*\\*${label}:\\*\\*\\s*(.+)$`, "im"));
  return m ? m[1]!.trim() : null;
}

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

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/**
 * Assemble the multi-line status card for a project cwd. `name` is the project's
 * display name (basename). Never throws — any unreadable artifact is just omitted
 * from the card.
 */
export function buildStatusCard(cwd: string, name: string): string {
  const lines = [`GSD status · ${name}`];

  // Auto-mode liveness line — the headline. A dead run is the thing the wearer
  // most needs to see, so it leads with a loud marker.
  const auto = readAutoState(cwd);
  if (auto.liveness === "stopped") {
    lines.push(`⚠ auto-mode STOPPED${auto.unitId ? ` at ${auto.unitId}` : ""}`);
  } else if (auto.liveness === "running") {
    lines.push(`▶ auto-mode running${auto.unitId ? ` ${auto.unitId}` : ""}`);
  }

  // Live progress counts (db) — the same line the list subtitle uses.
  const prog = readProgress(cwd);
  if (prog) lines.push(formatProgress(prog));

  // STATE.md fields: phase + next-action / blocker.
  const statePath = join(cwd, ".gsd", "STATE.md");
  if (existsSync(statePath)) {
    try {
      const state = readFileSync(statePath, "utf8");
      const phase = field(state, "Phase");
      if (phase) lines.push(`Phase: ${clip(phase, 40)}`);
      const nb = nextOrBlocker(state);
      if (nb) lines.push(`${nb.label}: ${clip(nb.text, 80)}`);
    } catch {
      /* best-effort */
    }
  }

  // Nothing beyond the header means the project isn't a GSD project (no db, no
  // STATE.md, no lock) — say so plainly rather than showing a bare title.
  if (lines.length === 1) lines.push("No active GSD milestone.");
  return lines.join("\n");
}
