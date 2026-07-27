import { test } from "node:test";
import assert from "node:assert/strict";
import type { Response } from "express";
import { emit, addClient } from "../src/server/events.ts";

// Minimal SSE sink: records every raw frame written to the client.
function fakeRes(): { writes: string[]; res: Response } {
  const writes: string[] = [];
  const res = {
    setHeader() {},
    flushHeaders() {},
    write(s: string) {
      writes.push(s);
      return true;
    },
  } as unknown as Response;
  return { writes, res };
}

// Parse the `data:` payloads out of what the client received (skip :ok/:heartbeat).
function frames(writes: string[]): Array<{ id: number; msg: Record<string, unknown> }> {
  const out: Array<{ id: number; msg: Record<string, unknown> }> = [];
  for (const w of writes) {
    const m = /^id: (\d+)\ndata: (.*)\n\n$/s.exec(w);
    if (m) out.push({ id: Number(m[1]), msg: JSON.parse(m[2]!) });
  }
  return out;
}

// The glasses drop SSE every ~30s and reconnect with neither needReplay nor a
// Last-Event-ID. The answer broadcasts while they are dark, so it must be
// replayed as the dark-window gap on the next connect — not lost, not re-sending
// frames a live client already saw.
test("reconnect replays only the dark-window gap", () => {
  const sid = "ev-gap-test";

  // Frame pushed before any client exists — must still replay on first connect.
  emit(sid, { type: "status", state: "busy" }); // id 1

  const c1 = fakeRes();
  const dispose1 = addClient(sid, c1.res, false); // first connect: gets the backlog
  assert.deepEqual(frames(c1.writes).map((f) => f.id), [1], "first connect should replay the pre-connect backlog");

  emit(sid, { type: "tool_call", text: "> Bash: x" }); // id 2 — delivered live to c1
  assert.deepEqual(frames(c1.writes).map((f) => f.id), [1, 2], "live frame should reach the connected client");

  dispose1(); // glasses navigate away → SSE dies

  // Turn completes while dark: answer + result broadcast to zero clients.
  emit(sid, { type: "status", state: "text_start" }); // id 3
  emit(sid, { type: "text_delta", text: "6." }); // id 4
  emit(sid, { type: "status", state: "text_end" }); // id 5
  emit(sid, { type: "result", success: true, text: "6." }); // id 6
  emit(sid, { type: "status", state: "idle" }); // id 7

  const c2 = fakeRes();
  const dispose2 = addClient(sid, c2.res, false); // reconnect: no needReplay, no Last-Event-ID
  const got = frames(c2.writes);
  assert.deepEqual(
    got.map((f) => f.id),
    [3, 4, 5, 6, 7],
    "reconnect must replay exactly the frames missed while dark (not id 1/2 already seen)",
  );
  assert.ok(
    got.some((f) => f.msg.type === "result" && f.msg.text === "6."),
    "the committing result frame must be replayed so the answer paints",
  );

  // A further reconnect with nothing new must replay nothing.
  const c3 = fakeRes();
  const dispose3 = addClient(sid, c3.res, false);
  assert.deepEqual(frames(c3.writes), [], "quiet reconnect should replay no frames");

  dispose2();
  dispose3();
});

// The App arms its native question UI ("awaiting" mode, where the mic answers
// the question directly instead of being read as an interrupt) off a
// `user_question` frame. emitQuestion must ship exactly that shape: one question,
// options as {label,description,preview}, carrying sessionId + a toolUseId.
test("emitQuestion ships a user_question frame that arms the App's awaiting mode", async () => {
  const { emitQuestion } = await import("../src/server/events.ts");
  const sid = "q-frame-probe";
  const c = fakeRes();
  const dispose = addClient(sid, c.res, false);
  emitQuestion(sid, "Pick a fruit", ["Apple", "Pear"]);
  const got = frames(c.writes).map((f) => f.msg);
  const uq = got.find((m) => m.type === "user_question")!;
  assert.ok(uq, "a user_question frame must be emitted");
  assert.equal(uq.sessionId, sid, "frame must carry sessionId (App keys awaiting off it)");
  const qs = uq.questions as Array<Record<string, unknown>>;
  assert.equal(qs.length, 1, "one question");
  assert.equal(qs[0]!.question, "Pick a fruit");
  assert.deepEqual(
    (qs[0]!.options as Array<Record<string, unknown>>).map((o) => o.label),
    ["Apple", "Pear"],
    "options carried as {label} in order",
  );
  dispose();
});
