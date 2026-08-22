import assert from "node:assert/strict";
import {
  projectEvent,
  projectAndValidatePage,
  validateCanonicalProjectionPage,
  ProjectionValidationError,
} from "../lib/projection.js";

// T28-02 canonical projection suite.
//
// Raw rc.2 durable events are projected to the canonical glasses form
// { seq, type, blocks[] }: the DSH source type is preserved verbatim and ZERO
// OR MORE typed projection blocks are DERIVED (text/image/tool/status/error/
// request/partial). A valid but non-renderable event yields blocks: [] while
// advancing the durable watermark.
//
// Evidence targets: AC2 (assistant/tool/status/request/error/image live block
// updates without duplicating durable history) — every block carries a stable
// deterministic identity; replay produces byte-identical ordered block IDs;
// raw DSH/storage/internal payloads and raw positional surfaceOp semantics are
// never leaked.

const id = (block) => block.blockId;

// ---- (1) user message: ordered mixed content, child identities -------------
const user = projectEvent({
  seq: 8,
  type: "user/message",
  data: {
    id: "user-1",
    role: "user",
    content: [
      { type: "text", text: "hello" },
      {
        type: "image",
        attachment: {
          attachmentId: "att-img-7f3a",
          mediaType: "image/png",
          bytes: 1234,
          width: 40,
          height: 30,
          name: "photo.png",
        },
      },
      { type: "text", text: " world" },
    ],
    source: { kind: "user", rpcId: "rpc-1" },
  },
});
assert.equal(user.type, "user/message");
assert.equal(user.seq, 8);
assert.deepEqual(user.blocks.map(id), [
  "message:u-user-1:content:0",
  "message:u-user-1:content:1",
  "message:u-user-1:content:2",
]);
assert.deepEqual(user.blocks[0], { blockId: "message:u-user-1:content:0", kind: "text", role: "user", text: "hello" });
// Image block carries ONLY the safe opaque attachment identity — never a
// filesystem path, bearer URL, or base64 dump.
assert.deepEqual(user.blocks[1], {
  blockId: "message:u-user-1:content:1",
  kind: "image",
  role: "user",
  attachmentId: "att-img-7f3a",
  mediaType: "image/png",
  width: 40,
  height: 30,
});
assert.deepEqual(user.blocks[2], { blockId: "message:u-user-1:content:2", kind: "text", role: "user", text: " world" });
// No raw DSH/internals leaked onto the canonical event.
assert.deepEqual(Object.keys(user).sort(), ["blocks", "seq", "type"]);
assert.ok(!("message" in user) && !("data" in user) && !("chunk" in user) && !("usage" in user));

// ---- (2) assistant chunk: partial block identity ---------------------------
const delta = projectEvent({
  seq: 14,
  type: "assistant/chunk",
  data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "pass" } },
});
assert.deepEqual(delta, {
  seq: 14,
  type: "assistant/chunk",
  blocks: [{
    blockId: "partial:1:1",
    kind: "partial",
    turn: 1,
    step: 1,
    chunk: { type: "text-delta", index: 0, text: "pass" },
  }],
});

// Reasoning deltas fold into the same partial stream (bounded canonical form).
const reasoning = projectEvent({
  seq: 15,
  type: "assistant/chunk",
  data: { turn: 1, step: 1, chunk: { type: "reasoning-delta", index: 1, text: "private" } },
});
assert.deepEqual(reasoning, {
  seq: 15,
  type: "assistant/chunk",
  blocks: [{
    blockId: "partial:1:1",
    kind: "partial",
    turn: 1,
    step: 1,
    chunk: { type: "reasoning-delta", index: 1 },
  }],
});

// ---- (3) assistant final message: text child + turn/step retained ----------
const assistant = projectEvent({
  seq: 21,
  type: "assistant/message",
  data: {
    turn: 1,
    step: 1,
    message: {
      id: "assistant-1",
      role: "assistant",
      content: [{ type: "text", text: "TB0 assistant passed" }],
      source: { kind: "model", provider: "tb0vllm", model: "lfm2.5-vl-3b" },
    },
    usage: { inputTokens: 30, outputTokens: 5 },
  },
});
assert.equal(assistant.type, "assistant/message");
assert.equal(assistant.turn, 1);
assert.equal(assistant.step, 1);
assert.deepEqual(assistant.blocks, [
  { blockId: "message:a-assistant-1:content:0", kind: "text", role: "assistant", text: "TB0 assistant passed" },
]);
assert.ok(!("usage" in assistant) && !("message" in assistant), "raw usage/message payloads must not leak");

