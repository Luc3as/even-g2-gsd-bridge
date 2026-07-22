# Even G2 ↔ GSD-PI bridge

View and steer your live GSD-PI coding agents from **Even Realities G2** glasses —
across projects, over your WireGuard tunnel, with dictation. No sideloading, no
re-pairing on the road.

It speaks the **official `@evenrealities/even-terminal` HTTP/SSE protocol**, so the
stock Even App (Terminal Mode) connects unmodified. The backend is an *attach-to-live*
adapter: it never owns your agents — it reads their transcripts and injects prompts
into the same tmux sessions your `sersám` launcher already uses.

```
G2 (Terminal Mode, R1 ring + dictation)
  → phone Even App (persistent BLE pair)
  → [WireGuard → gateway → rig LAN IP] → this bridge :3456
     ├ VIEW  = tail ~/.gsd/agent/sessions/<slug>/*.jsonl  → shrink to 576×288
     ├ STEER = tmux send-keys -t <project> "<dictated text>" Enter
     └ SWITCH= one session per project (native Even picker = sersám mirror)
```

## Why this design

- **One session per project.** `listSessions` returns a flat, cross-project list
  (`[Yummy] ● M012 auto`), so the glasses' native session picker becomes a network
  mirror of `sersám`. `●` = live tmux session, `○` = offline.
- **Read/write split.** Reads come from the gsd-native jsonl transcripts; writes go
  through `tmux send-keys` into the live pane. The desk `gsd` stays the sole process
  owner — the bridge never spawns a competing agent on the same transcript.
- **cwd is read from the transcript**, never decoded from the dir slug (project
  hyphens collide with the `/`→`-` slugging and make the slug lossy).

## Run

```bash
npm install
npm run build
npm start            # prints a QR + token; scan it in the Even App
# or, dev:
npm run dev
```

Then in the Even App → Terminal Mode → scan the QR (or enter `http://<rig-ip>:3456?token=…`).

### Config (all optional — see `.env.example`)

| env | default | meaning |
|-----|---------|---------|
| `BRIDGE_TOKEN` | random | fixed token = no re-pairing across restarts |
| `PORT` / `BIND_HOST` | `3456` / `0.0.0.0` | reachable over WG-routed LAN |
| `GSD_SESSIONS_DIR` | `~/.gsd/agent/sessions` | transcript root |
| `PROJECT_ROOTS` | `/opt/AI_projects` | which projects to expose |
| `ALLOW_SPAWN` | `true` | prompt to an offline project spawns tmux + `gsd` |
| `KEY_PERMISSION_ALLOW/DENY`, `KEY_INTERRUPT` | `Enter`/`Escape`/`Escape` | gsd TUI keystrokes |

### Deploy (systemd, autostart, survives reboot)

```bash
cp .env.example .env && chmod 600 .env   # set BRIDGE_TOKEN
npm run build
cp systemd/even-g2-gsd-bridge.service ~/.config/systemd/user/
systemctl --user enable --now even-g2-gsd-bridge
loginctl enable-linger lukas             # keep running while logged out
```

## Health / diagnostics

```bash
curl -s localhost:3456/health | jq
```

Returns uptime, live SSE client count, bind, and the **last persisted error**
(`.state/last-error.json`) so a wedged bridge is diagnosable without a console.

## Endpoints (even-terminal contract)

`GET /api/events` (SSE) · `GET /api/sessions` · `GET /api/sessions/:id/history` ·
`GET /api/info` · `GET /api/status` · `GET /api/messages` · `POST /api/prompt` ·
`POST /api/permission-response` · `POST /api/question-response` · `POST /api/interrupt`.
All under `/api`, Bearer or `?token=` auth. `/health` is unauthenticated.

## Calibration note

Permission/interrupt keystrokes (`KEY_*`) are best-effort defaults for the gsd/pi
TUI and may need tuning against your build — `tmux capture-pane -t <proj> -p` shows
the live dialog so you can map the right keys. Prompt injection itself is verified.

## Tests

```bash
npm test        # jsonl parser, status derivation, 576×288 shrink, project enum
```
