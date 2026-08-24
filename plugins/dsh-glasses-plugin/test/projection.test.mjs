import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
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
assert.deepEqual(user.blocks[0], { blockId: "message:u-user-1:content:0", kind: "text", role: "user", text: "hello", contentIndex: 0 });
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
  contentIndex: 1,
});
assert.deepEqual(user.blocks[2], { blockId: "message:u-user-1:content:2", kind: "text", role: "user", text: " world", contentIndex: 2 });
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
  { blockId: "message:a-assistant-1:content:0", kind: "text", role: "assistant", text: "TB0 assistant passed", contentIndex: 0 },
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

// A tool result projects a status/result SHELL plus deterministic nested
// content children (rc.2 ToolResultBlock.content may carry text AND image).
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
  blocks: [
    { blockId: "tool:call-9:result", kind: "tool/result", callId: "call-9", error: false },
    { blockId: "tool:call-9:result:content:0", kind: "text", role: "tool", text: "ok: 42", contentIndex: 0 },
  ],
});

// Nested tool-result content preserves text/image ORDER with stable child
// identities, and images carry only the durable opaque attachment ref + safe
// metadata (never bytes/path/URL) — AC2 no-silent-image-drop + no-leak rule.
const resultMixed = projectEvent({
  seq: 33,
  type: "tool/result",
  data: {
    turn: 1,
    step: 1,
    message: {
      id: "tr-3",
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call-9", isError: false, content: [
        { type: "text", text: "saw " },
        { type: "image", attachment: { attachmentId: "att-tool-2a", mediaType: "image/jpeg", width: 80, height: 60, bytes: 987 } },
        { type: "text", text: "matches" },
      ] }],
      source: { kind: "tool", callId: "call-9" },
    },
  },
});
assert.deepEqual(resultMixed.blocks, [
  { blockId: "tool:call-9:result", kind: "tool/result", callId: "call-9", error: false },
  { blockId: "tool:call-9:result:content:0", kind: "text", role: "tool", text: "saw ", contentIndex: 0 },
  { blockId: "tool:call-9:result:content:1", kind: "image", role: "tool", attachmentId: "att-tool-2a", mediaType: "image/jpeg", width: 80, height: 60, contentIndex: 1 },
  { blockId: "tool:call-9:result:content:2", kind: "text", role: "tool", text: "matches", contentIndex: 2 },
]);

// A failed tool result projects the error flag on the shell (tool error
// projection); the nested visible text still derives a stable content child.
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
  { blockId: "tool:call-9:result", kind: "tool/result", callId: "call-9", error: true },
  { blockId: "tool:call-9:result:content:0", kind: "text", role: "tool", text: "boom", contentIndex: 0 },
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

// Empty-content user/assistant messages are VALID non-renderable events: a
// max-token cutoff assistant message hosts usage/provenance only and must not
// inject a content-less turn. blocks: [] — the durable seq still advances.
const emptyAssistant = projectEvent({
  seq: 65,
  type: "assistant/message",
  data: { turn: 4, step: 0, message: { id: "empty-a", role: "assistant", content: [], source: { kind: "model", provider: "p", model: "m" } }, usage: { inputTokens: 9, outputTokens: 0 } },
});
assert.deepEqual(emptyAssistant, { seq: 65, type: "assistant/message", turn: 4, step: 0, blocks: [] });
const emptyUser = projectEvent({
  seq: 66,
  type: "user/message",
  data: { id: "empty-u", role: "user", content: [], source: { kind: "user" } },
});
assert.deepEqual(emptyUser, { seq: 66, type: "user/message", blocks: [] });

// -- Unknown-type vocabulary law (explicit pinned allowlist, AC5) -------------
// A truly UNRECOGNIZED type skips safely when the rc.2 envelope marks it
// ignorable:true.
const unknownIgnorable = projectEvent({ seq: 63, type: "something/future", ignorable: true, data: { whatever: 1 } });
assert.deepEqual(unknownIgnorable, { seq: 63, type: "something/future", blocks: [] });

