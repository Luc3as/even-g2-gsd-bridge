import { test } from "node:test";
import assert from "node:assert/strict";
import { shrink, toGlassesHistory } from "../src/even/format.ts";
import type { Turn } from "../src/gsd/jsonl.ts";

test("shrink collapses whitespace and hard-truncates", () => {
  assert.equal(shrink("a\n\n  b   c  \n"), "a\nb c");
  const long = "x".repeat(500);
  const out = shrink(long);
  assert.ok(out.length <= 280);
  assert.ok(out.endsWith("…"));
});

test("shrink clips over-long single lines", () => {
  const out = shrink("y".repeat(200));
  assert.ok(out.split("\n")[0]!.length <= 90);
});

test("toGlassesHistory folds tool calls into assistant text and limits", () => {
  const turns: Turn[] = [
    { role: "user", text: "hi", tools: [] },
    { role: "assistant", text: "ok", tools: ["Bash: run tests"] },
    { role: "tool", text: "", tools: [] },
    { role: "assistant", text: "done", tools: [] },
  ];
  const h = toGlassesHistory(turns, 2);
  assert.equal(h.length, 2);
  assert.equal(h[0]!.role, "assistant");
  assert.ok(h[0]!.text.includes("> Bash: run tests"));
  assert.equal(h[1]!.text, "done");
});
