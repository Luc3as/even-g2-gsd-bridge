import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePicker, matchAnswer, matchMulti, renderMenu } from "../src/gsd/questions.ts";

// Real capture shape (2026-07-22 live): box borders "│", left-panel bleed
// before the left border, "› " highlight marker, a client-appended
// "None of the above" (unnumbered), and the "esc to exit" footer.
const PICKER = [
  "  GSD · claude╭─ Fruit ──────────────────────────────────────────────────╮",
  " Server connect│  Pick a fruit                                            │",
  "▸ TOOL SEARCH (│   › 1. Apple                                             │ctrl+o collapse",
  "{\"type\":\"tool_r│     2. Banana                                          │",
  "▸ REQUEST USER │     3. Cherry                                            │ctrl+o collapse",
  "  Pick a fruit │     None of the above                                    │",
  "               │      Select to type your own answer.                     │",
  "               ├──────────────────────────────────────────────────────────┤",
  " ⠴ Working...  │  tab to add notes  |  enter to next  |  esc to exit      │",
  "               ╰──────────────────────────────────────────────────────────╯",
].join("\n");

// The review screen is NOT an open question — must not be detected as a picker.
const REVIEW = [
  "               ╭─ Review your answers ────────────────────────────────────╮",
  "               │   Pick a fruit                                           │",
  "               │     › Banana                                             │",
  "               │   › 0. Submit answers                                    │",
  "               ├──────────────────────────────────────────────────────────┤",
  "               │  ← to go back and edit  |  enter to submit  |  esc to end interview │",
  "               ╰──────────────────────────────────────────────────────────╯",
].join("\n");

test("parsePicker extracts header, prompt, and ordered options", () => {
  const q = parsePicker(PICKER);
  assert.ok(q, "picker should be detected");
  assert.equal(q!.header, "Fruit");
  assert.equal(q!.prompt, "Pick a fruit");
  assert.deepEqual(q!.options, ["Apple", "Banana", "Cherry"]);
});

test("parsePicker ignores the client-appended 'None of the above'", () => {
  const q = parsePicker(PICKER)!;
  assert.ok(!q.options.some((o) => /none of the above/i.test(o)));
});

// Real multi-select capture shape (2026-07-22 live): "[ ] Label" checkboxes,
// a "(Select all that apply)" subtitle, a "Done" action row, and a footer that
// adds "space to toggle". Digits are inert here; Space toggles.
const MULTI = [
  "question 'Pick ╭─ Langs ─────────────────────────────────────────────────╮",
  "╭─ GSD · claude│  Pick languages                                          │",
  " I'll ask that │   (Select all that apply)                                │",
  "▸ TOOL SEARCH (│   › [ ] Python                                           │ctrl+o collapse",
  "{\"type\":\"tool_r│     [ ] Rust                                           │",
  "▸ REQUEST USER │     [ ] Go                                               │ctrl+o collapse",
  "ask_user_questi│     [x] Zig                                              │",
  "  Pick language│     Done                                                 │",
  "               ├──────────────────────────────────────────────────────────┤",
  " ⠸ Working...  │  space to toggle  |  tab to add notes  |  enter to next  |  esc to exit │",
  "               ╰──────────────────────────────────────────────────────────╯",
].join("\n");

test("parsePicker detects a multi-select checkbox picker", () => {
  const q = parsePicker(MULTI);
  assert.ok(q, "multi picker should be detected");
  assert.equal(q!.multi, true);
  assert.equal(q!.header, "Langs");
  assert.equal(q!.prompt, "Pick languages");
  // Checkbox options in order, ignoring "(Select all that apply)" and "Done".
  assert.deepEqual(q!.options, ["Python", "Rust", "Go", "Zig"]);
});

test("parsePicker marks single-select as multi:false", () => {
  assert.equal(parsePicker(PICKER)!.multi, false);
});

test("renderMenu hint switches for multi-select", () => {
  assert.match(renderMenu(parsePicker(MULTI)!), /Say the numbers you want/);
});

test("matchMulti collects digits, number words, and labels", () => {
  const opts = ["Python", "Rust", "Go", "Zig"];
  assert.deepEqual(matchMulti(opts, "1 and 3"), [1, 3]);
  assert.deepEqual(matchMulti(opts, "python and go"), [1, 3]);
  assert.deepEqual(matchMulti(opts, "one three"), [1, 3]);
  assert.deepEqual(matchMulti(opts, "2, 4"), [2, 4]);
});

test("matchMulti label match is word-bounded and dedupes", () => {
  const opts = ["Python", "Rust", "Go", "Zig"];
  // "google" must not trip the short "Go" label.
  assert.deepEqual(matchMulti(opts, "google it"), []);
  // digit + same label collapse to one index.
  assert.deepEqual(matchMulti(opts, "3 go"), [3]);
  assert.deepEqual(matchMulti(opts, "nope"), []);
});

test("parsePicker returns null for the review screen (esc to end interview)", () => {
  assert.equal(parsePicker(REVIEW), null);
});

test("parsePicker returns null for an ordinary busy pane", () => {
  assert.equal(parsePicker("⠴ Working...\nsome agent output\nno picker here"), null);
});

test("matchAnswer maps bare digits within range", () => {
  const opts = ["Apple", "Banana", "Cherry"];
  assert.equal(matchAnswer(opts, "2"), 2);
  assert.equal(matchAnswer(opts, "4"), null); // out of range
  assert.equal(matchAnswer(opts, "0"), null);
});

test("matchAnswer maps number words", () => {
  const opts = ["Apple", "Banana", "Cherry"];
  assert.equal(matchAnswer(opts, "two"), 2);
  assert.equal(matchAnswer(opts, "third one"), 3);
});

test("matchAnswer finds a number word past the leading token", () => {
  // Dictation wraps the number ("option one", "number two", "choice 2").
  const opts = ["Apple", "Banana", "Cherry"];
  assert.equal(matchAnswer(opts, "option one"), 1);
  assert.equal(matchAnswer(opts, "number two"), 2);
  assert.equal(matchAnswer(opts, "choice 2"), 2);
  assert.equal(matchAnswer(opts, "the third one"), 3);
  assert.equal(matchAnswer(opts, "option four"), null); // out of range
});

test("matchAnswer fuzzy-matches labels", () => {
  const opts = ["Yes, you got it", "Not quite - let me clarify"];
  assert.equal(matchAnswer(opts, "yes"), 1);
  assert.equal(matchAnswer(opts, "clarify"), 2);
  assert.equal(matchAnswer(opts, "banana"), null);
});

test("renderMenu is compact and numbered", () => {
  const q = parsePicker(PICKER)!;
  const menu = renderMenu(q);
  assert.match(menu, /Pick a fruit/);
  assert.match(menu, /1\) Apple/);
  assert.match(menu, /3\) Cherry/);
  assert.match(menu, /Say a number/);
});