// Real rc.2 META records (permission/preset, sandbox/mode, approval/policy)
// are accepted by the EXPLICIT pinned non-renderable allowlist
// (dsh-session known-event-types.js complement), never by a skip heuristic.
// The durable seq advances; nothing renders.
for (const metaType of ["permission/preset", "sandbox/mode", "approval/policy"]) {
  const projected = projectEvent({ seq: 70, type: metaType, data: { whatever: 1 } });
  assert.deepEqual(projected, { seq: 70, type: metaType, blocks: [] }, `pinned non-renderable ${metaType} must classify explicitly`);
}

// An unknown REQUIRED event — absent from the explicit pinned vocabulary AND
// lacking an ignorable marker — FAILS CLOSED (AC5) regardless of whether it
// carries a SurfaceOp. Absence of a SurfaceOp is NOT an implicit ignorable
// marker: rc.2 non-surface events never carry surfaceOp, and that fact does
// not make them ignorable. The projection throws so writes are disabled and
// the caller takes its complete-resynchronization path.
for (const unknown of [
  { seq: 72, type: "some/future-meta", data: { whatever: 1 } },
  { seq: 73, type: "some/future-surface", surfaceOp: "append", data: { whatever: 1 } },
]) {
  assert.throws(
    () => projectEvent(unknown),
    (e) => e instanceof ProjectionValidationError && e.code === "unsupported-required-event",
    `unknown required event ${unknown.type} must reject, never silently skip`,
  );
}

// -- (7b) content-block vocabulary fails closed one layer down -----------------
// rc.2 ContentBlockMap is merge-extensible. An append-origin surface message
// carrying an UNKNOWN content kind must fail closed (AC5), not silently drop
// visible model/user content; 'reasoning' is known non-renderable.
assert.throws(
  () => projectEvent({ seq: 80, type: "user/message", surfaceOp: "append", data: { id: "uX", role: "user", content: [{ type: "text", text: "visible" }, { type: "brand/new-block", value: 1 }], source: { kind: "user" } } }),
  (e) => e instanceof ProjectionValidationError && e.code === "unsupported-required-content-block",
  "unknown message content kind must fail closed",
);
assert.throws(
  () => projectEvent({ seq: 81, type: "tool/result", data: { message: { role: "user", content: [{ type: "tool-result", toolCallId: "t1", isError: false, content: [{ type: "brand/new-block", value: 1 }] }], source: { callId: "t1" } } } }),
  (e) => e instanceof ProjectionValidationError && e.code === "unsupported-required-content-block",
  "unknown nested tool-result content kind must fail closed",
);
const reasoningOnly = projectEvent({
  seq: 82,
  type: "assistant/message",
  data: { turn: 5, step: 0, message: { id: "r-only", role: "assistant", content: [{ type: "reasoning", text: "chain" }], source: { kind: "model", provider: "p", model: "m" } } },
});
assert.deepEqual(reasoningOnly, { seq: 82, type: "assistant/message", turn: 5, step: 0, blocks: [] }, "reasoning-only message is valid non-renderable");

// -- (7c) tool identity is SINGULAR per callId (AC2 no-duplication) -------------
// An assistant message's nested tool-call content and the dedicated tool/call
// durable event CONVERGE to the same stable identity tool:<callId>:call, so
// one logical tool invocation folds into ONE card. The page law accepts the
// repeated stable blockId (repeatable tool kind) — never a duplicate error.
const convergedToolPage = projectAndValidatePage([
  { seq: 90, type: "assistant/message", surfaceOp: "append", data: { turn: 6, step: 1, message: { id: "a-call", role: "assistant", content: [{ type: "text", text: "calling" }, { type: "tool-call", id: "c9", name: "read", arguments: "{}" }, { type: "text", text: "done" }], source: { kind: "model", provider: "p", model: "m" } } } },
  { seq: 91, type: "tool/call", data: { turn: 6, step: 1, callId: "c9", name: "read", arguments: "{}" } },
  { seq: 92, type: "step/end", data: { turn: 6, step: 1 } },
]);
const toolCallIds = convergedToolPage.flatMap((e) => e.blocks.filter((b) => b.kind === "tool/call").map((b) => b.blockId));
assert.deepEqual(toolCallIds, ["tool:c9:call", "tool:c9:call"], "message tool-call + dedicated tool/call converge to one identity");
assert.equal(new Set(toolCallIds).size, 1, "exactly one distinct tool-call card identity");
// message text children keep their correct message-root identities after the
// converged tool block (indices preserved, never renumbered).
const msgEvent = convergedToolPage[0];
assert.deepEqual(
  msgEvent.blocks.filter((b) => b.kind === "text").map((b) => [b.blockId, b.contentIndex]),
  [["message:a-a-call:content:0", 0], ["message:a-a-call:content:2", 2]],
  "message text children keep exact source content indices",
);

