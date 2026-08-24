import assert from "node:assert/strict";
import { readBoundHistoryPage, validateHistoryPage } from "../lib/live-sync.js";

const event = (seq) => ({ seq, type: "step/end", blocks: [] });
const issuedBase = Object.freeze({
  epoch: "epoch-page-a",
  serverGeneration: "generation-a",
  attachmentId: "attachment-a",
  attachmentGeneration: 1,
  sessionId: "selected-session",
  baseStreamSequence: 10,
  baseHistoryAsOfSeq: 10,
  streamClaimed: true,
});

let request;
const adapter = {
  async readProjectionBefore(sessionId, options) {
    request = { sessionId, options };
    return { asOfSeq: 99, events: [event(4), event(7)], hasMore: true };
  },
};
const page = await readBoundHistoryPage(adapter, issuedBase, { beforeSeq: 10, limit: 2 });
assert.deepEqual(request, { sessionId: "selected-session", options: { beforeSeq: 10, limit: 2 } });
assert.deepEqual(page.events.map(({ seq }) => seq), [4, 7]);
assert.equal(page.baseHistoryAsOfSeq, 10, "page stays bound to snapshot base, not cold-read tail 99");
assert.equal(page.nextBeforeSeq, 4);
assert.equal(validateHistoryPage(page, { issuedBase, beforeSeq: 10, limit: 2 }).ok, true);

const empty = await readBoundHistoryPage({
  async readProjectionBefore() { return { asOfSeq: 99, events: [], hasMore: false }; },
}, issuedBase, { beforeSeq: 1, limit: 2 });
assert.deepEqual(empty.events, []);
assert.equal(empty.hasMore, false);
assert.equal(empty.nextBeforeSeq, null);

await assert.rejects(
  () => readBoundHistoryPage({ async readProjectionBefore() { return { asOfSeq: 99, events: [event(10)], hasMore: false }; } }, issuedBase, { beforeSeq: 10, limit: 2 }),
  (error) => error.code === "event-not-before-cursor",
);

console.log("history-paging.test.mjs: PASS");
