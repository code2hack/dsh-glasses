import { validateCanonicalProjectionPage } from "./projection.js";
import { M1_PROTOCOL_MAJOR, validateSnapshotWire } from "./snapshot.js";

export class LiveSyncValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "LiveSyncValidationError";
  }
}

const fail = (code, message) => ({ ok: false, code, message });

function throwOnFailure(result) {
  if (!result.ok) throw new LiveSyncValidationError(result.code, result.message);
}

export function issuedBaseFromSnapshot(snapshot) {
  const law = validateSnapshotWire(snapshot);
  if (!law.ok) throw new LiveSyncValidationError(law.code, `cannot issue invalid snapshot: ${law.message}`);
  const attachment = snapshot.attachments[0];
  return Object.freeze({
    epoch: snapshot.connectionEpoch,
    serverGeneration: snapshot.serverGeneration,
    attachmentId: attachment.attachmentId,
    attachmentGeneration: attachment.attachmentGeneration,
    sessionId: attachment.sessionId,
    baseStreamSequence: snapshot.streamSequence,
    baseHistoryAsOfSeq: attachment.history.asOfSeq,
    streamClaimed: false,
  });
}

export function createIssuedBaseRegistry({ maxEntries = 256 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new LiveSyncValidationError("invalid-registry-bound", "maxEntries must be a positive integer");
  }
  const records = new Map();
  return Object.freeze({
    issue(snapshot) {
      const record = issuedBaseFromSnapshot(snapshot);
      if (records.has(record.epoch)) throw new LiveSyncValidationError("duplicate-connectionEpoch", `epoch ${record.epoch} already issued`);
      records.set(record.epoch, record);
      while (records.size > maxEntries) records.delete(records.keys().next().value);
      return record.epoch;
    },
    get(epoch) {
      return records.get(epoch);
    },
    claim(epoch) {
      const record = records.get(epoch);
      if (!record) throw new LiveSyncValidationError("unknown-connectionEpoch", `epoch ${String(epoch)} was not issued`);
      if (record.streamClaimed) throw new LiveSyncValidationError("stream-already-claimed", `epoch ${epoch} already has a stream`);
      const claimed = Object.freeze({ ...record, streamClaimed: true });
      records.set(epoch, claimed);
      return claimed;
    },
  });
}

const fenceFields = [
  ["protocolMajor", () => M1_PROTOCOL_MAJOR],
  ["serverGeneration", (base) => base.serverGeneration],
  ["connectionEpoch", (base) => base.epoch],
  ["attachmentId", (base) => base.attachmentId],
  ["attachmentGeneration", (base) => base.attachmentGeneration],
  ["sessionId", (base) => base.sessionId],
];

function validateFences(value, base) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("not-live-sync-message", "message must be an object");
  if (!base || typeof base !== "object") return fail("invalid-issued-base", "issued base is required");
  for (const [field, expected] of fenceFields) {
    if (value[field] !== expected(base)) return fail(`${field}-mismatch`, `${field} does not match the issued snapshot base`);
  }
  return { ok: true };
}

function wireBase(base) {
  return {
    protocolMajor: M1_PROTOCOL_MAJOR,
    serverGeneration: base.serverGeneration,
    connectionEpoch: base.epoch,
    attachmentId: base.attachmentId,
    attachmentGeneration: base.attachmentGeneration,
    sessionId: base.sessionId,
  };
}

export function validateStreamHello(value, issuedBase) {
  try {
    const fences = validateFences(value, issuedBase);
    if (!fences.ok) return fences;
    if (value.baseStreamSequence !== issuedBase.baseStreamSequence) return fail("baseStreamSequence-mismatch", "hello baseStreamSequence does not match snapshot");
    if (value.baseHistoryAsOfSeq !== issuedBase.baseHistoryAsOfSeq) return fail("baseHistoryAsOfSeq-mismatch", "hello baseHistoryAsOfSeq does not match snapshot");
    return { ok: true };
  } catch (error) {
    return fail("validator-error", String(error?.message ?? error));
  }
}

export function buildStreamHello(issuedBase) {
  const value = {
    ...wireBase(issuedBase),
    baseStreamSequence: issuedBase.baseStreamSequence,
    baseHistoryAsOfSeq: issuedBase.baseHistoryAsOfSeq,
  };
  throwOnFailure(validateStreamHello(value, issuedBase));
  return value;
}

