// T27-05: exhaustive server/protocol snapshot contract suite.
//
// Freezes the M1 wire schema as executable protocol law: the positive complete
// snapshot must validate, an empty-history snapshot must validate, and every
// contract violation must be REJECTED (never silently repaired). The
// validateSnapshotWire() gate is the frozen untrusted-wire law that the server
// builder output and (later) the client staging module both converge on.
//
// Machine-readable scenario results are printed as JSONL on stdout so T27-12
// can fold them into docs/evidence without reinterpreting.
import assert from "node:assert/strict";
import { buildCanonicalSnapshot, validateSnapshotWire, M1_BOOTSTRAP_MAX_EVENTS } from "../lib/snapshot.js";

const SESSION = "session-contract-a";
const RESULTS = [];

function canonicalSnapshot(over = {}) {
  const base = buildCanonicalSnapshot({
    sessionId: SESSION,
    attachmentId: "att-11111111-2222-3333-4444-555555555555",
    projected: {
      asOfSeq: 4,
      events: [
        { seq: 1, type: "user/message", blockId: "message:u-u1", message: { role: "user", id: "u1", text: "hello" } },
        { seq: 2, type: "assistant/chunk", blockId: "partial:1:1", turn: 1, step: 1, chunk: { type: "block-start", index: 0, blockType: "text" } },
        { seq: 3, type: "assistant/chunk", blockId: "partial:1:1", turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "par" } },
        { seq: 4, type: "assistant/message", blockId: "message:a-a1", turn: 1, step: 1, message: { role: "assistant", id: "a1", text: "final", provider: "p", model: "m" } },
      ],
    },
    agentState: "idle",
    serverGeneration: "gen-abcdef01",
    connectionEpoch: "epoch-1",
    maxEvents: M1_BOOTSTRAP_MAX_EVENTS,
  });
  return structuredClone({ ...base, ...over });
}

const record = (name, verdict, detail) => {
  RESULTS.push({ name, verdict, detail });
  console.log(`${verdict === "PASS" ? "PASS" : "FAIL"} ${name}`);
};

// ---- Positive fixtures ----
{
  const snap = canonicalSnapshot();
  const res = validateSnapshotWire(snap, { expectedSessionId: SESSION, maxEvents: M1_BOOTSTRAP_MAX_EVENTS });
  record("positive: complete canonical snapshot accepted", res.ok ? "PASS" : "FAIL", res.ok ? null : res.code);
  assert.equal(res.ok, true);
}
{
  const snap = canonicalSnapshot({
    streamSequence: -1,
    attachments: [{
      ...canonicalSnapshot().attachments[0],
      state: "unavailable",
      agent: { state: "unavailable", serverGeneration: "gen-abcdef01", attachmentGeneration: 1 },
      history: { serverGeneration: "gen-abcdef01", attachmentGeneration: 1, asOfSeq: -1, events: [] },
    }],
  });
  const res = validateSnapshotWire(snap, { expectedSessionId: SESSION });
  record("positive: empty-history snapshot (asOfSeq -1) accepted", res.ok ? "PASS" : "FAIL", res.ok ? null : res.code);
  assert.equal(res.ok, true);
}
// Server-builder self-consistency: what the producer builds is law-valid.
{
  const res = validateSnapshotWire(canonicalSnapshot(), { expectedSessionId: SESSION });
  record("positive: buildCanonicalSnapshot output is wire-valid", res.ok ? "PASS" : "FAIL", res.ok ? null : res.code);
  assert.equal(res.ok, true);
}

