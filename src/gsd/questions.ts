/**
 * ANSWER-mode: glasses have voice→text only, so every gsd interactive question
 * must collapse to "say a number". gsd flushes NO jsonl while a picker is open
 * (verified live 2026-07-22), so questions are detected by scraping the tmux
 * pane, not the transcript.
 *
 * Mechanic (both locked live 2026-07-22):
 *   single-select — the interview UI binds DIGIT shortcuts: typing `2` jumps to
 *     option 2 and auto-advances to a "Review your answers" screen; a following
 *     Enter submits. Answer = `send-keys <n>` then `send-keys Enter`.
 *   multi-select — digits are INERT; options are checkboxes toggled by Space.
 *     Answer = walk down to each target (Down×k) + Space to toggle, then Enter
 *     (advance to review) + Enter (submit). See the responder in provider.ts.
 *
 * Native permission dialogs are not handled here: gsd auto-mode self-governs
 * safety at the agent layer, so the raw SDK elicitation dialog never fires in
 * practice (verified live). respondPermission covers the raw-select model.
 */

export interface PendingQuestion {
  /** Box title, e.g. "Fruit" (may be empty if not rendered). */
  header: string;
  /** Question text, e.g. "Pick a fruit". */
  prompt: string;
  /** Option labels in on-screen order; index+1 is the digit to send. */
  options: string[];
  /** True for a checkbox (Select-all) picker; false for single-select. */
  multi: boolean;
  /** Stable string identity so a redraw of the same question is not re-emitted. */
  signature: string;
}

const pending = new Map<string, PendingQuestion>();

export function getPending(sessionId: string): PendingQuestion | undefined {
  return pending.get(sessionId);
}
export function setPending(sessionId: string, q: PendingQuestion): void {
  pending.set(sessionId, q);
}
export function clearPending(sessionId: string): void {
  pending.delete(sessionId);
}

// After a selection is sent, the picker stays painted on the tmux pane for a
// beat (send-keys lag + the TUI's own redraw before it advances). The 500ms
// tailer re-scrapes that stale pane, sees the same picker, and — since the
// answered question was already cleared from `pending` — re-arms it, so the
// App answers the same question again and again (observed live: one "Option 1"
// looped ~15 selects). We record the just-answered signature here; detectQuestion
// refuses to re-arm it until the pane changes to a genuinely different question
// or the picker clears. Cleared on pane-clear so the SAME question asked again
// later still arms.
const answered = new Map<string, string>();

export function markAnswered(sessionId: string, signature: string): void {
  answered.set(sessionId, signature);
}
export function wasAnswered(sessionId: string, signature: string): boolean {
  return answered.get(sessionId) === signature;
}
export function clearAnswered(sessionId: string): void {
  answered.delete(sessionId);
}

// A gsd answer often ends in a trailing next-steps menu ("Ďalej?" / "Next
// steps:" then a numbered list). That list is plain answer TEXT, not an open
// picker, so a bare-number reply would otherwise be forwarded verbatim and the
// model would re-read its own list and re-decide non-deterministically (it
// picked the wrong item live 2026-07-22). The tailer caches the parsed options
// here so provider.prompt can expand "2" → "2. <label>" before forwarding,
// making the choice deterministic. One-shot: cleared on the next prompt.
const lastMenu = new Map<string, string[]>();

export function getLastMenu(sessionId: string): string[] | undefined {
  return lastMenu.get(sessionId);
}
export function setLastMenu(sessionId: string, options: string[]): void {
  lastMenu.set(sessionId, options);
}
export function clearLastMenu(sessionId: string): void {
  lastMenu.delete(sessionId);
}

/**
 * Parse a captured pane into a pending question (single- or multi-select), or
 * null if no picker is open. Discriminator: the picker footer says "esc to
 * exit" (both variants); the later "Review your answers" screen says "esc to
 * end interview" — only the former is an open question awaiting a pick.
 * Single-select renders "N. Label"; multi-select renders "[ ] Label" / "[x]
 * Label" (digits inert, Space toggles).
 */
