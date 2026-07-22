# even-terminal SSE frame contract

The Even G2 firmware (Terminal Mode) speaks a **fixed, small** set of SSE frame
types over `GET /api/events`. It **silently drops any frame type it does not
recognize** — no error, no log, the frame just never renders. Every rule below
was verified live against `@evenrealities/even-terminal@0.8.1`
(`dist/claude/session.js` is the authoritative contract; inspect it before
inventing a frame type).

The bridge tails **completed** `jsonl` transcripts — there is no live token
stream — so it ships each whole answer as a single burst, unlike the reference
SDK which streams many small deltas.

## Frame types the firmware understands

| type | shape | purpose |
|------|-------|---------|
| `status` | `{ type:"status", state, sessionId }` | lifecycle: `busy`, `idle`, `think_start`, `think_end`, `text_start`, `text_end` |
| `text_delta` | `{ type:"text_delta", text }` | a chunk of assistant text (bare — no `ts`, no icon) |
| `result` | `{ type:"result", success, text, provider, sessionId, costUsd, turns, durationMs, inputTokens, outputTokens }` | finalizes a turn and **commits** the persisted answer |
| `user_prompt` | `{ type:"user_prompt", text, ts? }` | echoes the wearer's own input |
| `tool_start` / `tool_end` | tool activity | (not currently emitted — see below) |
| `info` | `{ type:"info", model }` | model banner |

There is **no `agent_message` frame type.** Assistant text renders *only* as a
`text_delta` stream bracketed by `status:text_start` / `status:text_end`. An
earlier version of this bridge emitted `agent_message` — the frame reached the
ring wearing a type the firmware ignores, so the answer never painted.

## The paint-and-persist sequence

Emitting assistant text correctly requires **four** things in order. Getting any
one wrong produces a distinct, confusing failure:

```
status:text_start  (sessionId REQUIRED)
text_delta         (the whole answer, bare)
status:text_end    (sessionId REQUIRED)
result             (sessionId + text REQUIRED)  ← commits the message
status:idle
```

Why each part matters:

1. **`sessionId` on the `status` frames.** The glasses key the render buffer off
   the `sessionId` carried on the status frames. A `text_start` *without* it never
   arms text rendering, so the body stays blank even though the delta arrives.
2. **The `text_delta` must be bare.** No `ts`, no icon prefix. A stray field
   between `busy` and the answer's `text_start` corrupted the render buffer so the
   body never painted. (Root cause of the original "status and prompt render, body
   is blank" bug: stray `tool_call` + `ts` + icon fields.)
3. **The finalizing `result` frame.** The firmware treats the streamed
   `text_delta` as a **transient live preview**. The persisted, on-screen answer
   is committed from `result.text`. Emit the delta triad *without* a following
   `result` and the answer flashes, then clears on `idle` — status and prompt
   still render, the answer goes blank. Order on the wire is `text_end → result →
   idle`. Stats are unknown for a tailed turn and ship as zero (shape over
   accuracy — the firmware only needs the frame to exist).

See `emitText()` in `src/server/events.ts`.

## Do not emit `tool_result`

gsd-native `jsonl` logs an assistant turn as `content: [toolCall, text]` and
flushes the matching `toolResult` on a **separate line after it**, so a
`toolResult` always trails its own answer. The glasses render **latest-frame-
wins**, so emitting `tool_result` *buries* the answer that just painted. Two
consequences the bridge deliberately avoids:

- **Do not emit `tool_result` / `tool_call`.** They overwrite the answer.
- **Do not derive status from the trailing line.** It would falsely re-flip a
  finished turn back to `busy`. Derive status from the *last assistant message*
  in the chunk instead.

Tool activity is therefore intentionally **not** surfaced. If per-tool progress
is wanted later, emit the firmware-known `tool_start` / `tool_end` frames — never
the `tool_call` / `tool_result` pair.

## Lens glyph limits (576×288, monochrome BMP font)

The lens font renders **monochrome BMP glyphs only**. Color emoji and dingbats
render as a tofu box. Verified sets:

| category | safe | dead |
|----------|------|------|
| arrows | `→` `▶` `»` `->` `=>` `>>` | — |
| bullets | `•` `●` `○` `*` `-` | `◦` |
| boxes | `▫` `■` `□` | `▪` `█` `░` |
| stars | `★` `☆` | — |
| lines | `─` `├` `←` `↑` `↓` | `│` `↳` |
| brackets | `[x]` `[v]` | — |
| checks | — | `✓` `✗` `✔` `✘` (all dingbats tofu) |
| emoji | — | all color emoji tofu |

**Size gotcha:** a glyph can render and still be unreadable. `▸` (U+25B8, small
triangle) paints but is too tiny to read as a marker at lens size — use `▶`
(U+25B6, full-size). Prefer full-size variants for any marker the wearer must
notice. The next-steps menu decoration uses `─` (rule) and `▶` (option prefix).

## SSE ring, replay, and the dark window

The glasses **drop the SSE connection every ~30 s** and are frequently dark
exactly when a tailed answer lands. The event ring handles this:

- Every session has a 500-entry ring buffer (`id` + frame).
- `broadcast` marks `lastDeliveredId` only when a live client survives the write,
  so a frame broadcast into an empty client set is **not** counted as delivered.
- On reconnect the replay cursor is chosen in priority order:
  1. `Last-Event-ID` (standard `EventSource` auto-reconnect cursor),
  2. `needReplay=true` (explicit full-history load — replay the whole ring),
  3. `lastDeliveredId` (the dark-window gap — replay everything the glasses
     missed while disconnected).

Without rule 3, an answer that broadcast while the glasses were dark would be
lost forever. A content frame (`text_delta` / `result`) dropped with no live
client is logged as a warning, not silently swallowed.

> **Operational note:** a restart wipes the ring (`nextId=1`). Do not restart the
> bridge mid-capture — ask a *fresh* question after a restart, or the replay
> cursor and the glasses disagree about ids.
