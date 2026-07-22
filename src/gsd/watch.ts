import { statSync, openSync, readSync, closeSync } from "node:fs";
import type { Config } from "../config.js";
import { emit, emitText, sessionHasClients, consumeEcho } from "../server/events.js";
import { parseLine, blocksToText, deriveStatusFromEntries } from "./jsonl.js";
import { listProjects, type Project } from "./sessions.js";
import { capturePane } from "./tmux.js";
import { parsePicker, getPending, setPending, clearPending, renderMenu, setLastMenu, clearLastMenu } from "./questions.js";
import { log } from "../log.js";

/**
 * Poll-based tailer. fs.watch is unreliable across network/overlay FS, so we
 * poll: every tick, for each project that currently has an SSE client, read new
 * bytes from its newest transcript, normalize appended entries into
 * even-messages, and emit them. Byte offsets are tracked per sessionId so a
 * newly-attached client gets a full replay from the ring, then live deltas.
 */

interface TailState {
  file: string;
  offset: number;
  status: "busy" | "idle";
}

const tails = new Map<string, TailState>();

function readFrom(path: string, offset: number): { data: string; newOffset: number } {
  const st = statSync(path);
  if (st.size <= offset) return { data: "", newOffset: st.size < offset ? st.size : offset };
  const fd = openSync(path, "r");
  try {
    const len = st.size - offset;
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, offset);
    return { data: buf.subarray(0, n).toString("utf8"), newOffset: offset + n };
  } finally {
    closeSync(fd);
  }
}

// gsd answers commonly end with a short next-steps menu ("Ďalej?" / "Next steps:"
// then a numbered list). On the 576x288 lens it blends into the answer body, so
// insert a rule line above the header to split it off, and prefix each numbered
// option with `▶` so the choices stand out from body text. Only a header line
// that is nothing but the keyword triggers it, so a genuine numbered-list answer
// is left alone. `─` and `▶` are geometric BMP glyphs proven to render on the
// glasses (color emoji and dingbats tofu-box, see KNOWLEDGE).
const NEXT_STEPS_HEADER = /^(ďalej|ďalšie|next steps?|next|možnosti|options)\b[?:]?$/i;
const OPTION_LINE = /^(\s*)(\d+[.)]\s+.+)$/;
export function markNextSteps(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 1; i--) {
    if (NEXT_STEPS_HEADER.test(lines[i]!.trim())) {
      // Prefix each numbered option below the header with the arrow glyph.
      for (let j = i + 1; j < lines.length; j++) {
        const m = lines[j]!.match(OPTION_LINE);
        if (m) lines[j] = `${m[1]}▶ ${m[2]}`;
      }
      lines.splice(i, 0, "─────");
      return lines.join("\n");
    }
  }
  return text;
}

// Extract the numbered options of a trailing next-steps menu, or [] if none.
// Same header rule as markNextSteps; collects the "N. Label" / "N) Label" lines
// that follow so a bare-number lens reply can be expanded to its full label.
export function nextStepsOptions(text: string): string[] {
  const lines = text.split("\n");
  let hi = -1;
  for (let i = lines.length - 1; i >= 1; i--) {
    if (NEXT_STEPS_HEADER.test(lines[i]!.trim())) {
      hi = i;
      break;
    }
  }
  if (hi < 0) return [];
  const opts: string[] = [];
  for (let i = hi + 1; i < lines.length; i++) {
    const m = lines[i]!.trim().match(/^(\d+)[.)]\s+(.+)$/);
    if (m) opts[Number(m[1]) - 1] = m[2]!.trim();
  }
  return opts.filter((o) => typeof o === "string" && o.length > 0);
}

function emitEntry(sessionId: string, line: string): void {
  const e = parseLine(line);
  if (!e) return;
  if (e.type === "model_change" && e.modelId) {
    emit(sessionId, { type: "info", model: String(e.modelId) });
    return;
  }
  if (e.type !== "message" || !e.message) return;
  const role = e.message.role;
  const { text, tools } = blocksToText(e.message.content);
  if (!text && tools.length === 0) return;
  if (role === "assistant") {
    // Tool activity is intentionally NOT emitted. The old `tool_call` frame is an
    // unknown type the firmware drops, and firing it between `busy` and the
    // answer's `text_start` corrupted the render buffer so the body never
    // painted. The reference bridge uses `tool_start`/`tool_end`; if per-tool
    // progress is wanted later, emit those firmware-known frames instead.
    if (text) {
      // Cache the trailing menu (if any) so a bare-number lens reply expands to
      // its full label instead of being re-decided by the model. Overwrite on a
      // fresh menu, clear when the latest answer has none.
      const opts = nextStepsOptions(text);
      if (opts.length) setLastMenu(sessionId, opts);
      else clearLastMenu(sessionId);
      emitText(sessionId, markNextSteps(text));
    }
  } else if (role === "user") {
    // A glasses-sent prompt was already echoed optimistically by provider; skip
    // the jsonl replay of that same line so the wearer doesn't see it twice.
    if (consumeEcho(sessionId, text)) return;
    // Bare text, matching the reference user_prompt (no icon prefix).
    emit(sessionId, { type: "user_prompt", text, ts: e.timestamp });
  }
}

