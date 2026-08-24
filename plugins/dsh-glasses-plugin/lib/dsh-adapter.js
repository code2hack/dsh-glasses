// SPEC §5 project-owned DSH adapter — M1 read slice (Ticket #27).
//
// This module is the ONLY place the M1 read path may touch DSH internals
// (ctx.sessionQuery, ctx.on('session/event'), ctx.agents). The plugin's HTTP
// handlers receive DSH through this adapter; raw DSH payloads never cross the
// /glasses/v1 namespace directly.
//
// Supported runtime and seam list are pinned in ../dsh-compat.json and
// enforced by ../test/dsh-compat.test.mjs (executable ABI gate) plus the
// construction-time seam guard below (boot-time guard). storage/apiProxy are
// deliberately NOT part of this adapter: they belong to the dormant TB0/M3
// write path.
//
// M1 scope: one selected session, bounded canonical history, explicit durable-
// sequence predecessor/successor reads, and canonical live observation through
// this adapter only. Multiple attachments remain future work.

import { projectAndValidatePage } from "./projection.js";

export class AdapterValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "AdapterValidationError";
  }
}

const REQUIRED_SEAMS = [
  ["sessionQuery.listSessions", (ctx) => typeof ctx?.sessionQuery?.listSessions === "function"],
  ["sessionQuery.readSession", (ctx) => typeof ctx?.sessionQuery?.readSession === "function"],
  ["context.on(session/event)", (ctx) => typeof ctx?.on === "function"],
  ["agents.get", (ctx) => typeof ctx?.agents?.get === "function"],
];

// DSH AgentStatus vocabulary observed in the pinned rc.2 runtime. Anything
// unrecognized (future status, or a changed shape) must surface as `unknown`,
// never be silently coerced.
const AGENT_STATUS_VOCABULARY = new Set(["idle", "running"]);

export const ATTACHMENT_STATE_VOCABULARY = new Set([
  "idle",
  "running",
  "waiting-user",
  "unavailable",
  "unknown",
]);

function assertArrayEvents(snapshot, operation) {
  if (!snapshot || !Array.isArray(snapshot.events)) {
    throw new AdapterValidationError("malformed-page", `${operation}: snapshot.events is not an array`);
  }
}

function assertStrictlyIncreasingUniqueSeq(events, sessionId, operation) {
  let previous = -1;
  for (const event of events) {
    const seq = event?.seq;
    if (!Number.isInteger(seq) || seq < 0) {
      throw new AdapterValidationError(
        "malformed-page",
        `${operation}(${sessionId}): non-finite/negative seq ${String(seq)}`,
      );
    }
    if (seq <= previous) {
      throw new AdapterValidationError(
        "non-monotonic-page",
        `${operation}(${sessionId}): events are not strictly increasing by seq (${previous} then ${seq})`,
      );
    }
    previous = seq;
  }
}

/**
 * Build the read slice of the project-owned DSH adapter. Differentiation from
 * DSH internals ends here: every projection the M1 plugin serves is produced
 * by this adapter.
 */