// Same convergence for tool RESULTS: message-content tool-result and the
// dedicated tool/result event share the SAME shell + ordered children.
const convergedResultPage = projectAndValidatePage([
  { seq: 100, type: "assistant/message", surfaceOp: "append", data: { turn: 7, step: 1, message: { id: "a-res", role: "assistant", content: [{ type: "tool-result", toolCallId: "r7", isError: false, content: [{ type: "text", text: "result text" }] }], source: { kind: "model", provider: "p", model: "m" } } } },
  { seq: 101, type: "tool/result", data: { message: { role: "user", content: [{ type: "tool-result", toolCallId: "r7", isError: false, content: [{ type: "text", text: "result text" }] }], source: { callId: "r7" } } } },
]);
const resultShellIds = convergedResultPage.flatMap((e) => e.blocks.filter((b) => b.kind === "tool/result").map((b) => b.blockId));
assert.deepEqual(resultShellIds, ["tool:r7:result", "tool:r7:result"], "message tool-result + dedicated tool/result converge to one shell");
assert.equal(new Set(resultShellIds).size, 1, "exactly one distinct tool-result shell identity");

// -- (7d) nested tool-result text/image ordering is preserved exactly -----------
// A dedicated tool/result with nested text->image->text keeps child order via
// the explicit contentIndex (0,1,2) and the page law accepts it.
const orderedResult = projectEvent({
  seq: 110,
  type: "tool/result",
  data: { message: { role: "user", content: [{ type: "tool-result", toolCallId: "ord", isError: false, content: [
    { type: "text", text: "A" },
    { type: "image", attachment: { attachmentId: "att-X", mediaType: "image/webp", width: 12, height: 34 } },
    { type: "text", text: "B" },
  ] }], source: { callId: "ord" } } },
});
assert.deepEqual(
  orderedResult.blocks.map((b) => [b.blockId, b.kind, b.role === undefined ? null : b.role, b.contentIndex]),
  [
    ["tool:ord:result", "tool/result", null, undefined],
    ["tool:ord:result:content:0", "text", "tool", 0],
    ["tool:ord:result:content:1", "image", "tool", 1],
    ["tool:ord:result:content:2", "text", "tool", 2],
  ],
  "nested text->image->text children keep exact order and indices",
);
validateCanonicalProjectionPage([orderedResult]);

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

// ---- (9) surfaceOp semantics: append derives transcript blocks; replace does NOT
// An append-origin surface event is the human transcript's durable source
// material and renders. A positional REPLACEMENT copy (model-surface rewrite,
// e.g. compaction) shadows a range the user already read: it stays in durable
// seq space with blocks: [] so it never renders as another ordinary transcript
// message (rc.2 isAppendSurfaceEvent / isReplacementSurfaceEvent oracle).
const appended = projectEvent({
  seq: 70,
  type: "assistant/message",
  surfaceOp: "append",
  data: { turn: 3, step: 0, message: { id: "m70", role: "assistant", content: [{ type: "text", text: "z" }], source: { kind: "model", provider: "p", model: "m" } } },
});
assert.deepEqual(appended.blocks.map(id), ["message:a-m70:content:0"]);
assert.equal(appended.blocks[0].text, "z");

const replaced = projectEvent({
  seq: 70,
  type: "assistant/message",
  surfaceOp: { op: "replace", start: 0, end: 4 },
  data: { turn: 3, step: 0, message: { id: "m70", role: "assistant", content: [{ type: "text", text: "compaction summary" }], source: { kind: "model", provider: "p", model: "m" } } },
});
assert.deepEqual(replaced, { seq: 70, type: "assistant/message", blocks: [] },
  "replacement surface copies stay model-only: seq advances, no transcript block");

// Same for a replaced user message and a replaced tool result (the whole
// surface-eligible vocabulary).
assert.deepEqual(projectEvent({ seq: 71, type: "user/message", surfaceOp: { op: "replace", start: 0, end: 4 }, data: { id: "u70", role: "user", content: [{ type: "text", text: "x" }], source: { kind: "user" } } }),
  { seq: 71, type: "user/message", blocks: [] });
