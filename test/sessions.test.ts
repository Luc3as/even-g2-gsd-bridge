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
  const root = mkdtempSync(join(tmpdir(), "gsd-sess-"));
  // Slug hyphens collide with path separators — decode must NOT be attempted.
  const slug = "--opt-AI_projects-Yummy-packing-assistant--";
  const dir = join(root, slug);
  mkdirSync(dir);
  const cwd = "/opt/AI_projects/Yummy-packing-assistant";
  writeFileSync(
    join(dir, "2026-07-22T08-11-30-967Z_abc.jsonl"),
    JSON.stringify({ type: "session", id: "abc", cwd, timestamp: "2026-07-22T08:11:30.967Z" }) +
      "\n" +
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hello world" }] } }) +
      "\n",
  );
  // A worktree dir must be filtered out.
  const wt = join(root, "--opt-AI_projects-Yummy-.gsd-worktrees-M001--");
  mkdirSync(wt);
  writeFileSync(
    join(wt, "x.jsonl"),
    JSON.stringify({ type: "session", cwd: "/opt/AI_projects/Yummy-packing-assistant/.gsd/worktrees/M001" }) + "\n",
  );

  const projects = listProjects(root, ["/opt/AI_projects"]);
  rmSync(root, { recursive: true, force: true });

  assert.equal(projects.length, 1);
  assert.equal(projects[0]!.cwd, cwd);
  assert.equal(projects[0]!.name, "Yummy-packing-assistant");
  assert.equal(projects[0]!.tmuxName, "Yummy-packing-assistant");
  assert.equal(projects[0]!.sessionId, slug);
  assert.equal(projects[0]!.title, "hello world");
});
