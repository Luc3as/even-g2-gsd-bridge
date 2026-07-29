import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tick, markNextSteps, nextStepsOptions } from "../src/gsd/watch.ts";
import { getMessages } from "../src/server/events.ts";
import { setPending, clearPending } from "../src/gsd/questions.ts";
import type { Config } from "../src/config.ts";

const SESSION = (cwd: string) =>
  JSON.stringify({ type: "session", version: 3, id: "t", timestamp: "2026-07-22T00:00:00.000Z", cwd });
const USER = (text: string) =>
  JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const ASSISTANT = (text: string) =>
  JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "thinking", text: "…" }, { type: "text", text }] },
  });

function cfgFor(store: string): Config {
  return {
    sessionsDirs: [store],
    projectRoots: ["/opt/AI_projects"],
    busyWindowMs: 120000,
    tailIntervalMs: 500,
  } as Config;
}

// Regression: a newline-terminated chunk used to drift the byte offset +1 per
// read (the trailing "" from split counted as a byte), so the NEXT line was read
// one byte short, failed to parse, and its entry was silently dropped. For a
// plain answer turn that dropped line was the answer text — it never reached
// the ring, and the glasses stayed stuck on "thinking". The answer now ships as
// a firmware-known text_delta (bracketed by text_start/text_end), not an
// `agent_message` the glasses silently drop.
test("tick emits an answer written a tick after the prompt (no offset drift)", () => {
  const store = mkdtempSync(join(tmpdir(), "watch-drift-"));
  try {
    const cwd = "/opt/AI_projects/drift-probe";
    const dir = join(store, "--slug--");
    mkdirSync(dir);
    const file = join(dir, "x.jsonl");
    // Pre-existing transcript so first-sight starts at a non-zero EOF.
    writeFileSync(file, SESSION(cwd) + "\n" + ASSISTANT("older answer") + "\n");
    const cfg = cfgFor(store);

    let now = 1_000_000;
    tick(cfg, now); // first sight → offset = EOF
    now += 500;

    appendFileSync(file, USER("Show me the letters bit") + "\n");
    tick(cfg, now); // prompt lands in its own chunk
    now += 500;

    appendFileSync(file, ASSISTANT("Letters bit = the trailer line.") + "\n");
    tick(cfg, now); // answer lands in the next chunk
    now += 500;
    tick(cfg, now);

    const msgs = getMessages("--slug--", 0);
    const types = msgs.map((m) => m.type);
    assert.ok(types.includes("user_prompt"), `expected user_prompt, got ${types.join(",")}`);
    // Answer renders via the text_delta triad, not an agent_message.
    assert.ok(types.includes("text_delta"), `answer dropped by offset drift, got ${types.join(",")}`);
    assert.ok(!types.includes("agent_message"), `answer must not use the unrenderable agent_message type`);
    const answer = msgs.find((m) => m.type === "text_delta");
    assert.equal((answer as { text?: string }).text, "Letters bit = the trailer line.");
    // text_delta must be bracketed by a text_start/text_end status pair.
    const startIdx = msgs.findIndex((m) => m.type === "status" && (m as { state?: string }).state === "text_start");
    const deltaIdx = msgs.findIndex((m) => m.type === "text_delta");
    const endIdx = msgs.findIndex((m) => m.type === "status" && (m as { state?: string }).state === "text_end");
    assert.ok(startIdx >= 0 && startIdx < deltaIdx && deltaIdx < endIdx, "text_delta not bracketed by text_start/text_end");
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

// Regression: while a gsd picker is open, the transcript's last entry is the
// toolCall that opened it and the file mtime is fresh, so the tailer would emit
// a "busy" status and the glasses show "working" over the question. That false
// busy is why the wearer holds the ring, whose ESC then kills the turn. With a
// pending picker the turn is blocked on the human → the busy flip is suppressed.
const TOOLCALL = () =>
  JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "toolCall", name: "ask_user_questions", arguments: {} }] },
  });

test("tick suppresses the busy status flip while a picker is pending", () => {
  const store = mkdtempSync(join(tmpdir(), "watch-pending-"));
  try {
    const cwd = "/opt/AI_projects/pending-probe";
    const dir = join(store, "--pslug--");
    mkdirSync(dir);
    const file = join(dir, "x.jsonl");
    writeFileSync(file, SESSION(cwd) + "\n" + ASSISTANT("older answer") + "\n");
    const cfg = cfgFor(store);

    let now = 2_000_000;
    tick(cfg, now); // first sight → offset = EOF, status idle
    now += 500;

    // The turn opens a picker: gsd flushes the toolCall line, then nothing more.
    setPending("--pslug--", {
      header: "Fruit",
      prompt: "Pick",
      options: ["a", "b"],
      multi: false,
      signature: "s|Fruit|Pick|a|b",
    });
    appendFileSync(file, TOOLCALL() + "\n");
    tick(cfg, now); // toolCall would be "busy" — but a picker is pending

    const busy = getMessages("--pslug--", 0).filter(
      (m) => m.type === "status" && (m as { state?: string }).state === "busy",
    );
    assert.equal(busy.length, 0, "must not flip to busy while a picker is pending");
  } finally {
    clearPending("--pslug--");
    rmSync(store, { recursive: true, force: true });
  }
});