/**
 * One tail tick. Exposed for tests. Discovers current projects, tails those
 * with clients, resets offset if the active transcript file rotated.
 */
export function tick(cfg: Config, now: number): void {
  let projects;
  try {
    projects = listProjects(cfg.sessionsDirs, cfg.projectRoots);
  } catch (err) {
    log.error("watch", "listProjects failed", err);
    return;
  }
  for (const p of projects) {
    if (!p.newestJsonl) continue;
    // Tail EVERY project, even with no SSE client attached, so the message ring
    // keeps a rolling backlog. Otherwise any jsonl written while the glasses are
    // disconnected (e.g. SSE dropped mid-turn) is skipped here AND never enters
    // the ring, so a needReplay reconnect can't surface it — the answer is lost
    // for good. emit()'s broadcast no-ops when there are no clients, so this only
    // fills the ring; it costs nothing live.
    let t = tails.get(p.sessionId);
    if (!t || t.file !== p.newestJsonl) {
      // First sight or file rotation: start at EOF so we tail forward without
      // dumping the entire pre-existing transcript into the ring.
      t = { file: p.newestJsonl, offset: statSizeSafe(p.newestJsonl), status: "idle" };
      tails.set(p.sessionId, t);
      continue;
    }
    let chunk;
    try {
      chunk = readFrom(t.file, t.offset);
    } catch (err) {
      log.error("watch", `read failed ${t.file}`, err);
      continue;
    }
    if (chunk.data) {
      const lines = chunk.data.split("\n");
      // split's final element is never a complete line: it's the empty string
      // when data ends in "\n", or a partial line when it doesn't. Dropping it
      // in both cases keeps `consumed` byte-exact — counting the trailing "" as
      // +1 drifted the offset one byte per read, corrupting the next line's
      // parse so its entry (often an answer) was silently dropped.
      const complete = lines.slice(0, -1);
      let consumed = 0;
      for (const line of complete) {
        emitEntry(p.sessionId, line);
        consumed += Buffer.byteLength(line, "utf8") + 1;
      }
      t.offset += consumed;
      // Status transition detection: decide off the last assistant message in
      // the chunk, not a trailing toolResult (which gsd logs after the answer
      // text and would wrongly re-flip a finished turn to busy).
      const st = deriveStatusFromEntries(complete);
      if (st && st !== t.status) {
        t.status = st;
        emit(p.sessionId, { type: "status", state: st, sessionId: p.sessionId });
      }
    }
    // Idle-by-silence: no writes within busy window flips busy→idle.
    if (t.status === "busy" && now - p.mtimeMs > cfg.busyWindowMs) {
      t.status = "idle";
      emit(p.sessionId, { type: "status", state: "idle", sessionId: p.sessionId });
    }

    // ANSWER-mode: a gsd picker leaves no jsonl trace, so scrape the live pane.
    // Only meaningful when glasses are attached to answer it.
    if (sessionHasClients(p.sessionId)) detectQuestion(p);
  }
}

/**
 * Fire-and-forget pane scrape for an open single-select picker. On a newly-seen
 * question, emit the numbered menu as an agent_message (stock glasses render it
 * with zero protocol changes) and store it so provider.prompt routes the next
 * utterance to a digit selection. Idempotent via the question signature.
 */
function detectQuestion(p: Project): void {
  capturePane(p.tmuxName, 40)
    .then((pane) => {
      const q = parsePicker(pane);
      const had = getPending(p.sessionId);
      if (q) {
        if (!had || had.signature !== q.signature) {
          setPending(p.sessionId, q);
          emitText(p.sessionId, renderMenu(q));
          log.info("watch", `question detected ${p.sessionId} (${q.options.length} options)`);
        }
      } else if (had) {
        clearPending(p.sessionId);
      }
    })
    .catch((err) => log.error("watch", `question detect failed ${p.sessionId}`, err));
}

function statSizeSafe(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function startWatcher(cfg: Config): () => void {
  const timer = setInterval(() => tick(cfg, Date.now()), cfg.tailIntervalMs);
  log.info("watch", `tailer started (interval=${cfg.tailIntervalMs}ms)`);
  return () => clearInterval(timer);
}
