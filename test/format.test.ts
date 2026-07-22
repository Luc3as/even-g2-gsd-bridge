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

test("toGlassesHistory leads with prose, folds tool calls beneath, drops tool output", () => {
  const turns: Turn[] = [
    { role: "user", text: "hi", tools: [] },
    { role: "assistant", text: "ok", tools: ["Bash: run tests"] },
    { role: "tool", text: "M .gsd/CODEBASE.md\nM .gsd/hook-state.json", tools: [] },
    { role: "assistant", text: "done", tools: [] },
  ];
  const h = toGlassesHistory(turns, 3);
  // The raw tool-result dump must never reach the glasses.
  assert.ok(!h.some((e) => e.role === "tool"));
  assert.ok(!h.some((e) => e.text.includes("CODEBASE.md")));
  const firstAssistant = h.find((e) => e.role === "assistant")!;
  // Prose leads, tool-call summary folds beneath it.
  assert.ok(firstAssistant.text.startsWith("ok"));
  assert.ok(firstAssistant.text.includes("> Bash: run tests"));
});
