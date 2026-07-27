import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapAnswer } from "../src/even/provider.ts";

// The Even App answers a question by POSTing a JSON object keyed by the question
// text with the picked option label as the value (verified live 2026-07-27):
//   {"Deploy the lightest changes now?":"Yes, deploy"}
// unwrapAnswer must extract the label so matchAnswer sees "Yes, deploy", not the
// whole blob (which only matched by luck via substring).
test("unwrapAnswer extracts the label from the App's JSON answer object", () => {
  assert.equal(
    unwrapAnswer('{"Deploy the lightest changes now?":"Yes, deploy"}'),
    "Yes, deploy",
  );
});

test("unwrapAnswer joins multiple values (multi-select array or several keys)", () => {
  assert.equal(unwrapAnswer('{"q":["Python","Go"]}'), "Python Go");
  assert.equal(unwrapAnswer('{"q1":"Python","q2":"Go"}'), "Python Go");
  assert.equal(unwrapAnswer('["Python","Go"]'), "Python Go");
});

test("unwrapAnswer returns a bare dictation string unchanged", () => {
  assert.equal(unwrapAnswer("option one"), "option one");
  assert.equal(unwrapAnswer("1"), "1");
  assert.equal(unwrapAnswer("  Yes, deploy  "), "  Yes, deploy  ");
});

test("unwrapAnswer falls back to raw text on malformed or empty JSON", () => {
  assert.equal(unwrapAnswer('{"q":'), '{"q":'); // truncated
  assert.equal(unwrapAnswer("{}"), "{}"); // no string values
  assert.equal(unwrapAnswer('{"q":42}'), '{"q":42}'); // non-string value
});
