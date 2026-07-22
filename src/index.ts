import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import qrcode from "qrcode-terminal";
import { loadConfig, primaryLanIp } from "./config.js";
import { createGsdProvider } from "./even/provider.js";
import { createRoutes } from "./server/routes.js";
import { startWatcher } from "./gsd/watch.js";
import { totalClients } from "./server/events.js";
import { log, setStateDir, getLastError, redactToken } from "./log.js";

const cfg = loadConfig();
setStateDir(cfg.stateDir);

const startedAt = Date.now();
const provider = createGsdProvider(cfg);

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Request log line (skips the noisy SSE heartbeat stream).
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === "/api/events") return next();
  const t0 = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    log.info("http", `${req.ip} ${res.statusCode} ${req.method} ${redactToken(req.originalUrl)} ${ms.toFixed(0)}ms`);
  });
  next();
});

// ── Health (unauthenticated, agent-first diagnostics) ──────────────────
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    sseClients: totalClients(),
    lastError: getLastError(),
    bind: `${cfg.bindHost}:${cfg.port}`,
    sessionsDirs: cfg.sessionsDirs,
    projectRoots: cfg.projectRoots,
  });
});

// ── Auth: Bearer token or ?token= ──────────────────────────────────────
function auth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : (req.query.token as string | undefined);
  if (provided !== cfg.token) {
    log.warn("auth", `401 ${req.method} ${req.path} (ip=${req.ip})`);
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

app.use("/api", auth, createRoutes(provider));

const server = app.listen(cfg.port, cfg.bindHost, () => {
  const ip = primaryLanIp();
  const url = `http://${ip}:${cfg.port}`;
  const connectUrl = `${url}?token=${cfg.token}`;
  log.info("server", `listening on ${cfg.bindHost}:${cfg.port}`);
  console.log("\n══════════════════════════════════════════════");
  console.log("  Even G2 ↔ GSD-PI bridge");
  console.log(`  LAN URL   : ${url}`);
  console.log(`  token     : ${cfg.token}`);
  console.log(`  sessions  : ${cfg.sessionsDirs.join(", ")}`);
  console.log(`  projects  : ${cfg.projectRoots.join(", ")}`);
  console.log("  Scan in the Even App (Terminal Mode):");
  console.log("══════════════════════════════════════════════\n");
  qrcode.generate(connectUrl, { small: true });
  startWatcher(cfg);
});

// ── Process-level resilience ───────────────────────────────────────────
process.on("uncaughtException", (err) => log.error("process", "uncaughtException", err));
process.on("unhandledRejection", (reason) => log.error("process", `unhandledRejection: ${String(reason)}`));

function shutdown() {
  log.info("server", "shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
