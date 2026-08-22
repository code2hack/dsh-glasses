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

  return {
    protocolMajor: M1_PROTOCOL_MAJOR,
    serverGeneration: sg,
    connectionEpoch: ce,
    attachmentSetRevision: M1_ATTACHMENT_SET_REVISION,
    streamSequence: asOfSeq,
    attachments: [attachmentBlock],
    drafts: [],
  };
}
