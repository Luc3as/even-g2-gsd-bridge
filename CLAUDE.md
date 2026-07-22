
---

## General coding guidelines

**1. Think before coding.** State assumptions; if multiple interpretations exist, present
them — don't pick silently. If a simpler approach exists, say so. If unclear, stop and ask.

**2. Simplicity first.** Minimum code that solves the problem. No speculative abstractions,
no configurability that wasn't requested. "Would a senior engineer say this is overcomplicated?"

**3. Surgical changes.** Touch only what you must. Match existing style. Don't refactor what
isn't broken. Only remove orphans *your* change created; mention pre-existing dead code, don't delete it.
Every changed line should trace to the request.

**4. Goal-driven execution.** Turn tasks into verifiable goals ("write a failing test, then
make it pass"). Loop until the verification gate passes.

**5. Verify external data before coding.** Query the real n8n/DB/Helios values before writing
mapping code — don't assume column names or shapes.

---

## Self-improving memory

- Aim to be the best version of yourself; longer tasks should accrue wisdom from experience.
- Capture durable lessons (gotchas, conventions, environment facts) so they're not re-learned.
- You may craft custom skills from your own experience for more efficient future work.
- Always search available skills and pick the best for the task (SEO, UX/UI, Security, …).
