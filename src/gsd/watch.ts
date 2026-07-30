import { statSync, openSync, readSync, closeSync } from "node:fs";
import type { Config } from "../config.js";
import { emit, emitText, emitQuestion, sessionHasClients, consumeEcho } from "../server/events.js";
import { parseLine, blocksToText, deriveStatusFromEntries } from "./jsonl.js";
import { listProjects, type Project } from "./sessions.js";
import { capturePane } from "./tmux.js";
import { parsePicker, getPending, setPending, clearPending, renderMenu, setLastMenu, clearLastMenu, wasAnswered, clearAnswered } from "./questions.js";
import { readAutoState, latestSeriousNotification, classifyDisplayState, hasBlocker, type AutoLiveness, type DisplayState } from "./auto.js";
import { readProgress, progressSignature } from "./progress.js";
import { buildStatusCard } from "./status.js";
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

// Per-session alarm dedup so a crash/stop, pause, or failure notification fires
// ONCE, not every tick. `disp` remembers the last-seen wearer-facing state so we
// alarm only on the EDGE into stopped/paused (a dead lock or a lingering blocker
// would re-alarm forever on a level check). `notifId` remembers the last serious
// notification pushed so a new failure (different id) alarms while the same one
// stays quiet — gsd leaves `read:false` even on consumed entries, so id-dedup is
// the only reliable gate.
interface AlarmState {
  disp: DisplayState;
  notifId: string | null;
}
const lastAlarm = new Map<string, AlarmState>();

// Ambient dashboard repaint state, mirroring `lastAlarm`. Per session we remember
// the last pushed change signature (progressSignature+disp — both deliberately
// exclude the live elapsed ticker and cost drift) and when we last pushed, so an
// unchanged tick repaints nothing and the min-interval floor bounds stacking on
// the append-only lens.
interface AmbientState {
  sig: string;
  lastPushAt: number;
}
const ambient = new Map<string, AmbientState>();