export function parsePicker(pane: string): PendingQuestion | null {
  if (!pane.includes("esc to exit")) return null;

  const lines = pane.split("\n");
  const numbered: string[] = [];
  const checkbox: string[] = [];
  let prompt = "";
  let header = "";

  for (const line of lines) {
    // Box title from the top border: "╭─ Fruit ─...─╮". Left-side panels can
    // bleed a second "╭─" onto the same row, so take the last one.
    const cIdx = line.lastIndexOf("╭");
    if (cIdx >= 0 && !header) {
      const m = line.slice(cIdx).match(/╭─+\s*(.+?)\s*─/);
      if (m) header = m[1]!.trim();
    }

    // Isolate box interior (between first and last "│") so left/right panel
    // bleed can't be misread as content.
    const first = line.indexOf("│");
    const last = line.lastIndexOf("│");
    if (first < 0 || last <= first) continue;
    const inner = line.slice(first + 1, last).trim();
    if (!inner) continue;

    // Numbered option (single-select): optional "› " marker, then "N. Label".
    const num = inner.match(/^(?:›\s*)?(\d+)\.\s+(.+?)$/);
    if (num) {
      const n = Number(num[1]);
      if (n >= 1) numbered[n - 1] = num[2]!.trim();
      continue;
    }
    // Checkbox option (multi-select): optional "› " marker, then "[ ] Label".
    const chk = inner.match(/^(?:›\s*)?\[[ xX]\]\s+(.+?)$/);
    if (chk) {
      checkbox.push(chk[1]!.trim());
      continue;
    }
    // First non-option, non-chrome interior line is the question text. Skip the
    // multi-select subtitle "(Select all that apply)" and the "Done" action row.
    if (
      !prompt &&
      !/tab to add notes|enter to|esc to|space to toggle|Select to type/.test(inner) &&
      !/^\(Select all that apply\)$/.test(inner) &&
      inner !== "Done"
    ) {
      prompt = inner;
    }
  }

  const multi = checkbox.length > 0;
  const options = (multi ? checkbox : numbered).filter((o) => typeof o === "string" && o.length > 0);
  if (options.length === 0) return null;
  return {
    header,
    prompt,
    options,
    multi,
    signature: `${multi ? "m" : "s"}|${header}|${prompt}|${options.join("|")}`,
  };
}

/** Render the menu shown on the glasses. Short — 576×288 has little room. */
export function renderMenu(q: PendingQuestion): string {
  const head = q.prompt || q.header || "Question";
  const body = q.options.map((o, i) => `${i + 1}) ${o}`).join("\n");
  const hint = q.multi ? "Say the numbers you want." : "Say a number.";
  return `❓ ${head}\n${body}\n${hint}`;
}

const NUM_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

/**
 * Map a spoken utterance to a 1-based option index, or null if nothing matches.
 * Order: bare digit → leading number word → exact label → label substring.
 * Fuzzy matching is best-effort; the caller re-prompts on null.
 */
export function matchAnswer(options: string[], utterance: string): number | null {
  const u = utterance.trim().toLowerCase();
  if (!u) return null;

  if (/^\d+$/.test(u)) {
    const n = Number(u);
    return n >= 1 && n <= options.length ? n : null;
  }

  // Dictation rarely gives a bare number — it wraps it ("option one", "number
  // two", "the third one", "choice 2"). Scan every word for the first digit or
  // number-word, not just the leading token, and take that as the index.
  for (const w of u.split(/\s+/)) {
    if (/^\d+$/.test(w)) {
      const n = Number(w);
      if (n >= 1 && n <= options.length) return n;
    }
    if (NUM_WORDS[w] && NUM_WORDS[w]! <= options.length) return NUM_WORDS[w]!;
  }

  const labels = options.map((o) => o.toLowerCase());
  const exact = labels.indexOf(u);
  if (exact >= 0) return exact + 1;

  for (let i = 0; i < labels.length; i++) {
    if (labels[i]!.includes(u) || u.includes(labels[i]!)) return i + 1;
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Map a spoken utterance to a SET of 1-based indices for a multi-select picker.
 * Collects every signal: whole-label matches (word-boundary, so "Go" ≠
 * "google"), bare digits, and number words. Returns a sorted unique list;
 * empty means nothing matched and the caller re-prompts. e.g. "python and go"
 * or "1 and 3" or "one three" → [1, 3].
 */
export function matchMulti(options: string[], utterance: string): number[] {
  const u = utterance.trim().toLowerCase();
  if (!u) return [];
  const picks = new Set<number>();

  options.forEach((o, i) => {
    const label = o.toLowerCase();
    if (label && new RegExp(`\\b${escapeRegex(label)}\\b`).test(u)) picks.add(i + 1);
  });
  for (const m of u.matchAll(/\d+/g)) {
    const n = Number(m[0]);
    if (n >= 1 && n <= options.length) picks.add(n);
  }
  for (const token of u.split(/[\s,]+/)) {
    const n = NUM_WORDS[token];
    if (n && n <= options.length) picks.add(n);
  }
  return [...picks].sort((a, b) => a - b);
}
