import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../log.js";

const execFileAsync = promisify(execFile);

/**
 * tmux adapter — the WRITE side of attach-to-live. The bridge never owns the
 * agent subprocess; it injects keystrokes into the same tmux session sersám
 * launches, so the desk `gsd` stays the sole stdio owner. Proven mechanic
 * (2026-07-22): `send-keys <literal>` then `send-keys Enter` submits a line.
 */

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, { timeout: 5000 });
  return stdout;
}

export async function hasSession(name: string): Promise<boolean> {
  try {
    await tmux(["has-session", "-t", `=${name}`]);
    return true;
  } catch {
    return false;
  }
}

export async function listSessionNames(): Promise<string[]> {
  try {
    const out = await tmux(["list-sessions", "-F", "#{session_name}"]);
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return []; // no server running = no sessions
  }
}

/** Create a detached tmux session at cwd and launch the agent command. */
export async function spawnSession(name: string, cwd: string, command: string): Promise<void> {
  await tmux(["new-session", "-d", "-s", name, "-c", cwd]);
  await tmux(["send-keys", "-t", name, command, "Enter"]);
  log.info("tmux", `spawned session ${name} at ${cwd} (launched: ${command})`);
}

/**
 * Send a text prompt as one submitted line: literal text (so spaces/quotes are
 * safe) followed by a separate Enter. `-l` forces literal interpretation.
 * Note: send-keys pane targets do NOT accept the `=exact` prefix (unlike
 * has-session), so we target the bare session name (its active pane).
 */
export async function sendPrompt(name: string, text: string): Promise<void> {
  await tmux(["send-keys", "-t", name, "-l", text]);
  // Ink TUIs (gsd) need the literal text to commit to input state before the
  // newline, or the Enter lands in the same render frame and is dropped —
  // typed line sits unsubmitted. A short beat makes submit reliable.
  await new Promise((r) => setTimeout(r, 200));
  await tmux(["send-keys", "-t", name, "Enter"]);
}

/** Send raw named keys (e.g. Enter, Escape, C-c) for control actions. */
export async function sendKeys(name: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await tmux(["send-keys", "-t", name, ...keys]);
}

/** Capture the visible pane content — fallback view / permission-dialog scrape. */
export async function capturePane(name: string, lines = 40): Promise<string> {
  try {
    return await tmux(["capture-pane", "-t", name, "-p", "-S", `-${lines}`]);
  } catch {
    return "";
  }
}
