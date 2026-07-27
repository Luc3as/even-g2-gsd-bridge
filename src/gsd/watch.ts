import { statSync, openSync, readSync, closeSync } from "node:fs";
import type { Config } from "../config.js";
import { emit, emitText, sessionHasClients, consumeEcho } from "../server/events.js";
import { parseLine, blocksToText, deriveStatusFromEntries } from "./jsonl.js";
import { listProjects, type Project } from "./sessions.js";
import { capturePane } from "./tmux.js";
import { parsePicker, getPending, setPending, clearPending, renderMenu, setLastMenu, clearLastMenu } from "./questions.js";
import { readProgress, formatProgressRich, progressSignature } from "./progress.js";
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

// Last progress signature pushed per session, so the live GSD-progress line is
// emitted only when slice/task counts actually advance — not every tick.
const lastProgress = new Map<string, string>();

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

// gsd answers commonly end with a short "next-steps" menu the wearer can reply
// to with a number. The model phrases the lead-in freely ("Ďalej?", "Otvorené
// nite, tvoj výber:", …), so detection is STRUCTURAL, not keyword-only: a
// trailing block of ≥2 numbered options qualifies as a menu when ANY of these
// hold — a bare next-steps keyword sits directly above it, one option is an
// "Iné"/"Other" escape hatch, or a short question line ("Čo?") trails it. A
// plain numbered fact-list (moon facts) has none of these, so it is left alone.
// On the 576x288 lens the menu blends into the answer body, so we insert a rule
// line above the lead-in and prefix each option with `▶`. `─` and `▶` are
// geometric BMP glyphs proven to render on the glasses (color emoji and
// dingbats tofu-box, see KNOWLEDGE).
const NEXT_STEPS_HEADER = /^(ďalej|ďalšie|next steps?|next|možnosti|options)\b[?:]?$/i;
const OPTION_LINE = /^(\s*)(\d+)([.)])\s+(.+)$/;
const TRAILER_Q = /^.{1,40}\?$/;
// `\b` is unreliable after the non-ASCII "é" (JS \w is ASCII-only), so anchor
// the escape-hatch keyword with an explicit end/delimiter class instead.
const OTHER_OPTION = /^\*{0,2}(iné|other|else)($|[\s—-])/i;

interface Menu {
  /** Line indices of the contiguous trailing numbered block. */
  block: number[];
  /** Line the `─────` rule is inserted above (lead-in, or first option). */
  leadInIdx: number;
  /** Option labels, index 0 = option 1. */
  options: string[];
}

function detectMenu(lines: string[]): Menu | null {
  const optIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) if (OPTION_LINE.test(lines[i]!)) optIdx.push(i);
  if (optIdx.length < 2) return null;
  // Take the trailing CONTIGUOUS run of numbered lines (a menu is a solid block;
  // scattered "1." lines across body prose are not).
  let s = optIdx.length - 1;
  while (s > 0 && optIdx[s - 1] === optIdx[s]! - 1) s--;
  const block = optIdx.slice(s);
  if (block.length < 2) return null;
  const first = block[0]!;
  const last = block[block.length - 1]!;

  // Lead-in = nearest non-blank line above the block (header/intro).
  let lead = first - 1;
  while (lead >= 0 && lines[lead]!.trim() === "") lead--;
  const headerQual = lead >= 0 && NEXT_STEPS_HEADER.test(lines[lead]!.trim());

  // Nearest non-blank line below the block = a possible trailing question.
  let after = last + 1;
  while (after < lines.length && lines[after]!.trim() === "") after++;
  const trailerQual = after < lines.length && TRAILER_Q.test(lines[after]!.trim());

  const options: string[] = [];
  let otherQual = false;
  for (const i of block) {
    const m = lines[i]!.match(OPTION_LINE);
    if (!m) continue;
    const label = m[4]!.trim();
    options[Number(m[2]) - 1] = label;
    if (OTHER_OPTION.test(label)) otherQual = true;
  }
  if (!headerQual && !trailerQual && !otherQual) return null;

  return {
    block,
    leadInIdx: lead >= 0 ? lead : first,
    options: options.filter((o) => typeof o === "string" && o.length > 0),
  };
}

export function markNextSteps(text: string): string {
  const lines = text.split("\n");
  const menu = detectMenu(lines);
  if (!menu) return text;
  // Prefix each option first, then splice the rule in above the lead-in (splice
  // shifts indices, so it must come after the block edits).
  for (const i of menu.block) {
    const m = lines[i]!.match(OPTION_LINE);
    if (m) lines[i] = `${m[1]}▶ ${m[2]}${m[3]} ${m[4]}`;
  }
  lines.splice(menu.leadInIdx, 0, "─────");
  return lines.join("\n");
}

// Extract the numbered options of a trailing next-steps menu, or [] if none, so
// a bare-number lens reply can be expanded to its full label. Same structural
// detection as markNextSteps.
export function nextStepsOptions(text: string): string[] {
  const menu = detectMenu(text.split("\n"));
  return menu ? menu.options : [];
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
    if (sessionHasClients(p.sessionId)) {
      detectQuestion(p);
      detectProgress(p);
    }
  }
}

/**
 * Push a live GSD auto-mode progress line to the lens when the milestone's
 * slice/task counts advance. Read-only DB read (see progress.ts); silent when
 * the project has no active milestone. Deduped on the count signature so a
 * stalled milestone doesn't repaint every tick. Only called with clients
 * attached, so a disconnected session accrues no state.
 */
function detectProgress(p: Project): void {
  const prog = readProgress(p.cwd);
  if (!prog) {
    lastProgress.delete(p.sessionId);
    return;
  }
  const sig = progressSignature(prog);
  if (lastProgress.get(p.sessionId) === sig) return;
  lastProgress.set(p.sessionId, sig);
  emitText(p.sessionId, formatProgressRich(prog));
  log.info("watch", `progress → ${p.sessionId} (${sig})`);
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