// ---- Negative fixtures (each must be rejected, never repaired) ----
const NEGATIVES = [
  ["unsupported protocolMajor", (s) => { s.protocolMajor = 2; }, "unsupported-protocolMajor"],
  ["missing serverGeneration", (s) => { delete s.serverGeneration; }, "missing-serverGeneration"],
  ["empty serverGeneration", (s) => { s.serverGeneration = ""; }, "missing-serverGeneration"],
  ["missing connectionEpoch", (s) => { delete s.connectionEpoch; }, "missing-connectionEpoch"],
  ["empty connectionEpoch", (s) => { s.connectionEpoch = ""; }, "missing-connectionEpoch"],
  ["wrong attachmentSetRevision", (s) => { s.attachmentSetRevision = 2; }, "wrong-attachmentSetRevision"],
  ["zero attachments", (s) => { s.attachments = []; }, "zero-attachments"],
  ["two attachments", (s) => { s.attachments.push(structuredClone(s.attachments[0])); }, "two-attachments"],
  ["wrong configured sessionId", (s) => { /* expected passed as option */ }, "wrong-sessionId"],
  ["missing/empty attachmentId", (s) => { s.attachments[0].attachmentId = ""; }, "missing-attachmentId"],
  ["attachmentId equals sessionId", (s) => { s.attachments[0].attachmentId = SESSION; }, "attachmentId-encodes-session"],
  ["attachmentId contains sessionId", (s) => { s.attachments[0].attachmentId = `x-${SESSION}-y`; }, "attachmentId-encodes-session"],
  ["attachmentId couples serverGeneration", (s) => { s.attachments[0].attachmentId = s.serverGeneration; }, "attachmentId-couples-serverGeneration"],
  ["zero attachmentGeneration", (s) => { s.attachments[0].attachmentGeneration = 0; }, "non-positive-attachmentGeneration"],
  ["negative attachmentGeneration", (s) => { s.attachments[0].attachmentGeneration = -1; }, "non-positive-attachmentGeneration"],
  ["missing attachment sessionId", (s) => { s.attachments[0].sessionId = ""; }, "missing-attachment-sessionId"],
  ["missing attachment label", (s) => { s.attachments[0].label = ""; }, "missing-label"],
  ["non-zero attachment order", (s) => { s.attachments[0].order = 1; }, "non-zero-order"],
  ["invalid attachment state", (s) => { s.attachments[0].state = "ready"; }, "invalid-attachment-state"],
  ["malformed attachment", (s) => { s.attachments[0] = null; }, "malformed-attachment"],
  ["historyRead != true", (s) => { s.attachments[0].capabilities.historyRead = false; }, "historyRead-not-true"],
  ["liveUpdates true", (s) => { s.attachments[0].capabilities.liveUpdates = true; }, "mutation-capability-enabled"],
  ["draftMutations true", (s) => { s.attachments[0].capabilities.draftMutations = true; }, "mutation-capability-enabled"],
  ["send true", (s) => { s.attachments[0].capabilities.send = true; }, "mutation-capability-enabled"],
  ["steer true", (s) => { s.attachments[0].capabilities.steer = true; }, "mutation-capability-enabled"],
  ["interrupt true", (s) => { s.attachments[0].capabilities.interrupt = true; }, "mutation-capability-enabled"],
  ["resolveRequest true", (s) => { s.attachments[0].capabilities.resolveRequest = true; }, "mutation-capability-enabled"],
  ["non-empty drafts", (s) => { s.drafts.push({ opId: "x" }); }, "non-empty-drafts"],
  ["drafts not array", (s) => { s.drafts = {}; }, "drafts-not-array"],
  ["agent state != attachment state", (s) => { s.attachments[0].agent.state = "running"; }, "agent-state-mismatch"],
  ["agent wrong serverGeneration", (s) => { s.attachments[0].agent.serverGeneration = "other-gen"; }, "agent-serverGeneration-mismatch"],
  ["agent wrong attachmentGeneration", (s) => { s.attachments[0].agent.attachmentGeneration = 9; }, "agent-attachmentGeneration-mismatch"],
  ["missing agent projection", (s) => { delete s.attachments[0].agent; }, "missing-agent-projection"],
  ["history wrong serverGeneration", (s) => { s.attachments[0].history.serverGeneration = "other-gen"; }, "history-serverGeneration-mismatch"],
  ["history wrong attachmentGeneration", (s) => { s.attachments[0].history.attachmentGeneration = 9; }, "history-attachmentGeneration-mismatch"],
  ["history.events not array", (s) => { s.attachments[0].history.events = {}; }, "history-events-not-array"],
  ["descending event sequence", (s) => { s.attachments[0].history.events = [{ seq: 4, type: "step/end" }, { seq: 3, type: "step/end" }, { seq: 4, type: "step/end" }]; }, "non-monotonic-seq"],
  ["duplicate sequence", (s) => { s.attachments[0].history.events = [{ seq: 2, type: "step/end" }, { seq: 2, type: "step/end" }, { seq: 4, type: "step/end" }]; }, "non-monotonic-seq"],
  ["event seq > asOfSeq", (s) => { s.attachments[0].history.events = [{ seq: 5, type: "step/end" }, { seq: 4, type: "step/end" }]; }, "seq-beyond-asOfSeq"],
  ["duplicate message blockId", (s) => {
    s.streamSequence = 2;
    s.attachments[0].history.asOfSeq = 2;
    s.attachments[0].history.events = [
      { seq: 1, type: "user/message", blockId: "message:u-u1", message: { role: "user", id: "u1", text: "a" } },
      { seq: 2, type: "user/message", blockId: "message:u-u1", message: { role: "user", id: "u1", text: "b" } },
    ];
  }, "duplicate-blockId"],
  ["message blockId wrong prefix", (s) => { s.attachments[0].history.events[0].blockId = "message:a-u1"; }, "type-blockId-mismatch"],
  ["chunk blockId wrong prefix", (s) => { s.attachments[0].history.events[1].blockId = "message:a-1"; }, "type-blockId-mismatch"],
  ["malformed projected message (no role)", (s) => { s.attachments[0].history.events[0].message = { text: "x" }; }, "malformed-projected-event"],
  ["malformed projected chunk (no chunk.type)", (s) => { s.attachments[0].history.events[1].chunk = {}; }, "malformed-projected-event"],
  ["streamSequence != history.asOfSeq", (s) => { s.streamSequence = 99; }, "streamSequence-mismatch"],
  ["history beyond configured maximum", (s) => { /* maxEvents passed as option */ }, "history-beyond-max"],
  ["envelope ok field present", (s) => { s.ok = true; }, "envelope-ok-not-allowed"],
];

