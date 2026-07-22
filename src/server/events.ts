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
