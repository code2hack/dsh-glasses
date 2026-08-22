// T27-02 unit tests for lib/dsh-adapter.js (SPEC §5 read slice, M1 scope).
// Pure logic only: a mock ctx stands in for DSH internals. The disposable
// rc.2 runtime proof lives in dsh-adapter-runtime.test.mjs.

import assert from "node:assert/strict";
import { createGlassesDshAdapter, AdapterValidationError } from "../lib/dsh-adapter.js";

const results = [];
const ok = (name) => results.push(["PASS", name]);
const fail = (name, error) => { results.push(["FAIL", name]); console.error(`FAIL ${name}: ${error}`); };
const scenario = async (name, fn) => { try { await fn(); ok(name); } catch (e) { fail(name, e); } };

function makeCtx({ sessions = [], readEvents, agentMap = {}, onHandler } = {}) {
  const listeners = new Map();
  return {
    sessionQuery: {
      listSessions: async () => sessions.map((s) => ({ sessionId: s })),
      readSession: async () => ({ events: readEvents }),
    },
    agents: {
      get: (sid) => (sid in agentMap ? agentMap[sid] : undefined),
    },
    on: (channel, handler) => {
      if (channel !== "session/event") throw new Error(`unexpected channel ${channel}`);
      listeners.set(handler, handler);
      return () => listeners.delete(handler);
    },
    _emit: (session, event) => { for (const h of listeners.values()) h(session, event); },
  };
}

// helper to build canonical raw events
const evt = (seq, type = "user/message", extra = {}) => ({ seq, type, ...extra });

