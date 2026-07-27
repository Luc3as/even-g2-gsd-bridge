import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "../config.js";
import { listProjects, listAttachable, findProject, type Project } from "../gsd/sessions.js";
import { parseTranscript, deriveStatus, type Status } from "../gsd/jsonl.js";
import { toGlassesHistory } from "./format.js";
import * as tmux from "../gsd/tmux.js";
import { getPending, clearPending, markAnswered, matchAnswer, matchMulti, renderMenu, getLastMenu, clearLastMenu } from "../gsd/questions.js";
import { emit, emitText, recordEcho } from "../server/events.js";
import { buildStatusCard } from "../gsd/status.js";
import { readAutoState } from "../gsd/auto.js";
import { log } from "../log.js";

const execFileAsync = promisify(execFile);

/**
 * True when a glasses utterance is the wearer asking for project status: bare
 * "status", "/status", "/gsd status", or "gsd status" (dictation drops the slash
 * and may sentence-case, so match loosely and case-insensitively). Kept narrow so
 * an ordinary prompt that merely contains the word "status" still routes to gsd.
 */
function isStatusCommand(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.?!…]+$/, "");
  return t === "status" || t === "/status" || t === "gsd status" || t === "/gsd status";
}

/**
 * The Even App answers a question by POSTing a JSON object keyed by the question
 * text with the picked option label(s) as values, e.g. {"Pick a fruit":"Apple"}
 * (this mirrors the reference bridge's own `JSON.parse(answer)`; see
 * even-terminal session.js:handleAskUserQuestion). Extract the answer string(s)
 * so the matcher sees "Apple", not the whole blob. String values join with a
 * space (a multi-select answer may arrive as an array or several keys). A bare
 * dictation string that isn't JSON returns unchanged.
 */
export function unwrapAnswer(text: string): string {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return text;
  try {
    const parsed = JSON.parse(t);
    const vals = Array.isArray(parsed) ? parsed : Object.values(parsed);
    const flat = vals.flat().filter((v) => typeof v === "string");
    return flat.length ? flat.join(" ") : text;
  } catch {
    return text;
  }
}

/**
 * The GSD even-terminal provider. Implements the exact 9-method surface the
 * official @evenrealities/even-terminal routes consume, but split by concern:
 *   READ  (listSessions/getHistory/status)  → gsd-native jsonl transcripts
 *   WRITE (prompt/interrupt/permission/question) → tmux send-keys into the
 *          live pane, so the desk gsd remains the sole process owner.
 */

export interface SessionInfo {
  id: string;
  title: string;
  timestamp: string;
  cwd: string;
  provider: "claude";
  status: Status | null;
}

export interface ProviderError extends Error {
  statusCode?: number;
}

function notFound(msg: string): ProviderError {
  return Object.assign(new Error(msg), { statusCode: 404 });
}

