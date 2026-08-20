import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createCodexAdapter, rfc6455Frame } from "../lib/codex.js";

/** In-memory stand-in for the Codex app-server control socket (JSON-RPC 2.0 + notifications). */
class MockCodexClient extends EventEmitter {
  constructor(path, options) {
    super();
    this.path = path;
    this.requests = [];
    this.notifications = [];
    this.responses = new Map();
    this.nextTurn = 1;
    this.closed = false;
  }
  async connect({ clientInfo }) {
    this.requests.push(["initialize", { clientInfo }]);
  }
  async request(method, params, _timeout) {
    this.requests.push([method, params]);
    if (method === "turn/start") {
      const turnId = `turn-${this.nextTurn++}`;
      const threadId = params.threadId;
      if (this.emitCompleted) {
        setImmediate(() => {
          this.emit("notification", { jsonrpc: "2.0", method: "turn/completed", params: { threadId, turnId, status: "completed" } });
        });
      }
      return { turn: { id: turnId } };
    }
    const respond = this.responses.get(method);
    if (respond) {
      if (respond instanceof Error) throw respond;
      return typeof respond === "function" ? respond(params) : respond;
    }
    throw new Error(`mock codex client has no canned response for ${method}`);
  }
  async close() { this.closed = true; }
}

const threadFixture = {
  id: "01a02000-3d49-7f50-8222-86a9be3556d7",
  path: "/home/code2hack/.codex/sessions/rollout.jsonl",
  name: "dsh-glasses-Bootstrap-#19-Codex",
  cwd: "/work",
  model: "gpt-5.6-sol",
  status: { type: "idle" },
  turns: [{ role: "user", items: [{ type: "userMessage", content: [{ type: "inputText", text: "dsh-glasses-Bootstrap-#19-Codex" }] }] }],
};

function makeAdapter({ responses, emitCompleted = true, seedGraceMs = 250, replyTimeoutMs = 250 } = {}) {
  const requests = [];
  const client = new MockCodexClient("/tmp/app-server-control.sock");
  client.emitCompleted = emitCompleted;
  const adapter = createCodexAdapter({
    bin: "codex",
    controlSocket: "/tmp/app-server-control.sock",
    clientFactory: () => client,
    replyTimeoutMs,
    seedGraceMs,
  });
  // The always-set thread/read canned response is what makeAdapter configures; a
  // per-test override simply replaces it before the call that needs it.
  if (responses) for (const [method, value] of Object.entries(responses)) client.responses.set(method, value);
  return {
    adapter,
    client,
    requests,
    // collect requests after each call from the mock
    drain() {
      const taken = client.requests.slice();
      client.requests.length = 0;
      return taken;
    },
  };
}

test("createThread seeds exactly one turn whose text is byte-for-byte the Codex name, then stays idle", async () => {
  const h = makeAdapter();
  h.client.responses.set("thread/start", { thread: { id: threadFixture.id }, model: "gpt-5.6-sol" });
  h.client.responses.set("thread/name/set", {});
  h.client.responses.set("thread/read", { thread: threadFixture });

  const created = await h.adapter.createThread({ cwd: "/work", name: threadFixture.name, thinkingEffort: "max" });
  const calls = h.drain();
  assert.deepEqual(calls.map(([method]) => method), [
    "initialize",
    "thread/start",
    "thread/name/set",
    "turn/start",
    "thread/read",
  ]);
  assert.equal(created.threadId, threadFixture.id);
  assert.equal(created.firstPrompt, "dsh-glasses-Bootstrap-#19-Codex");
  assert.equal(created.status, "idle");
  assert.equal(created.inheritedModel, "gpt-5.6-sol");
  const start = calls.find(([method]) => method === "thread/start");
  assert.deepEqual(start[1], { cwd: "/work", config: { model_reasoning_effort: "max" } });
  assert.equal("model" in start[1], false, "no per-thread model/modal override may be sent");
  assert.equal("profile" in start[1].config, false, "no legacy profile key may be sent");
  const turn = calls.find(([method]) => method === "turn/start");
  assert.deepEqual(turn[1].input, [{ type: "text", text: "dsh-glasses-Bootstrap-#19-Codex" }]);
  assert.equal(turn[1].effort, "max");
  assert.equal(h.client.requests.length, 0, "createThread must perform exactly one seed turn");
});

