import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMilestoneMetrics, readStopReason } from "../src/gsd/metrics.ts";

// Fixed reference instant so elapsed math is deterministic (no Date.now flake).
const NOW = Date.parse("2026-07-28T06:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

// Canonical live payload shape (contractVersion "1"); overridable per test.
function snapshot(unitId: string, cost: number, total: number): string {
  return JSON.stringify({
    unitType: "execute-task",
    unitId,
    model: "claude-fable-5",
    tokens: { input: 32, output: 9434, cacheRead: 1493492, cacheWrite: 86874, total },
    cost,
    toolCalls: 18,
    contractVersion: "1",
  });
}

// Build a minimal .gsd/gsd.db carrying only the two tables readMilestoneMetrics
// queries, with only the columns it reads (mirrors the live schema subset).
interface DispatchRow {
  id: number;
  milestone_id: string;
  started_at: string | null;
  ended_at: string | null;
  status?: string | null;
  exit_reason?: string | null;
  error_summary?: string | null;
}

function makeDb(spec: {
  snapshots?: { payload: string; type?: string }[];
  dispatches?: DispatchRow[];
}): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "metrics-"));
  mkdirSync(join(cwd, ".gsd"));
  const db = new DatabaseSync(join(cwd, ".gsd", "gsd.db"));
  db.exec("CREATE TABLE audit_events (event_id TEXT, type TEXT, payload_json TEXT)");
  db.exec(
    "CREATE TABLE unit_dispatches (id INTEGER, milestone_id TEXT, started_at TEXT, ended_at TEXT, " +
      "status TEXT, exit_reason TEXT, error_summary TEXT)",
  );
  let i = 0;
  for (const s of spec.snapshots ?? [])
    db.prepare("INSERT INTO audit_events VALUES (?,?,?)").run(`e${i++}`, s.type ?? "unit-metrics-snapshot", s.payload);
  for (const d of spec.dispatches ?? [])
    db.prepare("INSERT INTO unit_dispatches VALUES (?,?,?,?,?,?,?)").run(
      d.id,
      d.milestone_id,
      d.started_at,
      d.ended_at,
      d.status ?? null,
      d.exit_reason ?? null,
      d.error_summary ?? null,
    );
  db.close();
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("readMilestoneMetrics returns null when there is no .gsd/gsd.db", () => {
  const cwd = mkdtempSync(join(tmpdir(), "metrics-nodb-"));
  try {
    assert.equal(readMilestoneMetrics(cwd, "M013", { now: NOW }), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("readMilestoneMetrics returns null when the file is not a sqlite db", () => {
  const cwd = mkdtempSync(join(tmpdir(), "metrics-garbage-"));
  try {
    mkdirSync(join(cwd, ".gsd"));
    writeFileSync(join(cwd, ".gsd", "gsd.db"), "not a database");
    assert.equal(readMilestoneMetrics(cwd, "M013", { now: NOW }), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("readMilestoneMetrics returns null when the tables are absent (older gsd schema)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "metrics-notables-"));
  try {
    mkdirSync(join(cwd, ".gsd"));
    new DatabaseSync(join(cwd, ".gsd", "gsd.db")).close(); // empty db, no tables
    assert.equal(readMilestoneMetrics(cwd, "M013", { now: NOW }), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("readMilestoneMetrics sums cost and tokens.total over exact and prefixed unitIds", () => {
  const { cwd, cleanup } = makeDb({
    snapshots: [
      { payload: snapshot("M013", 1.5, 1000) }, // bare milestone-level unit
      { payload: snapshot("M013/S01/T01", 2.25, 2000) },
      { payload: snapshot("M013/S01/T02", 0.25, 500) },
      { payload: snapshot("M012/S05/T01", 99, 99999) }, // other milestone — excluded
    ],
  });
  try {
    const m = readMilestoneMetrics(cwd, "M013", { now: NOW })!;
    assert.equal(m.costUsd, 4);
    assert.equal(m.tokensTotal, 3500);
  } finally {
    cleanup();
  }
});

test("readMilestoneMetrics: M0130 rows never leak into M013 (prefix trap)", () => {
  const { cwd, cleanup } = makeDb({
    snapshots: [
      { payload: snapshot("M013/S01/T01", 1, 100) },
      { payload: snapshot("M0130", 50, 5000) },
      { payload: snapshot("M0130/S01/T01", 50, 5000) },
    ],
    dispatches: [
      { id: 1, milestone_id: "M013", started_at: iso(600_000), ended_at: iso(540_000) },
      { id: 2, milestone_id: "M0130", started_at: iso(500_000), ended_at: iso(100_000) },
    ],
  });
  try {
    const m = readMilestoneMetrics(cwd, "M013", { now: NOW })!;
    assert.equal(m.costUsd, 1);
    assert.equal(m.tokensTotal, 100);
    assert.equal(m.elapsedMs, 60_000); // only the M013 dispatch
  } finally {
    cleanup();
  }
});

test("readMilestoneMetrics skips malformed snapshot rows (bad JSON, missing/non-finite numbers)", () => {
  const { cwd, cleanup } = makeDb({
    snapshots: [
      { payload: snapshot("M013/S01/T01", 1, 100) }, // the only good row
      { payload: '{"unitId":"M013/S01/T02", broken' }, // invalid JSON
      { payload: JSON.stringify({ unitId: "M013/S01/T03", tokens: { total: 200 } }) }, // no cost
      { payload: JSON.stringify({ unitId: "M013/S01/T04", cost: 2 }) }, // no tokens
      { payload: JSON.stringify({ unitId: "M013/S01/T05", cost: "2", tokens: { total: 300 } }) }, // cost not a number
      { payload: JSON.stringify({ unitId: "M013/S01/T06", cost: Number.NaN, tokens: { total: 400 } }) }, // NaN → null in JSON, non-finite
      { payload: snapshot("M013/S01/T07", 5, 500), type: "turn-result" }, // wrong event type
    ],
  });
  try {
    const m = readMilestoneMetrics(cwd, "M013", { now: NOW })!;
    assert.equal(m.costUsd, 1);
    assert.equal(m.tokensTotal, 100);
  } finally {
    cleanup();
  }
});

test("readMilestoneMetrics: no matching rows → honest zeros, not null", () => {
  const { cwd, cleanup } = makeDb({});
  try {
    assert.deepEqual(readMilestoneMetrics(cwd, "M013", { now: NOW }), {
      costUsd: 0,
      tokensTotal: 0,
      elapsedMs: 0,
      activeElapsedMs: null,
    });
  } finally {
    cleanup();
  }
});

test("readMilestoneMetrics sums closed dispatch durations; open rows ignored when not live", () => {
  const { cwd, cleanup } = makeDb({
    dispatches: [
      { id: 1, milestone_id: "M013", started_at: iso(600_000), ended_at: iso(480_000) }, // 2m
      { id: 2, milestone_id: "M013", started_at: iso(480_000), ended_at: iso(300_000) }, // 3m (failed attempts count too)
      { id: 3, milestone_id: "M013", started_at: iso(240_000), ended_at: null }, // open — not trusted when not live
      { id: 4, milestone_id: "M012", started_at: iso(900_000), ended_at: iso(300_000) }, // other milestone
    ],
  });
  try {
    const m = readMilestoneMetrics(cwd, "M013", { now: NOW })!;
    assert.equal(m.elapsedMs, 300_000);
    assert.equal(m.activeElapsedMs, null);
  } finally {
    cleanup();
  }
});

test("readMilestoneMetrics live: newest open dispatch is the unit in flight; stale open rows stay excluded", () => {
  const { cwd, cleanup } = makeDb({
    dispatches: [
      { id: 1, milestone_id: "M013", started_at: iso(600_000), ended_at: iso(480_000) }, // closed 2m
      { id: 2, milestone_id: "M013", started_at: iso(700_000_000), ended_at: null }, // stale open (dead run, ~8 days)
      { id: 3, milestone_id: "M013", started_at: iso(240_000), ended_at: null }, // newest open → active, 4m
    ],
  });
  try {
    const m = readMilestoneMetrics(cwd, "M013", { now: NOW, live: true })!;
    assert.equal(m.activeElapsedMs, 240_000);
    assert.equal(m.elapsedMs, 120_000 + 240_000); // closed + active; stale open row never summed
  } finally {
    cleanup();
  }
});

test("readMilestoneMetrics live: no open dispatch → activeElapsedMs stays null", () => {
  const { cwd, cleanup } = makeDb({
    dispatches: [{ id: 1, milestone_id: "M013", started_at: iso(600_000), ended_at: iso(480_000) }],
  });
  try {
    const m = readMilestoneMetrics(cwd, "M013", { now: NOW, live: true })!;
    assert.equal(m.activeElapsedMs, null);
    assert.equal(m.elapsedMs, 120_000);
  } finally {
    cleanup();
  }
});

test("readMilestoneMetrics skips dispatch rows with unparseable or inverted timestamps", () => {
  const { cwd, cleanup } = makeDb({
    dispatches: [
      { id: 1, milestone_id: "M013", started_at: "garbage", ended_at: iso(0) },
      { id: 2, milestone_id: "M013", started_at: iso(100_000), ended_at: "garbage" },
      { id: 3, milestone_id: "M013", started_at: null, ended_at: iso(0) },
      { id: 4, milestone_id: "M013", started_at: iso(100_000), ended_at: iso(200_000) }, // ended before started
      { id: 5, milestone_id: "M013", started_at: iso(60_000), ended_at: iso(0) }, // the only sane row: 1m
      { id: 6, milestone_id: "M013", started_at: "garbage", ended_at: null }, // open but unparseable → never active
    ],
  });
  try {
    const m = readMilestoneMetrics(cwd, "M013", { now: NOW, live: true })!;
    assert.equal(m.elapsedMs, 60_000);
    assert.equal(m.activeElapsedMs, null);
  } finally {
    cleanup();
  }
});

test("readMilestoneMetrics live: active elapsed clamps to 0 on a slightly-future started_at (clock skew)", () => {
  const { cwd, cleanup } = makeDb({
    dispatches: [{ id: 1, milestone_id: "M013", started_at: iso(-5_000), ended_at: null }],
  });
  try {
    const m = readMilestoneMetrics(cwd, "M013", { now: NOW, live: true })!;
    assert.equal(m.activeElapsedMs, 0);
    assert.equal(m.elapsedMs, 0);
  } finally {
    cleanup();
  }
});

// ---- readStopReason ----------------------------------------------------------

test("readStopReason returns null when there is no .gsd/gsd.db", () => {
  const cwd = mkdtempSync(join(tmpdir(), "stopreason-nodb-"));
  try {
    assert.equal(readStopReason(cwd, "M013"), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("readStopReason returns null when the file is not a sqlite db", () => {
  const cwd = mkdtempSync(join(tmpdir(), "stopreason-garbage-"));
  try {
    mkdirSync(join(cwd, ".gsd"));
    writeFileSync(join(cwd, ".gsd", "gsd.db"), "not a database");
    assert.equal(readStopReason(cwd, "M013"), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("readStopReason returns null when the unit_dispatches table is absent (older schema)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "stopreason-notable-"));
  try {
    mkdirSync(join(cwd, ".gsd"));
    new DatabaseSync(join(cwd, ".gsd", "gsd.db")).close(); // empty db, no tables
    assert.equal(readStopReason(cwd, "M013"), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("readStopReason returns null when there is no failed dispatch", () => {
  const { cwd, cleanup } = makeDb({
    dispatches: [
      { id: 1, milestone_id: "M013", started_at: iso(600_000), ended_at: iso(540_000), status: "completed" },
      { id: 2, milestone_id: "M013", started_at: iso(240_000), ended_at: null, status: "running" },
    ],
  });
  try {
    assert.equal(readStopReason(cwd, "M013"), null);
  } finally {
    cleanup();
  }
});

test("readStopReason returns the newest failed dispatch's reason (id DESC), not the newest row overall", () => {
  const { cwd, cleanup } = makeDb({
    dispatches: [
      {
        id: 1,
        milestone_id: "M013",
        started_at: iso(600_000),
        ended_at: iso(540_000),
        status: "failed",
        exit_reason: "verify-timeout",
        error_summary: "first failure — superseded",
      },
      {
        id: 2,
        milestone_id: "M013",
        started_at: iso(400_000),
        ended_at: iso(300_000),
        status: "failed",
        exit_reason: "token-exhausted",
        error_summary: "token budget exhausted after 3 retries",
      },
      // Newest row overall is an open crashed row with no reason — must be ignored.
      { id: 3, milestone_id: "M013", started_at: iso(120_000), ended_at: null, status: "running" },
    ],
  });
  try {
    assert.deepEqual(readStopReason(cwd, "M013"), {
      exitReason: "token-exhausted",
      errorSummary: "token budget exhausted after 3 retries",
    });
  } finally {
    cleanup();
  }
});

test("readStopReason surfaces both fields independently (exit_reason present, error_summary blank)", () => {
  const { cwd, cleanup } = makeDb({
    dispatches: [
      {
        id: 1,
        milestone_id: "M013",
        started_at: iso(400_000),
        ended_at: iso(300_000),
        status: "failed",
        exit_reason: "validation-needs-attention",
        error_summary: "   ", // whitespace-only → coerced to null
      },
    ],
  });
  try {
    assert.deepEqual(readStopReason(cwd, "M013"), {
      exitReason: "validation-needs-attention",
      errorSummary: null,
    });
  } finally {
    cleanup();
  }
});

test("readStopReason returns null when the failed row has both reason columns blank", () => {
  const { cwd, cleanup } = makeDb({
    dispatches: [
      {
        id: 1,
        milestone_id: "M013",
        started_at: iso(400_000),
        ended_at: iso(300_000),
        status: "failed",
        exit_reason: null,
        error_summary: "",
      },
    ],
  });
  try {
    assert.equal(readStopReason(cwd, "M013"), null);
  } finally {
    cleanup();
  }
});

test("readStopReason scopes to the milestone and trims surrounding whitespace", () => {
  const { cwd, cleanup } = makeDb({
    dispatches: [
      {
        id: 1,
        milestone_id: "M012",
        started_at: iso(400_000),
        ended_at: iso(300_000),
        status: "failed",
        error_summary: "other milestone's failure",
      },
      {
        id: 2,
        milestone_id: "M013",
        started_at: iso(200_000),
        ended_at: iso(100_000),
        status: "failed",
        error_summary: "  verify timed out x3  ",
      },
    ],
  });
  try {
    assert.deepEqual(readStopReason(cwd, "M013"), {
      exitReason: null,
      errorSummary: "verify timed out x3",
    });
  } finally {
    cleanup();
  }
});
