# Even G2 ↔ GSD-PI bridge

*[Slovenská verzia nižšie ↓](#slovensky)*

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

## Why this exists

The agent runs on a rig at the desk. You are not — you're on the couch, in the
kitchen, or on the road. You want to check *"did the build pass, did it get stuck
on a permission dialog, what did it just answer"* — and nudge it — **without
pulling out a laptop, unlocking a phone, or SSH-ing in.**

The G2 glasses already have a screen, a dictation mic, and a ring for input; the
stock Even App already speaks a Terminal protocol over the network. The missing
piece was a host-side adapter mapping that protocol onto a **live GSD-PI agent in
tmux** — read its answers, forward your dictated prompts — without becoming a
second process fighting the desk agent for the same transcript. This bridge is
that piece.

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

## What it needs to run

- **Node ≥ 20** on the rig where the agents run.
- **GSD-PI** writing transcripts under `~/.gsd/sessions/` or `~/.gsd/agent/sessions/`.
- **tmux** sessions named by project basename (`sname`: non `[A-Za-z0-9_-]` → `_`),
  so the bridge's `send-keys` targets line up with the desk launcher's panes. Any
  launcher that follows this naming works; a ready-made neon TUI one ships in
  [`scripts/sersam`](scripts/sersam) (the launcher this bridge was built against).
  Or skip it entirely and let the bridge spawn sessions on demand (`ALLOW_SPAWN`).
- **Even Realities G2** + phone Even App in Terminal Mode, reachable to the rig —
  on the LAN, or over a **WireGuard** tunnel (that's the on-the-road case).
- No cloud, no account. Auth is a single bearer token (fix it via `BRIDGE_TOKEN`
  so restarts don't force a re-pair).

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

### The desk launcher (optional)

The bridge steers whatever `tmux` sessions already exist — it doesn't start them.
To start/resume/kill them from the desk, use the bundled launcher:

```bash
install -m755 scripts/sersam ~/.local/bin/sersam   # then just run: sersam
SERSAM_ROOT=/path/to/projects sersam               # if not /opt/AI_projects
```

It needs **`bash` ≥ 4** (uses `mapfile`), **`tmux`**, and **`tput`** (from
`ncurses`) plus the usual coreutils (`find`, `tr`, `sort`, `date`, `hostname`) —
all standard on Linux. On Debian/Ubuntu: `sudo apt install tmux ncurses-bin`.
A 24-bit-colour terminal renders the neon UI best, but it degrades gracefully.

It lists every dir under `SERSAM_ROOT`, and `Enter` starts or resumes a `tmux`
session named the same way the bridge expects. Not required — any launcher (or
`ALLOW_SPAWN`) that produces those session names works.

## Usage (once running)

After the bridge runs and the Even App is paired (scan the QR once):

1. **Open Terminal Mode** on the G2. The native session picker is a live mirror
   of your projects, newest activity on top: `[Project] ● latest prompt` — `●` a
   live `tmux` session, `○` offline.
2. **Pick a project** with the R1 ring; you see that agent's latest exchange,
   shrunk to the 576×288 lens.
3. **Dictate a prompt.** It is injected into that project's `tmux` pane as if you
   typed it at the desk. If the project is offline, the bridge spawns `tmux` +
   `gsd` first (`ALLOW_SPAWN`).
4. **Answer by voice.** When gsd opens a picker, say the option number ("two") —
   the bridge maps it to the keystroke. When an answer ends in a `Ďalej?` /
   `Next steps:` menu, saying a number runs that option deterministically.

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

---

<a name="slovensky"></a>

# Even G2 ↔ GSD-PI most (slovensky)

Sleduj a riaď svojich živých [GSD-PI](https://opengsd.net/) kódovacích agentov z
okuliarov **Even Realities G2** — naprieč projektmi, cez WireGuard tunel, hlasom.
Bez sideloadingu, bez opätovného párovania na cestách.

Most hovorí **oficiálnym `@evenrealities/even-terminal` HTTP/SSE protokolom**, takže
sa naň bežná Even App (Terminal Mode) pripojí bez úprav. Je to adaptér typu
*pripoj-sa-k-živému*: nikdy nevlastní tvojich agentov. Číta ich gsd-natívne `jsonl`
transkripty a vkladá prompty do tých istých `tmux` relácií, ktoré už riadi tvoj
`sersám` launcher.

## Prečo to vzniklo

Agent beží na stroji pri stole. Ty nie — si na gauči, v kuchyni alebo na cestách.
Chceš skontrolovať *„prešiel build, zasekol sa na permission dialógu, čo práve
odpovedal"* — a postrčiť ho — **bez toho, aby si vytiahol notebook, odomkol telefón
alebo sa SSH-oval dnu.**

Okuliare G2 už majú displej, diktovací mikrofón aj prsteň na ovládanie; bežná Even
App už hovorí Terminal protokolom cez sieť. Chýbal len hostiteľský adaptér, ktorý
ten protokol namapuje na **živého GSD-PI agenta v tmuxe** — číta jeho odpovede,
posiela tvoje nadiktované prompty — bez toho, aby sa stal druhým procesom bojujúcim
o ten istý transkript. Tento most je práve to.

## Čo môžeš robiť z okuliarov

- **Vidieť, čo každý agent povedal**, naprieč projektmi, najnovšia aktivita hore.
  Zoznam projektov je živé zrkadlo `sersámu`: `[Yummy] ● posledný príkaz`, kde
  `●` = živá `tmux` relácia, `○` = offline. Podtitulok sleduje **posledný** prompt.
- **Nadiktovať nový prompt** do ľubovoľného projektu. Ak projekt nemá živú reláciu,
  most na požiadanie spustí `tmux` + `gsd` (`ALLOW_SPAWN`).
- **Odpovedať na interaktívne otázky agenta hlasom.** gsd TUI výbery (single- aj
  multi-select) sú zredukované na *„povedz číslo"* — most zosníma otvorený výber z
  `tmux` panelu a namapuje vyslovenú číslicu na správny stlačený kláves.
- **Odpovedať na next-steps menu číslom.** Keď odpoveď končí menu `Ďalej?` /
  `Next steps:`, povedať `2` deterministicky spustí možnosť 2 (popis sa rozvinie
  ešte pred tým, než sa dostane k modelu, takže si nemôže znova prečítať vlastný
  zoznam a rozhodnúť sa inak).

## Čo treba na spustenie

- **Node ≥ 20** na stroji, kde bežia agenti.
- **GSD-PI** zapisujúce transkripty do `~/.gsd/sessions/` alebo `~/.gsd/agent/sessions/`.
- **tmux** relácie pomenované podľa názvu projektu (`sname`: znaky mimo
  `[A-Za-z0-9_-]` → `_`). Funguje ľubovoľný launcher s týmto pomenovaním; hotový
  neonový TUI launcher je v [`scripts/sersam`](scripts/sersam). Alebo ho vynechaj
  a nech relácie spustí most sám (`ALLOW_SPAWN`).
- **Even Realities G2** + telefón s Even App v Terminal Mode, dosiahnuteľný na stroj —
  na LAN, alebo cez **WireGuard** tunel (scenár na cestách).
- Žiaden cloud, žiaden účet. Autentifikácia je jeden bearer token (fixný cez
  `BRIDGE_TOKEN`, aby reštart nevynútil opätovné párovanie).

## Spustenie

```bash
npm install
npm run build
npm start            # vypíše QR + token; naskenuj ho v Even App
```

Potom v Even App → **Terminal Mode** → naskenuj QR (alebo zadaj
`http://<ip-stroja>:3456?token=…`). Konfiguráciu, deploy cez systemd, health-check
a endpointy pozri v anglickej sekcii vyššie. Detaily protokolu a architektúry sú v
[`docs/PROTOCOL.md`](docs/PROTOCOL.md) a [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Desk launcher (voliteľné)

Most riadi `tmux` relácie, ktoré už existujú — sám ich neštartuje. Na
štart/resume/kill z desktopu použi priložený launcher:

```bash
install -m755 scripts/sersam ~/.local/bin/sersam   # potom stačí: sersam
SERSAM_ROOT=/cesta/k/projektom sersam              # ak nie /opt/AI_projects
```

Potrebuje **`bash` ≥ 4** (používa `mapfile`), **`tmux`** a **`tput`** (z
`ncurses`) plus bežné coreutils (`find`, `tr`, `sort`, `date`, `hostname`) —
všetko štandard na Linuxe. Na Debiane/Ubuntu: `sudo apt install tmux ncurses-bin`.
Neónové UI najlepšie vykreslí terminál s 24-bit farbami, ale degraduje elegantne.

Nie je povinný — funguje ľubovoľný launcher (alebo `ALLOW_SPAWN`), ktorý vyrobí
očakávané názvy relácií.

## Používanie (keď most beží)

Po spustení mosta a spárovaní (QR raz):

1. **Otvor Terminal Mode** na G2 — picker je živé zrkadlo projektov, najnovšie
   hore: `[Projekt] ● posledný prompt` (`●` živá relácia, `○` offline).
2. **Vyber projekt** prsteňom R1 — uvidíš poslednú výmenu agenta.
3. **Nadiktuj prompt** — vloží sa do `tmux` panelu projektu. Offline projekt most
   najprv spustí (`ALLOW_SPAWN`).
4. **Odpovedaj hlasom** — pri výbere povedz číslo možnosti; pri `Ďalej?` menu
   tiež číslo spustí danú možnosť.

## Testy

```bash
npm test        # jsonl parser, odvodenie stavu, zmenšenie na 576×288,
                # enumerácia projektov, parsovanie výberov, detekcia menu, SSE emit
npm run typecheck
```

## Licencia

MIT.
