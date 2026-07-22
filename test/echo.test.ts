import { test } from "node:test";
import assert from "node:assert/strict";
import { recordEcho, consumeEcho } from "../src/server/events.ts";

test("consumeEcho matches a recorded echo once, then stops", () => {
  const s = "sess-echo-1";
  recordEcho(s, "show me the latest git commit");
  assert.equal(consumeEcho(s, "show me the latest git commit"), true);
  // Same text again is a genuine repeat — not suppressed.
  assert.equal(consumeEcho(s, "show me the latest git commit"), false);
});

test("consumeEcho normalizes whitespace", () => {
  const s = "sess-echo-2";
  recordEcho(s, "  hello   world ");
  assert.equal(consumeEcho(s, "hello world"), true);
});

test("consumeEcho returns false when nothing was echoed", () => {
  assert.equal(consumeEcho("sess-echo-unknown", "anything"), false);
});

test("two identical echoes are consumed twice (one per replay)", () => {
  const s = "sess-echo-3";
  recordEcho(s, "run tests");
  recordEcho(s, "run tests");
  assert.equal(consumeEcho(s, "run tests"), true);
  assert.equal(consumeEcho(s, "run tests"), true);
  assert.equal(consumeEcho(s, "run tests"), false);
});
