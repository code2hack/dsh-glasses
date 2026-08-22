// T27-04 pure snapshot-builder suite: the canonical M1 snapshot contract is
// produced exactly, and every contract violation fails closed.
import assert from "node:assert/strict";
import {
  buildCanonicalSnapshot,
  validateSnapshotWire,
  SnapshotValidationError,
  M1_PROTOCOL_MAJOR,
  M1_ATTACHMENT_SET_REVISION,
  M1_ATTACHMENT_GENERATION,
  M1_ATTACHMENT_LABEL,
  M1_BOOTSTRAP_MAX_EVENTS,
} from "../lib/snapshot.js";

const SESSION = "session-real-a";
const SERVER_GENERATION = "gen-abc123";
const EPOCH_A = "epoch-1-aaaa";
const EPOCH_B = "epoch-2-bbbb";

function canonicalEvents() {
  return [
    { seq: 1, type: "user/message", blockId: "message:u-u1", message: { role: "user", id: "u1", text: "hello", rpcId: "r" } },
    { seq: 2, type: "assistant/chunk", blockId: "partial:1:1", turn: 1, step: 1, chunk: { type: "block-start", index: 0, blockType: "text" } },
    { seq: 3, type: "assistant/chunk", blockId: "partial:1:1", turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "par" } },
    { seq: 4, type: "assistant/message", blockId: "message:a-a1", turn: 1, step: 1, message: { role: "assistant", id: "a1", text: "final", provider: "p", model: "m" } },
  ];
}

function baseArgs(over = {}) {
  return {
    sessionId: SESSION,
    attachmentId: `att-6f1e0a2b3c4d`,
    projected: { asOfSeq: 4, events: canonicalEvents() },
    agentState: "idle",
    serverGeneration: SERVER_GENERATION,
    connectionEpoch: EPOCH_A,
    maxEvents: M1_BOOTSTRAP_MAX_EVENTS,
    ...over,
  };
}

// ---- Positive: the exact normative snapshot is built (no envelope `ok`) ----
{
  const snap = buildCanonicalSnapshot(baseArgs());
  assert.equal(Object.hasOwn(snap, "ok"), false, "the canonical snapshot IS the HTTP-200 body; no envelope ok field");
  assert.equal(snap.protocolMajor, M1_PROTOCOL_MAJOR);
  assert.equal(snap.serverGeneration, SERVER_GENERATION);
  assert.equal(snap.connectionEpoch, EPOCH_A);
  assert.equal(snap.attachmentSetRevision, M1_ATTACHMENT_SET_REVISION);
  assert.equal(snap.streamSequence, 4);
  assert.deepEqual(snap.drafts, []);
  assert.equal(snap.attachments.length, 1);
  const a = snap.attachments[0];
  assert.equal(a.attachmentId, "att-6f1e0a2b3c4d");
  assert.notEqual(a.attachmentId, SESSION);
  assert.equal(a.attachmentId.includes(SESSION), false, "attachmentId must not encode sessionId");
  assert.equal(a.attachmentGeneration, M1_ATTACHMENT_GENERATION);
  assert.equal(a.sessionId, SESSION);
  assert.equal(a.label, M1_ATTACHMENT_LABEL);
  assert.equal(a.order, 0);
  assert.equal(a.state, "idle");
  assert.deepEqual(a.capabilities, { historyRead: true, liveUpdates: false, draftMutations: false, send: false, steer: false, interrupt: false, resolveRequest: false });
  assert.equal(a.agent.state, a.state);
  assert.equal(a.agent.serverGeneration, SERVER_GENERATION);
  assert.equal(a.agent.attachmentGeneration, a.attachmentGeneration);
  assert.equal(a.history.serverGeneration, SERVER_GENERATION);
  assert.equal(a.history.attachmentGeneration, a.attachmentGeneration);
  assert.equal(a.history.asOfSeq, 4);
  assert.equal(a.history.events.length, 4);
  assert.equal(snap.attachments.length, 1);
  console.log("[snapshot-builder] canonical positive fixture: PASS");
}

// attachmentId is stable across bootstraps of the SAME attachment lifetime.
assert.equal(buildCanonicalSnapshot(baseArgs({ connectionEpoch: EPOCH_B })).attachments[0].attachmentId, "att-6f1e0a2b3c4d");

// A fresh connectionEpoch must be passed per bootstrap; the builder never
// fabricates or reuses one.
assert.equal(buildCanonicalSnapshot(baseArgs({ connectionEpoch: EPOCH_B })).connectionEpoch, EPOCH_B);

// ---- Negative: every contract violation fails closed (nothing normalized) ----
const rejects = (over, code, label) => {
  assert.throws(
    () => buildCanonicalSnapshot(baseArgs(over)),
    (e) => e instanceof SnapshotValidationError && e.code === code,
    label,
  );
};
rejects({ sessionId: "" }, "invalid-sessionId", "empty sessionId");
rejects({ attachmentId: undefined }, "invalid-attachmentId", "missing attachmentId");
rejects({ attachmentId: "" }, "invalid-attachmentId", "empty attachmentId");
rejects({ attachmentId: SESSION }, "attachmentId-encodes-session", "attachmentId equals sessionId");
rejects({ attachmentId: `x-${SESSION}-y` }, "attachmentId-encodes-session", "attachmentId contains sessionId");
rejects({ projected: { asOfSeq: 4, events: {} } }, "malformed-projected", "events not an array");
rejects({ projected: { asOfSeq: "4", events: [] } }, "malformed-asOfSeq", "asOfSeq not integer");
rejects({ serverGeneration: "" }, "invalid-serverGeneration", "empty serverGeneration");
rejects({ connectionEpoch: "" }, "invalid-connectionEpoch", "empty connectionEpoch");
rejects({ agentState: "bogus" }, "invalid-agent-state", "state outside vocabulary");
rejects({ maxEvents: 3 }, "history-beyond-bound", "history length beyond configured bound");
rejects({ maxEvents: 2 }, "history-beyond-bound", "history length beyond smaller bound");