for (const [name, mutate, expectCode] of NEGATIVES) {
  const snap = canonicalSnapshot();
  mutate(snap);
  const opts = {};
  if (name === "wrong configured sessionId") opts.expectedSessionId = "session-other";
  if (name === "history beyond configured maximum") opts.maxEvents = 2;
  const res = validateSnapshotWire(snap, opts);
  const detail = res.ok ? "not rejected" : res.code;
  const pass = !res.ok && res.code === expectCode;
  record(`negative: ${name} -> ${expectCode}`, pass ? "PASS" : "FAIL", detail);
  assert.equal(pass, true);
}

// Explicit negative assertions demanded by the Ticket (opaque identity).
{
  const snap = canonicalSnapshot();
  const att = snap.attachments[0];
  assert.notEqual(att.attachmentId, SESSION);
  assert.equal(att.attachmentId.includes(SESSION), false);
  assert.notEqual(att.attachmentId, snap.serverGeneration);
  assert.equal(att.attachmentId.includes(snap.serverGeneration), false);
  record("identity: attachmentId opaque vs sessionId AND vs serverGeneration", "PASS", null);
}
{
  const snapshot = canonicalSnapshot();
  record("identity: no ok envelope on canonical snapshot", Object.hasOwn(snapshot, "ok") ? "FAIL" : "PASS", null);
  assert.equal(Object.hasOwn(snapshot, "ok"), false);
}

console.log("\n=== snapshot-contract SUMMARY ===");
for (const r of RESULTS) console.log(`${r.verdict} ${r.name}`);
for (const r of RESULTS) console.log(`RESULT\t${JSON.stringify(r)}`);
const failed = RESULTS.filter((r) => r.verdict !== "PASS");
if (failed.length) { console.log(`FAILED: ${failed.length}`); process.exit(1); }
console.log(`ALL PASS (${RESULTS.length} checks)`);