try {
  await scenario("construction: requires ctx", async () => {
    assert.throws(() => createGlassesDshAdapter(null), AdapterValidationError);
  });

  await scenario("construction: fails fast when a required read seam is missing", async () => {
    const ctx = makeCtx();
    delete ctx.sessionQuery;
    assert.throws(() => createGlassesDshAdapter(ctx), (e) => e instanceof AdapterValidationError && e.code === "missing-seam");
  });

  await scenario("construction: maxEvents default and non-integer clamp", async () => {
    const a1 = createGlassesDshAdapter(makeCtx(), { maxEvents: 50 });
    assert.equal(a1.maxEvents, 50);
    const a2 = createGlassesDshAdapter(makeCtx(), {});
    assert.equal(a2.maxEvents, 200);
    const a3 = createGlassesDshAdapter(makeCtx(), { maxEvents: "x" });
    assert.equal(a3.maxEvents, 200);
    const a4 = createGlassesDshAdapter(makeCtx(), { maxEvents: 0 });
    assert.equal(a4.maxEvents, 200);
  });

  await scenario("listAttachableSessions: returns project-shaped stable list", async () => {
    const adapter = createGlassesDshAdapter(makeCtx({ sessions: ["s-a", "s-b"] }));
    const list = await adapter.listAttachableSessions();
    assert.deepEqual(list, [{ sessionId: "s-a" }, { sessionId: "s-b" }]);
  });

  await scenario("listAttachableSessions: rejects non-array list", async () => {
    const ctx = makeCtx();
    ctx.sessionQuery.listSessions = async () => null;
    const adapter = createGlassesDshAdapter(ctx);
    await assert.rejects(async () => adapter.listAttachableSessions(), AdapterValidationError);
  });

  await scenario("readProjectionPage: canonical bounded projection", async () => {
    const raw = [evt(0), evt(1, "assistant/message", { data: { message: { id: "a1", content: [{ type: "text", text: "hi" }] } } }), evt(2)];
    const adapter = createGlassesDshAdapter(makeCtx({ readEvents: raw }), { maxEvents: 200 });
    const page = await adapter.readProjectionPage("session-1");
    assert.equal(page.asOfSeq, 2);
    assert.equal(page.events.length, 3);
    assert.equal(page.events[1].type, "assistant/message");
    assert.equal(page.events[1].message.text, "hi");
    assert.deepEqual(page.events.map((e) => e.seq), [0, 1, 2]);
  });

  await scenario("readProjectionPage: enforces the configured bound (trailing slice)", async () => {
    const raw = [evt(0), evt(1), evt(2), evt(3), evt(4)];
    const adapter = createGlassesDshAdapter(makeCtx({ readEvents: raw }), { maxEvents: 2 });
    const page = await adapter.readProjectionPage("session-1");
    assert.deepEqual(page.events.map((e) => e.seq), [3, 4]);
    assert.equal(page.asOfSeq, 4);
  });

  await scenario("readProjectionPage: empty page has asOfSeq -1", async () => {
    const adapter = createGlassesDshAdapter(makeCtx({ readEvents: [] }));
    const page = await adapter.readProjectionPage("session-1");
    assert.equal(page.asOfSeq, -1);
    assert.deepEqual(page.events, []);
  });

  await scenario("readProjectionPage: rejects cursor (M1 is cursorless)", async () => {
    const adapter = createGlassesDshAdapter(makeCtx({ readEvents: [] }));
    await assert.rejects(async () => adapter.readProjectionPage("session-1", "cursor-4"), (e) => e instanceof AdapterValidationError && e.code === "unsupported-cursor");
  });

  await scenario("readProjectionPage: rejects non-array events", async () => {
    const adapter = createGlassesDshAdapter(makeCtx({ readEvents: null }));
    await assert.rejects(async () => adapter.readProjectionPage("session-1"), (e) => e instanceof AdapterValidationError && e.code === "malformed-page");
  });

  await scenario("readProjectionPage: rejects descending (non-monotonic) sequence", async () => {
    const adapter = createGlassesDshAdapter(makeCtx({ readEvents: [evt(2), evt(1)] }));
    await assert.rejects(async () => adapter.readProjectionPage("session-1"), (e) => e instanceof AdapterValidationError && e.code === "non-monotonic-page");
  });

  await scenario("readProjectionPage: rejects duplicate sequence", async () => {
    const adapter = createGlassesDshAdapter(makeCtx({ readEvents: [evt(1), evt(1)] }));
    await assert.rejects(async () => adapter.readProjectionPage("session-1"), (e) => e instanceof AdapterValidationError && e.code === "non-monotonic-page");
  });

  await scenario("readProjectionPage: rejects non-finite/negative seq", async () => {
    const adapter = createGlassesDshAdapter(makeCtx({ readEvents: [evt(-1)] }));
    await assert.rejects(async () => adapter.readProjectionPage("session-1"), (e) => e instanceof AdapterValidationError && e.code === "malformed-page");
    const adapter2 = createGlassesDshAdapter(makeCtx({ readEvents: [{ seq: "1", type: "user/message" }] }));
    await assert.rejects(async () => adapter2.readProjectionPage("session-1"), AdapterValidationError);
  });

  await scenario("readProjectionPage: propagates readSession rejection", async () => {
    const ctx = makeCtx();
    ctx.sessionQuery.readSession = async () => { throw Object.assign(new Error("boom"), { code: "ERR" }); };
    const adapter = createGlassesDshAdapter(ctx);
    await assert.rejects(async () => adapter.readProjectionPage("session-1"), /boom/);
  });

  await scenario("observeSession: filters to the requested session and returns a working disposer", async () => {
    const ctx = makeCtx();
    const adapter = createGlassesDshAdapter(ctx);
    const seen = [];
    const off = adapter.observeSession("s-target", (event) => seen.push(event.seq));
    ctx._emit({ id: "s-other" }, evt(10));
    ctx._emit({ id: "s-target" }, evt(11));
    assert.deepEqual(seen, [11]);
    off();
    ctx._emit({ id: "s-target" }, evt(12));
    assert.deepEqual(seen, [11]);
  });

  await scenario("observeSession: rejects non-function listener", async () => {
    const adapter = createGlassesDshAdapter(makeCtx());
    assert.throws(() => adapter.observeSession("s", "not-a-fn"), AdapterValidationError);
  });

  await scenario("getAgentState: maps known states explicitly", async () => {
    const adapter = createGlassesDshAdapter(makeCtx({ agentMap: { "s-1": { status: "running" }, "s-2": { status: "idle" } } }));
    assert.equal(adapter.getAgentState("s-1"), "running");
    assert.equal(adapter.getAgentState("s-2"), "idle");
  });

  await scenario("getAgentState: missing agent -> unavailable; unknown future status -> unknown", async () => {
    const adapter = createGlassesDshAdapter(makeCtx({ agentMap: { "s-3": { status: "future-status" } } }));
    assert.equal(adapter.getAgentState("s-missing"), "unavailable");
    assert.equal(adapter.getAgentState("s-3"), "unknown");
  });

  await scenario("getAgentState: agent without a string status -> unavailable", async () => {
    const adapter = createGlassesDshAdapter(makeCtx({ agentMap: { "s-4": {} } }));
    assert.equal(adapter.getAgentState("s-4"), "unavailable");
  });
} catch (error) {
  fail("dsh-adapter.fatal", error);
}

console.log("\n=== dsh-adapter SUMMARY ===");
for (const [r, n] of results) console.log(`${r} ${n}`);
const failed = results.filter(([r]) => r === "FAIL");
if (failed.length) { console.log(`FAILED: ${failed.length}`); process.exit(1); }
console.log(`ALL PASS (${results.length} checks)`);
process.exit(0);