// Interrupted assistant message carries a bounded error projection on top of
// its delivered text (tool/turn/interruption error projection).
const interrupted = projectEvent({
  seq: 22,
  type: "assistant/message",
  data: {
    turn: 2,
    step: 0,
    interrupted: true,
    message: { id: "inter-1", role: "assistant", content: [{ type: "text", text: "partial answer" }], source: { kind: "model", provider: "p", model: "m" } },
  },
});
assert.deepEqual(interrupted.blocks.map((b) => [b.kind, b.blockId]), [
  ["text", "message:a-inter-1:content:0"],
  ["error", "error:message:message:a-inter-1"],
]);

// ---- (4) tool call / tool result projection -------------------------------
const call = projectEvent({
  seq: 30,
  type: "tool/call",
  data: { turn: 1, step: 1, callId: "call-9", name: "dsh-tool-fs.read", arguments: '{"path":"a.txt"}' },
});
assert.deepEqual(call, {
  seq: 30,
  type: "tool/call",
  blocks: [{ blockId: "tool:call-9:call", kind: "tool/call", callId: "call-9", name: "dsh-tool-fs.read", arguments: '{"path":"a.txt"}' }],
});

const result = projectEvent({
  seq: 31,
  type: "tool/result",
  data: {
    turn: 1,
    step: 1,
    message: {
      id: "tr-1",
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call-9", isError: false, content: [{ type: "text", text: "ok: 42" }] }],
      source: { kind: "tool", callId: "call-9" },
    },
  },
});
assert.deepEqual(result, {
  seq: 31,
  type: "tool/result",
  blocks: [{ blockId: "tool:call-9:result", kind: "tool/result", callId: "call-9", text: "ok: 42", error: false }],
});

// A failed tool result projects the error flag (tool error projection).
const failedResult = projectEvent({
  seq: 32,
  type: "tool/result",
  data: {
    turn: 1,
    step: 1,
    message: {
      id: "tr-2",
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call-9", isError: true, content: [{ type: "text", text: "boom" }] }],
      source: { kind: "tool", callId: "call-9" },
    },
    error: { name: "Bad", code: "E2BIG" },
  },
});
assert.deepEqual(failedResult.blocks, [
  { blockId: "tool:call-9:result", kind: "tool/result", callId: "call-9", text: "boom", error: true },
]);

// ---- (5) turn start/end status + error projection --------------------------
const turnStart = projectEvent({ seq: 40, type: "turn/start", data: { turn: 4 } });
assert.deepEqual(turnStart, {
  seq: 40,
  type: "turn/start",
  blocks: [{ blockId: "status:turn:4", kind: "status", turn: 4, state: "running" }],
});

const turnEndIdle = projectEvent({ seq: 41, type: "turn/end", data: { turn: 4, reason: { kind: "stop" } } });
assert.deepEqual(turnEndIdle, {
  seq: 41,
  type: "turn/end",
  blocks: [{ blockId: "status:turn:4", kind: "status", turn: 4, state: "idle" }],
});

const turnEndError = projectEvent({
  seq: 42,
  type: "turn/end",
  data: { turn: 5, reason: { kind: "error", error: { message: "provider timeout" } } },
});
assert.deepEqual(turnEndError.blocks, [
  { blockId: "status:turn:5", kind: "status", turn: 5, state: "idle" },
  { blockId: "error:turn:5", kind: "error", turn: 5, message: "provider timeout" },
]);

// ---- (6) request header / context projection ------------------------------
const reqContext = projectEvent({
  seq: 50,
  type: "request/context",
  data: { provider: "openai", model: "gpt-4o", contextWindow: 128000 },
});
assert.deepEqual(reqContext, {
  seq: 50,
  type: "request/context",
  blocks: [{ blockId: "request:s50", kind: "request", provider: "openai", model: "gpt-4o" }],
});

const reqHeader = projectEvent({
  seq: 51,
  type: "request/header",
  data: { header: { visibleText: "asking dsh to look this up" }, reason: "goal" },
});
assert.deepEqual(reqHeader, {
  seq: 51,
  type: "request/header",
  blocks: [{ blockId: "request:s51", kind: "request", reason: "goal" }],
});

// ---- (7) valid non-renderable source events -> blocks: [] -----------------
const nonRenderable = projectEvent({ seq: 60, type: "step/end", data: { turn: 1, step: 1 } });
assert.deepEqual(nonRenderable, { seq: 60, type: "step/end", blocks: [] });
const todo = projectEvent({ seq: 61, type: "todo/write", data: { todos: [{ id: "t", title: "x" }] } });
assert.deepEqual(todo, { seq: 61, type: "todo/write", blocks: [] });
const endSeed = projectEvent({ seq: 62, type: "session/end-seed", data: {} });
assert.deepEqual(endSeed, { seq: 62, type: "session/end-seed", blocks: [] });
const unknown = projectEvent({ seq: 63, type: "something/future", data: { whatever: 1 } });
assert.deepEqual(unknown, { seq: 63, type: "something/future", blocks: [] });

