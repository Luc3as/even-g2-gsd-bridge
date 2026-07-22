import { readFileSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "../config.js";
import { listProjects, listAttachable, findProject, type Project } from "../gsd/sessions.js";
import { parseTranscript, deriveStatus, type Status } from "../gsd/jsonl.js";
import { toGlassesHistory } from "./format.js";
import * as tmux from "../gsd/tmux.js";
import { getPending, clearPending, matchAnswer, matchMulti, renderMenu } from "../gsd/questions.js";
import { emit, recordEcho } from "../server/events.js";
import { log } from "../log.js";

const execFileAsync = promisify(execFile);

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
    if (!p.newestJsonl) return "idle";
    try {
      const raw = readFileSync(p.newestJsonl, "utf8");
      const mtime = statSync(p.newestJsonl).mtimeMs;
      return deriveStatus(raw, mtime, cfg.busyWindowMs, Date.now());
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

    if (q.multi) {
      const picks = matchMulti(q.options, text);
      if (picks.length === 0) {
        emit(p.sessionId, { type: "agent_message", text: `Didn't catch that.\n${renderMenu(q)}` });
        return true;
      }
      clearPending(p.sessionId);
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

    const idx = matchAnswer(q.options, text);
    if (idx == null) {
      emit(p.sessionId, { type: "agent_message", text: `Didn't catch that.\n${renderMenu(q)}` });
      return true;
    }
    clearPending(p.sessionId);
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

    // If a picker is open, this utterance is a selection, not a new prompt.
    if (await trySelect(p, text)) {
      return { sessionId: p.sessionId, provider: "claude" as const };
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
