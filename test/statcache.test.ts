import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoByStat, clearStatCache } from "../src/gsd/statcache.ts";
import { listProjects } from "../src/gsd/sessions.ts";

test("memoByStat recomputes only when an input file's stat signature moves", () => {
  clearStatCache();
  const root = mkdtempSync(join(tmpdir(), "statcache-"));
  try {
    const f = join(root, "a.txt");
    let calls = 0;
    const compute = () => ++calls;

    assert.equal(memoByStat([f], compute), 1); // missing file → computed once
    assert.equal(memoByStat([f], compute), 1); // still missing → hit

    writeFileSync(f, "x");
    assert.equal(memoByStat([f], compute), 2); // appeared → recompute
    assert.equal(memoByStat([f], compute), 2); // unchanged → hit

    appendFileSync(f, "y");
    assert.equal(memoByStat([f], compute), 3); // size moved → recompute

    utimesSync(f, new Date(0), new Date(0));
    assert.equal(memoByStat([f], compute), 4); // mtime moved, same size → recompute

    rmSync(f);
    assert.equal(memoByStat([f], compute), 5); // vanished → recompute
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listProjects title follows a transcript append across the memo", () => {
  clearStatCache();
  const root = mkdtempSync(join(tmpdir(), "statcache-sess-"));
  try {
    const cwd = join(root, "proj");
    const dir = join(root, "--proj--");
    mkdirSync(cwd);
    mkdirSync(dir);
    const msg = (role: string, text: string) =>
      JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
    const file = join(dir, "s.jsonl");
    writeFileSync(file, JSON.stringify({ type: "session", id: "s", cwd }) + "\n" + msg("user", "first") + "\n");
    assert.equal(listProjects([root], [root])[0]!.title, "first");
    assert.equal(listProjects([root], [root])[0]!.title, "first"); // memo hit
    appendFileSync(file, msg("user", "second") + "\n");
    assert.equal(listProjects([root], [root])[0]!.title, "second"); // append invalidates
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listProjects picks up a rotated-in transcript on the next call (dir mtime fast path)", () => {
  clearStatCache();
  const root = mkdtempSync(join(tmpdir(), "statcache-rot-"));
  try {
    const cwd = join(root, "proj");
    const dir = join(root, "--proj--");
    mkdirSync(cwd);
    mkdirSync(dir);
    const session = JSON.stringify({ type: "session", id: "s", cwd }) + "\n";
    writeFileSync(join(dir, "a.jsonl"), session);
    assert.equal(listProjects([root], [root])[0]!.newestJsonl, join(dir, "a.jsonl"));
    // New file, newer mtime: the dir mtime moves on create → full rescan, no 10s wait.
    writeFileSync(join(dir, "b.jsonl"), session);
    utimesSync(join(dir, "b.jsonl"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    assert.equal(listProjects([root], [root])[0]!.newestJsonl, join(dir, "b.jsonl"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
