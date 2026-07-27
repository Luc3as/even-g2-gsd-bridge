import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProgress, formatProgress, formatProgressRich, progressSignature } from "../src/gsd/progress.ts";

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

test("progressSignature changes only when counts/slice/milestone change", () => {
  const base = { milestoneId: "M001", slicesDone: 1, slicesTotal: 4, activeSliceId: "S02", activeSliceTitle: "x", tasksDone: 1, tasksTotal: 3, activeTaskId: "T02", activeTaskTitle: "y" };
  assert.equal(progressSignature(base), progressSignature({ ...base }));
  assert.notEqual(progressSignature(base), progressSignature({ ...base, tasksDone: 2 }));
  assert.notEqual(progressSignature(base), progressSignature({ ...base, slicesDone: 2 }));
  assert.notEqual(progressSignature(base), progressSignature({ ...base, activeSliceId: "S03" }));
  assert.notEqual(progressSignature(base), progressSignature({ ...base, milestoneId: "M002" }));
});
