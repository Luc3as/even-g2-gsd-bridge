import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProgress, readAutoLiveness, formatProgress, formatProgressRich, fmtElapsed, progressSignature } from "../src/gsd/progress.ts";

// Build a minimal .gsd/gsd.db under a temp cwd matching the live schema
// (milestones/slices/tasks; slices/tasks carry a title column). Returns the cwd.
// Title defaults to "<id> title" when not given, so most specs stay terse.
function makeProject(spec: {
  milestones: { id: string; status: string }[];
  slices?: { milestone_id: string; id: string; status: string; title?: string }[];
  tasks?: { milestone_id: string; slice_id: string; id: string; status: string; title?: string }[];
}): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "progress-"));
  mkdirSync(join(cwd, ".gsd"));
  const db = new DatabaseSync(join(cwd, ".gsd", "gsd.db"));
  db.exec("CREATE TABLE milestones (id TEXT, status TEXT)");
  db.exec("CREATE TABLE slices (milestone_id TEXT, id TEXT, title TEXT, status TEXT)");
  db.exec("CREATE TABLE tasks (milestone_id TEXT, slice_id TEXT, id TEXT, title TEXT, status TEXT)");
  for (const m of spec.milestones)
    db.prepare("INSERT INTO milestones VALUES (?,?)").run(m.id, m.status);
  for (const s of spec.slices ?? [])
    db.prepare("INSERT INTO slices VALUES (?,?,?,?)").run(s.milestone_id, s.id, s.title ?? `${s.id} title`, s.status);
  for (const t of spec.tasks ?? [])
    db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?)").run(t.milestone_id, t.slice_id, t.id, t.title ?? `${t.id} title`, t.status);
  db.close();
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("readProgress returns null when there is no .gsd/gsd.db", () => {
  const cwd = mkdtempSync(join(tmpdir(), "progress-nodb-"));
  try {
    assert.equal(readProgress(cwd), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("readProgress returns null when no milestone is active", () => {
  const { cwd, cleanup } = makeProject({ milestones: [{ id: "M001", status: "complete" }] });
  try {
    assert.equal(readProgress(cwd), null);
  } finally {
    cleanup();
  }
});

test("readProgress reports the active milestone with slice + task counts", () => {
  const { cwd, cleanup } = makeProject({
    milestones: [
      { id: "M001", status: "complete" },
      { id: "M002", status: "active" },
    ],
    slices: [
      { milestone_id: "M002", id: "S01", status: "complete" },
      { milestone_id: "M002", id: "S02", status: "complete" },
      { milestone_id: "M002", id: "S03", status: "pending" },
      { milestone_id: "M002", id: "S04", status: "pending" },
    ],
    tasks: [
      { milestone_id: "M002", slice_id: "S03", id: "T01", status: "complete" },
      { milestone_id: "M002", slice_id: "S03", id: "T02", status: "pending" },
      { milestone_id: "M002", slice_id: "S03", id: "T03", status: "pending" },
    ],
  });
  try {
    const p = readProgress(cwd);
    assert.deepEqual(p, {
      milestoneId: "M002",
      slicesDone: 2,
      slicesTotal: 4,
      activeSliceId: "S03",
      activeSliceTitle: "S03 title",
      tasksDone: 1,
      tasksTotal: 3,
      // First PENDING task in S03 by id = T02 (T01 complete).
      activeTaskId: "T02",
      activeTaskTitle: "T02 title",
    });
  } finally {
    cleanup();
  }
});

test("readProgress: active slice is the first PENDING one by id, not by row order", () => {
  const { cwd, cleanup } = makeProject({
    milestones: [{ id: "M001", status: "active" }],
    slices: [
      // Insert out of order; S02 pending must win over S03 pending.
      { milestone_id: "M001", id: "S03", status: "pending" },
      { milestone_id: "M001", id: "S01", status: "complete" },
      { milestone_id: "M001", id: "S02", status: "pending" },
    ],
  });
  try {
    assert.equal(readProgress(cwd)?.activeSliceId, "S02");
  } finally {
    cleanup();
  }
});

test("readProgress: all slices complete → no active slice, zero tasks", () => {
  const { cwd, cleanup } = makeProject({
    milestones: [{ id: "M001", status: "active" }],
    slices: [
      { milestone_id: "M001", id: "S01", status: "complete" },
      { milestone_id: "M001", id: "S02", status: "complete" },
    ],
  });
  try {
    const p = readProgress(cwd)!;
    assert.equal(p.activeSliceId, null);
    assert.equal(p.slicesDone, 2);
    assert.equal(p.slicesTotal, 2);
    assert.equal(p.tasksTotal, 0);
  } finally {
    cleanup();
  }
});

test("formatProgress: active slice with tasks", () => {
  assert.equal(
    formatProgress({ milestoneId: "M013", slicesDone: 4, slicesTotal: 8, activeSliceId: "S05", activeSliceTitle: "x", tasksDone: 2, tasksTotal: 5, activeTaskId: "T03", activeTaskTitle: "y" }),
    "M013 ▶ S05 · 4/8 slices · T2/5",
  );
});

test("formatProgress: active slice, no tasks planned yet (omits T segment)", () => {
  assert.equal(
    formatProgress({ milestoneId: "M013", slicesDone: 4, slicesTotal: 8, activeSliceId: "S05", activeSliceTitle: "x", tasksDone: 0, tasksTotal: 0, activeTaskId: null, activeTaskTitle: null }),
    "M013 ▶ S05 · 4/8 slices",
  );
});

test("formatProgress: all slices done → check-mark form", () => {
  assert.equal(
    formatProgress({ milestoneId: "M013", slicesDone: 8, slicesTotal: 8, activeSliceId: null, activeSliceTitle: null, tasksDone: 0, tasksTotal: 0, activeTaskId: null, activeTaskTitle: null }),
    "M013 ✓ 8/8 slices",
  );
});

test("formatProgressRich: slice + task titles on separate lines", () => {
  assert.equal(
    formatProgressRich({ milestoneId: "M011", slicesDone: 0, slicesTotal: 4, activeSliceId: "S01", activeSliceTitle: "Shared layout & routes", tasksDone: 0, tasksTotal: 2, activeTaskId: "T01", activeTaskTitle: "Scaffold routes" }),
    "M011 ▶ S01 · 0/4 slices\nShared layout & routes\nT0/2 · Scaffold routes",
  );
});

test("formatProgressRich: no tasks planned → slice title only, no T line", () => {
  assert.equal(
    formatProgressRich({ milestoneId: "M011", slicesDone: 1, slicesTotal: 4, activeSliceId: "S02", activeSliceTitle: "Email handoff", tasksDone: 0, tasksTotal: 0, activeTaskId: null, activeTaskTitle: null }),
    "M011 ▶ S02 · 1/4 slices\nEmail handoff",
  );
});

test("formatProgressRich: task counted but no title → bare T line", () => {
  assert.equal(
    formatProgressRich({ milestoneId: "M011", slicesDone: 0, slicesTotal: 2, activeSliceId: "S01", activeSliceTitle: null, tasksDone: 1, tasksTotal: 3, activeTaskId: null, activeTaskTitle: null }),
    "M011 ▶ S01 · 0/2 slices\nT1/3",
  );
});

test("formatProgressRich: all slices done → finishing form", () => {
  assert.equal(
    formatProgressRich({ milestoneId: "M013", slicesDone: 4, slicesTotal: 4, activeSliceId: null, activeSliceTitle: null, tasksDone: 0, tasksTotal: 0, activeTaskId: null, activeTaskTitle: null }),
    "M013 ✓ 4/4 slices — milestone finishing",
  );
});

test("formatProgressRich: long title clipped to lens width", () => {
  const long = "A".repeat(60);
  const out = formatProgressRich({ milestoneId: "M001", slicesDone: 0, slicesTotal: 1, activeSliceId: "S01", activeSliceTitle: long, tasksDone: 0, tasksTotal: 0, activeTaskId: null, activeTaskTitle: null });
  const titleLine = out.split("\n")[1]!;
  assert.equal(titleLine.length, 40);
  assert.ok(titleLine.endsWith("…"));
});

test("fmtElapsed: sub-minute → seconds, over a minute → Nm Ns", () => {
  assert.equal(fmtElapsed(0), "+0s");
  assert.equal(fmtElapsed(45_000), "+45s");
  assert.equal(fmtElapsed(59_999), "+59s");
  assert.equal(fmtElapsed(60_000), "+1m0s");
  assert.equal(fmtElapsed(134_000), "+2m14s");
});

test("formatProgressRich: elapsedMs appends live ticker to the count line", () => {
  const p = { milestoneId: "M011", slicesDone: 0, slicesTotal: 4, activeSliceId: "S01", activeSliceTitle: "Shared layout", tasksDone: 0, tasksTotal: 2, activeTaskId: "T01", activeTaskTitle: "Scaffold" };
  assert.equal(
    formatProgressRich(p, 134_000),
    "M011 ▶ S01 · 0/4 slices · +2m14s\nShared layout\nT0/2 · Scaffold",
  );
  // elapsedMs=0 (the default / initial push) carries no ticker.
  assert.equal(formatProgressRich(p, 0).split("\n")[0], "M011 ▶ S01 · 0/4 slices");
});

test("formatProgressRich: finishing form ignores elapsedMs (no ticker over idle)", () => {
  assert.equal(
    formatProgressRich({ milestoneId: "M013", slicesDone: 4, slicesTotal: 4, activeSliceId: null, activeSliceTitle: null, tasksDone: 0, tasksTotal: 0, activeTaskId: null, activeTaskTitle: null }, 99_000),
    "M013 ✓ 4/4 slices — milestone finishing",
  );
});

// ── readAutoLiveness (auto-mode DB heartbeat + worker-pid) ─────────────────
// Fixed reference instant so heartbeat ages are deterministic (no Date.now flake).
const NOW = Date.parse("2026-07-28T06:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
// Injected pid probes — never touch real processes in tests.
const ALIVE = () => true;
const DEAD = () => false;

// Build a .gsd/gsd.db carrying only the workers table (readAutoLiveness ignores
// milestones/slices/tasks). Rows are keyed by the RESOLVED realpath of cwd, which
// is what readAutoLiveness matches on (it realpaths cwd before querying).
function makeWorkers(rows: { status: string; heartbeatMsAgo: number; pid?: number | null }[], opts?: { noTable?: boolean }): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "liveness-"));
  mkdirSync(join(cwd, ".gsd"));
  const realpath = realpathSync(cwd);
  const db = new DatabaseSync(join(cwd, ".gsd", "gsd.db"));
  if (!opts?.noTable) {
    db.exec(
      "CREATE TABLE workers (worker_id TEXT, status TEXT, last_heartbeat_at TEXT, pid INTEGER, project_root_realpath TEXT)",
    );
    let i = 0;
    for (const r of rows)
      db.prepare("INSERT INTO workers VALUES (?,?,?,?,?)").run(`w${i++}`, r.status, iso(r.heartbeatMsAgo), r.pid === undefined ? 4242 : r.pid, realpath);
  }
  db.close();
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("readAutoLiveness returns null when there is no .gsd/gsd.db", () => {
  const cwd = mkdtempSync(join(tmpdir(), "liveness-nodb-"));
  try {
    assert.equal(readAutoLiveness(cwd, NOW, ALIVE), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("readAutoLiveness returns null when the workers table is absent (older gsd)", () => {
  const { cwd, cleanup } = makeWorkers([], { noTable: true });
  try {
    assert.equal(readAutoLiveness(cwd, NOW, ALIVE), null);
  } finally {
    cleanup();
  }
});

test("readAutoLiveness: fresh active heartbeat (within 60s TTL) → running", () => {
  const { cwd, cleanup } = makeWorkers([{ status: "active", heartbeatMsAgo: 5_000 }]);
  try {
    assert.deepEqual(readAutoLiveness(cwd, NOW, ALIVE), { liveness: "running", quietForMs: null });
  } finally {
    cleanup();
  }
});

test("readAutoLiveness: stale heartbeat + worker pid ALIVE → quiet (mid-unit, NOT stopped)", () => {
  // The false "gsd stopped" the wearer saw: the loop stamps the heartbeat once
  // per unit (~4-8 min apart) with a 60s TTL, so a healthy run is stale for most
  // of every unit. An alive worker pid means the unit is executing.
  const { cwd, cleanup } = makeWorkers([{ status: "active", heartbeatMsAgo: 90_000 }]);
  try {
    assert.deepEqual(readAutoLiveness(cwd, NOW, ALIVE), { liveness: "quiet", quietForMs: 90_000 });
  } finally {
    cleanup();
  }
});

test("readAutoLiveness: stale heartbeat + worker pid DEAD → stopped", () => {
  const { cwd, cleanup } = makeWorkers([{ status: "active", heartbeatMsAgo: 90_000 }]);
  try {
    assert.deepEqual(readAutoLiveness(cwd, NOW, DEAD), { liveness: "stopped", quietForMs: null });
  } finally {
    cleanup();
  }
});

test("readAutoLiveness: stale heartbeat + no usable pid on the row → stopped", () => {
  // Can't verify life without a pid — match GSD's own janitor and treat as dead.
  const { cwd, cleanup } = makeWorkers([{ status: "active", heartbeatMsAgo: 90_000, pid: null }]);
  try {
    assert.deepEqual(readAutoLiveness(cwd, NOW, ALIVE), { liveness: "stopped", quietForMs: null });
  } finally {
    cleanup();
  }
});

test("readAutoLiveness: quiet age uses fresher artifact evidence over the heartbeat", () => {
  // Unit runtime records / activity transcripts are written mid-unit while the
  // heartbeat is silent — the freshest of them is the honest "last progress".
  const { cwd, cleanup } = makeWorkers([{ status: "active", heartbeatMsAgo: 300_000 }]);
  try {
    const actDir = join(cwd, ".gsd", "activity");
    mkdirSync(actDir);
    const f = join(actDir, "520-execute-task-M013-S08-T04.jsonl");
    writeFileSync(f, "{}\n");
    const at = new Date(NOW - 120_000);
    utimesSync(f, at, at);
    assert.deepEqual(readAutoLiveness(cwd, NOW, ALIVE), { liveness: "quiet", quietForMs: 120_000 });
  } finally {
    cleanup();
  }
});

test("readAutoLiveness: heartbeat exactly at the TTL boundary (60s) → running", () => {
  const { cwd, cleanup } = makeWorkers([{ status: "active", heartbeatMsAgo: 60_000 }]);
  try {
    // now - beat == TTL is within the window (<=), so still live.
    assert.deepEqual(readAutoLiveness(cwd, NOW, ALIVE), { liveness: "running", quietForMs: null });
  } finally {
    cleanup();
  }
});

test("readAutoLiveness: only stopping rows (no active) → stopped", () => {
  const { cwd, cleanup } = makeWorkers([
    { status: "stopping", heartbeatMsAgo: 5_000 },
    { status: "stopping", heartbeatMsAgo: 120_000 },
  ]);
  try {
    assert.deepEqual(readAutoLiveness(cwd, NOW, ALIVE), { liveness: "stopped", quietForMs: null });
  } finally {
    cleanup();
  }
});

test("readAutoLiveness: empty workers table (no rows) → stopped", () => {
  const { cwd, cleanup } = makeWorkers([]);
  try {
    assert.deepEqual(readAutoLiveness(cwd, NOW, ALIVE), { liveness: "stopped", quietForMs: null });
  } finally {
    cleanup();
  }
});

test("readAutoLiveness: freshest active row wins — a live run beside an ancient active row → running", () => {
  // Mirrors the live Yummy DB: two active rows, one ancient (Jul-15). ORDER BY
  // heartbeat DESC must pick the fresh one so the ancient row can't mask a live run.
  const { cwd, cleanup } = makeWorkers([
    { status: "active", heartbeatMsAgo: 5_000 },
    { status: "active", heartbeatMsAgo: 1_000_000_000 },
  ]);
  try {
    assert.deepEqual(readAutoLiveness(cwd, NOW, ALIVE), { liveness: "running", quietForMs: null });
  } finally {
    cleanup();
  }
});

test("readAutoLiveness: freshest active row wins — newest active stale, worker dead → stopped", () => {
  const { cwd, cleanup } = makeWorkers([
    { status: "active", heartbeatMsAgo: 200_000 },
    { status: "active", heartbeatMsAgo: 1_000_000_000 },
  ]);
  try {
    assert.deepEqual(readAutoLiveness(cwd, NOW, DEAD), { liveness: "stopped", quietForMs: null });
  } finally {
    cleanup();
  }
});

test("progressSignature changes only when counts/slice/milestone change", () => {
  const base = { milestoneId: "M001", slicesDone: 1, slicesTotal: 4, activeSliceId: "S02", activeSliceTitle: "x", tasksDone: 1, tasksTotal: 3, activeTaskId: "T02", activeTaskTitle: "y" };
  assert.equal(progressSignature(base), progressSignature({ ...base }));
  assert.notEqual(progressSignature(base), progressSignature({ ...base, tasksDone: 2 }));
  assert.notEqual(progressSignature(base), progressSignature({ ...base, slicesDone: 2 }));
  assert.notEqual(progressSignature(base), progressSignature({ ...base, activeSliceId: "S03" }));
  assert.notEqual(progressSignature(base), progressSignature({ ...base, milestoneId: "M002" }));
  // Active task shift (e.g. gsd replans tasks so a new one is active at the same
  // done-count) must still push, so the wearer sees the unit-in-flight change.
  assert.notEqual(progressSignature(base), progressSignature({ ...base, activeTaskId: "T03" }));
});
