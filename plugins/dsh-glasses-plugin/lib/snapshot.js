// Canonical M1 snapshot construction (SPEC §7.1 / plan T27-04).
//
// PURE module: no ctx, no sockets, no host seams. The snapshot builder consumes
// ONLY the adapter-provided canonical projection page ({ asOfSeq, events }) plus
// identity/state parameters — raw DSH payloads never reach this module, and it
// never re-projects events (projection happened inside the adapter).
//
// It fails closed (SnapshotValidationError) on every contract violation rather
// than silently normalizing, so an incomplete / malformed / wrong-generation
// snapshot can never become visible state.

import { validateCanonicalProjectionPage } from "./projection.js";

export const M1_PROTOCOL_MAJOR = 1;
export const M1_ATTACHMENT_SET_REVISION = 1;
export const M1_ATTACHMENT_GENERATION = 1; // M1: one attachment, one generation
export const M1_ATTACHMENT_LABEL = "Attached session";
// Hard ceiling that an arbitrary configured bootstrapMaxEvents may not remove.
export const M1_BOOTSTRAP_MAX_EVENTS = 1000;

export const M1_STATES = Object.freeze(["idle", "running", "waiting-user", "unavailable", "unknown"]);

export const M1_CAPABILITIES = Object.freeze({
  historyRead: true,
  liveUpdates: false, // M1 does not advertise/consume SSE as a capability
  draftMutations: false,
  send: false,
  steer: false,
  interrupt: false,
  resolveRequest: false,
});

export class SnapshotValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "SnapshotValidationError";
  }
}

