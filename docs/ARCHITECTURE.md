# Architecture

The bridge is a thin, stateless-ish adapter between two contracts it does not
own: the **even-terminal HTTP/SSE protocol** (glasses side) and the **gsd-native
`jsonl` + `tmux`** surface (agent side). It reads transcripts and injects
keystrokes; it never runs an agent itself.

```
Even App ──HTTP/SSE──▶  src/server/routes.ts ──▶ src/even/provider.ts
   ▲                          │                          │  reads
   │  SSE frames              │                          ▼
   └──────  src/server/events.ts  ◀── emit() ── src/gsd/watch.ts (tails jsonl)
                                                          │  writes
                                                          ▼
                                              src/gsd/tmux.ts (send-keys)
```

## Module map

| file | responsibility |
|------|----------------|
| `src/index.ts` | express app, `/health`, token auth, QR/token banner, starts the watcher, process-level resilience (`uncaughtException`, `SIGTERM`) |
| `src/config.ts` | env → `Config` (all defaults safe); `primaryLanIp()` for the QR URL |
| `src/log.ts` | structured single-line logs + persisted `last-error.json` (agent-first diagnostics); `DEBUG=1` enables per-frame SSE tracing |
| `src/server/routes.ts` | the `/api/*` even-terminal endpoints |
| `src/server/events.ts` | per-session SSE ring buffer, fan-out, replay, `emitText()` (the paint sequence), optimistic-echo dedupe |
| `src/even/provider.ts` | the read/write split: reads transcripts for history/status, writes prompts + picker answers via `tmux` |
| `src/even/format.ts` | 576×288 shrink — collapse whitespace, drop tool-result noise, hard-truncate |
| `src/gsd/sessions.ts` | project enumeration; `cwd` from the transcript, tmux-name slugging, latest-prompt subtitle, cold-start projects |
| `src/gsd/watch.ts` | tail loop over `jsonl`; parses new lines to frames; next-steps menu detection + decoration |
| `src/gsd/questions.ts` | ANSWER-mode: parse an open `tmux` picker, match a spoken utterance to option index(es), cache the last next-steps menu |
| `src/gsd/jsonl.ts` | gsd-native `jsonl` line parser + transcript → turns |
| `src/gsd/tmux.ts` | `tmux` primitives: `send-keys`, `send prompt`, spawn, session probe |

## Read / write split

The desk `gsd` process owns each transcript and its `tmux` pane. The bridge must
never become a second writer to the same `jsonl`, so:

- **READ** — `listSessions`, `getHistory`, `getStatus` parse the gsd-native
  `jsonl`. Status is *derived*, not authoritative: a session is `busy` only if
  its newest `jsonl` changed within `BUSY_WINDOW_MS`, and status is read from the
  **last assistant message** in the chunk (never the trailing `toolResult` line —
  see [PROTOCOL.md](PROTOCOL.md)).
- **WRITE** — `prompt`, `interrupt`, `permission`, `question` all resolve to
  `tmux send-keys` into the live pane. The desk `gsd` remains the sole process
  owner; the bridge just types into it.

`cwd` is always read from the transcript's `session` line. The sessions-dir slug
is `/`→`-` encoded and **lossy** (project names contain hyphens), so it must
never be reverse-decoded into a path.

Two transcript roots are scanned and merged: interactive TUI sessions
(`~/.gsd/sessions`) and auto-mode/worktree runs (`~/.gsd/agent/sessions`). A
project can appear in both; entries are keyed by `cwd` and the **newest**
transcript wins, so live activity always surfaces. Worktree dirs
(`/.gsd/worktrees/…`) are filtered out.

## Project list & subtitle

`listSessions` returns a flat cross-project list sorted by transcript mtime
(newest first — the Even App hard-caps the visible list at ~10 entries, so order
is everything). Each entry title is `[name] ● subtitle` / `[name] ○ subtitle`,
`●` for a live `tmux` session.

