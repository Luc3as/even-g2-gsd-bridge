/**
 * Parser for the gsd-native session transcript format written by @opengsd/gsd-pi
 * at ~/.gsd/agent/sessions/<project-slug>/<ts>_<uuid>.jsonl.
 *
 * Verified shape (2026-07-22, live Yummy-packing-assistant session):
 *   line 0            {type:"session", id, timestamp, cwd, version}
 *   thinking change   {type:"thinking_level_change", thinkingLevel}
 *   model change      {type:"model_change", provider, modelId}
 *   system inject      {type:"custom_message", customType, content}
 *   turn              {type:"message", message:{role, content:[...]}}
 *                       role ∈ assistant | user | toolResult
 *                       content block .type ∈ toolCall | text | thinking
 *                       toolCall = {name, arguments, externalResult:{content:[{text}]}}
 *
 * This is NOT the Claude-Code / claude-agent-sdk format, so the official
 * even-terminal claude provider's reader does not apply.
 */

export interface SessionMeta {
  id: string;
  cwd: string;
  timestamp: string;
  model?: string;
}

/** A display-normalized entry, provider-agnostic, ready for 576x288 shrink. */
export interface Turn {
  role: "assistant" | "user" | "tool" | "system";
  /** Plain-text lines already stripped of block structure. */
  text: string;
  /** Tool calls summarized as "> Tool: desc" when role === assistant. */
  tools: string[];
  timestamp?: string;
}

export type Status = "busy" | "idle";

interface RawEntry {
  type?: string;
  customType?: string;
  content?: string;
  provider?: string;
  modelId?: string;
  timestamp?: string;
  id?: string;
  cwd?: string;
  message?: { role?: string; content?: unknown };
}

export function parseLine(line: string): RawEntry | null {
  const t = line.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as RawEntry;
  } catch {
    return null;
  }
}

export function blocksToText(content: unknown): { text: string; tools: string[] } {
  const tools: string[] = [];
  if (typeof content === "string") return { text: content, tools };
  if (!Array.isArray(content)) return { text: "", tools };
  const textParts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const type = b.type;
    if (type === "text" && typeof b.text === "string" && b.text.trim()) {
      textParts.push(b.text.trim());
    } else if (type === "toolCall") {
      tools.push(summarizeToolCall(b));
    } else if (type === "thinking") {
      // thinking is intentionally dropped from the glasses view (noise on 576x288).
    }
  }
  return { text: textParts.join("\n"), tools };
}

/** One-line summary of a tool call, e.g. "Bash: Inspect e2e dir". */
export function summarizeToolCall(block: Record<string, unknown>): string {
  const name = typeof block.name === "string" ? block.name : "tool";
  const args = (block.arguments ?? {}) as Record<string, unknown>;
  const hint =
    (typeof args.description === "string" && args.description) ||
    (typeof args.command === "string" && args.command) ||
    (typeof args.file_path === "string" && args.file_path) ||
    (typeof args.path === "string" && args.path) ||
    (typeof args.pattern === "string" && args.pattern) ||
    (typeof args.prompt === "string" && args.prompt) ||
    "";
  const clipped = String(hint).replace(/\s+/g, " ").slice(0, 80);
  return clipped ? `${name}: ${clipped}` : name;
}

/** Parse a whole transcript into meta + normalized turns. */
export function parseTranscript(raw: string): { meta: SessionMeta | null; turns: Turn[] } {
  let meta: SessionMeta | null = null;
  const turns: Turn[] = [];
  for (const line of raw.split("\n")) {
    const e = parseLine(line);
    if (!e) continue;
    if (e.type === "session") {
      meta = { id: e.id ?? "", cwd: e.cwd ?? "", timestamp: e.timestamp ?? "" };
    } else if (e.type === "model_change" && e.modelId) {
      if (meta) meta.model = e.modelId;
    } else if (e.type === "message" && e.message) {
      const role = e.message.role;
      const { text, tools } = blocksToText(e.message.content);
      if (!text && tools.length === 0) continue;
      if (role === "assistant") turns.push({ role: "assistant", text, tools, timestamp: e.timestamp });
      else if (role === "user") turns.push({ role: "user", text, tools: [], timestamp: e.timestamp });
      else if (role === "toolResult") {
        // Tool results are folded into the preceding assistant turn's context;
        // surface only short ones so the glasses see command output, not dumps.
        turns.push({ role: "tool", text: text.slice(0, 200), tools: [], timestamp: e.timestamp });
      }
    }
  }
  return { meta, turns };
}

/** Single-entry status hint for the live tailer (null = not decisive). */
export function deriveStatusFromEntry(line: string): Status | null {
  const e = parseLine(line);
  if (!e || e.type !== "message" || !e.message) return null;
  const role = e.message.role;
  if (role === "toolResult" || role === "user") return "busy";
  if (role === "assistant") {
    const content = e.message.content;
    if (Array.isArray(content) && content.length) {
      const last = content[content.length - 1] as Record<string, unknown>;
      return last?.type === "toolCall" ? "busy" : "idle";
    }
    return "idle";
  }
  return null;
}

/**
 * Chunk-aware status: scan the just-appended lines newest-first and decide off
 * the last ASSISTANT message, skipping trailing toolResults. A toolResult alone
 * is ambiguous — it follows both a mid-turn tool call (busy) and a finished
 * answer whose result was logged after the text (idle). gsd writes the final
 * answer as an assistant block sequence ending in text, then flushes the
 * toolResult line; deciding off that trailing toolResult wrongly re-flips a
 * completed turn to busy and buries the answer under the "thinking" spinner.
 * Returns null when the chunk holds no decisive assistant/user entry, so the
 * caller keeps the prior status (the silence window still clears a real busy).
 */
export function deriveStatusFromEntries(lines: string[]): Status | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = parseLine(lines[i]!);
    if (!e || e.type !== "message" || !e.message) continue;
    const role = e.message.role;
    if (role === "assistant") {
      const content = e.message.content;
      if (Array.isArray(content) && content.length) {
        const last = content[content.length - 1] as Record<string, unknown>;
        return last?.type === "toolCall" ? "busy" : "idle";
      }
      return "idle";
    }
    if (role === "user") return "busy";
    // toolResult: ambiguous — keep scanning back for the deciding assistant.
  }
  return null;
}

/**
 * Derive live status from the tail of the transcript plus file mtime.
 * "busy" = the agent is mid-turn (last thing is a tool call/result or a very
 * recent assistant chunk) and the file is fresh; otherwise "idle".
 */
export function deriveStatus(raw: string, fileMtimeMs: number, busyWindowMs: number, now: number): Status {
  if (now - fileMtimeMs > busyWindowMs) return "idle";
  // Walk from the end for the last meaningful entry.
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = parseLine(lines[i]!);
    if (!e) continue;
    if (e.type === "message" && e.message) {
      const role = e.message.role;
      if (role === "toolResult") return "busy"; // waiting for the model's next step
      if (role === "user") return "busy"; // just prompted, model will respond
      if (role === "assistant") {
        // If the assistant's last block is a tool call it's still working;
        // if it's text it likely finished the turn.
        const content = e.message.content;
        if (Array.isArray(content) && content.length) {
          const last = content[content.length - 1] as Record<string, unknown>;
          return last?.type === "toolCall" ? "busy" : "idle";
        }
        return "idle";
      }
    }
    // meta/system lines: keep scanning upward
  }
  return "idle";
}
