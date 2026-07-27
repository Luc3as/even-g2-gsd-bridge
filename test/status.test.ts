import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatusCard } from "../src/gsd/status.ts";

interface Opts {
  db?: {
    milestones: { id: string; status: string }[];
    slices?: { milestone_id: string; id: string; status: string; title?: string }[];
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
    for (const m of opts.db.milestones)
      db.prepare("INSERT INTO milestones VALUES (?,?)").run(m.id, m.status);
    for (const s of opts.db.slices ?? [])
      db.prepare("INSERT INTO slices VALUES (?,?,?,?)").run(s.milestone_id, s.id, s.title ?? `${s.id} title`, s.status);
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

test("buildStatusCard: running auto-run + progress + phase + next action", () => {
  const { cwd, cleanup } = makeProject({
    db: {
      milestones: [{ id: "M013", status: "active" }],
      slices: [
        { milestone_id: "M013", id: "S01", status: "complete" },
        { milestone_id: "M013", id: "S02", status: "complete" },
        { milestone_id: "M013", id: "S03", status: "pending" },
        { milestone_id: "M013", id: "S04", status: "pending" },
      ],
    },
    lock: { pid: process.pid, unitType: "plan-slice", unitId: "M013/S03" },
    state: STATE_MD,
  });
  try {
    const card = buildStatusCard(cwd, "Yummy-packing-assistant");
    const lines = card.split("\n");
    assert.equal(lines[0], "GSD status · Yummy-packing-assistant");
    assert.equal(lines[1], "▶ auto-mode running M013/S03");
    assert.equal(lines[2], "M013 ▶ S03 · 2/4 slices");
    assert.equal(lines[3], "Phase: planning");
    assert.ok(lines[4]!.startsWith("Next: Slice S03 has no DB tasks"));
  } finally {
    cleanup();
  }
});

test("buildStatusCard: a dead auto-run leads with the STOPPED alarm line", () => {
  const { cwd, cleanup } = makeProject({
    db: { milestones: [{ id: "M013", status: "active" }], slices: [{ milestone_id: "M013", id: "S02", status: "pending" }] },
    lock: { pid: 2147483647, unitType: "run-uat", unitId: "M013/S02" },
    state: STATE_MD,
  });
  try {
    const lines = buildStatusCard(cwd, "Proj").split("\n");
    assert.equal(lines[1], "⚠ auto-mode STOPPED at M013/S02");
  } finally {
    cleanup();
  }
});

test("buildStatusCard: a real blocker outranks the next-action line", () => {
  const stateWithBlocker = STATE_MD.replace("## Blockers\n- None", "## Blockers\n- Waiting on Helios column names from T01 probe");
  const { cwd, cleanup } = makeProject({ state: stateWithBlocker });
  try {
    const card = buildStatusCard(cwd, "Proj");
    assert.ok(card.includes("Blocked: Waiting on Helios column names"));
    assert.ok(!card.includes("Next:"));
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