// Stacking backstop for the append-only lens: even if the change signature
// legitimately churns (e.g. task after task completing fast), never repaint the
// ambient dashboard more than ~2×/min. Debounce is on the signature; this floors
// the cadence so a burst of real advances still yields at most a few cards/unit.
const AMBIENT_MIN_INTERVAL_MS = 30_000;

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

    // Auto-mode failure alarm FIRST, before the tail's first-sight/rotation
    // `continue` below — else a bridge start (or a per-turn file rotation, which
    // gsd-native does constantly) would skip the alarm exactly on the tick a crash
    // becomes visible. Runs for EVERY project, client attached or not: a crash
    // while the glasses are dark must still hit the ring so a reconnect surfaces
    // it (emit no-ops the live broadcast but always fills the ring).
    const { liveness: autoLiveness, disp, alarmed } = detectAutoAlarm(p);

    // Ambient dashboard repaint (S01): during an AUTO run only (the inverse of
    // the firehose gate below — interactive turns stream their transcript, auto
    // runs get this glance frame; the two never both emit text_delta on one
    // session), repaint buildStatusCard on its own when — and only when — the
    // progress signature OR the display state moves. Debounced on
    // progressSignature+disp (both exclude the live elapsed ticker and cost
    // drift, so an unchanged tick repaints nothing) plus a min-interval floor,
    // and gated on an attached client so the append-only lens never accrues a
    // burst of stacked cards while dark. Suppressed on a tick where
    // detectAutoAlarm already pushed a frame (`alarmed`) so the loud one-liner
    // is not shadowed by a stacked full frame. The stored signature advances
    // even when we don't push (dark, throttled, or alarm-suppressed), so a later
    // attach+change pushes exactly once, not a replayed burst. Baseline is
    // adopted silently on first sight (mirrors detectAutoAlarm's `!prev`) so a
    // bridge restart doesn't repaint every auto project on tick 1. Defensively
    // wrapped (R009) so an ambient throw can't break the alarm/status/tail path.
    if (autoLiveness !== "none") {
      try {
        const prog = readProgress(p.cwd);
        const sig = `${prog ? progressSignature(prog) : "-"}|${disp}`;
        const prevAmbient = ambient.get(p.sessionId);
        if (!prevAmbient) {
          ambient.set(p.sessionId, { sig, lastPushAt: 0 });
        } else if (sig !== prevAmbient.sig) {
          const canPush =
            !alarmed &&
            sessionHasClients(p.sessionId) &&
            now - prevAmbient.lastPushAt >= AMBIENT_MIN_INTERVAL_MS;
          if (canPush) {
            emitText(p.sessionId, buildStatusCard(p.cwd, p.name));
            ambient.set(p.sessionId, { sig, lastPushAt: now });
          } else {
            // Track the advance without pushing; keep lastPushAt so the
            // min-interval floor still applies to the eventual push.
            ambient.set(p.sessionId, { sig, lastPushAt: prevAmbient.lastPushAt });
          }
        }
      } catch (err) {
        log.error("watch", `ambient repaint failed ${p.sessionId}`, err);
      }
    }

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
    let complete: string[] = [];
    if (chunk.data) {
      // split's final element is never a complete line: it's the empty string
      // when data ends in "\n", or a partial line when it doesn't. Dropping it
      // in both cases keeps `consumed` byte-exact — counting the trailing "" as
      // +1 drifted the offset one byte per read, corrupting the next line's
      // parse so its entry (often an answer) was silently dropped.
      complete = chunk.data.split("\n").slice(0, -1);
      let consumed = 0;
      // Transcript-stream gate: only mirror an *interactive* gsd session's turns
      // to the lens. During an auto-run (running/quiet/stopped) the firehose of
      // coding turns buries the pull-based status card and paints as clipped raw
      // lines — the "cut lines, first few words only" the wearer reported. So
      // suppress it: the wearer pulls buildStatusCard on demand and gets one-shot
      // transition alarms from detectAutoAlarm. Offset still advances so the tail
      // stays byte-exact, and chunkVerdict below still resolves busy/idle status.
      const streamTranscript = autoLiveness === "none";
      for (const line of complete) {
        if (streamTranscript) emitEntry(p.sessionId, line);
        consumed += Buffer.byteLength(line, "utf8") + 1;
      }
      t.offset += consumed;
    }

    // Status resolution. Two signals, chunk-verdict wins when decisive:
    //  1. Chunk verdict — the last assistant message in bytes read THIS tick.
    //     Authoritative because it can see a *finished* answer (last entry is
    //     assistant text → idle) and flip idle early, before the busy window
    //     lapses. Decided off the last assistant, not a trailing toolResult (gsd
    //     logs the result AFTER the answer, which would wrongly re-flip to busy).
    //  2. Freshness — newest transcript across ALL of this project's stores
    //     (gsd-native rotates a file per turn while the Claude-Code run streams
    //     continuously) written within the busy window. This is the honest "run
    //     is live" fallback for when this tick read no decisive chunk: the growth
    //     may have landed on a sibling file we aren't tailing, so a chunk-only
    //     gate would never assert busy and the elapsed ticker would stay closed.
    //     A real >busyWindow stall (nothing written anywhere) still resolves idle
    //     and stops the ticker — no faked motion.
    // A pending picker means the turn is blocked on the wearer → force idle (a
    // false busy over a question is why the wearer holds the ring, killing it).
    // The jsonl derivers are typed Status but provably yield only busy|idle (a
    // transcript never encodes a pending picker); narrow here since the tailer's
    // SSE status frame is busy|idle only — "awaiting" is served solely from
    // statusFor via /api/sessions, never streamed.
    const chunkVerdict = complete.length
      ? (deriveStatusFromEntries(complete) as "busy" | "idle" | null)
      : null;
    const fresh = now - p.mtimeMs <= cfg.busyWindowMs;
    let want: "busy" | "idle" = chunkVerdict ?? (fresh ? "busy" : "idle");
    // Wearer-facing display state overrides the freshness/chunk verdict for the
    // input gate. STOPPED (dead lock, OR credit-death: quiet past the stall
    // ceiling with a still-alive TUI pid) and PAUSED (blocker) both force idle so
    // the glasses release the input gate — a lingering "busy" over a dead/blocked
    // run is the "Thinking forever" lie the wearer reported. A "quiet" run still
    // UNDER the ceiling (disp=running) is genuinely mid-unit work even when the
    // transcript has gone silent past the busyWindow, so force busy. A fresh
    // "running" heartbeat and "idle"/none defer to the freshness/chunk verdict, so
    // a finished-answer chunk can still flip idle early.
    if (disp === "stopped" || disp === "paused") want = "idle";
    else if (autoLiveness === "quiet") want = "busy";
    if (getPending(p.sessionId)) want = "idle";
    if (want !== t.status) {
      t.status = want;
      emit(p.sessionId, { type: "status", state: want, sessionId: p.sessionId });
    }

    // ANSWER-mode: a gsd picker leaves no jsonl trace, so scrape the live pane.
    // Only meaningful when glasses are attached to answer it. Unsolicited progress
    // pushing was removed (it stacked stale frames and faked motion); the wearer
    // pulls the dashboard on demand (buildStatusCard) and gets one-shot transition
    // alarms from detectAutoAlarm instead.
    if (sessionHasClients(p.sessionId)) {
      detectQuestion(p);
    }
  }
}

