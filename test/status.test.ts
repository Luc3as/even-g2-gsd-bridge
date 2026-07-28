import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatusCard } from "../src/gsd/status.ts";

const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
const DEAD_PID = 2147483647;

interface Opts {
  db?: {
    milestones: { id: string; status: string }[];
    slices?: { milestone_id: string; id: string; status: string; title?: string }[];
    tasks?: { milestone_id: string; slice_id: string; id: string; status: string; title?: string }[];
    /** beatAgoMs > 60_000 is a stale heartbeat (TTL is 60s). */
    workers?: { pid: number; beatAgoMs: number }[];
    snapshots?: { unitId: string; cost: number; tokens: number }[];
    dispatches?: { id: number; milestone_id: string; startedAgoMs: number; endedAgoMs: number | null }[];
    /** Skip creating audit_events/unit_dispatches to prove the metrics degrade path. */
    noMetricsTables?: boolean;
  };
  lock?: object;
  state?: string;
}

function makeProject(opts: Opts): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "status-"));
  mkdirSync(join(cwd, ".gsd"));
  if (opts.db) {
    const db = new DatabaseSync(join(cwd, ".gsd", "gsd.db"));
    db.exec("CREATE TABLE milestones (id TEXT, status TEXT)");
    db.exec("CREATE TABLE slices (milestone_id TEXT, id TEXT, title TEXT, status TEXT)");
    db.exec("CREATE TABLE tasks (milestone_id TEXT, slice_id TEXT, id TEXT, title TEXT, status TEXT)");
    db.exec("CREATE TABLE workers (pid INTEGER, last_heartbeat_at TEXT, status TEXT, project_root_realpath TEXT)");
    if (!opts.db.noMetricsTables) {
      db.exec("CREATE TABLE audit_events (type TEXT, payload_json TEXT)");
      db.exec("CREATE TABLE unit_dispatches (id INTEGER, milestone_id TEXT, started_at TEXT, ended_at TEXT)");
    }
    for (const m of opts.db.milestones)
      db.prepare("INSERT INTO milestones VALUES (?,?)").run(m.id, m.status);
    for (const s of opts.db.slices ?? [])
      db.prepare("INSERT INTO slices VALUES (?,?,?,?)").run(s.milestone_id, s.id, s.title ?? `${s.id} title`, s.status);
    for (const t of opts.db.tasks ?? [])
      db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?)").run(t.milestone_id, t.slice_id, t.id, t.title ?? `${t.id} title`, t.status);
    for (const w of opts.db.workers ?? [])
      db.prepare("INSERT INTO workers VALUES (?,?,?,?)").run(w.pid, iso(w.beatAgoMs), "active", realpathSync(cwd));
    for (const s of opts.db.snapshots ?? [])
      db.prepare("INSERT INTO audit_events VALUES (?,?)").run(
        "unit-metrics-snapshot",
        JSON.stringify({ unitId: s.unitId, cost: s.cost, tokens: { total: s.tokens } }),
      );
    for (const d of opts.db.dispatches ?? [])
      db.prepare("INSERT INTO unit_dispatches VALUES (?,?,?,?)").run(
        d.id, d.milestone_id, iso(d.startedAgoMs), d.endedAgoMs === null ? null : iso(d.endedAgoMs),
      );
    db.close();
  }
  if (opts.lock) writeFileSync(join(cwd, ".gsd", "auto.lock"), JSON.stringify(opts.lock));
  if (opts.state) writeFileSync(join(cwd, ".gsd", "STATE.md"), opts.state);
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

const STATE_MD = `# GSD State

**Active Milestone:** M013: Single source of truth
**Active Slice:** S03: Restructure order cards
**Phase:** planning

## Blockers
- None

## Next Action
Slice S03 has no DB tasks. Plan slice tasks before execution.
`;

/** The canonical mid-slice fixture: M013, 2/4 slices, 2/4 tasks in S03. */
function midSliceDb(): NonNullable<Opts["db"]> {
  return {
    milestones: [{ id: "M013", status: "active" }],
    slices: [
      { milestone_id: "M013", id: "S01", status: "complete" },
      { milestone_id: "M013", id: "S02", status: "complete" },
      { milestone_id: "M013", id: "S03", status: "pending", title: "Restructure order cards" },
      { milestone_id: "M013", id: "S04", status: "pending" },
    ],
    tasks: [
      { milestone_id: "M013", slice_id: "S03", id: "T01", status: "complete" },
      { milestone_id: "M013", slice_id: "S03", id: "T02", status: "complete" },
      { milestone_id: "M013", slice_id: "S03", id: "T03", status: "pending", title: "Tablet search collapse" },
      { milestone_id: "M013", slice_id: "S03", id: "T04", status: "pending" },
    ],
    snapshots: [
      { unitId: "M013/S01/T01", cost: 1.25, tokens: 500_000 },
      { unitId: "M013/S02/T01", cost: 1.25, tokens: 500_000 },
      // Prefix trap: M0130 must never count toward M013 (scoping is exact-or-prefix+"/").
      { unitId: "M0130/S01/T01", cost: 99, tokens: 9_000_000 },
    ],
    dispatches: [
      { id: 1, milestone_id: "M013", startedAgoMs: 18 * 60_000, endedAgoMs: 4 * 60_000 }, // 14m closed
      { id: 2, milestone_id: "M013", startedAgoMs: 4 * 60_000, endedAgoMs: null }, // in flight
    ],
  };
}

