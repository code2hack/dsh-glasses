import assert from "node:assert/strict";
import test from "node:test";
import { createDshAdapter } from "../lib/dsh.js";

function fakeCtx({ createImpl, resumeImpl, status, followup = () => {} }) {
  const flush = async () => {};
  const handle = (sessionId) => ({
    agent: { status, session: { id: sessionId }, followup(message) { followup(message); } },
    async dispose() {},
  });
  return {
    get(key) {
      if (key === "agentDefaultModel") return { currentSelection: () => ({ provider: "ds4", model: "deepseek-v4-flash-0731" }) };
      if (key === "sessions") return { flush };
      if (key === "agents") {
        return {
          async create(options) {
            if (createImpl) return createImpl(options);
            return handle(options.sessionId);
          },
          async resume(options) {
            if (resumeImpl) return resumeImpl(options);
            throw new Error("unexpected resume");
          },
        };
      }
      return undefined;
    },
  };
}

test("createAgent recovers an orphan persisted session under the same deterministic id via resume", async () => {
  let resumed = false;
  let disposed = false;
  const adapter = createDshAdapter(fakeCtx({
    status: "idle",
    createImpl: async () => {
      throw new Error('session "dsh-glasses-S1-#21-DSH" already has a persisted log on disk that does not match this live session (id collision)');
    },
    resumeImpl: async (options) => {
      resumed = true;
      assert.equal(options.resumeSessionId, "dsh-glasses-S1-#21-DSH");
      return { agent: { status: "idle", session: { id: options.resumeSessionId } }, async dispose() { disposed = true; } };
    },
  }));
  const binding = { sessionId: "dsh-glasses-S1-#21-DSH", worktree: "/w", bootstrapPrompt: "bootstrap", milestone: "S1", number: 21 };
  await adapter.createAgent(binding);
  assert.equal(resumed, true, "orphan log must be recovered by resume of the SAME id");
  assert.equal(adapter.isLive(binding), true);
  assert.equal(adapter.agentStatus(binding), "idle");
  await adapter.disposeAgent(binding);
  assert.equal(disposed, true);
});

test("createAgent does not swallow unrelated creation failures", async () => {
  const adapter = createDshAdapter(fakeCtx({
    status: "idle",
    createImpl: async () => { throw new Error("agent factory not ready"); },
    resumeImpl: async () => { throw new Error("unexpected"); },
  }));
  await assert.rejects(() => adapter.createAgent({ sessionId: "x-DSH", worktree: "/w" }), /agent factory not ready/);
});

test("wake and continue target the SAME live handle", async () => {
  const followups = [];
  const adapter = createDshAdapter(fakeCtx({ status: "idle", followup(message) { followups.push(message); } }));
  const binding = { sessionId: "dsh-glasses-S1-#22-DSH", worktree: "/w", bootstrapPrompt: "B1", number: 22, milestone: "S1" };
  await adapter.createAgent(binding);
  await adapter.wakeAgent(binding);
  await adapter.continueAgent(binding);
  assert.equal(followups.length, 2);
  assert.equal(followups[0]?.content?.[0]?.text, "B1", "wake delivers the recorded bootstrap prompt to the same handle");
  assert.match(followups[1]?.content?.[0]?.text ?? "", /Continue Ticket #22/);
});

test("createAgent collision recovery refuses to resume a FOREIGN orphan (cwd mismatch)", async () => {
  let resumed = false;
  const adapter = createDshAdapter(fakeCtx({
    status: "idle",
    createImpl: async () => {
      throw new Error('session "dsh-glasses-S1-#21-DSH" already has a persisted log on disk that does not match this live session (id collision)');
    },
    resumeImpl: async () => { resumed = true; return { agent: { status: "idle", session: { id: "x" } }, async dispose() {} }; },
  }), { sessionLogReader: async () => '{"type":"session/start"}\ncwd=/somewhere/else' });
  const binding = { sessionId: "dsh-glasses-S1-#21-DSH", worktree: "/w", bootstrapPrompt: "bootstrap", milestone: "S1", number: 21 };
  await assert.rejects(() => adapter.createAgent(binding), /already has a persisted log/);
  assert.equal(resumed, false, "a foreign orphan must NOT be resumed as if it were ours");
});

test("createAgent collision recovery resumes when the persisted session belongs to this worktree", async () => {
  let resumed = false;
  const adapter = createDshAdapter(fakeCtx({
    status: "idle",
    createImpl: async () => {
      throw new Error('session "dsh-glasses-S1-#21-DSH" already has a persisted log on disk that does not match this live session (id collision)');
    },
    resumeImpl: async () => { resumed = true; return { agent: { status: "idle", session: { id: "dsh-glasses-S1-#21-DSH" } }, async dispose() {} }; },
  }), { sessionLogReader: async () => `{"type":"session/start"}\ncwd=/w` });
  const binding = { sessionId: "dsh-glasses-S1-#21-DSH", worktree: "/w", bootstrapPrompt: "bootstrap", milestone: "S1", number: 21 };
  await adapter.createAgent(binding);
  assert.equal(resumed, true);
  assert.equal(adapter.isLive(binding), true);
});
