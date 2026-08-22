import assert from "node:assert/strict";
import {
  projectEvent,
  projectAndValidatePage,
  validateCanonicalProjectionPage,
  ProjectionValidationError,
} from "../lib/projection.js";

// Canonical projection now attaches stable blockId to renderable content.
const user = projectEvent({
  seq: 8,
  type: "user/message",
  data: {
    id: "user-1",
    role: "user",
    content: [
      { type: "text", text: "hello" },
      { type: "image", attachmentId: "not-projected" },
      { type: "text", text: " world" },
    ],
    source: { kind: "user", rpcId: "rpc-1" },
  },
});
assert.deepEqual(user, {
  seq: 8,
  type: "user/message",
  blockId: "message:u-user-1",
  message: { role: "user", id: "user-1", text: "hello world", rpcId: "rpc-1" },
});

const delta = projectEvent({
  seq: 14,
  type: "assistant/chunk",
  data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "pass" } },
});
assert.deepEqual(delta, {
  seq: 14,
  type: "assistant/chunk",
  blockId: "partial:1:1",
  turn: 1,
  step: 1,
  chunk: { type: "text-delta", index: 0, text: "pass" },
});

const reasoning = projectEvent({
  seq: 15,
  type: "assistant/chunk",
  data: { turn: 1, step: 1, chunk: { type: "reasoning-delta", index: 1, text: "private" } },
});
assert.deepEqual(reasoning, {
  seq: 15,
  type: "assistant/chunk",
  blockId: "partial:1:1",
  turn: 1,
  step: 1,
  chunk: { type: "reasoning-delta", index: 1 },
});

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
assert.deepEqual(assistant, {
  seq: 21,
  type: "assistant/message",
  blockId: "message:a-assistant-1",
  turn: 1,
  step: 1,
  message: {
    role: "assistant",
    id: "assistant-1",
    text: "TB0 assistant passed",
    provider: "tb0vllm",
    model: "lfm2.5-vl-3b",
  },
  usage: { inputTokens: 30, outputTokens: 5 },
});

assert.deepEqual(projectEvent({ seq: 22, type: "step/end", data: { secret: "not-projected" } }), {
  seq: 22,
  type: "step/end",
});

// Deterministic seq-based fallback when no durable id exists.
assert.equal(
  projectEvent({ seq: 99, type: "user/message", data: { role: "user", content: [{ type: "text", text: "x" }], source: { kind: "user" } } }).blockId,
  "message:u-s99",
);
assert.equal(
  projectEvent({ seq: 100, type: "assistant/message", data: { turn: 0, step: 0, message: { role: "assistant", content: [{ type: "text", text: "y" }], source: { kind: "model", provider: "p", model: "m" } } } }).blockId,
  "message:a-s100",
);

// blockId is STABLE across independent projections of the same durable events.
for (let run = 0; run < 2; run++) {
  assert.equal(projectEvent({ seq: 8, type: "user/message", data: { id: "user-1" } }).blockId, "message:u-user-1");
  assert.equal(projectEvent({ seq: 14, type: "assistant/chunk", data: { turn: 7, step: 3, chunk: { type: "text-delta", index: 0, text: "a" } } }).blockId, "partial:7:3");
  assert.equal(projectEvent({ seq: 21, type: "assistant/message", data: { message: { id: "assistant-1" } } }).blockId, "message:a-assistant-1");
}

// ---- Validation operating on the canonical PROJECTED page (what the snapshot
// builder receives; raw DSH payloads never leak upward for validation) ----

// (a) A well-formed page is accepted.
assert.equal(
  projectAndValidatePage([
    { seq: 0, type: "permission/preset" },
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
  chunkProjected.filter((e) => e.type === "assistant/chunk").map((e) => e.blockId),
  ["partial:2:1", "partial:2:1", "partial:2:1", "partial:2:1"],
);
// All four chunk events share one logical partial identity; the forward
// validator must not treat that repetition as duplication.
assert.equal(validateCanonicalProjectionPage(chunkProjected), true);

// (c) Sequence validation still rejects globally: duplicate, backwards, negative.
for (const [name, bad] of [
  ["duplicate-seq", [{ seq: 3 }, { seq: 3 }]],
  ["backwards-seq", [{ seq: 3 }, { seq: 2 }]],
  ["negative-seq", [{ seq: -1 }]],
]) {
  assert.throws(() => validateCanonicalProjectionPage(bad), (e) => e instanceof ProjectionValidationError && (e.code === "non-monotonic-seq" || e.code === "malformed-seq"), name);
}
assert.throws(() => validateCanonicalProjectionPage(null), (e) => e instanceof ProjectionValidationError && e.code === "malformed-page");

// (d) A repeated MESSAGE identity (two user/message for the same durable id)
// is still a reject.
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

// (e) A projected chunk event that lost its partial blockId is malformed.
assert.throws(
  () =>
    validateCanonicalProjectionPage([
      { seq: 10, type: "assistant/chunk", turn: 2, step: 1, chunk: { type: "text-delta", index: 0, text: "x" } },
    ]),
  (e) => e instanceof ProjectionValidationError && e.code === "malformed-blockId",
);

console.log("projection.test.mjs: PASS");
