import assert from "node:assert/strict";
import {
  buildHistoryPage,
  buildProjectionDelta,
  buildStreamHello,
  createIssuedBaseRegistry,
  issuedBaseFromSnapshot,
  validateHistoryPage,
  validateProjectionDelta,
  validateStreamHello,
} from "../lib/live-sync.js";
import { buildCanonicalSnapshot } from "../lib/snapshot.js";

const event = (seq, text = `event-${seq}`) => ({
  seq,
  type: "user/message",
  blocks: [{ blockId: `message:u-u${seq}:content:0`, kind: "text", contentIndex: 0, role: "user", text }],
});

const snapshot = buildCanonicalSnapshot({
  sessionId: "session-live-a",
  attachmentId: "att-live-a",
  projected: { asOfSeq: 42, events: [event(42)] },
  agentState: "idle",
  serverGeneration: "generation-a",
  connectionEpoch: "epoch-a",
});
const base = issuedBaseFromSnapshot(snapshot);

assert.deepEqual(base, {
  epoch: "epoch-a",
  serverGeneration: "generation-a",
  attachmentId: "att-live-a",
  attachmentGeneration: 1,
  sessionId: "session-live-a",
  baseStreamSequence: 42,
  baseHistoryAsOfSeq: 42,
  streamClaimed: false,
});

const registry = createIssuedBaseRegistry({ maxEntries: 2 });
assert.equal(registry.issue(snapshot), base.epoch);
assert.deepEqual(registry.get(base.epoch), base);
assert.equal(registry.claim(base.epoch).streamClaimed, true);
assert.throws(() => registry.claim(base.epoch), (error) => error.code === "stream-already-claimed");
const snapshotB = structuredClone(snapshot);
snapshotB.connectionEpoch = "epoch-b";
const snapshotC = structuredClone(snapshot);
snapshotC.connectionEpoch = "epoch-c";
registry.issue(snapshotB);
registry.issue(snapshotC);
assert.equal(registry.get("epoch-a"), undefined, "issued-base registry stays bounded");

const hello = buildStreamHello(base);
assert.equal(validateStreamHello(hello, base).ok, true);
for (const [field, value, code] of [
  ["protocolMajor", 2, "protocolMajor-mismatch"],
  ["serverGeneration", "other", "serverGeneration-mismatch"],
  ["connectionEpoch", "other", "connectionEpoch-mismatch"],
  ["attachmentId", "other", "attachmentId-mismatch"],
  ["attachmentGeneration", 2, "attachmentGeneration-mismatch"],
  ["sessionId", "other", "sessionId-mismatch"],
  ["baseStreamSequence", 41, "baseStreamSequence-mismatch"],
  ["baseHistoryAsOfSeq", 41, "baseHistoryAsOfSeq-mismatch"],
]) {
  assert.equal(validateStreamHello({ ...hello, [field]: value }, base).code, code);
}

const delta = buildProjectionDelta(base, { baseStreamSequence: 42, event: event(57) });
assert.equal(delta.streamSequence, 43);
assert.equal(delta.event.seq, 57);
assert.equal(validateProjectionDelta(delta, { issuedBase: base, expectedBaseStreamSequence: 42 }).ok, true);
assert.equal(validateProjectionDelta({ ...delta, connectionEpoch: "other" }, { issuedBase: base, expectedBaseStreamSequence: 42 }).code, "connectionEpoch-mismatch");
assert.equal(validateProjectionDelta({ ...delta, serverGeneration: "other" }, { issuedBase: base, expectedBaseStreamSequence: 42 }).code, "serverGeneration-mismatch");
assert.equal(validateProjectionDelta({ ...delta, streamSequence: 44 }, { issuedBase: base, expectedBaseStreamSequence: 42 }).code, "stream-sequence-gap");
assert.equal(validateProjectionDelta(delta, { issuedBase: base, expectedBaseStreamSequence: 41 }).code, "baseStreamSequence-mismatch");
assert.equal(validateProjectionDelta({ ...delta, event: event(42) }, { issuedBase: base, expectedBaseStreamSequence: 42 }).code, "durable-seq-not-after-base");
assert.equal(validateProjectionDelta({ ...delta, event: { ...event(57), blocks: {} } }, { issuedBase: base, expectedBaseStreamSequence: 42 }).code, "malformed-blocks");

const page = buildHistoryPage(base, {
  beforeSeq: 42,
  limit: 2,
  events: [event(39), event(41)],
  hasMore: true,
  nextBeforeSeq: 39,
});
assert.equal(validateHistoryPage(page, { issuedBase: base, beforeSeq: 42, limit: 2 }).ok, true);
assert.equal(validateHistoryPage({ ...page, events: [event(41), event(39)] }, { issuedBase: base, beforeSeq: 42, limit: 2 }).code, "non-monotonic-seq");
assert.equal(validateHistoryPage({ ...page, events: [event(41), event(42)] }, { issuedBase: base, beforeSeq: 42, limit: 2 }).code, "event-not-before-cursor");
assert.equal(validateHistoryPage({ ...page, events: [event(38), event(39), event(41)] }, { issuedBase: base, beforeSeq: 42, limit: 2 }).code, "page-beyond-limit");
assert.equal(validateHistoryPage({ ...page, nextBeforeSeq: 41 }, { issuedBase: base, beforeSeq: 42, limit: 2 }).code, "nextBeforeSeq-mismatch");
const empty = buildHistoryPage(base, { beforeSeq: 0, limit: 2, events: [], hasMore: false, nextBeforeSeq: null });
assert.equal(validateHistoryPage(empty, { issuedBase: base, beforeSeq: 0, limit: 2 }).ok, true);

console.log("[live-sync-contract] hello/delta/page and issued-base laws: PASS");