// Regression: the elapsed ticker gate is `status==="busy"`, but busy used to
// flip ONLY when a tick read growth from the exact file being tailed. gsd-native
// rotates a transcript file per turn while the Claude-Code run streams to a
// sibling, so the growth lands off-target and busy never asserted → the ticker
// stayed frozen for a whole long task. Busy now also asserts from freshness: a
// transcript written within the busy window means the run is live. A real stall
// (nothing written past the window) still resolves idle so the ticker stops.
test("tick asserts busy from mtime freshness when no decisive chunk is read", () => {
  const store = mkdtempSync(join(tmpdir(), "watch-fresh-"));
  try {
    const cwd = "/opt/AI_projects/fresh-probe";
    const dir = join(store, "--fslug--");
    mkdirSync(dir);
    const file = join(dir, "x.jsonl");
    // A toolCall-only transcript: mid-task, no finished-answer text. The chunk
    // verdict on first-sight is skipped (offset starts at EOF), so only freshness
    // can decide — and the file was just written, so it must resolve busy.
    writeFileSync(file, SESSION(cwd) + "\n" + TOOLCALL() + "\n");
    const cfg = cfgFor(store);

    // Real wall-clock now so `now - mtimeMs` is a small positive age (fresh).
    let now = Date.now();
    tick(cfg, now); // first sight → offset=EOF, status idle, continues (no verdict)
    tick(cfg, now); // no new chunk, but mtime fresh → freshness asserts busy
    const busy = getMessages("--fslug--", 0).filter(
      (m) => m.type === "status" && (m as { state?: string }).state === "busy",
    );
    assert.equal(busy.length, 1, "fresh transcript with no decisive chunk must resolve busy");

    // Jump the clock past the busy window with no new write → stale → idle.
    now += cfg.busyWindowMs + 1000;
    tick(cfg, now);
    const last = getMessages("--fslug--", 0).filter((m) => m.type === "status").at(-1);
    assert.equal((last as { state?: string }).state, "idle", "a stall past the busy window must resolve idle");
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

// A crash just stops jsonl writes, so status lapses to idle — the wearer can't
// tell "died" from "finished". The alarm reads gsd's own liveness (auto.lock pid)
// and pushes a loud AUTO-STOPPED line ONCE, on the running→stopped transition.
// The project cwd must be a real dir here (unlike the fake-cwd tests above) so its
// .gsd/auto.lock is readable — so the store lives INSIDE the project root.
test("tick alarms once when an auto-run's lock pid goes dead", () => {
  const root = mkdtempSync(join(tmpdir(), "watch-alarm-root-"));
  try {
    const cwd = join(root, "crashy-proj");
    mkdirSync(join(cwd, ".gsd"), { recursive: true });
    const store = join(root, "store");
    const dir = join(store, "--aslug--");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "x.jsonl");
    writeFileSync(file, SESSION(cwd) + "\n" + ASSISTANT("mid-run answer") + "\n");
    const cfg = { sessionsDirs: [store], projectRoots: [root], busyWindowMs: 120000, tailIntervalMs: 500 } as Config;

    let now = Date.now();
    // Lock held by a live pid (this process) → running. Baseline, no alarm.
    writeFileSync(join(cwd, ".gsd", "auto.lock"), JSON.stringify({ pid: process.pid, unitType: "run-uat", unitId: "M013/S02" }));
    tick(cfg, now); // first sight → adopts "running" baseline silently, offset=EOF
    now += 500;

    // A busy chunk lands so the tail status flips to "busy" — the state the
    // glasses gate input on. The death transition below must force it back to idle.
    appendFileSync(file, TOOLCALL() + "\n");
    tick(cfg, now);
    now += 500;
    assert.equal(
      getMessages("--aslug--", 0).filter((m) => m.type === "status").at(-1) &&
        (getMessages("--aslug--", 0).filter((m) => m.type === "status").at(-1) as { state?: string }).state,
      "busy",
      "tail must be busy before the run dies",
    );

    let alarms = getMessages("--aslug--", 0).filter(
      (m) => m.type === "text_delta" && String((m as { text?: string }).text).includes("AUTO-STOPPED"),
    );
    assert.equal(alarms.length, 0, "must not alarm while the run is live");

    // The run dies: lock now names a dead pid. Transition running→stopped fires.
    writeFileSync(join(cwd, ".gsd", "auto.lock"), JSON.stringify({ pid: 2147483647, unitType: "run-uat", unitId: "M013/S02" }));
    tick(cfg, now);
    now += 500;
    tick(cfg, now); // second tick over the same dead lock must NOT re-alarm

    alarms = getMessages("--aslug--", 0).filter(
      (m) => m.type === "text_delta" && String((m as { text?: string }).text).includes("AUTO-STOPPED"),
    );
    assert.equal(alarms.length, 1, "AUTO-STOPPED must fire exactly once on the death transition");
    assert.ok(String((alarms[0] as { text?: string }).text).includes("M013/S02"), "alarm carries the unit id");
    // The death must release the glasses' input gate: the settling status is idle.
    const lastStatus = getMessages("--aslug--", 0).filter((m) => m.type === "status").at(-1);
    assert.equal((lastStatus as { state?: string }).state, "idle", "a dead run must settle the status to idle so the glasses accept input again");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A blocker appearing mid-run is an intentional, resumable halt — distinct from a
// crash. It must fire ⏸ AUTO-PAUSED once (edge, not every tick) and settle the
// input gate to idle so the wearer isn't stuck watching "Thinking" over a run that
// is waiting on something. The pause signal is the current-state STATE.md blocker.
test("tick alarms once (⏸ AUTO-PAUSED) when a blocker appears mid-run, then settles idle", () => {
  const root = mkdtempSync(join(tmpdir(), "watch-pause-root-"));
  try {
    const cwd = join(root, "paused-proj");
    mkdirSync(join(cwd, ".gsd"), { recursive: true });
    const store = join(root, "store");
    const dir = join(store, "--pauseslug--");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "x.jsonl");
    writeFileSync(file, SESSION(cwd) + "\n" + ASSISTANT("mid-run answer") + "\n");
    const cfg = { sessionsDirs: [store], projectRoots: [root], busyWindowMs: 120000, tailIntervalMs: 500 } as Config;

    let now = Date.now();
    // Live lock (this pid), no blocker → running baseline, no alarm.
    writeFileSync(join(cwd, ".gsd", "auto.lock"), JSON.stringify({ pid: process.pid, unitType: "execute-task", unitId: "M013/S02" }));
    writeFileSync(join(cwd, ".gsd", "STATE.md"), "# GSD State\n\n## Blockers\n- None\n");
    tick(cfg, now); // first sight → adopts "running" baseline silently, offset=EOF
    now += 500;

    // A busy chunk lands so the tail status flips to "busy" — the state the glasses
    // gate input on. The pause transition below must force it back to idle.
    appendFileSync(file, TOOLCALL() + "\n");
    tick(cfg, now);
    now += 500;
    assert.equal(
      (getMessages("--pauseslug--", 0).filter((m) => m.type === "status").at(-1) as { state?: string }).state,
      "busy",
      "tail must be busy before the blocker appears",
    );

    let pauses = getMessages("--pauseslug--", 0).filter(
      (m) => m.type === "text_delta" && String((m as { text?: string }).text).includes("AUTO-PAUSED"),
    );
    assert.equal(pauses.length, 0, "must not alarm while running with no blocker");

    // A blocker appears: running→paused edge fires once.
    writeFileSync(join(cwd, ".gsd", "STATE.md"), "# GSD State\n\n## Blockers\n- Waiting on Helios column names\n");
    tick(cfg, now);
    now += 500;
    tick(cfg, now); // second tick over the same blocker must NOT re-alarm

    pauses = getMessages("--pauseslug--", 0).filter(
      (m) => m.type === "text_delta" && String((m as { text?: string }).text).includes("AUTO-PAUSED"),
    );
    assert.equal(pauses.length, 1, "⏸ AUTO-PAUSED must fire exactly once on the pause transition");
    assert.ok(String((pauses[0] as { text?: string }).text).includes("M013/S02"), "pause alarm carries the unit id");
    // A paused run releases the input gate: settling status is idle.
    const lastStatus = getMessages("--pauseslug--", 0).filter((m) => m.type === "status").at(-1);
    assert.equal((lastStatus as { state?: string }).state, "idle", "a paused run must settle the status to idle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("markNextSteps inserts a rule and prefixes each option with an arrow glyph", () => {
  const out = markNextSteps("Posledný commit = X.\nĎalej?\n1. Celý reflog\n2. Iné");
  assert.equal(out, "Posledný commit = X.\n─────\nĎalej?\n▶ 1. Celý reflog\n▶ 2. Iné");
});

test("markNextSteps leaves a plain numbered answer alone", () => {
  const txt = "Fakty o Mesiaci:\n1. ~384 400 km\n2. dráha eliptická";
  assert.equal(markNextSteps(txt), txt);
});

test("nextStepsOptions parses a trailing menu into labels", () => {
  const opts = nextStepsOptions("Zhrnutie.\nĎalej?\n1. Obsah 4-SUMMARY.md\n2. Porovnať 1–4\n3. Iné");
  assert.deepEqual(opts, ["Obsah 4-SUMMARY.md", "Porovnať 1–4", "Iné"]);
});

test("nextStepsOptions returns [] for a plain numbered answer (no menu header)", () => {
  assert.deepEqual(nextStepsOptions("Fakty:\n1. ~384 400 km\n2. eliptická"), []);
});

// Structural detection: the model phrases the lead-in freely. A trailing
// numbered block anchored by a short "Čo?" question line is a menu even though
// no bare keyword header precedes it (live 2026-07-22 miss).
const FREEFORM = "Otvorené nite, tvoj výber:\n\n1. Rotovať secrets\n2. Zavrieť gaps\n3. Iné\n\nČo?";

test("detects a free-form menu anchored by a trailing question line", () => {
  assert.deepEqual(nextStepsOptions(FREEFORM), ["Rotovať secrets", "Zavrieť gaps", "Iné"]);
  const out = markNextSteps(FREEFORM);
  assert.equal(
    out,
    "─────\nOtvorené nite, tvoj výber:\n\n▶ 1. Rotovať secrets\n▶ 2. Zavrieť gaps\n▶ 3. Iné\n\nČo?",
  );
});

test("detects a menu anchored only by an Iné/Other escape option", () => {
  const txt = "Návrhy:\n1. Prvý krok\n2. Druhý krok\n3. Iné — povedz čo";
  assert.deepEqual(nextStepsOptions(txt), ["Prvý krok", "Druhý krok", "Iné — povedz čo"]);
});

// Firehose gate: during an auto-run (live lock pid → running liveness), an
// assistant answer written to the transcript must NOT stream to the lens. Left
// ungated, every coding turn of an unattended auto-run paints as a clipped raw
// line and buries the pull-based status card — the "cut lines, first few words
// only" the wearer reported. Status must still resolve busy off the same chunk.
test("tick does NOT stream transcript turns during an auto-run (firehose gated)", () => {
  const root = mkdtempSync(join(tmpdir(), "watch-firehose-root-"));
  try {
    const cwd = join(root, "auto-proj");
    mkdirSync(join(cwd, ".gsd"), { recursive: true });
    const store = join(root, "store");
    const dir = join(store, "--fslug--");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "x.jsonl");
    writeFileSync(file, SESSION(cwd) + "\n" + ASSISTANT("older answer") + "\n");
    const cfg = { sessionsDirs: [store], projectRoots: [root], busyWindowMs: 120000, tailIntervalMs: 500 } as Config;

    let now = Date.now();
    // Live lock (this pid) → running liveness → auto-run in progress.
    writeFileSync(join(cwd, ".gsd", "auto.lock"), JSON.stringify({ pid: process.pid, unitType: "run-uat", unitId: "M013/S02" }));
    tick(cfg, now); // first sight → offset=EOF, baseline
    now += 500;

    // A coding turn lands mid-run. It must NOT reach the lens as a text_delta…
    appendFileSync(file, ASSISTANT("Refactored the widening helper and reran the suite.") + "\n");
    tick(cfg, now);
    now += 500;

    const deltas = getMessages("--fslug--", 0).filter((m) => m.type === "text_delta");
    assert.equal(deltas.length, 0, "auto-run transcript must not stream to the lens");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Complement: an interactive gsd session (no auto.lock → liveness "none") still
// streams its answer to the lens — the gate is auto-mode-only.
test("tick still streams transcript turns for an interactive session (liveness none)", () => {
  const store = mkdtempSync(join(tmpdir(), "watch-interactive-"));
  try {
    const cwd = "/opt/AI_projects/interactive-probe";
    const dir = join(store, "--islug--");
    mkdirSync(dir);
    const file = join(dir, "x.jsonl");
    writeFileSync(file, SESSION(cwd) + "\n" + ASSISTANT("older answer") + "\n");
    const cfg = cfgFor(store);

    let now = 3_000_000;
    tick(cfg, now); // first sight → offset=EOF
    now += 500;

    appendFileSync(file, ASSISTANT("Interactive answer.") + "\n");
    tick(cfg, now);
    now += 500;
    tick(cfg, now);

    const deltas = getMessages("--islug--", 0).filter((m) => m.type === "text_delta");
    assert.equal(deltas.length, 1, "interactive session must still stream its answer");
    assert.equal((deltas[0] as { text?: string }).text, "Interactive answer.");
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});
