import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tick } from "../src/gsd/watch.ts";
import { getMessages } from "../src/server/events.ts";
import type { Config } from "../src/config.ts";

const SESSION = (cwd: string) =>
  JSON.stringify({ type: "session", version: 3, id: "t", timestamp: "2026-07-22T00:00:00.000Z", cwd });
const USER = (text: string) =>
  JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const ASSISTANT = (text: string) =>
  JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "thinking", text: "…" }, { type: "text", text }] },
  });

function cfgFor(store: string): Config {
  return {
    sessionsDirs: [store],
    projectRoots: ["/opt/AI_projects"],
    busyWindowMs: 120000,
    tailIntervalMs: 500,
  } as Config;
}

// Regression: a newline-terminated chunk used to drift the byte offset +1 per
// read (the trailing "" from split counted as a byte), so the NEXT line was read
// one byte short, failed to parse, and its entry was silently dropped. For a
// plain answer turn that dropped line was the agent_message — the answer never
// reached the ring, and the glasses stayed stuck on "thinking".
test("tick emits an answer written a tick after the prompt (no offset drift)", () => {
  const store = mkdtempSync(join(tmpdir(), "watch-drift-"));
  try {
    const cwd = "/opt/AI_projects/drift-probe";
    const dir = join(store, "--slug--");
    mkdirSync(dir);
    const file = join(dir, "x.jsonl");
    // Pre-existing transcript so first-sight starts at a non-zero EOF.
    writeFileSync(file, SESSION(cwd) + "\n" + ASSISTANT("older answer") + "\n");
    const cfg = cfgFor(store);

    let now = 1_000_000;
    tick(cfg, now); // first sight → offset = EOF
    now += 500;

    appendFileSync(file, USER("Show me the letters bit") + "\n");
    tick(cfg, now); // prompt lands in its own chunk
    now += 500;

    appendFileSync(file, ASSISTANT("Letters bit = the trailer line.") + "\n");
    tick(cfg, now); // answer lands in the next chunk
    now += 500;
    tick(cfg, now);

    const msgs = getMessages("--slug--", 0);
    const types = msgs.map((m) => m.type);
    assert.ok(types.includes("user_prompt"), `expected user_prompt, got ${types.join(",")}`);
    assert.ok(types.includes("agent_message"), `answer dropped by offset drift, got ${types.join(",")}`);
    const answer = msgs.find((m) => m.type === "agent_message");
    assert.equal((answer as { text?: string }).text, "Letters bit = the trailer line.");
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});