test("buildStatusCard: ▶RUN renders the full 6-line frame", () => {
  const db = midSliceDb();
  db.workers = [{ pid: process.pid, beatAgoMs: 1000 }]; // fresh beat → running
  const { cwd, cleanup } = makeProject({
    db,
    lock: { pid: process.pid, unitType: "execute-task", unitId: "M013/S03/T03" },
    state: STATE_MD,
  });
  try {
    const lines = buildStatusCard(cwd, "Yummy-packing-assistant").split("\n");
    assert.equal(lines.length, 6);
    // pct: (2 done + 2/4 task fraction) / 4 slices = 62.5 → 63
    assert.equal(lines[0], "M013 ▶RUN · 63% · S 2/4 · T 2/4");
    assert.equal(lines[1], "✓ S01-S02");
    assert.equal(lines[2], "● S03 Restructure order cards");
    assert.equal(lines[3], "  ✓T01 ✓T02 ●T03 ○T04");
    // Live run → elapsed suffix from the open dispatch (~4m; tolerate timer drift)
    assert.match(lines[4]!, /^▶ T03 Tablet search collapse · \+\d+m$/);
    // 14m closed + ~4m in flight ≈ 18m
    assert.match(lines[5]!, /^\$2\.50 · 1\.0M tok · 1[89]m$/);
  } finally {
    cleanup();
  }
});

test("buildStatusCard: stale beat + alive pid renders ◌QUIET, still live", () => {
  const db = midSliceDb();
  db.workers = [{ pid: process.pid, beatAgoMs: 5 * 60_000 }]; // stale beat, alive pid → quiet
  const { cwd, cleanup } = makeProject({
    db,
    lock: { pid: process.pid, unitId: "M013/S03/T03" },
    state: STATE_MD,
  });
  try {
    const lines = buildStatusCard(cwd, "Proj").split("\n");
    assert.equal(lines[0], "M013 ◌QUIET · 63% · S 2/4 · T 2/4");
    // quiet is still live → active-task elapsed suffix stays
    assert.match(lines[4]!, /^▶ T03 Tablet search collapse · \+\d+m$/);
  } finally {
    cleanup();
  }
});

test("buildStatusCard: stale beat + dead pid renders ⚠STOP and drops the elapsed suffix", () => {
  const db = midSliceDb();
  db.workers = [{ pid: DEAD_PID, beatAgoMs: 5 * 60_000 }]; // stale beat, dead pid → stopped
  const { cwd, cleanup } = makeProject({
    db,
    lock: { pid: DEAD_PID, unitId: "M013/S03/T03" },
    state: STATE_MD,
  });
  try {
    const lines = buildStatusCard(cwd, "Proj").split("\n");
    assert.equal(lines[0], "M013 ⚠STOP · 63% · S 2/4 · T 2/4");
    // Not live: the stale open dispatch must NOT produce a week-long counter…
    assert.equal(lines[4], "▶ T03 Tablet search collapse");
    // …and is excluded from milestone elapsed too (closed 14m only).
    assert.equal(lines[5], "$2.50 · 1.0M tok · 14m");
  } finally {
    cleanup();
  }
});

test("buildStatusCard: no auto.lock renders ○IDLE and STATE.md Next: on line 5", () => {
  const db = midSliceDb();
  const { cwd, cleanup } = makeProject({ db, state: STATE_MD }); // no lock → none/idle
  try {
    const lines = buildStatusCard(cwd, "Proj").split("\n");
    assert.equal(lines[0], "M013 ○IDLE · 63% · S 2/4 · T 2/4");
    // Idle shows Next:, not a false "▶ T03 in flight" line.
    assert.ok(lines[4]!.startsWith("Next: Slice S03 has no DB tasks"));
    assert.ok(lines[4]!.length <= 40);
  } finally {
    cleanup();
  }
});