export function createGlassesDshAdapter(ctx, options = {}) {
  if (!ctx || typeof ctx !== "object") {
    throw new AdapterValidationError("invalid-ctx", "createGlassesDshAdapter: ctx is required");
  }
  for (const [seam, check] of REQUIRED_SEAMS) {
    if (!check(ctx)) {
      throw new AdapterValidationError(
        "missing-seam",
        `createGlassesDshAdapter: required read seam '${seam}' is absent on the supplied ctx`,
      );
    }
  }

  const configuredMaxEvents = Number(options.maxEvents);
  const maxEvents = Number.isInteger(configuredMaxEvents) && configuredMaxEvents >= 1
    ? configuredMaxEvents
    : 200;
  const sessionQuery = ctx.sessionQuery;
  const agents = ctx.agents;

  /**
   * Internal only: the full list of attachable sessions. Nothing from this
   * list is served to the glasses edge except the explicitly configured
   * selected session. Returns a project-shaped stable list.
   */
  async function listAttachableSessions() {
    const records = await sessionQuery.listSessions();
    if (!Array.isArray(records)) {
      throw new AdapterValidationError("malformed-sessions", "listAttachableSessions: sessionQuery.listSessions did not return an array");
    }
    return records.map((record) => ({ sessionId: record?.sessionId }));
  }

  /**
   * Bounded canonical history projection for one session. M1 is cursorless:
   * passing a cursor must be rejected rather than silently ignored. Non-
   * monotonic or duplicate sequences are rejected, never normalized away.
   */
  async function readCanonicalProjection(sessionId, operation) {
    if (typeof sessionId !== "string" || !sessionId) {
      throw new AdapterValidationError("invalid-session", `${operation}: sessionId must be a non-empty string`);
    }
    const snapshot = await sessionQuery.readSession(sessionId);
    assertArrayEvents(snapshot, operation);
    const rawEvents = snapshot.events;
    // Validate the complete authoritative log before any requested slice, so
    // malformed sequence or projection semantics cannot hide outside a page.
    assertStrictlyIncreasingUniqueSeq(rawEvents, sessionId, operation);
    return projectAndValidatePage(rawEvents);
  }

  function boundedRequest(options, boundary, minimum, operation) {
    const value = options?.[boundary];
    const limit = options?.limit;
    if (!options || typeof options !== "object" || Array.isArray(options) ||
        !Number.isInteger(value) || value < minimum ||
        !Number.isInteger(limit) || limit < 1 || limit > maxEvents) {
      throw new AdapterValidationError(
        "invalid-page-request",
        `${operation}: ${boundary} must be an integer >= ${minimum} and limit must be 1..${maxEvents}`,
      );
    }
    return { value, limit };
  }

  async function readProjectionPage(sessionId, cursor = undefined) {
    if (cursor != null) {
      throw new AdapterValidationError(
        "unsupported-cursor",
        "readProjectionPage: cursors are not part of the M1 slice; pass no cursor",
      );
    }

    const all = await readCanonicalProjection(sessionId, "readProjectionPage");
    const asOfSeq = all.length ? all[all.length - 1].seq : -1;
    return { asOfSeq, events: all.slice(-maxEvents) };
  }

  async function readProjectionBefore(sessionId, options) {
    const { value: beforeSeq, limit } = boundedRequest(options, "beforeSeq", 0, "readProjectionBefore");
    const all = await readCanonicalProjection(sessionId, "readProjectionBefore");
    const asOfSeq = all.length ? all[all.length - 1].seq : -1;
    const predecessors = all.filter((event) => event.seq < beforeSeq);
    return {
      asOfSeq,
      events: predecessors.slice(-limit),
      hasMore: predecessors.length > limit,
    };
  }

  async function readProjectionAfter(sessionId, options) {
    const { value: afterSeq, limit } = boundedRequest(options, "afterSeq", -1, "readProjectionAfter");
    const all = await readCanonicalProjection(sessionId, "readProjectionAfter");
    const asOfSeq = all.length ? all[all.length - 1].seq : -1;
    const successors = all.filter((event) => event.seq > afterSeq);
    if (successors.length > limit) {
      throw new AdapterValidationError(
        "projection-overflow",
        `readProjectionAfter: ${successors.length} events exceed limit ${limit}; complete resynchronization required`,
      );
    }
    return { asOfSeq, events: successors };
  }

  /**
   * Subscribe strictly to one selected session's durable stream. Returns a
   * disposer. Exists to move the pre-existing TB0 stream seam behind the
   * adapter; live-delta semantics are not developed by #27.
   */
  function observeSession(sessionId, listener, onError) {
    if (typeof listener !== "function") {
      throw new AdapterValidationError("invalid-listener", "observeSession: listener must be a function");
    }
    const off = ctx.on("session/event", (session, event) => {
      if (session?.id !== sessionId) return;
      try {
        listener(projectAndValidatePage([event])[0]);
      } catch (error) {
        if (typeof onError === "function") onError(error);
        else throw error;
      }
    });
    return typeof off === "function" ? off : () => {};
  }

  /**
   * Map the DSH agent status into the SPEC attachment-state vocabulary for
   * this slice. A missing agent is `unavailable`; an unrecognized status is
   * `unknown` (never coerced).
   */
  function getAgentState(sessionId) {
    let agent;
    try {
      agent = agents.get(sessionId);
    } catch {
      agent = undefined;
    }
    if (agent === undefined || agent === null || typeof agent.status !== "string") {
      return "unavailable";
    }
    if (!AGENT_STATUS_VOCABULARY.has(agent.status)) {
      return "unknown";
    }
    return agent.status; // 'idle' | 'running'
  }

  return Object.freeze({
    listAttachableSessions,
    readProjectionPage,
    readProjectionBefore,
    readProjectionAfter,
    observeSession,
    getAgentState,
    maxEvents,
  });
}
