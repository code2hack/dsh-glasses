import assert from "node:assert/strict";
import { projectEvent, validateCanonicalProjection, ProjectionValidationError } from "../lib/projection.js";

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

// validateCanonicalProjection: accepts a well-formed page.
assert.equal(
  validateCanonicalProjection([
    { seq: 0, type: "permission/preset" },
    { seq: 1, type: "user/message", data: { id: "u1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } } },
    { seq: 2, type: "assistant/message", data: { turn: 0, step: 0, message: { id: "a1", role: "assistant", content: [{ type: "text", text: "yo" }], source: { kind: "model", provider: "p", model: "m" } } } },
  ]),
  true,
);

// validateCanonicalProjection: rejects duplicate seq, backwards seq, negative seq.
for (const [name, bad] of [
  ["duplicate-seq", [{ seq: 3 }, { seq: 3 }]],
  ["backwards-seq", [{ seq: 3 }, { seq: 2 }]],
  ["negative-seq", [{ seq: -1 }]],
]) {
  assert.throws(() => validateCanonicalProjection(bad), (e) => e instanceof ProjectionValidationError && e.code === "non-monotonic-seq" || e.code === "malformed-seq", name);
}
assert.throws(() => validateCanonicalProjection(null), (e) => e instanceof ProjectionValidationError && e.code === "malformed-page");

// validateCanonicalProjection: rejects duplicate render blockIds.
assert.throws(
  () =>
    validateCanonicalProjection([
      { seq: 1, type: "user/message", data: { id: "same", role: "user", content: [{ type: "text", text: "a" }], source: { kind: "user" } } },
      { seq: 2, type: "user/message", data: { id: "same", role: "user", content: [{ type: "text", text: "b" }], source: { kind: "user" } } },
    ]),
  (e) => e instanceof ProjectionValidationError && e.code === "duplicate-blockId",
);

console.log("projection.test.mjs: PASS");
