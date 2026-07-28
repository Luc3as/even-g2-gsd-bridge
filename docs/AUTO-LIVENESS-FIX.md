# Auto-mode liveness: why the glasses clock keeps ticking after you stop GSD auto

## Symptom (reported 2026-07-28)

Yummy project open on the glasses. User stopped/cancelled GSD auto from the
keyboard. The glasses progress line kept showing a **growing `+Nm Ns` elapsed
ticker** and "progressing" — the bridge still believed auto-mode was live and
working.

## Root cause

The bridge's liveness model is **obsolete against current GSD**. It reads the
`.gsd/auto.lock` file and asks "is the lock's pid alive?" (`src/gsd/auto.ts`
`readAutoState` → `pidAlive`). Two facts break that:

1. **The lock pid is the persistent interactive `gsd` TUI, not a per-run child.**
   That process stays alive the whole time the terminal is open — during auto,
   after `/gsd stop`, while idle. So `pidAlive(lock.pid)` is **always true**
   while the TUI is up. It can never distinguish "auto loop running" from "TUI
   open, auto stopped".

2. **GSD moved liveness off the lock file into a DB heartbeat.** Current GSD
   (`crash-recovery.js` header: *"The auto.lock file is gone... contents
   synthesized from the DB"*) writes the `auto.lock` file **once per unit start**
   (a snapshot, never refreshed) and tracks real liveness in the `workers`
   table: `status` + `last_heartbeat_at`, refreshed **every loop iteration**
   (`heartbeatAutoWorker`), TTL **60s** (`HEARTBEAT_TTL_SECONDS`). A worker is
   live iff `status='active' AND last_heartbeat_at >= now-60s`.

### Live proof (Yummy, 2026-07-28 05:58 UTC)

```
workers newest row:
  pid: 2238022  status: active
  last_heartbeat_at: 05:54:53   ← stuck at loop start, never refreshed
  now:               05:58:03   ← heartbeat is 190s stale (TTL is 60s)
auto.lock file mtime: 05:54:53  ← same instant, a one-shot snapshot
pid 2238022: ALIVE (it is the interactive `gsd` TUI, cmd=`gsd`, not a run child)
```

So the DB heartbeat correctly says "auto is NOT live" (190s > 60s TTL), but the
bridge's pid-alive check says "running", and the status resolver only forces
idle on `"stopped"` (dead pid), never on this "stale heartbeat, live TUI" case.

### How that becomes a ticking clock (`src/gsd/watch.ts`)

- `readAutoState` returns `"running"` (pid alive) — or `"none"` after a clean
  `/gsd stop` clears the lock.
- Status resolution (`watch.ts:287`) forces `idle` **only** on `"stopped"`.
  Neither `"running"` nor `"none"` forces idle, so status falls to the jsonl
  **freshness** gate. The TUI keeps writing its own transcript, so `fresh=true`
  → `want="busy"`.
- `detectProgress` (`watch.ts:375`) reads the DB's `status='active'` milestone
  (which is still active — stopping auto doesn't clear the milestone) and, while
  `status==="busy"`, re-pushes the elapsed ticker every 15s. **Clock grows.**

The bridge is showing motion that isn't happening.

## Fix plan

**Principle:** make the bridge trust GSD's real liveness signal — the `workers`
table heartbeat — instead of the obsolete lock-file pid. The bridge already
opens `.gsd/gsd.db` read-only (`src/gsd/progress.ts`), so this is a read-only
add to an existing safe connection. No GSD-side change.

### 1. New authoritative liveness read (bridge-side)

Add a `readAutoLiveness(cwd)` that queries `workers`:

```sql
SELECT status, last_heartbeat_at, pid
FROM workers
WHERE project_root_realpath = ? AND status = 'active'
ORDER BY last_heartbeat_at DESC LIMIT 1
```

Verdict:
- row exists AND `last_heartbeat_at >= now - 60s` (TTL, read from the same
  constant GSD uses; hardcode 60 with a comment if not exportable) → **`running`**
- row exists but heartbeat is stale, OR only `stopping`/`crashed`/no rows →
  **`stopped`** (auto is not live)
- no `workers` table / no db → fall back to the current lock-file reader (fresh
  projects, non-auto sessions) → typically **`none`**

`project_root_realpath` must be the realpath (GSD stores `normalizeRealPath`);
resolve the project cwd the same way before matching.

Keep it read-only, never-throws, degrade to `none` on any failure — mirror
`progress.ts` exactly.

### 2. Status resolver honors "not live"

In `watch.ts` status resolution and `provider.ts` `statusFor`, treat the new
`stopped` verdict the same as today's dead-lock `stopped`: **force `idle`**. Once
idle, `detectProgress` stops ticking (it only ticks on `busy`) and the input gate
releases — exactly the existing stopped-lock behavior, now reachable for the real
common case (TUI alive, auto stopped/stale).

### 3. Progress freezes, doesn't lie

With status forced idle, the last progress line stays on screen frozen (correct —
that IS the last real state) and the `+Nm Ns` ticker stops. Optionally append a
one-time ` — stopped` marker to the frozen line so the wearer knows auto ended
vs is mid-task; low priority.

### 4. Do NOT force-idle a genuinely running worker

Guard: only the **freshest active** worker row counts. The `workers` table
accumulates dozens of old `stopping` rows (seen live) — filter to
`status='active'` and newest heartbeat so an old stale row never masks a live
run, and a live run (heartbeat within 60s) is never wrongly idled.

## Verification

1. **Repro (before):** open a project on glasses, start `/gsd auto`, let it run,
   then `/gsd stop`. Confirm the ticker keeps growing on the old build.
2. **Unit:** feed `readAutoLiveness` a temp db with (a) fresh-heartbeat active
   row → `running`; (b) 90s-stale active row → `stopped`; (c) only `stopping`
   rows → `stopped`; (d) no workers table → `none`.
3. **Live (after):** repeat the repro. Within one TTL window (≤60s) of the stop,
   the glasses status flips idle and the ticker freezes. A still-running auto
   keeps ticking (no false idle).
4. **Regression:** a real crash (killed pid, active row with stale heartbeat)
   still surfaces the `⚠ AUTO-STOPPED` alarm and idles — same edge, now also
   driven by heartbeat, not just pid death.

## Notes / open questions

- The lock file stays useful only for `unitId`/`unitType` labels on the alarm;
  liveness must come from the heartbeat. Keep reading the file for those fields.
- `stopAutoRemote` clears the lock and SIGTERMs the worker, which marks it
  `stopping` in the DB — so after a clean `/gsd stop` the workers read alone
  gives `stopped` even before the heartbeat lapses. Good: faster than waiting a
  full TTL.
- Dozens of leaked `stopping` rows per project is a GSD housekeeping smell, not a
  bridge bug — the `status='active'` filter sidesteps it.