function requireOpaque(value, code, message) {
  if (typeof value !== "string" || value === "") {
    throw new SnapshotValidationError(code, message);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Frozen untrusted-wire validator (T27-05 "protocol law").
// validateSnapshotWire() NEVER throws: it returns { ok: true } or
// { ok: false, code, message }. It checks the COMPLETE wire snapshot object —
// schema, opaque/generation identities, capabilities, drafts, and every
// projected event's seq/blockId/type correspondence — independent of how the
// snapshot was produced. The server builder and (later) the client staging
// module both converge on this law.
// ---------------------------------------------------------------------------

function bad(code, message) {
  return { ok: false, code, message };
}

const SNAPSHOT_KEYS = ["protocolMajor", "serverGeneration", "connectionEpoch", "attachmentSetRevision", "streamSequence", "attachments", "drafts"];
const MUTATION_CAPABILITIES = ["draftMutations", "send", "steer", "interrupt", "resolveRequest"];

function validateSnapshotWireInner(snapshot, { expectedSessionId, maxEvents = M1_BOOTSTRAP_MAX_EVENTS } = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return bad("not-snapshot", "snapshot must be an object");
  if (Object.hasOwn(snapshot, "ok")) return bad("envelope-ok-not-allowed", "the canonical snapshot carries no ok field");
  for (const key of SNAPSHOT_KEYS) {
    if (!Object.hasOwn(snapshot, key)) return bad(`missing-${key}`, `snapshot lacks required field ${key}`);
  }

  if (snapshot.protocolMajor !== M1_PROTOCOL_MAJOR) return bad("unsupported-protocolMajor", `protocolMajor ${snapshot.protocolMajor} != 1`);
  if (typeof snapshot.serverGeneration !== "string" || snapshot.serverGeneration === "") return bad("missing-serverGeneration", "serverGeneration must be a non-empty string");
  if (typeof snapshot.connectionEpoch !== "string" || snapshot.connectionEpoch === "") return bad("missing-connectionEpoch", "connectionEpoch must be a non-empty string");
  if (snapshot.attachmentSetRevision !== M1_ATTACHMENT_SET_REVISION) return bad("wrong-attachmentSetRevision", `attachmentSetRevision ${snapshot.attachmentSetRevision} != 1`);
  if (!Number.isInteger(snapshot.streamSequence)) return bad("malformed-streamSequence", "streamSequence must be an integer");

  if (!Array.isArray(snapshot.attachments)) return bad("zero-attachments", "attachments must be an array");
  if (snapshot.attachments.length === 0) return bad("zero-attachments", "exactly one attachment required");
  if (snapshot.attachments.length > 1) return bad("two-attachments", `expected exactly one attachment, got ${snapshot.attachments.length}`);

  if (!Array.isArray(snapshot.drafts)) return bad("drafts-not-array", "drafts must be an array");
  if (snapshot.drafts.length !== 0) return bad("non-empty-drafts", `drafts must be [] (got ${snapshot.drafts.length})`);

  const att = snapshot.attachments[0];
  if (!att || typeof att !== "object") return bad("malformed-attachment", "attachment must be an object");
  const sg = snapshot.serverGeneration;
  const attachmentGeneration = att.attachmentGeneration;

  if (expectedSessionId !== undefined && att.sessionId !== expectedSessionId) return bad("wrong-sessionId", `attachment sessionId ${att.sessionId} != expected ${expectedSessionId}`);
  if (typeof att.sessionId !== "string" || att.sessionId === "") return bad("missing-attachment-sessionId", "attachment sessionId must be a non-empty string");
  if (typeof att.attachmentId !== "string" || att.attachmentId === "") return bad("missing-attachmentId", "attachmentId must be a non-empty opaque string");
  if (att.attachmentId === att.sessionId || att.attachmentId.includes(att.sessionId)) return bad("attachmentId-encodes-session", `attachmentId ${att.attachmentId} encodes sessionId ${att.sessionId}`);
  if (att.attachmentId === sg || att.attachmentId.includes(sg)) return bad("attachmentId-couples-serverGeneration", `attachmentId ${att.attachmentId} couples serverGeneration ${sg}`);
  if (!Number.isInteger(attachmentGeneration) || attachmentGeneration <= 0) return bad("non-positive-attachmentGeneration", `attachmentGeneration ${attachmentGeneration} must be a positive integer`);
  if (typeof att.label !== "string" || att.label === "") return bad("missing-label", "attachment label must be a non-empty string");
  if (att.order !== 0) return bad("non-zero-order", `attachment order ${att.order} must be 0`);
  if (!M1_STATES.includes(att.state)) return bad("invalid-attachment-state", `attachment state ${att.state} not in ${M1_STATES.join("/")}`);

  const caps = att.capabilities;
  if (!caps || typeof caps !== "object") return bad("malformed-capabilities", "capabilities must be an object");
  if (caps.historyRead !== true) return bad("historyRead-not-true", "historyRead must be true");
  for (const key of ["liveUpdates", ...MUTATION_CAPABILITIES]) {
    if (caps[key] !== false) return bad("mutation-capability-enabled", `capability ${key} must be false in M1`);
  }

  const agent = att.agent;
  if (!agent || typeof agent !== "object") return bad("missing-agent-projection", "attachment must include the agent projection");
  if (agent.state !== att.state) return bad("agent-state-mismatch", "agent.state must equal attachment.state");
  if (agent.serverGeneration !== sg) return bad("agent-serverGeneration-mismatch", "agent.serverGeneration must equal snapshot.serverGeneration");
  if (agent.attachmentGeneration !== attachmentGeneration) return bad("agent-attachmentGeneration-mismatch", "agent.attachmentGeneration must equal attachment.attachmentGeneration");

  const history = att.history;
  if (!history || typeof history !== "object") return bad("missing-history", "attachment must include history");
  if (history.serverGeneration !== sg) return bad("history-serverGeneration-mismatch", "history.serverGeneration must equal snapshot.serverGeneration");
  if (history.attachmentGeneration !== attachmentGeneration) return bad("history-attachmentGeneration-mismatch", "history.attachmentGeneration must equal attachment.attachmentGeneration");
  if (!Number.isInteger(history.asOfSeq) || history.asOfSeq < -1) return bad("history-malformed-asOfSeq", "history.asOfSeq must be an integer >= -1");
  // Array check BEFORE any .length access: this validator never throws.
  if (!Array.isArray(history.events)) return bad("history-events-not-array", "history.events must be an array");
  if (snapshot.streamSequence !== history.asOfSeq) return bad("streamSequence-mismatch", "streamSequence must equal history.asOfSeq");
  if (history.events.length === 0 ? history.asOfSeq !== -1 : history.asOfSeq < 0) return bad("asOfSeq-mismatch", "asOfSeq must be -1 for empty history and >= 0 otherwise");
  if (history.events.length > maxEvents || history.events.length > M1_BOOTSTRAP_MAX_EVENTS) return bad("history-beyond-max", `history length ${history.events.length} exceeds bound`);
  if (history.events.length > 0 && history.events[history.events.length - 1]?.seq !== history.asOfSeq) return bad("asOfSeq-mismatch", "last event seq must equal asOfSeq");

  // ---- Per-event untrusted-wire checks ----
  // Canonical M1 (#28) event law: every history/key event is
  // { seq, type, blocks[] } where blocks are typed projection blocks with
  // stable identities. The wire law DELEGATES the full event/block law to the
  // single executable canonical projection law (validateCanonicalProjectionPage)
  // so producer, validator, and client mirror never drift; a valid but
  // non-renderable source event carries blocks: [] and still advances the
  // watermark. This validator MUST NOT throw: every projection-law fault is
  // converted to the same {ok:false, code} rejection.
  try {
    validateCanonicalProjectionPage(history.events);
  } catch (e) {
    if (e && typeof e.code === "string") {
      return bad(e.code, `canonical projection law: ${e.message}`);
    }
    return bad("malformed-projected-event", `canonical projection law fault: ${String(e)}`);
  }
  // Snapshot-specific watermark interplay: every event seq stays within the
  // snapshot watermark (the projection law already guarantees strictly
  // increasing, non-negative seqs and that the LAST event equals asOfSeq).
  for (const ev of history.events) {
    if (Number.isInteger(ev?.seq) && ev.seq > history.asOfSeq) {
      return bad("seq-beyond-asOfSeq", `event seq ${ev.seq} exceeds asOfSeq ${history.asOfSeq}`);
    }
  }

  return { ok: true };
}

// validateSnapshotWire() is a never-throwing gate over untrusted input. Any
// unexpected internal fault is converted to a normal {ok:false} rejection.
export function validateSnapshotWire(snapshot, opts) {
  try {
    return validateSnapshotWireInner(snapshot, opts);
  } catch (e) {
    return { ok: false, code: "validator-error", message: String(e?.message ?? e) };
  }
}

/**
 * Build the single exclusive M1 snapshot. Enforces every normative invariant
 * (AC1/AC2/AC5): one configured attachment, opaque non-session-encoding
 * attachmentId (supplied independently — NOT derived from serverGeneration),
 * positive attachment generation, set revision 1, fresh connectionEpoch
 * (caller MUST supply a new value per authenticated bootstrap),
 * streamSequence === history.asOfSeq, canonical projected history within the
 * hard bound, drafts === [], read-only capabilities, and generation agreement
 * across attachment/agent/history. The HTTP-200 body IS the canonical snapshot
 * (no envelope `ok` field; errors keep {ok:false, error}).
 */
export function buildCanonicalSnapshot({ sessionId, attachmentId, projected, agentState, serverGeneration, connectionEpoch, maxEvents }) {
  const sid = requireOpaque(sessionId, "invalid-sessionId", "sessionId must be a non-empty string");
  const attachment = requireOpaque(attachmentId, "invalid-attachmentId", "attachmentId must be a non-empty opaque string");
  if (attachment === sid || attachment.includes(sid)) {
    throw new SnapshotValidationError("attachmentId-encodes-session", `attachmentId ${attachment} encodes sessionId ${sid}`);
  }
  if (!projected || typeof projected !== "object" || !Array.isArray(projected.events)) {
    throw new SnapshotValidationError("malformed-projected", "projected must be {asOfSeq, events[]}");
  }
  const { asOfSeq, events } = projected;
  if (!Number.isInteger(asOfSeq) || asOfSeq < -1) {
    throw new SnapshotValidationError("malformed-asOfSeq", `asOfSeq must be an integer >= -1 (got ${String(asOfSeq)})`);
  }
  const sg = requireOpaque(serverGeneration, "invalid-serverGeneration", "serverGeneration must be a non-empty opaque string");
  const ce = requireOpaque(connectionEpoch, "invalid-connectionEpoch", "connectionEpoch must be a non-empty opaque string");
  const bound = Number.isInteger(maxEvents) && maxEvents > 0 ? maxEvents : M1_BOOTSTRAP_MAX_EVENTS;
  if (events.length > bound) {
    throw new SnapshotValidationError("history-beyond-bound", `history length ${events.length} exceeds bound ${bound}`);
  }
  if (events.length > M1_BOOTSTRAP_MAX_EVENTS) {
    throw new SnapshotValidationError("history-beyond-hard-max", `history length ${events.length} exceeds hard max ${M1_BOOTSTRAP_MAX_EVENTS}`);
  }

  // Fail closed on the canonical projected page (never sorts malformed input).
  // Surface uniformly as SnapshotValidationError while preserving the code.
  try {
    validateCanonicalProjectionPage(events);
  } catch (e) {
    if (e && typeof e.code === "string") {
      throw new SnapshotValidationError(e.code, `canonical projection invalid: ${e.message}`);
    }
    throw e;
  }

  // streamSequence === history.asOfSeq; every event seq is within it.
  for (const ev of events) {
    if (ev?.seq > asOfSeq) {
      throw new SnapshotValidationError("seq-beyond-asOfSeq", `event seq ${ev.seq} exceeds asOfSeq ${asOfSeq}`);
    }
  }
  if (events.length > 0 && events[events.length - 1]?.seq !== asOfSeq) {
    throw new SnapshotValidationError("asOfSeq-mismatch", "last event seq must equal asOfSeq");
  }

  if (!M1_STATES.includes(agentState)) {
    throw new SnapshotValidationError("invalid-agent-state", `agent state ${String(agentState)} not in ${M1_STATES.join("/")}`);
  }

  const generation = M1_ATTACHMENT_GENERATION;
  const attachmentBlock = {
    attachmentId: attachment,
    attachmentGeneration: generation,
    sessionId: sid,
    label: M1_ATTACHMENT_LABEL,
    order: 0,
    state: agentState,
    capabilities: { ...M1_CAPABILITIES },
    agent: { state: agentState, serverGeneration: sg, attachmentGeneration: generation },
    history: { serverGeneration: sg, attachmentGeneration: generation, asOfSeq, events },
  };

  const assembled = {
    protocolMajor: M1_PROTOCOL_MAJOR,
    serverGeneration: sg,
    connectionEpoch: ce,
    attachmentSetRevision: M1_ATTACHMENT_SET_REVISION,
    streamSequence: asOfSeq,
    attachments: [attachmentBlock],
    drafts: [],
  };

  // Producer -> wire-law convergence (single executable protocol law). The
  // builder may return ONLY snapshots the frozen validator accepts; any
  // divergence (empty-history watermark, block identity, event type, ...) is a
  // hard production error, surfaced with the SAME code the wire law would use.
  const law = validateSnapshotWire(assembled, { expectedSessionId: sid, maxEvents: bound });
  if (!law.ok) {
    throw new SnapshotValidationError(law.code, `built snapshot violates wire law: ${law.message}`);
  }
  return assembled;
}