The **subtitle is the latest user prompt** in that project, read from a tail
window of the newest transcript (`readTitleHint` in `sessions.ts`). It reads the
*last* user message, not the first, so the list behaves like a recent-activity
feed. (Auto-mode transcripts, which have no free-text user prompt, fall back to a
short `auto: S01`-style marker parsed from a `custom_message` line.)

Projects that exist on disk under a root but have **never** run gsd are listed as
cold-start entries with a synthetic `cold_…` sessionId and no transcript; the
first prompt to one spawns `tmux` + `gsd` (when `ALLOW_SPAWN`).

## ANSWER-mode: answering interactive questions by voice

The glasses have voice→text only, so every interactive question must collapse to
*"say a number."* Two distinct paths:

### 1. Live gsd pickers (single- / multi-select)

gsd flushes **no `jsonl`** while a picker is open (verified live), so an open
question is detected by **scraping the `tmux` pane**, not the transcript
(`parsePicker` in `questions.ts`). The picker footer `esc to exit` is the
discriminator (the later "Review your answers" screen says `esc to end
interview`).

- **single-select** — the interview UI binds **digit shortcuts**: typing `2`
  jumps to option 2 and auto-advances to the review screen; a following `Enter`
  submits. Answer = `send-keys <n>`, beat, `send-keys Enter`.
- **multi-select** — digits are **inert**; options are checkboxes toggled by
  `Space`. Answer = walk down to each target (`Down×k`) + `Space`, then `Enter`
  (advance to review) + `Enter` (submit).

A spoken utterance is mapped to an index by `matchAnswer` / `matchMulti`: bare
digit → number word → exact label → label substring. On no match, the menu is
re-shown and the question stays pending.

### 2. Trailing next-steps menus (plain answer text)

A gsd answer often *ends* in a numbered menu (`Ďalej?` / `Next steps:` / a
free-form intro + `Čo?` trailer). That list is plain answer **text**, not an open
picker, so a bare-number reply would otherwise be forwarded verbatim and the
model would re-read its own list and re-decide non-deterministically (it picked
the wrong item live).

`detectMenu` (shared by `markNextSteps` and `nextStepsOptions` so decoration and
binding never drift) recognizes a trailing block of ≥2 numbered options as a menu
when **any** anchor holds:

- a bare next-steps keyword line above it (`Ďalej?`), OR
- an `Iné` / `Other` / `else` escape option, OR
- a short trailing `?` question line (`Čo?`, ≤40 chars).

Plain fact-lists (no anchor) are left untouched. When a menu is detected the
tailer caches its parsed options per session (`setLastMenu`); on the next prompt,
`provider.prompt` expands a bare `2` → `2. <label>` before forwarding, making the
choice deterministic. It is **one-shot** — cleared on the next prompt. The real
voice-picker path (digit → `tmux`) is untouched.

> **Note on regex boundaries:** JS `\w`/`\b` are ASCII-only, so `\b` after a
> non-ASCII letter (e.g. `é` in `Ďalej`) fails to match. The detection uses an
> explicit delimiter character class instead of `\b`.

## Optimistic echo

`provider.prompt` echoes a glasses-sent prompt to the ring instantly (so the
wearer sees their own words with no lag). Seconds later the tailer reads the same
user line gsd wrote to `jsonl` and would emit it again. `recordEcho` /
`consumeEcho` (in `events.ts`) drop exactly one matching replay. gsd rewrites the
typed line before flushing (strips a leading `/`, sentence-cases, adds
punctuation), so the match is loose: lowercase, strip leading slash + trailing
punctuation, collapse whitespace. Records expire after 60 s.

## Failure visibility

- `/health` exposes uptime, live SSE client count, bind, roots, and the last
  persisted error.
- `log.error` writes `.state/last-error.json` so a wedged bridge is diagnosable
  with no console.
- Content frames (`text_delta` / `result`) dropped with no live client are logged
  as warnings, not silently swallowed.
- `DEBUG=1` turns on per-frame SSE tracing (`log.debug`).
