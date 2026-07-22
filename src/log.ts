import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Agent-first observability. Structured single-line logs plus a persisted
 * last-error file so the next agent (or a curl to /health) can diagnose a
 * wedged bridge without a live console.
 */
type Level = "debug" | "info" | "warn" | "error";

/** Verbose per-frame SSE tracing, gated so it stays off in normal operation. */
const DEBUG = process.env.DEBUG === "1";

let stateDir = ".state";
export function setStateDir(dir: string): void {
  stateDir = dir;
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch {
    /* best effort */
  }
}

export interface FailureState {
  message: string;
  phase: string;
  timestamp: string;
  stack?: string;
}

let lastError: FailureState | null = null;
export function getLastError(): FailureState | null {
  return lastError;
}

function line(level: Level, scope: string, msg: string): void {
  const ts = new Date().toISOString();
  const out = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (level === "error") console.error(out);
  else if (level === "warn") console.warn(out);
  else console.log(out);
}

export const log = {
  /** Only emits when DEBUG=1. Use for high-volume per-frame SSE tracing. */
  debug: (scope: string, msg: string) => {
    if (DEBUG) line("debug", scope, msg);
  },
  info: (scope: string, msg: string) => line("info", scope, msg),
  warn: (scope: string, msg: string) => line("warn", scope, msg),
  /** Records an error AND persists it as the durable failure state. */
  error: (scope: string, msg: string, err?: unknown) => {
    const stack = err instanceof Error ? err.stack : undefined;
    line("error", scope, msg + (err instanceof Error ? `: ${err.message}` : ""));
    lastError = { message: msg, phase: scope, timestamp: new Date().toISOString(), stack };
    try {
      writeFileSync(join(stateDir, "last-error.json"), JSON.stringify(lastError, null, 2));
    } catch {
      /* best effort */
    }
  },
};
