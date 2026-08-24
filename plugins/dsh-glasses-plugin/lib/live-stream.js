import { buildProjectionDelta, buildStreamHello } from "./live-sync.js";

export const LIVE_BUFFER_MAX_EVENTS = 256;
export const LIVE_BUFFER_MAX_BYTES = 512 * 1024;

function eventBytes(event) {
  return Buffer.byteLength(JSON.stringify(event));
}

export async function startRaceFreeLiveStream({
  adapter,
  issuedBase,
  sink,
  maxBufferEvents = LIVE_BUFFER_MAX_EVENTS,
  maxBufferBytes = LIVE_BUFFER_MAX_BYTES,
  signal,
}) {
  let phase = "buffering";
  let disposed = false;
  let bufferedBytes = 0;
  let lastBufferedSeq = issuedBase.baseHistoryAsOfSeq;
  let lastDurableSeq = issuedBase.baseHistoryAsOfSeq;
  let streamSequence = issuedBase.baseStreamSequence;
  const buffered = [];
  let off = () => {};
  let removeAbort = () => {};

  const close = () => {
    if (disposed) return;
    disposed = true;
    phase = "closed";
    off?.();
    removeAbort();
  };

  const fault = (reason) => {
    if (phase === "closed") return;
    sink.emit("resync-required", { reason });
    close();
    sink.close();
  };

  const emitDelta = (event) => {
    if (!Number.isInteger(event?.seq) || event.seq <= lastDurableSeq) {
      fault("non-monotonic-live-source");
      return false;
    }
    const delta = buildProjectionDelta(issuedBase, {
      baseStreamSequence: streamSequence,
      event,
    });
    if (sink.emit("projection", delta, delta.streamSequence) === false) {
      fault("transport-backpressure");
      return false;
    }
    streamSequence = delta.streamSequence;
    lastDurableSeq = event.seq;
    return true;
  };

  const onEvent = (event) => {
    if (phase === "closed") return;
    if (phase === "live") {
      try {
        emitDelta(event);
      } catch {
        fault("malformed-live-event");
      }
      return;
    }
    if (!Number.isInteger(event?.seq) || event.seq <= lastBufferedSeq) {
      fault("non-monotonic-live-source");
      return;
    }
    let size;
    try {
      size = eventBytes(event);
    } catch {
      fault("malformed-live-event");
      return;
    }
    if (buffered.length + 1 > maxBufferEvents || bufferedBytes + size > maxBufferBytes) {
      fault("live-buffer-overflow");
      return;
    }
    buffered.push(event);
    bufferedBytes += size;
    lastBufferedSeq = event.seq;
  };

  off = adapter.observeSession(issuedBase.sessionId, onEvent, () => fault("malformed-live-event"));
  if (phase === "closed") off();
  if (signal) {
    const onAbort = () => close();
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) close();
  }
  try {
    const catchUp = await adapter.readProjectionAfter(issuedBase.sessionId, {
      afterSeq: issuedBase.baseHistoryAsOfSeq,
      limit: adapter.maxEvents,
    });
    if (phase === "closed") return { close };

    if (!Array.isArray(catchUp?.events)) {
      fault("malformed-catch-up");
      return { close };
    }
    for (let index = 0; index < catchUp.events.length; index += 1) {
      const current = catchUp.events[index]?.seq;
      const previous = index === 0 ? issuedBase.baseHistoryAsOfSeq : catchUp.events[index - 1]?.seq;
      if (!Number.isInteger(current) || current <= previous) {
        fault("non-monotonic-catch-up");
        return { close };
      }
    }

    const merged = [];
    let coldIndex = 0;
    let bufferIndex = 0;
    while (coldIndex < catchUp.events.length || bufferIndex < buffered.length) {
      const cold = catchUp.events[coldIndex];
      const live = buffered[bufferIndex];
      if (cold && live && cold.seq === live.seq) {
        if (JSON.stringify(cold) !== JSON.stringify(live)) {
          fault("conflicting-catch-up-event");
          return { close };
        }
        merged.push(cold);
        coldIndex += 1;
        bufferIndex += 1;
      } else if (!live || (cold && cold.seq < live.seq)) {
        merged.push(cold);
        coldIndex += 1;
      } else {
        merged.push(live);
        bufferIndex += 1;
      }
    }

    if (sink.emit("hello", buildStreamHello(issuedBase)) === false) {
      fault("transport-backpressure");
      return { close };
    }
    for (const event of merged) {
      if (!emitDelta(event)) return { close };
    }
    phase = "live";
    return { close };
  } catch {
    fault("catch-up-failed");
    return { close };
  }
}
