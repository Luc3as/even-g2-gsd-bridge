import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAutoState, latestSeriousNotification, classifyDisplayState, STALL_CEILING_MS, type AutoState } from "../src/gsd/auto.ts";

// A temp project cwd with a .gsd dir. Optionally seed auto.lock + notifications.
function makeProject(opts: { lock?: object | string; notifs?: object[] }): {
  cwd: string;
  cleanup: () => void;
} {
  const cwd = mkdtempSync(join(tmpdir(), "auto-"));
  mkdirSync(join(cwd, ".gsd"));
  if (opts.lock !== undefined) {
    const body = typeof opts.lock === "string" ? opts.lock : JSON.stringify(opts.lock);
    writeFileSync(join(cwd, ".gsd", "auto.lock"), body);
  }
  if (opts.notifs) {
    writeFileSync(
      join(cwd, ".gsd", "notifications.jsonl"),
      opts.notifs.map((n) => JSON.stringify(n)).join("\n") + "\n",
    );
  }
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

const notif = (severity: string, message: string, id: string) => ({
  id,
  ts: "2026-07-27T13:00:00.000Z",
  severity,
  message,
  source: "notify",
  read: false,
});

test("readAutoState: no lock → liveness 'none'", () => {
  const { cwd, cleanup } = makeProject({});
  try {
    assert.deepEqual(readAutoState(cwd), { liveness: "none", quietForMs: null, unitId: null, unitType: null, pid: null });
  } finally {
    cleanup();
  }
});

test("readAutoState: lock held by THIS live process → running", () => {
  // process.pid is guaranteed alive, so this exercises the alive branch.
  const { cwd, cleanup } = makeProject({
    lock: { pid: process.pid, unitType: "run-uat", unitId: "M013/S02" },
  });
  try {
    const s = readAutoState(cwd);
    assert.equal(s.liveness, "running");
    assert.equal(s.unitId, "M013/S02");
    assert.equal(s.unitType, "run-uat");
    assert.equal(s.pid, process.pid);
  } finally {
    cleanup();
  }
});

test("readAutoState: lock held by a DEAD pid → stopped, carries the unit", () => {
  // PID 2^31-1 is above the kernel max, so it never exists → the dead branch.
  const { cwd, cleanup } = makeProject({
    lock: { pid: 2147483647, unitType: "execute-task", unitId: "M014/S01" },
  });
  try {
    const s = readAutoState(cwd);
    assert.equal(s.liveness, "stopped");
    assert.equal(s.unitId, "M014/S01");
    assert.equal(s.unitType, "execute-task");
  } finally {
    cleanup();
  }
});

test("readAutoState: lock with no pid → running (a lock exists, liveness unjudgeable)", () => {
  const { cwd, cleanup } = makeProject({ lock: { unitId: "M001/S01" } });
  try {
    assert.equal(readAutoState(cwd).liveness, "running");
  } finally {
    cleanup();
  }
});

test("readAutoState: corrupt lock → 'none' (never throws)", () => {
  const { cwd, cleanup } = makeProject({ lock: "{ not json" });
  try {
    assert.equal(readAutoState(cwd).liveness, "none");
  } finally {
    cleanup();
  }
});

test("latestSeriousNotification: none when only info/routine warnings", () => {
  const { cwd, cleanup } = makeProject({
    notifs: [
      notif("info", "Auto-mode resumed.", "a"),
      notif("warning", "Idle recovery: steering complete-slice M011/S03…", "b"),
      notif("warning", "[session] Lock heartbeat caught up after 10s — no action needed.", "c"),
    ],
  });
  try {
    assert.equal(latestSeriousNotification(cwd), null);
  } finally {
    cleanup();
  }
});

test("latestSeriousNotification: an error severity is always serious", () => {
  const { cwd, cleanup } = makeProject({
    notifs: [
      notif("info", "Auto-mode resumed.", "a"),
      notif("error", "[safety] evidence-xref: Claimed exitCode=0 but actual exitCode=1", "b"),
      notif("info", "later info", "c"),
    ],
  });
  try {
    const n = latestSeriousNotification(cwd);
    assert.equal(n?.id, "b");
    assert.equal(n?.severity, "error");
  } finally {
    cleanup();
  }
});

test("latestSeriousNotification: pause/halt-class warnings ARE surfaced", () => {
  const { cwd, cleanup } = makeProject({
    notifs: [
      notif("warning", "Idle recovery: routine", "a"),
      notif("warning", "Unit M013/S02 hit per-unit cap $5.00 — pausing auto-mode.", "b"),
    ],
  });
  try {
    assert.equal(latestSeriousNotification(cwd)?.id, "b");
  } finally {
    cleanup();
  }
});

test("latestSeriousNotification: returns the MOST RECENT serious one (tail-first)", () => {
  const { cwd, cleanup } = makeProject({
    notifs: [
      notif("error", "first error", "a"),
      notif("info", "chatter", "b"),
      notif("warning", "Auto-mode paused due to provider error", "c"),
    ],
  });
  try {
    assert.equal(latestSeriousNotification(cwd)?.id, "c");
  } finally {
    cleanup();
  }
});

test("latestSeriousNotification: absent file → null", () => {
  const { cwd, cleanup } = makeProject({});
  try {
    assert.equal(latestSeriousNotification(cwd), null);
  } finally {
    cleanup();
  }
});

// --- classifyDisplayState: the wearer-facing running/paused/stopped/idle map ---

const auto = (liveness: AutoState["liveness"], quietForMs: number | null = null): AutoState => ({
  liveness,
  quietForMs,
  unitId: null,
  unitType: null,
  pid: null,
});

test("classifyDisplayState: no lock → idle regardless of pause signal", () => {
  assert.equal(classifyDisplayState(auto("none"), false), "idle");
  assert.equal(classifyDisplayState(auto("none"), true), "idle");
});

test("classifyDisplayState: hard-dead liveness → stopped", () => {
  assert.equal(classifyDisplayState(auto("stopped"), false), "stopped");
  // A pause signal cannot resurrect a dead run.
  assert.equal(classifyDisplayState(auto("stopped"), true), "stopped");
});

test("classifyDisplayState: quiet PAST the ceiling → stopped (credit-death, pid alive)", () => {
  assert.equal(classifyDisplayState(auto("quiet", STALL_CEILING_MS), false), "stopped");
  assert.equal(classifyDisplayState(auto("quiet", STALL_CEILING_MS + 60_000), false), "stopped");
});

test("classifyDisplayState: quiet UNDER the ceiling → running (brief mid-unit silence is work)", () => {
  assert.equal(classifyDisplayState(auto("quiet", 5 * 60_000), false), "running");
  assert.equal(classifyDisplayState(auto("running"), false), "running");
});

test("classifyDisplayState: pause signal with a live worker → paused", () => {
  assert.equal(classifyDisplayState(auto("running"), true), "paused");
  // Quiet-but-under-ceiling is still a live worker, so a blocker there is paused too.
  assert.equal(classifyDisplayState(auto("quiet", 5 * 60_000), true), "paused");
});

test("classifyDisplayState: ceiling is injectable", () => {
  assert.equal(classifyDisplayState(auto("quiet", 3 * 60_000), false, 2 * 60_000), "stopped");
  assert.equal(classifyDisplayState(auto("quiet", 1 * 60_000), false, 2 * 60_000), "running");
});
