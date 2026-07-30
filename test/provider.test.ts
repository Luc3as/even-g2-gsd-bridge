import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGsdProvider, unwrapAnswer, isStatusCommand } from "../src/even/provider.ts";
import { setPending, clearPending } from "../src/gsd/questions.ts";
import type { Config } from "../src/config.ts";

// The Even App answers a question by POSTing a JSON object keyed by the question
// text with the picked option label as the value (verified live 2026-07-27):
//   {"Deploy the lightest changes now?":"Yes, deploy"}
// unwrapAnswer must extract the label so matchAnswer sees "Yes, deploy", not the
// whole blob (which only matched by luck via substring).
test("unwrapAnswer extracts the label from the App's JSON answer object", () => {
  assert.equal(
    unwrapAnswer('{"Deploy the lightest changes now?":"Yes, deploy"}'),
    "Yes, deploy",
  );
});

test("unwrapAnswer joins multiple values (multi-select array or several keys)", () => {
  assert.equal(unwrapAnswer('{"q":["Python","Go"]}'), "Python Go");
  assert.equal(unwrapAnswer('{"q1":"Python","q2":"Go"}'), "Python Go");
  assert.equal(unwrapAnswer('["Python","Go"]'), "Python Go");
});

test("unwrapAnswer returns a bare dictation string unchanged", () => {
  assert.equal(unwrapAnswer("option one"), "option one");
  assert.equal(unwrapAnswer("1"), "1");
  assert.equal(unwrapAnswer("  Yes, deploy  "), "  Yes, deploy  ");
});

test("unwrapAnswer falls back to raw text on malformed or empty JSON", () => {
  assert.equal(unwrapAnswer('{"q":'), '{"q":'); // truncated
  assert.equal(unwrapAnswer("{}"), "{}"); // no string values
  assert.equal(unwrapAnswer('{"q":42}'), '{"q":42}'); // non-string value
});

// The wearer may say "status", "dashboard", or "progress" — all three intercept
// in every command form the dictation can produce (whole-utterance rule, D001/R001).
test("isStatusCommand accepts all three keywords in all four command forms", () => {
  for (const k of ["status", "dashboard", "progress"]) {
    assert.equal(isStatusCommand(k), true);
    assert.equal(isStatusCommand(`/${k}`), true);
    assert.equal(isStatusCommand(`gsd ${k}`), true);
    assert.equal(isStatusCommand(`/gsd ${k}`), true);
  }
});

test("isStatusCommand tolerates dictation casing, whitespace, and trailing punctuation", () => {
  assert.equal(isStatusCommand("Dashboard."), true);
  assert.equal(isStatusCommand("  Progress?  "), true);
  assert.equal(isStatusCommand("GSD Status"), true);
  assert.equal(isStatusCommand("Status…"), true);
});

test("isStatusCommand rejects prompts that merely contain a keyword", () => {
  assert.equal(isStatusCommand("what is the status of the build"), false);
  assert.equal(isStatusCommand("show me the dashboard for sales"), false);
  assert.equal(isStatusCommand("progress the milestone to done"), false);
  assert.equal(isStatusCommand("update the status page"), false);
  assert.equal(isStatusCommand("dashboard status"), false); // two keywords ≠ a command
  assert.equal(isStatusCommand(""), false);
});

// ─── S05 T01: the input gate opens on a paused/stopped auto-run ──────────────
// statusFor governs the Even App's INPUT GATE: the App forwards a spoken
// utterance to POST /api/prompt only when the polled status reads "idle"; while
// it reads "busy" the word is intercepted as the native "stop waiting?" prompt
// whose confirm SIGINTs the pane (MEM016). So for the wearer to say/type the
// resume command into a paused/stopped run, statusFor must resolve the honest
// DisplayState (classifyDisplayState(readAutoState, hasBlocker)) and return
// "idle" for disp ∈ {paused, stopped} — WITHOUT idling a genuinely-working
// quiet-running unit (that would drop the M001 "working" dot and invite a stray
// resume mid-work). The pending-picker short-circuit stays FIRST (S04 green).

