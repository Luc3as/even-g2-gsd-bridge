import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmuxNameFor, listProjects } from "../src/gsd/sessions.ts";

test("tmuxNameFor matches sersám sname (non [A-Za-z0-9_-] → _)", () => {
  assert.equal(tmuxNameFor("/opt/AI_projects/Yummy-packing-assistant"), "Yummy-packing-assistant");
  assert.equal(tmuxNameFor("/opt/AI_projects/AI_IT_Helpdesk"), "AI_IT_Helpdesk");
  assert.equal(tmuxNameFor("/opt/AI_projects/my proj.v2"), "my_proj_v2");
});

test("listProjects reads cwd from the session line, not the lossy slug", () => {
  // Hermetic: the project cwd lives UNDER the temp root and the root is the only
  // allowed projectRoot, so no real-disk `.gsd/gsd.db` is read (the auto-progress
  // subtitle reads a project's live db; a real active milestone would otherwise
  // override the prompt-hint title asserted here).
  const root = mkdtempSync(join(tmpdir(), "gsd-sess-"));
  const cwd = join(root, "Yummy-packing-assistant");
  mkdirSync(cwd);
  // Slug hyphens collide with path separators — decode must NOT be attempted.
  const slug = "--Yummy-packing-assistant--";
  const dir = join(root, slug);
  mkdirSync(dir);
  writeFileSync(
    join(dir, "2026-07-22T08-11-30-967Z_abc.jsonl"),
    JSON.stringify({ type: "session", id: "abc", cwd, timestamp: "2026-07-22T08:11:30.967Z" }) +
      "\n" +
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hello world" }] } }) +
      "\n",
  );
  // A worktree dir must be filtered out.
  const wt = join(root, "--Yummy-.gsd-worktrees-M001--");
  mkdirSync(wt);
  writeFileSync(
    join(wt, "x.jsonl"),
    JSON.stringify({ type: "session", cwd: join(cwd, ".gsd/worktrees/M001") }) + "\n",
  );

  const projects = listProjects([root], [root]);
  rmSync(root, { recursive: true, force: true });

  assert.equal(projects.length, 1);
  assert.equal(projects[0]!.cwd, cwd);
  assert.equal(projects[0]!.name, "Yummy-packing-assistant");
  assert.equal(projects[0]!.tmuxName, "Yummy-packing-assistant");
  assert.equal(projects[0]!.sessionId, slug);
  assert.equal(projects[0]!.title, "hello world");
});

test("listProjects title tracks the LATEST user prompt, not the first", () => {
  // Hermetic: cwd under the temp root (see the cwd-from-session-line test) so the
  // auto-progress subtitle finds no real db and the prompt-hint title is asserted.
  const root = mkdtempSync(join(tmpdir(), "gsd-sess-"));
  const cwd = join(root, "Even-g2-gsd-bridge");
  mkdirSync(cwd);
  const dir = join(root, "--Even-g2-gsd-bridge--");
  mkdirSync(dir);
  const msg = (role: string, text: string) =>
    JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
  writeFileSync(
    join(dir, "s.jsonl"),
    [
      JSON.stringify({ type: "session", id: "s", cwd, timestamp: "2026-07-22T08:00:00.000Z" }),
      msg("user", "first command"),
      msg("assistant", "some long answer"),
      msg("user", "latest command"),
      msg("assistant", "trailing answer"),
    ].join("\n") + "\n",
  );

  const projects = listProjects([root], [root]);
  rmSync(root, { recursive: true, force: true });

  assert.equal(projects[0]!.title, "latest command");
});
