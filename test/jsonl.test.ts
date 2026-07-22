import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTranscript,
  deriveStatus,
  deriveStatusFromEntry,
  deriveStatusFromEntries,
  summarizeToolCall,
} from "../src/gsd/jsonl.ts";

// Fixtures mirror the verified live gsd-native format (2026-07-22).
const SESSION = JSON.stringify({
  type: "session",
  version: 3,
  id: "019f88e1",
  timestamp: "2026-07-22T08:11:30.967Z",
  cwd: "/opt/AI_projects/Yummy-packing-assistant",
});
const MODEL = JSON.stringify({ type: "model_change", provider: "claude-code", modelId: "claude-opus-4-8" });
const USER = JSON.stringify({
  type: "message",
  message: { role: "user", content: [{ type: "text", text: "add e2e tests" }] },
  timestamp: "2026-07-22T08:12:00.000Z",
});
const ASSISTANT_TOOL = JSON.stringify({
  type: "message",
  timestamp: "2026-07-22T08:15:14.369Z",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "Looking at the e2e dir." },
      { type: "toolCall", name: "Bash", arguments: { command: "ls e2e/", description: "Inspect e2e dir" } },
    ],
  },
});
const ASSISTANT_DONE = JSON.stringify({
  type: "message",
  timestamp: "2026-07-22T08:16:00.000Z",
  message: { role: "assistant", content: [{ type: "text", text: "Done. All tests pass." }] },
});
const TOOL_RESULT = JSON.stringify({
  type: "message",
  timestamp: "2026-07-22T08:15:15.000Z",
  message: { role: "toolResult", content: [{ type: "text", text: "spec.ts\nfixtures" }] },
});

test("parseTranscript reads meta cwd + model and normalizes turns", () => {
  const raw = [SESSION, MODEL, USER, ASSISTANT_TOOL].join("\n");
  const { meta, turns } = parseTranscript(raw);
  assert.equal(meta?.cwd, "/opt/AI_projects/Yummy-packing-assistant");
  assert.equal(meta?.model, "claude-opus-4-8");
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.role, "user");
  assert.equal(turns[1]!.role, "assistant");
  assert.deepEqual(turns[1]!.tools, ["Bash: Inspect e2e dir"]);
});

test("summarizeToolCall prefers description, falls back to command", () => {
  assert.equal(summarizeToolCall({ name: "Bash", arguments: { description: "d", command: "c" } }), "Bash: d");
  assert.equal(summarizeToolCall({ name: "Read", arguments: { file_path: "/a/b.ts" } }), "Read: /a/b.ts");
  assert.equal(summarizeToolCall({ name: "X", arguments: {} }), "X");
});

test("deriveStatus: pending tool call = busy, final text = idle, stale = idle", () => {
  const now = Date.parse("2026-07-22T08:16:05.000Z");
  const busy = [SESSION, ASSISTANT_TOOL].join("\n");
  assert.equal(deriveStatus(busy, now, 120000, now), "busy");
  const done = [SESSION, ASSISTANT_DONE].join("\n");
  assert.equal(deriveStatus(done, now, 120000, now), "idle");
  // Fresh file but last entry is a tool result → still working.
  const waiting = [SESSION, ASSISTANT_TOOL, TOOL_RESULT].join("\n");
  assert.equal(deriveStatus(waiting, now, 120000, now), "busy");
  // Old mtime forces idle regardless of content.
  assert.equal(deriveStatus(busy, now - 200000, 120000, now), "idle");
});

// The live bug: gsd writes the final answer as assistant [toolCall, text],
// then flushes the toolResult line after it. Deciding off the trailing
// toolResult wrongly re-flips the finished turn to busy.
const ASSISTANT_TOOL_THEN_TEXT = JSON.stringify({
  type: "message",
  timestamp: "2026-07-22T11:14:48.922Z",
  message: {
    role: "assistant",
    content: [
      { type: "toolCall", name: "Bash", arguments: { command: "git log -1", description: "latest commit" } },
      { type: "text", text: "Latest commit: 69959f9 feat: add n8n-PATTERNS.md" },
    ],
  },
});

test("deriveStatusFromEntries decides off last assistant, skipping trailing toolResult", () => {
  // Answer delivered, result logged after → idle (the bug fix).
  assert.equal(deriveStatusFromEntries([ASSISTANT_TOOL_THEN_TEXT, TOOL_RESULT]), "idle");
  // Mid-turn: assistant only called a tool, result back, more coming → busy.
  assert.equal(deriveStatusFromEntries([ASSISTANT_TOOL, TOOL_RESULT]), "busy");
  // Just prompted, no assistant yet → busy.
  assert.equal(deriveStatusFromEntries([USER]), "busy");
  // Chunk of only a toolResult (assistant came earlier) → undecided, keep prior.
  assert.equal(deriveStatusFromEntries([TOOL_RESULT]), null);
  // Plain finished answer → idle.
  assert.equal(deriveStatusFromEntries([ASSISTANT_DONE]), "idle");
});

test("deriveStatusFromEntry classifies a single line", () => {
  assert.equal(deriveStatusFromEntry(ASSISTANT_TOOL), "busy");
  assert.equal(deriveStatusFromEntry(ASSISTANT_DONE), "idle");
  assert.equal(deriveStatusFromEntry(TOOL_RESULT), "busy");
  assert.equal(deriveStatusFromEntry(SESSION), null);
});

test("parseTranscript tolerates blank + malformed lines", () => {
  const raw = [SESSION, "", "{not json", USER].join("\n");
  const { turns } = parseTranscript(raw);
  assert.equal(turns.length, 1);
});