// duplicate message blockId (cross-session invariance)
rejects(
  {
    projected: {
      asOfSeq: 5,
      events: [
        { seq: 1, type: "user/message", blockId: "message:u-u1", message: { role: "user", id: "u1", text: "a" } },
        { seq: 2, type: "user/message", blockId: "message:u-u1", message: { role: "user", id: "u1", text: "b" } },
      ],
    },
  },
  "duplicate-blockId",
  "duplicate message blockId",
);
// non-monotonic seq
rejects(
  { projected: { asOfSeq: 2, events: [{ seq: 3 }, { seq: 2 }].map((e, i) => ({ ...e, type: "step/end" })) } },
  "non-monotonic-seq",
  "backwards seq",
);
// event seq beyond asOfSeq
rejects({ projected: { asOfSeq: 3, events: [{ seq: 5, type: "step/end" }] } }, "seq-beyond-asOfSeq", "event seq > asOfSeq");
// last event seq != asOfSeq
rejects({ projected: { asOfSeq: 9, events: [{ seq: 1, type: "step/end" }] } }, "asOfSeq-mismatch", "asOfSeq mismatch with last event");
// history beyond the HARD max (config cannot remove the hard cap)
{
  const many = Array.from({ length: M1_BOOTSTRAP_MAX_EVENTS + 5 }, (_, i) => ({ seq: i, type: "step/end" }));
  rejects({ projected: { asOfSeq: many.length, events: many }, maxEvents: M1_BOOTSTRAP_MAX_EVENTS + 10 }, "history-beyond-hard-max", "hard max cannot be removed by config");
}

// ---------------------------------------------------------------------------
// Producer -> wire-law convergence (single executable protocol law).
// The builder must reject exactly what validateSnapshotWire() rejects.
// ---------------------------------------------------------------------------
// Empty history must be asOfSeq/streamSequence -1; a non-empty watermark with
// [] events is a law violation the builder previously accepted.
rejects({ projected: { asOfSeq: 5, events: [] } }, "asOfSeq-mismatch", "empty history with wrong watermark must be rejected like the wire law");
// Empty history with a NEGATIVE watermark other than -1 is also a mismatch.
rejects({ projected: { asOfSeq: -2, events: [] } }, "malformed-asOfSeq", "asOfSeq below -1 rejected");
// attachmentId coupling serverGeneration must be rejected exactly like the law.
rejects({ attachmentId: "g", serverGeneration: "g" }, "attachmentId-couples-serverGeneration", "attachmentId == serverGeneration must be rejected");
// Frozen-law block identity / event type codes surface identically from the builder.
rejects(
  { projected: { asOfSeq: 2, events: [{ seq: 1, type: "user/message", blockId: "message:a-u1", message: { role: "user", id: "u1", text: "x" } }, { seq: 2, type: "step/end" }] } },
  "type-blockId-mismatch",
  "wrong message blockId identity rejected like the law",
);
rejects(
  { projected: { asOfSeq: 2, events: [{ seq: 1, type: "step/end" }, { seq: 2, type: "assistant/chunk", blockId: "partial:9:9", turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "p" } }] } },
  "type-blockId-mismatch",
  "chunk blockId not matching its turn/step rejected like the law",
);
rejects(
  { projected: { asOfSeq: 2, events: [{ seq: 1, type: "user/message", blockId: "message:u-u1", message: { role: "assistant", id: "u1", text: "x" } }, { seq: 2, type: "step/end" }] } },
  "type-role-mismatch",
  "user/message wrong role rejected like the law",
);
rejects(
  { projected: { asOfSeq: 2, events: [{ seq: 1, type: "user/message", blockId: "message:u-u1", message: { role: "user", id: "u1" } }, { seq: 2, type: "step/end" }] } },
  "malformed-projected-event",
  "message missing text rejected like the law",
);
rejects(
  { projected: { asOfSeq: 2, events: [{ seq: 1, type: "step/end" }, { seq: 2, type: "assistant/chunk", blockId: "partial:1:1", turn: 1, step: 1, chunk: {} }] } },
  "malformed-projected-event",
  "chunk missing chunk.type rejected like the law",
);
rejects(
  { projected: { asOfSeq: 2, events: [{ seq: 1, type: "", blockId: "message:u-u1", message: { role: "user", id: "u1", text: "x" } }, { seq: 2, type: "step/end" }] } },
  "malformed-projected-event",
  "event missing type rejected like the law",
);
// Any snapshot the builder RETURNS is wire-law-valid (convergence invariant).
{
  const built = buildCanonicalSnapshot(baseArgs());
  const law = validateSnapshotWire(built, { expectedSessionId: SESSION, maxEvents: M1_BOOTSTRAP_MAX_EVENTS });
  assert.equal(law.ok, true, "builder output must pass the frozen wire law");
  console.log("convergence invariant: buildCanonicalSnapshot output passes validateSnapshotWire");
}

console.log("snapshot.test.mjs: PASS");