export function validateProjectionDelta(value, { issuedBase, expectedBaseStreamSequence } = {}) {
  try {
    const fences = validateFences(value, issuedBase);
    if (!fences.ok) return fences;
    if (!Number.isInteger(expectedBaseStreamSequence)) return fail("invalid-expected-stream-sequence", "expectedBaseStreamSequence must be an integer");
    if (value.baseStreamSequence !== expectedBaseStreamSequence) return fail("baseStreamSequence-mismatch", "delta base does not match installed transport sequence");
    if (value.streamSequence !== value.baseStreamSequence + 1) return fail("stream-sequence-gap", "delta transport sequence must advance exactly once");
    try {
      validateCanonicalProjectionPage([value.event]);
    } catch (error) {
      return fail(typeof error?.code === "string" ? error.code : "malformed-projected-event", String(error?.message ?? error));
    }
    if (value.event.seq <= issuedBase.baseHistoryAsOfSeq) return fail("durable-seq-not-after-base", "delta event must follow the snapshot history watermark");
    return { ok: true };
  } catch (error) {
    return fail("validator-error", String(error?.message ?? error));
  }
}

export function buildProjectionDelta(issuedBase, { baseStreamSequence, event }) {
  const value = {
    ...wireBase(issuedBase),
    baseStreamSequence,
    streamSequence: baseStreamSequence + 1,
    event,
  };
  throwOnFailure(validateProjectionDelta(value, { issuedBase, expectedBaseStreamSequence: baseStreamSequence }));
  return value;
}

export function validateHistoryPage(value, { issuedBase, beforeSeq, limit } = {}) {
  try {
    const fences = validateFences(value, issuedBase);
    if (!fences.ok) return fences;
    if (value.baseHistoryAsOfSeq !== issuedBase.baseHistoryAsOfSeq) return fail("baseHistoryAsOfSeq-mismatch", "page base watermark does not match snapshot");
    if (!Number.isInteger(beforeSeq) || beforeSeq < 0 || value.beforeSeq !== beforeSeq) return fail("beforeSeq-mismatch", "page does not match the requested exclusive cursor");
    if (!Number.isInteger(limit) || limit < 1 || value.limit !== limit) return fail("limit-mismatch", "page does not match the requested limit");
    if (!Array.isArray(value.events)) return fail("malformed-page-events", "page events must be an array");
    if (value.events.length > limit) return fail("page-beyond-limit", "page exceeds requested limit");
    try {
      validateCanonicalProjectionPage(value.events);
    } catch (error) {
      return fail(typeof error?.code === "string" ? error.code : "malformed-projected-event", String(error?.message ?? error));
    }
    if (value.events.some((event) => event.seq >= beforeSeq || event.seq > issuedBase.baseHistoryAsOfSeq)) {
      return fail("event-not-before-cursor", "page events must precede the exclusive cursor and issued base");
    }
    if (typeof value.hasMore !== "boolean") return fail("malformed-hasMore", "hasMore must be boolean");
    const expectedNext = value.hasMore && value.events.length > 0 ? value.events[0].seq : null;
    if (value.nextBeforeSeq !== expectedNext) return fail("nextBeforeSeq-mismatch", "nextBeforeSeq must be the oldest returned seq when hasMore, otherwise null");
    return { ok: true };
  } catch (error) {
    return fail("validator-error", String(error?.message ?? error));
  }
}

export function buildHistoryPage(issuedBase, { beforeSeq, limit, events, hasMore, nextBeforeSeq }) {
  const value = {
    ...wireBase(issuedBase),
    baseHistoryAsOfSeq: issuedBase.baseHistoryAsOfSeq,
    beforeSeq,
    limit,
    events,
    hasMore,
    nextBeforeSeq,
  };
  throwOnFailure(validateHistoryPage(value, { issuedBase, beforeSeq, limit }));
  return value;
}

export async function readBoundHistoryPage(adapter, issuedBase, { beforeSeq, limit }) {
  const projected = await adapter.readProjectionBefore(issuedBase.sessionId, { beforeSeq, limit });
  return buildHistoryPage(issuedBase, {
    beforeSeq,
    limit,
    events: projected.events,
    hasMore: projected.hasMore,
    nextBeforeSeq: projected.hasMore && projected.events.length > 0 ? projected.events[0].seq : null,
  });
}