test("buildStatusCard: a real blocker replaces line 5", () => {
  const db = midSliceDb();
  db.workers = [{ pid: process.pid, beatAgoMs: 1000 }];
  const stateWithBlocker = STATE_MD.replace("## Blockers\n- None", "## Blockers\n- Waiting on Helios column names from T01 probe");
  const { cwd, cleanup } = makeProject({
    db,
    lock: { pid: process.pid, unitId: "M013/S03/T03" },
    state: stateWithBlocker,
  });
  try {
    const card = buildStatusCard(cwd, "Proj");
    const lines = card.split("\n");
    assert.ok(lines[4]!.startsWith("⚠ Blocked: Waiting on Helios column"));
    assert.ok(lines[4]!.length <= 40);
    assert.ok(!card.includes("Next:"));
    assert.ok(!card.includes("▶ T03"));
  } finally {
    cleanup();
  }
});

test("buildStatusCard: completed-slice range compresses and keeps gaps (skipped slices)", () => {
  const { cwd, cleanup } = makeProject({
    db: {
      milestones: [{ id: "M013", status: "active" }],
      slices: [
        { milestone_id: "M013", id: "S01", status: "complete" },
        { milestone_id: "M013", id: "S02", status: "complete" },
        { milestone_id: "M013", id: "S03", status: "complete" },
        { milestone_id: "M013", id: "S04", status: "complete" },
        { milestone_id: "M013", id: "S05", status: "complete" },
        { milestone_id: "M013", id: "S06", status: "skipped" },
        { milestone_id: "M013", id: "S07", status: "complete" },
        { milestone_id: "M013", id: "S08", status: "pending" },
      ],
    },
  });
  try {
    const lines = buildStatusCard(cwd, "Proj").split("\n");
    assert.equal(lines[1], "✓ S01-S05 S07");
  } finally {
    cleanup();
  }
});

test("buildStatusCard: active slice without tasks drops the T count and glyph row", () => {
  const { cwd, cleanup } = makeProject({
    db: {
      milestones: [{ id: "M013", status: "active" }],
      slices: [
        { milestone_id: "M013", id: "S01", status: "complete" },
        { milestone_id: "M013", id: "S02", status: "pending", title: "Unplanned slice" },
      ],
    },
    state: STATE_MD,
  });
  try {
    const lines = buildStatusCard(cwd, "Proj").split("\n");
    assert.equal(lines[0], "M013 ○IDLE · 50% · S 1/2"); // no " · T"
    assert.equal(lines[1], "✓ S01");
    assert.equal(lines[2], "● S02 Unplanned slice");
    // no glyph row; line after the active slice is the STATE.md Next:
    assert.ok(lines[3]!.startsWith("Next:"));
  } finally {
    cleanup();
  }
});

test("buildStatusCard: unreadable metrics tables omit line 6 without throwing", () => {
  const db = midSliceDb();
  db.noMetricsTables = true;
  db.snapshots = [];
  db.dispatches = [];
  db.workers = [{ pid: process.pid, beatAgoMs: 1000 }];
  const { cwd, cleanup } = makeProject({
    db,
    lock: { pid: process.pid, unitId: "M013/S03/T03" },
    state: STATE_MD,
  });
  try {
    const lines = buildStatusCard(cwd, "Proj").split("\n");
    assert.equal(lines.length, 5); // frame minus the metrics line
    assert.ok(!lines.some((l) => l.includes(" tok")));
    // metrics null also means no elapsed suffix on line 5
    assert.equal(lines[4], "▶ T03 Tablet search collapse");
  } finally {
    cleanup();
  }
});

test("buildStatusCard: every line ≤40 chars and ≤6 lines even with long titles", () => {
  const long = "An enormously verbose slice title that would never fit a lens line at all";
  const db = midSliceDb();
  db.workers = [{ pid: process.pid, beatAgoMs: 1000 }];
  db.slices![2]!.title = long;
  db.tasks![2]!.title = long;
  const { cwd, cleanup } = makeProject({
    db,
    lock: { pid: process.pid, unitId: "M013/S03/T03" },
    state: STATE_MD.replace("## Blockers\n- None", `## Blockers\n- ${long}`),
  });
  try {
    const lines = buildStatusCard(cwd, "Proj").split("\n");
    assert.ok(lines.length <= 6, `expected ≤6 lines, got ${lines.length}`);
    for (const line of lines) {
      assert.ok([...line].length <= 40, `line >40 chars: "${line}"`);
    }
  } finally {
    cleanup();
  }
});

test("buildStatusCard: bare project (no db/state/lock) says so", () => {
  const { cwd, cleanup } = makeProject({});
  try {
    assert.equal(buildStatusCard(cwd, "Empty"), "GSD status · Empty\nNo active GSD milestone.");
  } finally {
    cleanup();
  }
});
