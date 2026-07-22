import type { Turn } from "../gsd/jsonl.js";

/**
 * Display shrink for the G2 canvas (576x288 ≈ a few short lines). The Even App
 * renders the text we hand it, so the job here is ruthless compression: collapse
 * whitespace, drop noise, hard-truncate, and put the actionable thing first.
 */

const MAX_LINE = 90;
const MAX_TURN_CHARS = 280;

export function shrink(text: string, maxChars = MAX_TURN_CHARS): string {
  const collapsed = text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0)
    .map((l) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE - 1) + "…" : l))
    .join("\n");
  return collapsed.length > maxChars ? collapsed.slice(0, maxChars - 1) + "…" : collapsed;
}

/** Normalized history for the glasses: {role, text}, newest-relevant, shrunk. */
export function toGlassesHistory(turns: Turn[], limit: number): Array<{ role: string; text: string }> {
  const out: Array<{ role: string; text: string }> = [];
  for (const t of turns) {
    let text = t.text;
    if (t.role === "assistant" && t.tools.length) {
      const toolLines = t.tools.map((x) => `> ${x}`).join("\n");
      text = text ? `${toolLines}\n${text}` : toolLines;
    }
    if (!text.trim()) continue;
    out.push({ role: t.role, text: shrink(text) });
  }
  return out.slice(-limit);
}
