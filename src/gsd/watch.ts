import { statSync, openSync, readSync, closeSync } from "node:fs";
import type { Config } from "../config.js";
import { emit, sessionHasClients, consumeEcho } from "../server/events.js";
import { parseLine, blocksToText, deriveStatusFromEntry } from "./jsonl.js";
import { listProjects, type Project } from "./sessions.js";
import { capturePane } from "./tmux.js";
import { parsePicker, getPending, setPending, clearPending, renderMenu } from "./questions.js";
import { log } from "../log.js";

/**
 * Poll-based tailer. fs.watch is unreliable across network/overlay FS, so we
 * poll: every tick, for each project that currently has an SSE client, read new
 * bytes from its newest transcript, normalize appended entries into
 * even-messages, and emit them. Byte offsets are tracked per sessionId so a
 * newly-attached client gets a full replay from the ring, then live deltas.
 */

interface TailState {
  file: string;
  offset: number;
  status: "busy" | "idle";
}

const tails = new Map<string, TailState>();

function readFrom(path: string, offset: number): { data: string; newOffset: number } {
  const st = statSync(path);
  if (st.size <= offset) return { data: "", newOffset: st.size < offset ? st.size : offset };
  const fd = openSync(path, "r");
  try {
    const len = st.size - offset;
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, offset);
    return { data: buf.subarray(0, n).toString("utf8"), newOffset: offset + n };
  } finally {
    closeSync(fd);
  }
}

function emitEntry(sessionId: string, line: string): void {
  const e = parseLine(line);
  if (!e) return;
  if (e.type === "model_change" && e.modelId) {
    emit(sessionId, { type: "info", model: String(e.modelId) });
    return;
  }
  if (e.type !== "message" || !e.message) return;
  const role = e.message.role;
  const { text, tools } = blocksToText(e.message.content);
  if (!text && tools.length === 0) return;
  if (role === "assistant") {
    for (const tool of tools) emit(sessionId, { type: "tool_call", text: `> ${tool}`, ts: e.timestamp });
    if (text) emit(sessionId, { type: "agent_message", text, ts: e.timestamp });
  } else if (role === "user") {
    // A glasses-sent prompt was already echoed optimistically by provider; skip
    // the jsonl replay of that same line so the wearer doesn't see it twice.
    if (consumeEcho(sessionId, text)) return;
    emit(sessionId, { type: "user_prompt", text, ts: e.timestamp });
  } else if (role === "toolResult") {
    if (text.trim()) emit(sessionId, { type: "tool_result", text: text.slice(0, 200), ts: e.timestamp });
  }
}

/**
 * One tail tick. Exposed for tests. Discovers current projects, tails those
 * with clients, resets offset if the active transcript file rotated.
 */
export function tick(cfg: Config, now: number): void {
  let projects;
  try {
    projects = listProjects(cfg.sessionsDirs, cfg.projectRoots);
  } catch (err) {
    log.error("watch", "listProjects failed", err);
    return;
  }
  for (const p of projects) {
    if (!p.newestJsonl) continue;
    // Tail EVERY project, even with no SSE client attached, so the message ring
    // keeps a rolling backlog. Otherwise any jsonl written while the glasses are
    // disconnected (e.g. SSE dropped mid-turn) is skipped here AND never enters
    // the ring, so a needReplay reconnect can't surface it — the answer is lost
    // for good. emit()'s broadcast no-ops when there are no clients, so this only
    // fills the ring; it costs nothing live.
    let t = tails.get(p.sessionId);
    if (!t || t.file !== p.newestJsonl) {
      // First sight or file rotation: start at EOF so we tail forward without
      // dumping the entire pre-existing transcript into the ring.
      t = { file: p.newestJsonl, offset: statSizeSafe(p.newestJsonl), status: "idle" };
      tails.set(p.sessionId, t);
      continue;
    }
    let chunk;
    try {
      chunk = readFrom(t.file, t.offset);
    } catch (err) {
      log.error("watch", `read failed ${t.file}`, err);
      continue;
    }
    if (chunk.data) {
      const lines = chunk.data.split("\n");
      // Last element may be a partial line; only advance past complete lines.
      const complete = chunk.data.endsWith("\n") ? lines : lines.slice(0, -1);
      let consumed = 0;
      for (const line of complete) {
        emitEntry(p.sessionId, line);
        consumed += Buffer.byteLength(line, "utf8") + 1;
      }
      t.offset += consumed;
      // Status transition detection off the last complete entry.
      const last = complete[complete.length - 1];
      if (last) {
        const st = deriveStatusFromEntry(last);
        if (st && st !== t.status) {
          t.status = st;
          emit(p.sessionId, { type: "status", state: st });
        }
      }
    }
    // Idle-by-silence: no writes within busy window flips busy→idle.
    if (t.status === "busy" && now - p.mtimeMs > cfg.busyWindowMs) {
      t.status = "idle";
      emit(p.sessionId, { type: "status", state: "idle" });
    }

    // ANSWER-mode: a gsd picker leaves no jsonl trace, so scrape the live pane.
    // Only meaningful when glasses are attached to answer it.
    if (sessionHasClients(p.sessionId)) detectQuestion(p);
  }
}

/**
 * Fire-and-forget pane scrape for an open single-select picker. On a newly-seen
 * question, emit the numbered menu as an agent_message (stock glasses render it
 * with zero protocol changes) and store it so provider.prompt routes the next
 * utterance to a digit selection. Idempotent via the question signature.
 */
function detectQuestion(p: Project): void {
  capturePane(p.tmuxName, 40)
    .then((pane) => {
      const q = parsePicker(pane);
      const had = getPending(p.sessionId);
      if (q) {
        if (!had || had.signature !== q.signature) {
          setPending(p.sessionId, q);
          emit(p.sessionId, { type: "agent_message", text: renderMenu(q) });
          log.info("watch", `question detected ${p.sessionId} (${q.options.length} options)`);
        }
      } else if (had) {
        clearPending(p.sessionId);
      }
    })
    .catch((err) => log.error("watch", `question detect failed ${p.sessionId}`, err));
}

function statSizeSafe(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function startWatcher(cfg: Config): () => void {
  const timer = setInterval(() => tick(cfg, Date.now()), cfg.tailIntervalMs);
  log.info("watch", `tailer started (interval=${cfg.tailIntervalMs}ms)`);
  return () => clearInterval(timer);
}