// One parametrized auto-run project fixture: real cwd with .gsd (auto.lock for
// unit labels + gsd.db workers row for liveness) and a session store whose
// transcript names that cwd so findProject resolves the slug.
//   blocker — write a live STATE.md "## Blockers" entry (the disk pause signal
//             classifyDisplayState reads via hasBlocker). false → no STATE.md,
//             so hasBlocker is false and the run is not paused.
//   worker  — the gsd.db workers row shape:
//             "quiet"   active row, live pid, beat stale 90s (past the 60s TTL,
//                       under the 15m stall ceiling) → readAutoLiveness "quiet".
//             "running" active row, live pid, fresh beat → "running".
//             "stopped" active row, beat stale 90s, DEAD pid → "stopped" (the
//                       credit-death case: the persistent TUI pid outlives the
//                       worker, but a stale-beat + dead-pid row is hard-dead).
function autoFixture(
  prefix: string,
  opts: { blocker: boolean; worker: "quiet" | "running" | "stopped" },
) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const cwd = join(root, "proj");
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  const store = join(root, "store");
  const slug = `--${prefix}slug--`;
  const dir = join(store, slug);
  mkdirSync(dir, { recursive: true });
  // cwd carrier so findProject reads the project cwd off the transcript.
  writeFileSync(
    join(dir, "x.jsonl"),
    JSON.stringify({ type: "session", version: 3, id: "t", timestamp: "2026-07-30T00:00:00.000Z", cwd }) + "\n",
  );
  // Lock present → readAutoState is not "none"; the DB heartbeat below is
  // authoritative for liveness (unit labels come off the lock).
  writeFileSync(
    join(cwd, ".gsd", "auto.lock"),
    JSON.stringify({ pid: process.pid, unitType: "execute-task", unitId: "M013/S04" }),
  );
  if (opts.blocker) {
    // Intentional halt: a live STATE.md blocker → hasBlocker true → paused.
    writeFileSync(join(cwd, ".gsd", "STATE.md"), "# GSD State\n\n## Blockers\n- Waiting on the wearer's pick\n");
  }
  // A dead pid for the "stopped" shape: max 32-bit pid, never a live process
  // → pidAlive false → stale-beat + dead-pid row is hard "stopped".
  const deadPid = 2147483646;
  const realCwd = realpathSync(cwd);
  const db = new DatabaseSync(join(cwd, ".gsd", "gsd.db"));
  try {
    db.exec("CREATE TABLE workers (project_root_realpath TEXT, status TEXT, pid INTEGER, last_heartbeat_at TEXT);");
    const beat =
      opts.worker === "running"
        ? new Date().toISOString() // fresh beat within the 60s TTL
        : new Date(Date.now() - 90_000).toISOString(); // stale past the 60s TTL
    const pid = opts.worker === "stopped" ? deadPid : process.pid;
    db.prepare(
      "INSERT INTO workers (project_root_realpath, status, pid, last_heartbeat_at) VALUES (?, ?, ?, ?)",
    ).run(realCwd, "active", pid, beat);
  } finally {
    db.close();
  }
  const cfg = { sessionsDirs: [store], projectRoots: [root], busyWindowMs: 120000, tailIntervalMs: 500 } as Config;
  return { root, cwd, slug, cfg };
}

test("getSessionStatus returns 'awaiting' for a pending picker even on a paused auto-run (S04)", async () => {
  const { root, slug, cfg } = autoFixture("prov-await-", { blocker: true, worker: "quiet" });
  const provider = createGsdProvider(cfg);
  try {
    // Baseline: no picker pending. The run is paused (live STATE.md blocker), so
    // under the S05 input-gate semantics the poll reports "idle" — the gate is
    // open for a resume utterance. This proves the picker below is what flips it
    // to "awaiting", not that the fixture was already awaiting.
    assert.equal(await provider.getSessionStatus(slug), "idle", "a paused auto-run polls idle (input gate open) without a picker");

    // A real picker is armed (parsePicker → setPending) while the run is paused.
    setPending(slug, {
      header: "Fruit",
      prompt: "Pick a fruit",
      options: ["Apple", "Pear"],
      multi: false,
      signature: "s|Fruit|Pick a fruit|Apple|Pear",
    });
    // The pending-picker branch stays FIRST and outranks the liveness branch →
    // "awaiting", the value the Even App keys its native question card off
    // (MEM006). This is the S04 claim and it must stay green under S05.
    assert.equal(
      await provider.getSessionStatus(slug),
      "awaiting",
      "a pending picker must outrank the paused auto state on the status poll",
    );

    // Clearing the picker (answered/exited) hands the poll back to the auto-run's
    // own state — back to the paused "idle", not stuck "awaiting".
    clearPending(slug);
    assert.equal(await provider.getSessionStatus(slug), "idle", "clearing the picker returns the poll to the paused auto-run state");
  } finally {
    clearPending(slug);
    rmSync(root, { recursive: true, force: true });
  }
});

test("getSessionStatus returns 'idle' for a stopped auto-run (input gate open)", async () => {
  const { root, slug, cfg } = autoFixture("prov-stopped-", { blocker: false, worker: "stopped" });
  const provider = createGsdProvider(cfg);
  try {
    // A hard-dead worker (stale beat + dead pid) classifies as "stopped"; the gate
    // opens so the wearer can say the resume command into the crashed run.
    assert.equal(await provider.getSessionStatus(slug), "idle", "a stopped auto-run polls idle so the resume utterance is accepted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("getSessionStatus keeps 'busy' for a genuinely-working quiet-running unit (no blocker)", async () => {
  const { root, slug, cfg } = autoFixture("prov-busy-", { blocker: false, worker: "quiet" });
  const provider = createGsdProvider(cfg);
  try {
    // Regression guard: a quiet run with NO blocker, under the stall ceiling, is a
    // live worker mid-unit → "running" → "busy". The M001 "working" dot must be
    // preserved and the input gate stays SHUT so a stray word can't resume/inject
    // mid-work. The gate release is scoped to disp ∈ {paused, stopped}, not raw
    // quiet.
    assert.equal(await provider.getSessionStatus(slug), "busy", "a working quiet-running unit stays busy (gate shut mid-work)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