// ---- (8) replay is deterministic: identical ordered stable block IDs -------
const rawPage = [
  { seq: 1, type: "user/message", data: { id: "u1", role: "user", content: [ { type: "text", text: "hi" }, { type: "image", attachment: { attachmentId: "att-1", mediaType: "image/webp", width: 10, height: 10 } } ], source: { kind: "user" } } },
  { seq: 2, type: "assistant/chunk", data: { turn: 0, step: 0, chunk: { type: "block-start", index: 0, blockType: "text" } } },
  { seq: 3, type: "assistant/chunk", data: { turn: 0, step: 0, chunk: { type: "text-delta", index: 0, text: "par" } } },
  { seq: 4, type: "tool/call", data: { turn: 0, step: 0, callId: "c1", name: "read", arguments: "{}" } },
  { seq: 5, type: "turn/start", data: { turn: 0 } },
  { seq: 6, type: "request/context", data: { provider: "p", model: "m" } },
  { seq: 7, type: "assistant/message", data: { turn: 0, step: 0, message: { id: "a1", role: "assistant", content: [{ type: "text", text: "final" }], source: { kind: "model", provider: "p", model: "m" } } } },
  { seq: 8, type: "step/end", data: { turn: 0, step: 0 } },
];
const replayA = projectAndValidatePage(rawPage.map((e) => ({ ...e })));
const replayB = projectAndValidatePage(rawPage.map((e) => ({ ...e })));
assert.deepEqual(
  replayA.map((e) => ({ seq: e.seq, type: e.type, blocks: e.blocks.map((b) => b.blockId) })),
  replayB.map((e) => ({ seq: e.seq, type: e.type, blocks: e.blocks.map((b) => b.blockId) })),
  "replay must reproduce identical ordered block identities",
);

// ---- (9) surfaceOp is normalized away: append vs replace project identically
// The canon FORM must not depend on position ranges; both forms collapse to the
// same stable child identities.
const appended = projectEvent({
  seq: 70,
  type: "assistant/message",
  surfaceOp: { op: "append", start: 3, end: 3 },
  data: { turn: 3, step: 0, message: { id: "m70", role: "assistant", content: [{ type: "text", text: "z" }], source: { kind: "model", provider: "p", model: "m" } } },
});
const replaced = projectEvent({
  seq: 70,
  type: "assistant/message",
  surfaceOp: { op: "replace", start: 0, end: 4 },
  data: { turn: 3, step: 0, message: { id: "m70", role: "assistant", content: [{ type: "text", text: "z" }], source: { kind: "model", provider: "p", model: "m" } } },
});
assert.deepEqual(appended.blocks, replaced.blocks, "surfaceOp must not leak into projection blocks");

// ---- (10) deterministic seq-fallback identity (no durable id) --------------
const fallbackUser = projectEvent({ seq: 99, type: "user/message", data: { role: "user", content: [{ type: "text", text: "x" }], source: { kind: "user" } } });
assert.deepEqual(fallbackUser.blocks.map(id), ["message:u-s99:content:0"]);
const fallbackAsst = projectEvent({ seq: 100, type: "assistant/message", data: { turn: 0, step: 0, message: { role: "assistant", content: [{ type: "text", text: "y" }], source: { kind: "model", provider: "p", model: "m" } } } });
assert.deepEqual(fallbackAsst.blocks.map(id), ["message:a-s100:content:0"]);

