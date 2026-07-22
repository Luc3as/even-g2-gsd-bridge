import { Router, type Request, type Response } from "express";
import type { GsdProvider } from "../even/provider.js";
import { addClient, getMessages } from "./events.js";
import { log } from "../log.js";

/**
 * HTTP surface, wire-compatible with @evenrealities/even-terminal@0.8.1 so the
 * stock Even App talks to us unmodified. Single provider ("gsd"); the official
 * `provider` query/body field is accepted and ignored.
 */
const STATUS_CHECK_COUNT = 10;

export function createRoutes(provider: GsdProvider): Router {
  const router = Router();

  // GET /events?sessionId=&needReplay=true — SSE stream
  router.get("/events", (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: "Missing 'sessionId' query parameter" });
      return;
    }
    const dispose = addClient(sessionId, res, req.query.needReplay === "true");
    req.on("close", dispose);
  });

  // GET /sessions — resumable/attachable sessions (one per project)
  router.get("/sessions", async (req: Request, res: Response) => {
    const limit = Number(req.query.limit) || 10;
    try {
      const sessions = await provider.listSessions(limit, req.query.cwd as string | undefined);
      await Promise.all(
        sessions.slice(0, STATUS_CHECK_COUNT).map(async (s, i) => {
          if (sessions[i]!.status) return;
          sessions[i]!.status = await provider.getSessionStatus(s.id);
        }),
      );
      res.json({ sessions });
    } catch (err) {
      res.json({ sessions: [], error: (err as Error).message });
    }
  });

  // GET /info — account, model, version, provider
  router.get("/info", async (_req: Request, res: Response) => {
    try {
      res.json(await provider.getInfo());
    } catch (err) {
      res.json({ account: {}, model: "Unknown", version: "Unknown", error: (err as Error).message });
    }
  });

  // GET /sessions/:id/history
  router.get("/sessions/:id/history", async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 20);
    try {
      const history = await provider.getHistory(String(req.params.id), limit);
      res.json({ history });
    } catch (err) {
      res.json({ history: [], error: (err as Error).message });
    }
  });

  // POST /prompt — send a prompt (attach to live; spawn if configured)
  router.post("/prompt", async (req: Request, res: Response) => {
    const { text, sessionId, cwd } = req.body ?? {};
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Missing 'text' field" });
      return;
    }
    try {
      const result = await provider.prompt(sessionId, text, cwd);
      res.status(202).json({ ok: true, sessionId: result.sessionId, provider: result.provider });
    } catch (err) {
      const code = typeof (err as any).statusCode === "number" ? (err as any).statusCode : 500;
      log.error("route", `prompt failed (${code})`, err);
      res.status(code).json({ error: (err as Error).message });
    }
  });

  // POST /permission-response
  router.post("/permission-response", (req: Request, res: Response) => {
    const { sessionId, decision } = req.body ?? {};
    if (!sessionId) {
      res.status(400).json({ error: "Missing 'sessionId'" });
      return;
    }
    if (!provider.getStatus(sessionId)) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    provider.respondPermission(sessionId, decision || "deny");
    res.json({ ok: true });
  });

  // POST /question-response
  router.post("/question-response", (req: Request, res: Response) => {
    const { sessionId, answer } = req.body ?? {};
    if (!sessionId) {
      res.status(400).json({ error: "Missing 'sessionId'" });
      return;
    }
    if (!provider.getStatus(sessionId)) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    provider.respondQuestion(sessionId, answer || "skip");
    res.json({ ok: true });
  });

  // POST /interrupt
  router.post("/interrupt", (req: Request, res: Response) => {
    const { sessionId } = req.body ?? {};
    if (!sessionId) {
      res.status(400).json({ error: "Missing 'sessionId'" });
      return;
    }
    if (!provider.getStatus(sessionId)) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    provider.interrupt(sessionId);
    res.json({ ok: true });
  });

  // GET /status?sessionId=
  router.get("/status", (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: "Missing 'sessionId'" });
      return;
    }
    const status = provider.getStatus(sessionId);
    if (!status) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ state: status.state, sessionId, provider: status.provider });
  });

  // GET /messages?sessionId=&after= — poll fallback for SSE
  router.get("/messages", (req: Request, res: Response) => {
    const after = parseInt(req.query.after as string) || 0;
    const sessionId = req.query.sessionId as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: "Missing 'sessionId'" });
      return;
    }
    const status = provider.getStatus(sessionId);
    res.json({
      messages: getMessages(sessionId, after),
      state: status?.state ?? "idle",
      sessionId,
      provider: "gsd",
    });
  });

  return router;
}