export function createGsdProvider(cfg: Config) {
  function resolve(sessionId: string): Project | null {
    return findProject(cfg.sessionsDirs, cfg.projectRoots, sessionId);
  }

  function statusFor(p: Project): Status {
    // An open gsd picker flushes NO jsonl, so the transcript's last entry is the
    // toolCall/user that triggered it and the file mtime is still fresh —
    // deriveStatus would return "busy" and the glasses show "working" for the
    // whole ~busyWindow while the turn is actually blocked on the wearer's pick.
    // A pending picker means we're waiting on the human, which is idle. Reporting
    // busy here is why the wearer holds the ring, and that ESC kills the turn.
    // "awaiting" (not "idle") is what the reference server returns for a pending
    // question; the Even App polls /api/sessions and arms its native question
    // mode off this value so the mic answers directly instead of being read as
    // an interrupt. Returning "idle" here told the App the turn was done, so
    // every answer became a "quit waiting?" interrupt — the observed lockup.
    if (getPending(p.sessionId)) return "awaiting";
    // A dead auto-run leaves a fresh transcript mtime but will never write again;
    // freshness alone would report "busy" for the whole busyWindow, so the /status
    // route and the list "working" dot lie about a crashed run. The lock death is
    // authoritative — report idle. Mirrors the tailer's liveness gate (watch.ts).
    if (readAutoState(p.cwd).liveness === "stopped") return "idle";
    if (!p.newestJsonl) return "idle";
    try {
      const raw = readFileSync(p.newestJsonl, "utf8");
      // Freshness floor uses p.mtimeMs — the newest transcript across ALL of this
      // project's stores — not this one file's mtime. gsd-native rotates a file
      // per turn while the Claude-Code run streams continuously, so a single
      // file's mtime lags >busyWindow mid-run and deriveStatus would false-idle
      // the "working" dot. The content verdict still comes from the tailed file
      // (last meaningful entry); freshness only gates the idle-by-silence floor,
      // mirroring the tailer's freshness gate (see watch.ts). A real >busyWindow
      // stall (nothing written anywhere) still resolves idle.
      return deriveStatus(raw, p.mtimeMs, cfg.busyWindowMs, Date.now());
    } catch {
      return "idle";
    }
  }

  async function listSessions(limit: number, _cwd?: string): Promise<SessionInfo[]> {
    const projects = listAttachable(cfg.sessionsDirs, cfg.projectRoots);
    const live = new Set(await tmux.listSessionNames());
    return projects.slice(0, limit).map((p) => ({
      id: p.sessionId,
      // Prefix with project name so the glasses' native picker mirrors sersám.
      title: `[${p.name}]${live.has(p.tmuxName) ? " ●" : " ○"} ${p.title}`.slice(0, 64),
      timestamp: new Date(p.mtimeMs).toISOString(),
      cwd: p.cwd,
      provider: "claude" as const,
      status: null, // filled lazily by the route via getSessionStatus
    }));
  }

  async function getSessionStatus(sessionId: string): Promise<Status> {
    const p = resolve(sessionId);
    return p ? statusFor(p) : "idle";
  }

  /** Synchronous guard used by the write routes (404 when session unknown). */
  function getStatus(sessionId: string): { state: Status; provider: "claude" } | null {
    const p = resolve(sessionId);
    if (!p) return null;
    return { state: statusFor(p), provider: "claude" };
  }

  async function getInfo() {
    let version = "Unknown";
    try {
      const { stdout } = await execFileAsync("gsd", ["--version"], { timeout: 3000 });
      version = stdout.trim().split("\n")[0] || "Unknown";
    } catch {
      /* gsd may not print --version; non-fatal */
    }
    // Model from the most-recently-active project's transcript.
    let model = "Unknown";
    const projects = listProjects(cfg.sessionsDirs, cfg.projectRoots);
    if (projects[0]?.newestJsonl) {
      try {
        const { meta } = parseTranscript(readFileSync(projects[0].newestJsonl, "utf8"));
        if (meta?.model) model = meta.model;
      } catch {
        /* ignore */
      }
    }
    return { account: {}, model, version, provider: "claude" as const };
  }

  async function getHistory(sessionId: string, limit: number) {
    const p = resolve(sessionId);
    if (!p) throw notFound(`Session not found: ${sessionId}`);
    // Cold-start project: no transcript yet, nothing to render until first prompt.
    if (!p.newestJsonl) return [];
    const { turns } = parseTranscript(readFileSync(p.newestJsonl, "utf8"));
    return toGlassesHistory(turns, limit);
  }

  /**
   * Answer an open picker. Returns true if the utterance was consumed as a
   * selection (matched or not); false only when no picker is pending.
   *   single-select — map to a digit, type it (jumps + auto-advances to the
   *     review screen), beat, Enter to submit.
   *   multi-select — digits are inert; walk down to each target (Down×k) +
   *     Space to toggle, then Enter (review) + Enter (submit).
   * On no match, re-show the menu and keep the question pending.
   */
  async function trySelect(p: Project, text: string): Promise<boolean> {
    const q = getPending(p.sessionId);
    if (!q) return false;
    // Log the raw utterance + the options it's matched against, so a failed
    // match (dictation spelling letters, JSON-wrapped, odd encoding) is
    // diagnosable from the journal instead of a silent re-prompt loop.
    log.info("provider", `trySelect raw=${JSON.stringify(text)} multi=${q.multi} options=${JSON.stringify(q.options)}`);

    // The Even App answers a question by POSTing a JSON object keyed by the
    // question text with the picked option LABEL as the value (mirrors the
    // reference bridge's `JSON.parse(answer)` in session.js:handleAskUserQuestion).
    // Unwrap it to the answer string(s) before matching; a bare dictation string
    // (no JSON) falls through unchanged.
    const answer = unwrapAnswer(text);

    if (q.multi) {
      const picks = matchMulti(q.options, answer);
      if (picks.length === 0) {
        emitText(p.sessionId, `Didn't catch that.\n${renderMenu(q)}`);
        return true;
      }
      clearPending(p.sessionId);
      // Suppress re-arm of this same picker while it lingers on the pane after
      // the keys are sent (else the tailer re-detects and the App re-answers).
      markAnswered(p.sessionId, q.signature);
      // Cursor starts on the first option; walk down to each pick in ascending
      // order (Down× the gap), toggle with Space, then submit through review.
      const keys: string[] = [];
      let cursor = 0;
      for (const idx of picks) {
        for (let k = cursor; k < idx - 1; k++) keys.push("Down");
        keys.push("Space");
        cursor = idx - 1;
      }
      await tmux.sendKeys(p.tmuxName, keys);
      await new Promise((r) => setTimeout(r, 200));
      await tmux.sendKeys(p.tmuxName, ["Enter"]);
      await new Promise((r) => setTimeout(r, 200));
      await tmux.sendKeys(p.tmuxName, ["Enter"]);
      const picked = picks.map((i) => q.options[i - 1]).join(", ");
      emit(p.sessionId, { type: "user_prompt", text: `#${picks.join(",")} ${picked}` });
      log.info("provider", `question answer → ${p.tmuxName} (multi #${picks.join(",")})`);
      return true;
    }

    const idx = matchAnswer(q.options, answer);
    if (idx == null) {
      emitText(p.sessionId, `Didn't catch that.\n${renderMenu(q)}`);
      return true;
    }
    clearPending(p.sessionId);
    // Suppress re-arm of this same picker while it lingers on the pane after the
    // digit is sent (else the tailer re-detects and the App re-answers).
    markAnswered(p.sessionId, q.signature);
    await tmux.sendKeys(p.tmuxName, [String(idx)]);
    await new Promise((r) => setTimeout(r, 200));
    await tmux.sendKeys(p.tmuxName, ["Enter"]);
    emit(p.sessionId, { type: "user_prompt", text: `#${idx} ${q.options[idx - 1]}` });
    log.info("provider", `question answer → ${p.tmuxName} (#${idx})`);
    return true;
  }

  async function prompt(sessionId: string | undefined, text: string, cwd?: string) {
    // Resolve target project: by sessionId, else by cwd match (fresh prompt).
    let p = sessionId ? resolve(sessionId) : null;
    if (!p && cwd) {
      p = listProjects(cfg.sessionsDirs, cfg.projectRoots).find((x) => x.cwd === cwd) ?? null;
    }
    if (!p) throw notFound(`Unknown session/project: ${sessionId ?? cwd ?? "(none)"}`);

    // DIAGNOSTIC: dump every inbound prompt raw + whether a picker is pending, so
    // a mis-routed picker answer (App posts to /prompt, pending already cleared)
    // is visible in the journal instead of silently sent to tmux as a fresh line.
    log.info("provider", `prompt raw=${JSON.stringify(text)} pending=${!!getPending(p.sessionId)}`);

    // "status" / "/gsd status" — the wearer's stand-in for running `/gsd status`
    // in the project. Answered from artifacts gsd already writes (STATE.md +
    // progress db + auto.lock), so it is instant, needs no live tmux session, and
    // never spawns one. Only when no picker is pending (else "status" would be
    // mis-read as a menu answer). Recognized before the tmux/spawn path below.
    if (!getPending(p.sessionId) && isStatusCommand(text)) {
      emitText(p.sessionId, buildStatusCard(p.cwd, p.name));
      log.info("provider", `status card → ${p.sessionId}`);
      return { sessionId: p.sessionId, provider: "claude" as const };
    }

    // If a picker is open, this utterance is a selection, not a new prompt.
    if (await trySelect(p, text)) {
      return { sessionId: p.sessionId, provider: "claude" as const };
    }

    // No picker open: a bare-number reply to the last answer's trailing
    // next-steps menu ("Ďalej?"/"Next steps:") gets expanded to its full label
    // so the model runs the picked item instead of re-reading its list and
    // guessing. One-shot — the menu is consumed/cleared on this prompt.
    const menu = getLastMenu(p.sessionId);
    clearLastMenu(p.sessionId);
    if (menu) {
      const m = text.trim().match(/^(\d+)$/);
      if (m) {
        const n = Number(m[1]);
        if (n >= 1 && n <= menu.length) text = `${n}. ${menu[n - 1]}`;
      }
    }

    const isLive = await tmux.hasSession(p.tmuxName);
    if (!isLive) {
      if (!cfg.allowSpawn) {
        throw Object.assign(new Error(`No live tmux session '${p.tmuxName}'. Start it via sersám.`), {
          statusCode: 409,
        });
      }
      await tmux.spawnSession(p.tmuxName, p.cwd, cfg.spawnCommand);
      // Give the TUI a moment to come up before the first line.
      await new Promise((r) => setTimeout(r, 1500));
    }
    await tmux.sendPrompt(p.tmuxName, text);
    // Optimistic echo so the glasses see their own input immediately. Record it
    // so the jsonl tailer skips the duplicate replay of the same user line.
    recordEcho(p.sessionId, text);
    emit(p.sessionId, { type: "user_prompt", text });
    log.info("provider", `prompt → ${p.tmuxName} (${text.length} chars)`);
    return { sessionId: p.sessionId, provider: "claude" as const };
  }

  function respondPermission(sessionId: string, decision: string): void {
    const p = resolve(sessionId);
    if (!p) return;
    const keys = decision === "allow" ? cfg.keymap.permissionAllow : cfg.keymap.permissionDeny;
    tmux.sendKeys(p.tmuxName, keys).catch((err) => log.error("provider", "permission send failed", err));
    log.info("provider", `permission ${decision} → ${p.tmuxName} (${keys.join(" ")})`);
  }

  function respondQuestion(sessionId: string, answer: string): void {
    const p = resolve(sessionId);
    if (!p) return;
    // Map to a digit selection when a picker is open; else fall back to typing
    // the answer as a line (e.g. a free-text prompt the client mislabeled).
    if (getPending(sessionId)) {
      trySelect(p, answer).catch((err) => log.error("provider", "question select failed", err));
    } else {
      tmux.sendPrompt(p.tmuxName, answer).catch((err) => log.error("provider", "question send failed", err));
    }
    log.info("provider", `question answer → ${p.tmuxName}`);
  }

  function interrupt(sessionId: string): void {
    const p = resolve(sessionId);
    if (!p) return;
    tmux.sendKeys(p.tmuxName, cfg.keymap.interrupt).catch((err) =>
      log.error("provider", "interrupt send failed", err),
    );
    log.info("provider", `interrupt → ${p.tmuxName}`);
  }

  return {
    listSessions,
    getSessionStatus,
    getInfo,
    getHistory,
    prompt,
    respondPermission,
    respondQuestion,
    interrupt,
    getStatus,
  };
}

export type GsdProvider = ReturnType<typeof createGsdProvider>;