// ---- (11) validation over the canonical PROJECTED page ---------------------
// (a) A well-formed mixed page is accepted.
assert.equal(
  projectAndValidatePage([
    { seq: 0, type: "todo/write", data: { todos: [] } },
    { seq: 1, type: "user/message", data: { id: "u1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } } },
    { seq: 2, type: "assistant/message", data: { turn: 0, step: 0, message: { id: "a1", role: "assistant", content: [{ type: "text", text: "yo" }], source: { kind: "model", provider: "p", model: "m" } } } },
  ]).length,
  3,
);

// (b) A normal chunk stream — repeated partial identity across block-start,
// text-delta, text-delta, block-end — is VALID, not a duplicate-blockId reject.
const chunkStream = [
  { seq: 10, type: "assistant/chunk", data: { turn: 2, step: 1, chunk: { type: "block-start", index: 0, blockType: "text" } } },
  { seq: 11, type: "assistant/chunk", data: { turn: 2, step: 1, chunk: { type: "text-delta", index: 0, text: "par" } } },
  { seq: 12, type: "assistant/chunk", data: { turn: 2, step: 1, chunk: { type: "text-delta", index: 1, text: "tial" } } },
  { seq: 13, type: "assistant/chunk", data: { turn: 2, step: 1, chunk: { type: "block-end", index: 0, text: "partial" } } },
  { seq: 20, type: "assistant/message", data: { turn: 2, step: 1, message: { id: "a2", role: "assistant", content: [{ type: "text", text: "final" }], source: { kind: "model", provider: "p", model: "m" } } } },
];
const chunkProjected = projectAndValidatePage(chunkStream);
assert.deepEqual(
  chunkProjected.filter((e) => e.type === "assistant/chunk").map((e) => e.blocks.map(id)),
  [["partial:2:1"], ["partial:2:1"], ["partial:2:1"], ["partial:2:1"]],
);
assert.equal(validateCanonicalProjectionPage(chunkProjected), true);

// (b2) A same-block STATUS update (running -> idle at two different seqs) is
// a stable-block update, NOT a duplicate — both events are valid.
assert.equal(
  validateCanonicalProjectionPage([
    { seq: 1, type: "turn/start", data: { turn: 7 } },
    { seq: 2, type: "turn/end", data: { turn: 7, reason: { kind: "stop" } } },
  ].map(projectEvent)),
  true,
);

// (c) Sequence validation still rejects globally: duplicate, backwards, negative.
for (const [name, bad] of [
  ["duplicate-seq", [{ seq: 3, type: "user/message", blocks: [{ blockId: "message:u-a:content:0", kind: "text", role: "user", text: "x" }] }, { seq: 3, type: "user/message", blocks: [{ blockId: "message:u-b:content:0", kind: "text", role: "user", text: "y" }] }]],
  ["backwards-seq", [{ seq: 3, type: "user/message", blocks: [{ blockId: "message:u-a:content:0", kind: "text", role: "user", text: "x" }] }, { seq: 2, type: "user/message", blocks: [{ blockId: "message:u-b:content:0", kind: "text", role: "user", text: "y" }] }]],
  ["negative-seq", [{ seq: -1, type: "user/message", blocks: [{ blockId: "message:u-a:content:0", kind: "text", role: "user", text: "x" }] }]],
]) {
  assert.throws(() => validateCanonicalProjectionPage(bad), (e) => e instanceof ProjectionValidationError && (e.code === "non-monotonic-seq" || e.code === "malformed-seq"), name);
}
assert.throws(() => validateCanonicalProjectionPage(null), (e) => e instanceof ProjectionValidationError && e.code === "malformed-page");

// (d) A repeated MESSAGE identity (two user/message for the same durable id)
// is still a duplicate-child-blockId reject.
for (const fn of [projectAndValidatePage, (evts) => validateCanonicalProjectionPage(evts.map(projectEvent))]) {
  assert.throws(
    () =>
      fn([
        { seq: 1, type: "user/message", data: { id: "same", role: "user", content: [{ type: "text", text: "a" }], source: { kind: "user" } } },
        { seq: 2, type: "user/message", data: { id: "same", role: "user", content: [{ type: "text", text: "b" }], source: { kind: "user" } } },
      ]),
    (e) => e instanceof ProjectionValidationError && e.code === "duplicate-blockId",
  );
}

// (d2) A canonical event missing its blocks array is rejected (never sorted).
assert.throws(
  () =>
    validateCanonicalProjectionPage([
      { seq: 1, type: "user/message", message: { text: "x" } },
    ]),
  (e) => e instanceof ProjectionValidationError && e.code === "malformed-blocks",
);

// (e) A chunk event with no partial block is malformed.
assert.throws(
  () =>
    validateCanonicalProjectionPage([
      { seq: 10, type: "assistant/chunk", turn: 2, step: 1, blocks: [] },
    ]),
  (e) => e instanceof ProjectionValidationError && e.code === "chunk-no-block",
);

// (f) A message event that lost its content children is malformed.
assert.throws(
  () =>
    validateCanonicalProjectionPage([
      { seq: 1, type: "user/message", blocks: [] },
    ]),
  (e) => e instanceof ProjectionValidationError && e.code === "message-no-blocks",
);

// (g) A wrongly-rooted message child blockId is rejected.
assert.throws(
  () =>
    validateCanonicalProjectionPage([
      { seq: 1, type: "user/message", blocks: [{ blockId: "message:a-u1:content:0", kind: "text", role: "user", text: "x" }] },
    ]),
  (e) => e instanceof ProjectionValidationError && e.code === "blockId-root-mismatch",
);

// (h) An unknown block kind is rejected on the wire.
assert.throws(
  () =>
    validateCanonicalProjectionPage([
      { seq: 1, type: "user/message", blocks: [{ blockId: "message:u-u1:content:0", kind: "banana", text: "x" }] },
    ]),
  (e) => e instanceof ProjectionValidationError && e.code === "unknown-block-kind",
);

console.log("projection.test.mjs: PASS");
