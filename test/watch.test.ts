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
