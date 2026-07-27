import type { Response } from "express";
import { log } from "../log.js";

/**
 * Per-session message ring buffer + SSE fan-out. Wire-compatible with the
 * official @evenrealities/even-terminal /api/events: `id:`/`data:` frames,
 * needReplay support, 15s heartbeat, 500-message ring.
 */
export interface EvenMessage {
  type: string;
  [k: string]: unknown;
}

const MAX_MESSAGES_PER_SESSION = 500;


interface SessionBuf {
  messages: Array<{ id: number; msg: EvenMessage }>;
  clients: Set<Response>;
  nextId: number;
  // Highest id actually written to a live client. Frames pushed while no client
  // is connected (the glasses drop SSE every ~30s and are dark exactly when the
  // tailed answer lands) leave this behind; the next connect replays past it.
  lastDeliveredId: number;
}

const sessions = new Map<string, SessionBuf>();

function getSession(sessionId: string): SessionBuf {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { messages: [], clients: new Set(), nextId: 1, lastDeliveredId: 0 };
    sessions.set(sessionId, s);
  }
  return s;
}

export function pushMessage(sessionId: string, msg: EvenMessage): number {
  const s = getSession(sessionId);
  const id = s.nextId++;
  s.messages.push({ id, msg });
  if (s.messages.length > MAX_MESSAGES_PER_SESSION) s.messages.shift();
  return id;
}

export function getMessages(sessionId: string, after: number): Array<{ id: number } & EvenMessage> {
  const s = sessions.get(sessionId);
  if (!s) return [];
  return s.messages.filter((m) => m.id > after).map((m) => ({ id: m.id, ...m.msg }));
}

export function broadcast(sessionId: string, msg: EvenMessage, id: number): void {
  const s = sessions.get(sessionId);
  if (!s || s.clients.size === 0) {
    if (msg.type === "text_delta" || msg.type === "result") {
      log.warn("sse", `content frame '${msg.type}' dropped — no live client for ${sessionId} (id=${id})`);
    }
    return;
  }
  const data = JSON.stringify(msg);
  let dead = 0;
  let ok = 0;
  for (const res of s.clients) {
    try {
      res.write(`id: ${id}\ndata: ${data}\n\n`);
      ok++;
    } catch {
      s.clients.delete(res);
      dead++;
    }
  }
  log.debug(
    "sse",
    `broadcast ${sessionId} id=${id} type=${msg.type}${
      typeof msg.state === "string" ? `/${msg.state}` : ""
    } → ${ok} client(s)${dead ? ` (${dead} dead)` : ""}`,
  );
  if (dead > 0) log.warn("sse", `dropped ${dead} dead client(s) for ${sessionId}`);
  // Mark delivered only if a live client survived the write, so a frame lost to
  // an all-dead broadcast still replays on the next connect.
  if (s.clients.size > 0) s.lastDeliveredId = id;
}

/** Push to the ring AND fan out live — the single emit used everywhere. */
export function emit(sessionId: string, msg: EvenMessage): void {
  if (!sessionId) return;
  const id = pushMessage(sessionId, msg);
  broadcast(sessionId, msg, id);
}

/**
 * Emit assistant/system text the way the Even glasses firmware renders it.
 * The stock @evenrealities/even-terminal has NO `agent_message` type: assistant
 * text is rendered as a `text_delta` stream bracketed by a `status:text_start`
 * / `status:text_end` pair (see the reference bridge's claude/session.js). The
 * glasses silently drop any unknown frame type, so the bridge's old
 * `agent_message` emits never rendered — the answer reached the ring but wore a
 * type the firmware ignores. The reference streams many deltas live; the bridge
 * tails completed jsonl, so the whole line ships in one delta.
 */
export function emitText(sessionId: string, text: string): void {
  // Byte-match the reference wire (proven to paint on the glasses): EVERY status
  // frame carries `sessionId`; text_delta ships bare (no `ts`, no icon prefix).
  // The glasses key the render buffer off the sessionId on the status frames —
  // a text_start without it never arms text render, so the body stayed blank.
  emit(sessionId, { type: "status", state: "text_start", sessionId });
  emit(sessionId, { type: "text_delta", text });
  emit(sessionId, { type: "status", state: "text_end", sessionId });
  // The reference finalizes the turn with a `result` frame carrying sessionId +
  // the full stats shape. The firmware treats the streamed deltas as transient
  // and commits the persisted message from result.text — without it the answer
  // flashes and clears on idle. We tail completed jsonl, so ship it in one go;
  // stats are unknown for a tailed turn and ship as zero (shape over accuracy).
  emit(sessionId, {
    type: "result",
    success: true,
    text,
    sessionId,
    costUsd: 0,
    provider: "claude",
    turns: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
  });
}

