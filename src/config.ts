import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Runtime configuration, read once from env. All values have safe defaults so
 * the bridge boots with zero setup on the rig; override via env or a systemd
 * EnvironmentFile.
 */
export interface Config {
  /** TCP port the Even App connects to. Even ecosystem default is 3456. */
  port: number;
  /** Bind address. 0.0.0.0 so the phone can reach it over the WG-routed LAN. */
  bindHost: string;
  /** Bearer token the glasses must present (?token= or Authorization header). */
  token: string;
  /**
   * Roots that hold one session dir per project. gsd writes interactive TUI
   * sessions to ~/.gsd/sessions and (older) auto-mode runs to ~/.gsd/agent/sessions;
   * current gsd-pi auto-mode writes live runs in Claude-Code format under
   * ~/.claude/projects. All are scanned and merged (newest wins per cwd), and
   * parseLine normalizes the Claude-Code shape, so the live run is picked up.
   */
  sessionsDirs: string[];
  /** Only projects whose cwd is under one of these roots are exposed. */
  projectRoots: string[];
  /** If a project has no live tmux session, create one and launch gsd on prompt. */
  allowSpawn: boolean;
  /** Command run inside a freshly-spawned tmux session (see allowSpawn). */
  spawnCommand: string;
  /** Keystrokes sent to the gsd TUI for control actions (needs live calibration). */
  keymap: {
    /** permission "allow" — default highlighted choice is usually accept. */
    permissionAllow: string[];
    permissionDeny: string[];
    /** interrupt the current turn without killing the process. */
    interrupt: string[];
  };
  /** Directory for failure-state + pid artifacts. */
  stateDir: string;
  /** Poll interval (ms) for tailing jsonl files. */
  tailIntervalMs: number;
  /** A session is "busy" only if its jsonl changed within this window. */
  busyWindowMs: number;
  /**
   * Canonical command a matched resume utterance is rewritten to before it is
   * forwarded into the live tmux pane (see isResumeCommand). Restarts a
   * paused/stopped `gsd auto` run. Override via env RESUME_COMMAND.
   */
  resumeCommand: string;
}

function envList(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (!v) return fallback;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(): Config {
  const home = homedir();
  return {
    port: parseInt(process.env.PORT ?? "3456", 10),
    bindHost: process.env.BIND_HOST ?? "0.0.0.0",
    token: process.env.BRIDGE_TOKEN ?? randomBytes(16).toString("hex"),
    sessionsDirs: envList("GSD_SESSIONS_DIR", [
      join(home, ".gsd", "sessions"),
      join(home, ".gsd", "agent", "sessions"),
      join(home, ".claude", "projects"),
    ]),
    projectRoots: envList("PROJECT_ROOTS", ["/opt/AI_projects"]),
    allowSpawn: (process.env.ALLOW_SPAWN ?? "true") !== "false",
    spawnCommand: process.env.SPAWN_COMMAND ?? "gsd",
    keymap: {
      permissionAllow: envList("KEY_PERMISSION_ALLOW", ["Enter"]),
      permissionDeny: envList("KEY_PERMISSION_DENY", ["Escape"]),
      interrupt: envList("KEY_INTERRUPT", ["Escape"]),
    },
    stateDir: process.env.STATE_DIR ?? join(process.cwd(), ".state"),
    tailIntervalMs: parseInt(process.env.TAIL_INTERVAL_MS ?? "500", 10),
    busyWindowMs: parseInt(process.env.BUSY_WINDOW_MS ?? "120000", 10),
    resumeCommand: process.env.RESUME_COMMAND ?? "/gsd auto",
  };
}

/** Best-effort primary LAN IPv4, used for the QR URL the glasses scan. */
export function primaryLanIp(): string {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}