test("thinking-effort override is the only runtime knob and reaches both thread/start and the seed turn", async () => {
  const h = makeAdapter();
  h.client.responses.set("thread/start", { thread: { id: "t-1" }, model: "gpt-5.6-sol" });
  h.client.responses.set("thread/name/set", {});
  h.client.responses.set("thread/read", { thread: { ...threadFixture, id: "t-1" } });
  await h.adapter.createThread({ cwd: "/work", name: "alpha", thinkingEffort: "low" });
  const calls = h.drain();
  const start = calls.find(([method]) => method === "thread/start");
  assert.deepEqual(start[1].config, { model_reasoning_effort: "low" });
  const turn = calls.find(([method]) => method === "turn/start");
  assert.equal(turn[1].effort, "low");
  assert.equal("model" in start[1], false);
  assert.equal("profile" in start[1].config, false);
});

test("a non-terminal seed fails the publication (idle-seeded means terminal, per the bootstrap contract)", async () => {
  const h = makeAdapter({ emitCompleted: false, seedGraceMs: 250, replyTimeoutMs: 5_000 });
  h.client.responses.set("thread/start", { thread: { id: "t-seed-fail" }, model: null });
  h.client.responses.set("thread/name/set", {});
  // No notification and the thread stays busy ('active'): the dispatcher must
  // NOT publish a pair whose Codex is still processing its only seed.
  h.client.responses.set("thread/read", { thread: { ...threadFixture, id: "t-seed-fail", status: { type: "active" } } });
  await assert.rejects(() => h.adapter.createThread({ cwd: "/work", name: "beta", thinkingEffort: "max" }), /seed turn did not finish/);
});

test("a seed that ends in a failed state rejects before any claim is published", async () => {
  const h = makeAdapter({ emitCompleted: false, seedGraceMs: 4_000, replyTimeoutMs: 20_000 });
  h.client.responses.set("thread/start", { thread: { id: "t-seed-fail" }, model: null });
  h.client.responses.set("thread/name/set", {});
  h.client.responses.set("thread/read", { thread: { ...threadFixture, id: "t-seed-fail", status: { type: "failed" } } });
  await assert.rejects(() => h.adapter.createThread({ cwd: "/work", name: "beta", thinkingEffort: "max" }), /seed turn ended failed/);
});

test("thread/start itself failing rejects before any seed (nothing half-created is seeded)", async () => {
  const h = makeAdapter();
  h.client.responses.set("thread/start", new Error("thread/start fault"));  await assert.rejects(() => h.adapter.createThread({ cwd: "/work", name: "gamma", thinkingEffort: "max" }), /thread\/start fault/);
  const calls = h.drain().map(([method]) => method);
  assert.deepEqual(calls, ["initialize", "thread/start"]);
});

test("readThread reconstructs the same persistent thread by name through the app-server seam", async () => {
  const h = makeAdapter();
  // The app-server surfaces the seeded name as `preview` and leaves `name` null;
  // the seam must find the thread by the observable identity field.
  h.client.responses.set("thread/list", { data: [{ id: threadFixture.id, name: null, preview: threadFixture.name }] });
  h.client.responses.set("thread/read", { thread: threadFixture });
  const found = await h.adapter.readThread({ name: threadFixture.name });
  assert.equal(found.threadId, threadFixture.id);
  assert.equal(found.threadName, threadFixture.name);
  const calls = h.drain().map(([method]) => method);
  assert.deepEqual(calls, ["initialize", "thread/list", "thread/read"]);
});

test("sendMessage posts exactly one review turn to the existing thread", async () => {
  const h = makeAdapter();
  h.client.responses.set("thread/read", { thread: threadFixture });
  const result = await h.adapter.sendMessage({
    threadId: threadFixture.id,
    input: "review the exact head",
    thinkingEffort: "max",
  });
  assert.equal(result.threadId, threadFixture.id);
  const calls = h.drain();
  const turns = calls.filter(([method]) => method === "turn/start");
  assert.equal(turns.length, 1, "one review turn, no extra prompts");
  assert.deepEqual(turns[0][1].input, [{ type: "text", text: "review the exact head" }]);
});

test("rfc6455Frame masks client text frames and preserves the length", () => {
  const frame = rfc6455Frame(Buffer.from("hello"));
  assert.equal(frame[0] & 0x80, 0x80, "FIN set");
  assert.equal(frame[0] & 0x0f, 0x1, "text opcode");
  assert.equal(frame[1] & 0x80, 0x80, "mask set");
  assert.equal(frame[1] & 0x7f, 5, "payload length");
  const mask = frame.subarray(2, 6);
  const masked = frame.subarray(6);
  const unmasked = Buffer.from(masked.map((byte, index) => byte ^ mask[index % 4]));
  assert.equal(unmasked.toString(), "hello");
});