/**
 * Emit a `user_question` frame the way the Even App arms its native question UI.
 * This is what the reference bridge sends when an agent asks a question (see
 * even-terminal/dist/claude/session.js: handleAskUserQuestion). The App keys its
 * "awaiting" mode off this frame — only then does the mic answer the question
 * DIRECTLY (POST /question-response) instead of being read as an interrupt that
 * prompts "quit waiting for agent response?". Without it the wearer sees the
 * option text but the App still thinks a turn is in-flight, so answering needs a
 * hold-to-quit first. One question, options as {label}; header/description empty
 * (our picker carries only labels). toolUseId is synthetic (the answer routes by
 * sessionId, not toolUseId, in our tmux-backed responder).
 */
export function emitQuestion(
  sessionId: string,
  question: string,
  options: string[],
): void {
  emit(sessionId, {
    type: "user_question",
    questions: [
      {
        question,
        header: "",
        options: options.map((label) => ({ label, description: "", preview: "" })),
      },
    ],
    toolUseId: `bridge-${sessionId}`,
    sessionId,
  });
}

/**
 * Optimistic-echo dedupe. provider echoes a glasses-sent prompt instantly (so
 * the wearer sees their own words with no lag); seconds later the jsonl tailer
 * reads the same user line gsd wrote and would emit it again. provider records
 * each echo here; the tailer calls consumeEcho to drop the one matching replay.
 * Matched once, then removed, so a genuine later repeat of the same text still
 * shows. Records expire after ECHO_TTL_MS to bound the map.
 */
const recentEchoes = new Map<string, Array<{ text: string; at: number }>>();
const ECHO_TTL_MS = 60_000;

function normEcho(t: string): string {
  // gsd's TUI rewrites the typed line before flushing it to jsonl: it strips a
  // leading slash, sentence-cases words, and adds trailing punctuation. Match
  // loosely so the optimistic echo still cancels its own replay: lowercase,
  // drop a leading slash, strip trailing punctuation, collapse whitespace.
  return t
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[.!?…]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function recordEcho(sessionId: string, text: string): void {
  const arr = recentEchoes.get(sessionId) ?? [];
  arr.push({ text: normEcho(text), at: Date.now() });
  recentEchoes.set(sessionId, arr);
}

/** True (and consumes the record) if this user line matches a fresh echo. */
export function consumeEcho(sessionId: string, text: string): boolean {
  const arr = recentEchoes.get(sessionId);
  if (!arr) return false;
  const now = Date.now();
  const t = normEcho(text);
  let hit = false;
  const kept: Array<{ text: string; at: number }> = [];
  for (const e of arr) {
    if (now - e.at > ECHO_TTL_MS) continue; // prune stale
    if (!hit && e.text === t) {
      hit = true; // consume exactly one
      continue;
    }
    kept.push(e);
  }
  if (kept.length) recentEchoes.set(sessionId, kept);
  else recentEchoes.delete(sessionId);
  return hit;
}

export function sessionHasClients(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  return !!s && s.clients.size > 0;
}

export function totalClients(): number {
  let n = 0;
  for (const s of sessions.values()) n += s.clients.size;
  return n;
}

/** Attach an SSE client. Returns a disposer. */
export function addClient(
  sessionId: string,
  res: Response,
  needReplay: boolean,
  lastEventId?: string,
): () => void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.write(":ok\n\n");

  const s = getSession(sessionId);
  // Pick a replay cursor and re-send every frame after it. Priority:
  //   1. Last-Event-ID — a standard EventSource auto-reconnect cursor (rare here).
  //   2. needReplay=true — explicit full-history load (replay the whole ring).
  //   3. lastDeliveredId — the dark-window gap. The glasses drop SSE every ~30s
  //      and set neither of the above, so without this the answer that broadcast
  //      while they were disconnected is lost forever. This closes that gap.
  const after = Number(lastEventId);
  const replayFrom = Number.isFinite(after) && after > 0 ? after : needReplay ? 0 : s.lastDeliveredId;
  let replayed = 0;
  for (const entry of s.messages) {
    if (entry.id > replayFrom) {
      res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.msg)}\n\n`);
      replayed++;
    }
  }
  log.debug(
    "sse",
    `connect ${sessionId} replayFrom=${replayFrom} replayed=${replayed}/${s.messages.length} ring (nextId=${s.nextId}, lastDelivered=${s.lastDeliveredId})`,
  );
  s.lastDeliveredId = s.nextId - 1;
  s.clients.add(res);
  log.info("sse", `client connected ${sessionId} (session=${s.clients.size} total=${totalClients()})`);

  const heartbeat = setInterval(() => {
    try {
      res.write(":heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
      s.clients.delete(res);
    }
  }, 15000);

  return () => {
    clearInterval(heartbeat);
    s.clients.delete(res);
    log.info("sse", `client disconnected ${sessionId} (total=${totalClients()})`);
  };
}
