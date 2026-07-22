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
}

const sessions = new Map<string, SessionBuf>();

function getSession(sessionId: string): SessionBuf {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { messages: [], clients: new Set(), nextId: 1 };
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
  if (!s || s.clients.size === 0) return;
  const data = JSON.stringify(msg);
  let dead = 0;
  for (const res of s.clients) {
    try {
      res.write(`id: ${id}\ndata: ${data}\n\n`);
    } catch {
      s.clients.delete(res);
      dead++;
    }
  }
  if (dead > 0) log.warn("sse", `dropped ${dead} dead client(s) for ${sessionId}`);
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
export function emitText(sessionId: string, text: string, ts?: string): void {
  emit(sessionId, { type: "status", state: "text_start" });
  emit(sessionId, { type: "text_delta", text, ...(ts ? { ts } : {}) });
  emit(sessionId, { type: "status", state: "text_end" });
  // The reference streams text_delta live, then finalizes the turn with a
  // `result` frame. The firmware treats the streamed deltas as transient and
  // commits the persisted message from result.text — without it the answer
  // flashes and clears on idle. We tail completed jsonl, so ship it in one go.
  emit(sessionId, { type: "result", success: true, text, provider: "claude", sessionId });
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
export function addClient(sessionId: string, res: Response, needReplay: boolean): () => void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.write(":ok\n\n");

  const s = getSession(sessionId);
  if (needReplay) {
    for (const entry of s.messages) {
      res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.msg)}\n\n`);
    }
  }
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
