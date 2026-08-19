import assert from "node:assert/strict";
import { projectEvent } from "../lib/projection.js";

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

console.log("projection.test.mjs: PASS");
