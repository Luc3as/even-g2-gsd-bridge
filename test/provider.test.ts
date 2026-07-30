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

// ─── S04 T01: a pending picker outranks the paused/quiet auto state ──────────
// The core S04 claim: the blocked-pick chain composes with an auto-pause "for
// free". The Even App arms its native question card off the "awaiting" value it
// reads on the /api/sessions + /status poll (MEM006), so a picker armed while the
// auto-run is live-but-quiet/paused must STILL make getSessionStatus report
// "awaiting" — the pending-picker branch (provider.ts:97) short-circuits ahead of
// the liveness branch (108-109) that would otherwise report the quiet run as
// "busy". Already true in code; this locks it under a paused fixture so no future
// drift can bury the card behind the auto-run's working state.

// A live-but-quiet/paused auto-run project: real cwd with .gsd (auto.lock for
// unit labels + gsd.db workers row for liveness), a session store whose transcript
// names that cwd so findProject resolves the slug, and a STATE.md blocker so the
// run is intentionally paused (the S04 "auto-pause" the picker must outrank). The
// workers row is ACTIVE with a live pid but a heartbeat stale past the 60s TTL —
// GSD stamps the beat once per unit, so an alive worker with a stale beat is
// "quiet" (readAutoLiveness), which statusFor maps to "busy" absent a picker.
function pausedQuietFixture(prefix: string) {
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
  // Intentional halt: a live STATE.md blocker — the "auto-pause" state.
  writeFileSync(join(cwd, ".gsd", "STATE.md"), "# GSD State\n\n## Blockers\n- Waiting on the wearer's pick\n");
  // A quiet worker: active row, live pid, heartbeat stale past the 60s TTL (but
  // well under the 15m stall ceiling) → readAutoLiveness returns "quiet".
  const realCwd = realpathSync(cwd);
  const db = new DatabaseSync(join(cwd, ".gsd", "gsd.db"));
  try {
    db.exec("CREATE TABLE workers (project_root_realpath TEXT, status TEXT, pid INTEGER, last_heartbeat_at TEXT);");
    db.prepare(
      "INSERT INTO workers (project_root_realpath, status, pid, last_heartbeat_at) VALUES (?, ?, ?, ?)",
    ).run(realCwd, "active", process.pid, new Date(Date.now() - 90_000).toISOString());
  } finally {
    db.close();
  }
  const cfg = { sessionsDirs: [store], projectRoots: [root], busyWindowMs: 120000, tailIntervalMs: 500 } as Config;
  return { root, cwd, slug, cfg };
}

test("getSessionStatus returns 'awaiting' for a pending picker even on a paused/quiet auto-run", async () => {
  const { root, slug, cfg } = pausedQuietFixture("prov-await-");
  const provider = createGsdProvider(cfg);
  try {
    // Baseline: no picker pending. The quiet/paused auto-run is a live worker, so
    // the poll reports "busy" — proving the fixture is NOT already awaiting/idle
    // and that the picker below is the sole lever that flips it.
    assert.equal(await provider.getSessionStatus(slug), "busy", "a quiet paused auto-run polls busy without a picker");

    // A real picker is armed (parsePicker → setPending) while the run is paused.
    setPending(slug, {
      header: "Fruit",
      prompt: "Pick a fruit",
      options: ["Apple", "Pear"],
      multi: false,
      signature: "s|Fruit|Pick a fruit|Apple|Pear",
    });
    // The pending-picker branch outranks the quiet-liveness branch → "awaiting",
    // the value the Even App keys its native question card off (MEM006).
    assert.equal(
      await provider.getSessionStatus(slug),
      "awaiting",
      "a pending picker must outrank the paused/quiet auto state on the status poll",
    );

    // Clearing the picker (answered/exited) hands the poll back to the auto-run's
    // own state — back to busy, not stuck "awaiting".
    clearPending(slug);
    assert.equal(await provider.getSessionStatus(slug), "busy", "clearing the picker returns the poll to the auto-run state");
  } finally {
    clearPending(slug);
    rmSync(root, { recursive: true, force: true });
  }
});