assert.deepEqual(projectEvent({ seq: 72, type: "tool/result", surfaceOp: { op: "replace", start: 0, end: 4 }, data: { turn: 3, step: 0, message: { id: "tr70", role: "tool", content: [{ type: "tool-result", toolCallId: "c70", isError: false, content: [{ type: "text", text: "y" }] }], source: { kind: "tool", callId: "c70" } } } }),
  { seq: 72, type: "tool/result", blocks: [] });

// A replace-folded canonical event is a VALID non-renderable page entry: the
// wire law accepts blocks: [] for user/assistant messages, so the snapshot can
// still adopt it and keep watermarks monotonic.
assert.equal(
  validateCanonicalProjectionPage([
    { seq: 70, type: "assistant/message", blocks: [] },
    { seq: 71, type: "user/message", blocks: [] },
  ]),
  true,
  "replacement-folded message events (blocks: []) are valid non-renderable page entries",
);

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
  ["duplicate-seq", [{ seq: 3, type: "user/message", blocks: [{ blockId: "message:u-a:content:0", kind: "text", role: "user", text: "x", contentIndex: 0 }] }, { seq: 3, type: "user/message", blocks: [{ blockId: "message:u-b:content:0", kind: "text", role: "user", text: "y", contentIndex: 0 }] }]],
  ["backwards-seq", [{ seq: 3, type: "user/message", blocks: [{ blockId: "message:u-a:content:0", kind: "text", role: "user", text: "x", contentIndex: 0 }] }, { seq: 2, type: "user/message", blocks: [{ blockId: "message:u-b:content:0", kind: "text", role: "user", text: "y", contentIndex: 0 }] }]],
  ["negative-seq", [{ seq: -1, type: "user/message", blocks: [{ blockId: "message:u-a:content:0", kind: "text", role: "user", text: "x", contentIndex: 0 }] }]],
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

