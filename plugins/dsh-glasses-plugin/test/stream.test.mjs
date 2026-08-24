import assert from "node:assert/strict";
import { startRaceFreeLiveStream } from "../lib/live-stream.js";

const event = (seq) => ({ seq, type: "step/end", blocks: [] });
const issuedBase = Object.freeze({
  epoch: "epoch-stream-a",
  serverGeneration: "generation-a",
  attachmentId: "attachment-a",
  attachmentGeneration: 1,
  sessionId: "session-a",
  baseStreamSequence: 42,
  baseHistoryAsOfSeq: 42,
  streamClaimed: true,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(options = {}) {
  const cold = deferred();
  let listener = null;
  let disposed = false;
  let disposeCount = 0;
  const frames = [];
  let closed = false;
  const saturateAt = options.saturateAt ?? Infinity;
  const adapter = {
    maxEvents: 200,
    observeSession(sessionId, next) {
      assert.equal(sessionId, issuedBase.sessionId);
      listener = next;
      return () => { disposed = true; disposeCount += 1; listener = null; };
    },
    readProjectionAfter(sessionId, request) {
      assert.equal(sessionId, issuedBase.sessionId);
      assert.deepEqual(request, { afterSeq: 42, limit: 200 });
      return cold.promise;
    },
  };
  const sink = {
    emit(name, data, id) {
      frames.push({ name, data, id });
      return frames.length < saturateAt;
    },
    close() { closed = true; },
  };
  const start = startRaceFreeLiveStream({ adapter, issuedBase, sink, ...options });
  return {
    cold,
    frames,
    start,
    emit(value) { assert.ok(listener, "subscription must exist"); listener(value); },
    get closed() { return closed; },
    get disposed() { return disposed; },
    get disposeCount() { return disposeCount; },
  };
}

{
  const f = fixture({ saturateAt: 2 });
  f.cold.resolve({ asOfSeq: 44, events: [event(43), event(44)] });
  await f.start;
  assert.deepEqual(f.frames.filter(({ name }) => name === "projection").map(({ data }) => data.event.seq), [43]);
  assert.equal(f.frames.at(-1).name, "resync-required");
  assert.equal(f.frames.at(-1).data.reason, "transport-backpressure");
  assert.equal(f.closed, true);
  assert.equal(f.disposeCount, 1);
}

{
  const f = fixture();
  f.emit(event(44));
  f.cold.resolve({ asOfSeq: 44, events: [event(43), event(44)] });
  const stream = await f.start;
  assert.deepEqual(f.frames.map(({ name, id }) => [name, id]), [
    ["hello", undefined],
    ["projection", 43],
    ["projection", 44],
  ]);
  assert.deepEqual(f.frames.slice(1).map(({ data }) => [data.baseStreamSequence, data.streamSequence, data.event.seq]), [
    [42, 43, 43],
    [43, 44, 44],
  ]);
  f.emit(event(45));
  assert.deepEqual(f.frames.at(-1).data, { ...f.frames.at(-1).data, baseStreamSequence: 44, streamSequence: 45, event: event(45) });
  stream.close();
  assert.equal(f.disposed, true);
}

{
  const f = fixture();
  f.emit(event(44));
  f.emit(event(44));
  assert.equal(f.frames.at(-1).name, "resync-required");
  assert.equal(f.frames.at(-1).data.reason, "non-monotonic-live-source");
  assert.equal(f.closed, true);
  assert.equal(f.disposed, true);
  f.cold.resolve({ asOfSeq: 44, events: [event(43), event(44)] });
  await f.start;
}

{
  const f = fixture({ maxBufferEvents: 1 });
  f.emit(event(43));
  f.emit(event(44));
  assert.equal(f.frames.at(-1).name, "resync-required");
  assert.equal(f.frames.at(-1).data.reason, "live-buffer-overflow");
  assert.equal(f.closed, true);
  f.cold.resolve({ asOfSeq: 44, events: [event(43), event(44)] });
  await f.start;
}

{
  const f = fixture({ maxBufferBytes: 1 });
  f.emit(event(43));
  assert.equal(f.frames.at(-1).name, "resync-required");
  assert.equal(f.frames.at(-1).data.reason, "live-buffer-overflow");
  f.cold.resolve({ asOfSeq: 43, events: [event(43)] });
  await f.start;
}

{
  const f = fixture();
  f.cold.resolve({ asOfSeq: 44, events: [event(44), event(43)] });
  await f.start;
  assert.equal(f.frames.at(-1).name, "resync-required");
  assert.equal(f.frames.at(-1).data.reason, "non-monotonic-catch-up");
}

{
  const f = fixture();
  f.cold.reject(Object.assign(new Error("too many successors"), { code: "projection-overflow" }));
  await f.start;
  assert.equal(f.frames.at(-1).name, "resync-required");
  assert.equal(f.frames.at(-1).data.reason, "catch-up-failed");
  assert.equal(f.closed, true);
}

console.log("stream.test.mjs: PASS");
