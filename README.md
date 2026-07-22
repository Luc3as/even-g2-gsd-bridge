# Even G2 ↔ GSD-PI bridge

View and steer your live [GSD-PI](https://opengsd.net/) coding agents from **Even
Realities G2** glasses — across projects, over your WireGuard tunnel, hands-free
with dictation. No sideloading, no re-pairing on the road.

The bridge speaks the **official `@evenrealities/even-terminal` HTTP/SSE
protocol**, so the stock Even App (Terminal Mode) connects unmodified. It is an
*attach-to-live* adapter: it never owns your agents. It reads their gsd-native
`jsonl` transcripts and injects prompts into the same `tmux` sessions your
`sersám` launcher already drives.

```
G2 (Terminal Mode · R1 ring + dictation)
  → phone Even App (persistent BLE pair)
    → [ WireGuard → gateway → rig LAN IP ] → this bridge :3456
        ├ VIEW   tail ~/.gsd/**/sessions/<slug>/*.jsonl → shrink to 576×288
        ├ STEER  tmux send-keys -t <project> "<dictated text>" Enter
        ├ PICK   voice → "say a number" → digit keystroke into the gsd picker
        └ SWITCH one session per project (native Even picker = sersám mirror)
```

## What you can do from the glasses

- **See what each agent said**, across every project, newest activity on top.
  The project list is a live mirror of `sersám`: `[Yummy] ● latest command`
  where `●` = a live `tmux` session, `○` = offline. The subtitle tracks the
  **latest** prompt in that project, so the list reads like a recent-activity feed.
- **Dictate a new prompt** into any project. If the project has no live session,
  the bridge spawns `tmux` + `gsd` on demand (`ALLOW_SPAWN`).
- **Answer the agent's interactive questions by voice.** gsd's TUI pickers
  (single- and multi-select) are collapsed to *"say a number"* — the bridge
  scrapes the open picker from the `tmux` pane and maps your spoken digit to the
  right keystroke.
- **Answer a next-steps menu by number.** When an answer ends in a `Ďalej?` /
  `Next steps:` menu, saying `2` runs option 2 deterministically (the label is
  expanded before it reaches the model, so it can't re-read its own list and
  re-decide).

## Design in one screen

- **Read / write split.** Reads come from the gsd-native `jsonl` transcripts;
  writes go through `tmux send-keys` into the live pane. The desk `gsd` stays the
  sole process owner — the bridge never spawns a competing agent on a transcript
  it is also tailing.
- **One session per project.** `listSessions` returns a flat, cross-project list,
  so the glasses' native session picker becomes a network mirror of `sersám`.
- **cwd is read from the transcript, never decoded from the dir slug.** Project
  names contain hyphens that collide with the `/`→`-` slugging, so the slug is
  lossy; the authoritative `cwd` lives on the transcript's `session` line.
- **Firmware-shaped output.** The Even firmware has a fixed, small set of SSE
  frame types and silently drops the rest. Getting an answer to actually *paint
  and persist* on the lens took reverse-engineering the exact wire sequence — see
  [`docs/PROTOCOL.md`](docs/PROTOCOL.md). This is the least obvious part of the
  project and the most important to read before touching the emit path.

## Run

```bash
npm install
npm run build
npm start            # prints a QR + token; scan it in the Even App
# or, dev (watch mode):
npm run dev
```

Then in the Even App → **Terminal Mode** → scan the QR (or enter
`http://<rig-ip>:3456?token=…`).

### Config (all optional — safe defaults; see `.env.example`)

| env | default | meaning |
|-----|---------|---------|
| `BRIDGE_TOKEN` | random per boot | fixed value = glasses never re-pair across restarts |
| `PORT` / `BIND_HOST` | `3456` / `0.0.0.0` | `0.0.0.0` = reachable over the WG-routed LAN |
| `GSD_SESSIONS_DIR` | `~/.gsd/sessions,~/.gsd/agent/sessions` | transcript roots (comma-separated; newest wins per cwd) |
| `PROJECT_ROOTS` | `/opt/AI_projects` | only projects under these roots are exposed |
| `ALLOW_SPAWN` | `true` | a prompt to an offline project spawns `tmux` + `gsd` |
| `SPAWN_COMMAND` | `gsd` | command run inside a freshly spawned `tmux` session |
| `KEY_PERMISSION_ALLOW` / `KEY_PERMISSION_DENY` / `KEY_INTERRUPT` | `Enter` / `Escape` / `Escape` | gsd TUI keystrokes (calibrate — see below) |
| `TAIL_INTERVAL_MS` | `500` | jsonl tail poll interval |
| `BUSY_WINDOW_MS` | `120000` | a session is "busy" only if its jsonl changed this recently |
| `STATE_DIR` | `./.state` | failure-state + pid artifacts |

### Deploy (systemd user service, autostarts, survives reboot)

```bash
cp .env.example .env && chmod 600 .env    # set BRIDGE_TOKEN
npm run build
cp systemd/even-g2-gsd-bridge.service ~/.config/systemd/user/
systemctl --user enable --now even-g2-gsd-bridge
loginctl enable-linger "$USER"            # keep running while logged out
```

## Health / diagnostics

```bash
curl -s localhost:3456/health | jq
```

Returns uptime, live SSE client count, bind address, configured roots, and the
**last persisted error** (`.state/last-error.json`) — so a wedged bridge is
diagnosable without a live console. `/health` is the only unauthenticated route.

## Endpoints (even-terminal contract)

All under `/api`, authenticated by `Authorization: Bearer <token>` or `?token=`:

`GET /api/events` (SSE) · `GET /api/sessions` · `GET /api/sessions/:id/history` ·
`GET /api/info` · `GET /api/status` · `GET /api/messages` · `POST /api/prompt` ·
`POST /api/permission-response` · `POST /api/question-response` ·
`POST /api/interrupt`.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — module map, the read/write
  split, the ANSWER-mode voice-picker mechanics, and the SSE ring/replay model.
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — the even-terminal SSE frame contract
  and the firmware quirks that shape every emit (frame types, the text-paint
  triad, the finalizing `result` frame, lens glyph limits). **Read this before
  editing the emit path.**

## Calibration note

Permission/interrupt keystrokes (`KEY_*`) are best-effort defaults for the gsd/pi
TUI and may need tuning against your build — `tmux capture-pane -t <proj> -p`
shows the live dialog so you can map the right keys. Prompt injection and the
single/multi-select picker paths are verified live.

## Tests

```bash
npm test        # jsonl parser, status derivation, 576×288 shrink,
                # project enum, picker parsing, menu detection, SSE emit
npm run typecheck
```

## License

MIT.