/**
 * Surface a stopped/paused/failed auto-run to the glasses as a loud one-line
 * alarm, and return the wearer-facing state the tailer uses to gate input. The
 * jsonl tailer alone can't do this: a crash just stops writes, so status lapses
 * to idle — indistinguishable from a clean finish, which is why the wearer misses
 * failures. Reads gsd's liveness (auto.lock pid + DB heartbeat), the pause signal
 * (current-state STATE.md blocker), and the failure channel (notifications.jsonl),
 * classifies a DisplayState, and pushes on three deduped edges — each fires once:
 *   1. Into STOPPED — a crash/clean death (pid gone), OR credit-death (quiet past
 *      the stall ceiling with the TUI pid still alive). Edge-only: a dead run
 *      lingers, so a level check would re-alarm every tick.
 *   2. Into PAUSED — a blocker appeared while a worker is present.
 *   3. New serious notification — an error/pause/cap warning with an id we haven't
 *      pushed yet (gsd never flips `read`, so id is the gate), when no edge above
 *      already covered it this tick.
 * The idle/busy status frame that gates the glasses' input is emitted by the
 * tailer's status resolution off the returned `disp` — one authority for it.
 */
function detectAutoAlarm(p: Project): { liveness: AutoLiveness; disp: DisplayState; alarmed: boolean } {
  const auto = readAutoState(p.cwd);
  const notif = latestSeriousNotification(p.cwd);
  // Pause is a LEVEL signal from current-state STATE.md (a blocker), not the
  // never-cleared notif log — so a resolved pause can't wedge the state forever.
  const disp = classifyDisplayState(auto, hasBlocker(p.cwd));
  const prev = lastAlarm.get(p.sessionId);

  // First sight of this project: adopt current state as baseline WITHOUT alarming,
  // so a bridge restart doesn't re-fire every historical stop/pause/failure. Only
  // transitions observed live from here on alarm.
  if (!prev) {
    lastAlarm.set(p.sessionId, { disp, notifId: notif?.id ?? null });
    return { liveness: auto.liveness, disp, alarmed: false };
  }

  let alarmed = false;
  let notifId = prev.notifId;
  const unit = auto.unitId ? ` ${auto.unitId}` : "";
  const reason = () => (notif && notif.id !== prev.notifId ? ` — ${clip(notif.message, 60)}` : "");

  if (disp === "stopped" && prev.disp !== "stopped") {
    emitText(p.sessionId, `⚠ AUTO-STOPPED${unit}${reason()}`);
    log.warn("watch", `auto-stopped alarm → ${p.sessionId} (unit=${auto.unitId ?? "-"} pid=${auto.pid ?? "-"})`);
    alarmed = true;
    notifId = notif?.id ?? prev.notifId; // fold notif in so the branch below can't double-fire it
  }

  if (!alarmed && disp === "paused" && prev.disp !== "paused") {
    emitText(p.sessionId, `⏸ AUTO-PAUSED${unit}${reason()}`);
    log.warn("watch", `auto-paused alarm → ${p.sessionId} (unit=${auto.unitId ?? "-"})`);
    alarmed = true;
    notifId = notif?.id ?? prev.notifId;
  }

  if (!alarmed && notif && notif.id !== prev.notifId) {
    const tag = notif.severity === "error" ? "⚠ ERROR" : "⚠";
    emitText(p.sessionId, `${tag}: ${clip(notif.message, 72)}`);
    log.warn("watch", `notif alarm → ${p.sessionId} (${notif.severity} ${notif.id})`);
    notifId = notif.id;
    alarmed = true; // a frame was pushed this tick → suppress the ambient repaint below
  }

  lastAlarm.set(p.sessionId, { disp, notifId });
  return { liveness: auto.liveness, disp, alarmed };
}

/** Trim a message to one lens line, collapsing whitespace/newlines. */
function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
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
        // A just-answered picker lingers on the pane for a beat after the digit
        // is sent; without this guard the tailer re-arms it (pending was cleared
        // on the match) and the App answers the same question repeatedly. Skip
        // re-arming a signature we already answered — it clears when the pane
        // moves on to a different picker or empties (else branch below).
        if (wasAnswered(p.sessionId, q.signature)) return;
        if (!had || had.signature !== q.signature) {
          setPending(p.sessionId, q);
          // Silence the progress ticker locally (it gates on t.status==="busy")
          // so it stops re-pushing "working" over the question. Do NOT emit a
          // `state:idle` SSE frame here — that told the App the turn was done and
          // was the reason every answer became a "quit waiting?" interrupt. The
          // App now reads "awaiting" from statusFor via its /api/sessions poll,
          // which is what actually arms its native question mode.
          const t = tails.get(p.sessionId);
          if (t) t.status = "idle";
          // Render the option text (proven to paint on the 576×288 lens), then
          // send the `user_question` frame as the NOTIFY that mirrors the
          // reference bridge. The arming happens server-side via statusFor's
          // "awaiting"; this frame carries the structured options for the App's
          // native question card.
          emitText(p.sessionId, renderMenu(q));
          emitQuestion(p.sessionId, q.prompt || q.header || "Question", q.options);
          log.info("watch", `question detected ${p.sessionId} (${q.options.length} options)`);
        }
      } else {
        // Pane no longer shows a picker: the turn moved on. Clear both the
        // pending question and the answered-signature guard so the same question
        // asked again later re-arms cleanly.
        if (had) clearPending(p.sessionId);
        clearAnswered(p.sessionId);
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