// (f) An empty-content message event is VALID — NOT malformed. It renders
// nothing, the durable seq advances, and the page law accepts it.
assert.equal(
  validateCanonicalProjectionPage([
    { seq: 65, type: "assistant/message", turn: 4, step: 0, blocks: [] },
    { seq: 66, type: "user/message", blocks: [] },
  ]),
  true,
  "empty-content message events are valid non-renderable page entries",
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

// ---- (i) contentIndex law: explicit canonical index, validated against the
// :content:<i> suffix — ordering NEVER reparses the opaque message id.
// Missing contentIndex on a content child is rejected.
assert.throws(
  () =>
    validateCanonicalProjectionPage([
      { seq: 1, type: "user/message", blocks: [{ blockId: "message:u-u1:content:0", kind: "text", role: "user", text: "x" }] },
    ]),
  (e) => e instanceof ProjectionValidationError && e.code === "content-index-mismatch",
);
// A contentIndex that disagrees with the blockId suffix is rejected.
assert.throws(
  () =>
    validateCanonicalProjectionPage([
      { seq: 1, type: "user/message", blocks: [{ blockId: "message:u-u1:content:1", kind: "text", role: "user", text: "x", contentIndex: 0 }] },
    ]),
  (e) => e instanceof ProjectionValidationError && e.code === "content-index-mismatch",
);
// A tool-result content child with a mismatched contentIndex is rejected too.
assert.throws(
  () =>
    validateCanonicalProjectionPage([
      { seq: 1, type: "tool/result", blocks: [
        { blockId: "tool:c1:result", kind: "tool/result", callId: "c1", error: false },
        { blockId: "tool:c1:result:content:0", kind: "text", role: "tool", text: "x", contentIndex: 5 },
      ] },
    ]),
  (e) => e instanceof ProjectionValidationError && e.code === "content-index-mismatch",
);

// ---- (j) tool/result page law: a result SHELL is required and children must
// be rooted under it with role 'tool' (fail closed).
// Missing shell -> tool-result-shell-mismatch.
assert.throws(
  () =>
    validateCanonicalProjectionPage([
      { seq: 1, type: "tool/result", blocks: [
        { blockId: "tool:c1:result:content:0", kind: "text", role: "tool", text: "x", contentIndex: 0 },
      ] },
    ]),
  (e) => e instanceof ProjectionValidationError && e.code === "tool-result-shell-mismatch",
);
// Child not rooted under its shell -> blockId-root-mismatch.
assert.throws(
  () =>
    validateCanonicalProjectionPage([
      { seq: 1, type: "tool/result", blocks: [
        { blockId: "tool:c1:result", kind: "tool/result", callId: "c1", error: false },
        { blockId: "tool:other:result:content:0", kind: "text", role: "tool", text: "x", contentIndex: 0 },
      ] },
    ]),
  (e) => e instanceof ProjectionValidationError && e.code === "blockId-root-mismatch",
);
// Child with the wrong role -> type-role-mismatch.
assert.throws(
  () =>
    validateCanonicalProjectionPage([
      { seq: 1, type: "tool/result", blocks: [
        { blockId: "tool:c1:result", kind: "tool/result", callId: "c1", error: false },
        { blockId: "tool:c1:result:content:0", kind: "text", role: "assistant", text: "x", contentIndex: 0 },
      ] },
    ]),
  (e) => e instanceof ProjectionValidationError && e.code === "type-role-mismatch",
);
// A valid nested tool-result page (shell + children) is ACCEPTED.
assert.equal(
  validateCanonicalProjectionPage([
    { seq: 1, type: "tool/result", blocks: [
      { blockId: "tool:c1:result", kind: "tool/result", callId: "c1", error: false },
      { blockId: "tool:c1:result:content:0", kind: "text", role: "tool", text: "ok", contentIndex: 0 },
      { blockId: "tool:c1:result:content:1", kind: "image", role: "tool", attachmentId: "att-9", mediaType: "image/png", width: 10, height: 10, contentIndex: 1 },
    ] },
  ]),
  true,
  "valid nested tool-result pages are accepted",
);

// ---- DRIFT GUARD: pinned rc.2 vocabulary is fully classified -----------------
// ChatGPT: the non-renderable handling must come from an EXPLICIT allowlist
// — ideally exhaustively from the pinned rc.2 type declarations/runtime
// corpus — NOT from a skip heuristic. This guard resolves the INSTALLED pinned
// @deepseek-ai/dsh-session generated catalog (known-event-types.js) and proves
// that EVERY type the persistence read path understands is either projected or
// explicitly allowlisted: projectEvent must never throw unsupported-required-
// event on a benign probe. A future DSH upgrade that adds a required event
// type will FAIL here until the projection allowlist is updated deliberately.
function resolvePinnedDshRoot() {
  const bin = process.env.DSH_BIN || "dsh";
  let resolved = null;
  try {
    resolved = realpathSync(execFileSync("which", [bin], { encoding: "utf8" }).trim());
  } catch {
    return null;
  }
  let current = dirname(resolved);
  for (let i = 0; i < 16; i += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(current, "package.json"), "utf8"));
      if (pkg.name === "@deepseek-ai/dsh") return current;
    } catch { /* keep walking */ }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

( () => {
  const root = resolvePinnedDshRoot();
  if (!root) {
    console.log("[drift-guard] pinned @deepseek-ai/dsh root not resolvable via DSH_BIN; registry coverage check skipped");
    return;
  }
  const registryPath = join(root, "node_modules", "@deepseek-ai", "dsh-session", "lib", "types", "known-event-types.js");
  let src = null;
  try {
    src = readFileSync(registryPath, "utf8");
  } catch {
    console.log(`[drift-guard] pinned registry ${registryPath} not readable; check skipped`);
    return;
  }
  const pinned = [...src.matchAll(/^\s*'([a-z][a-z0-9/-]*)',?\s*$/gm)].map((m) => m[1]);
  assert.ok(pinned.length > 0, "pinned catalog must be non-empty");
  for (const t of pinned) {
    assert.doesNotThrow(
      () => projectEvent({ seq: 1, type: t, data: {} }),
      `pinned rc.2 event type ${t} must be classified by the explicit allowlist or a projection branch — never rejected as unknown-required`,
    );
  }
  console.log(`[drift-guard] all ${pinned.length} pinned rc.2 event types classified without unsupported-required-event`);
})();

console.log("projection.test.mjs: PASS");
