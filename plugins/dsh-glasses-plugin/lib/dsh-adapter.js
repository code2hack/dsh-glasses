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
// M1 scope: one selected session, cursorless bounded canonical history, read
// via the adapter only. Paging (cursors), live deltas, and multiple
// attachments are future work.

import { projectEvent } from "./projection.js";

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

function assertArrayEvents(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.events)) {
    throw new AdapterValidationError("malformed-page", "readProjectionPage: snapshot.events is not an array");
  }
}

function assertStrictlyIncreasingUniqueSeq(events, sessionId) {
  let previous = -1;
  for (const event of events) {
    const seq = event?.seq;
    if (!Number.isInteger(seq) || seq < 0) {
      throw new AdapterValidationError(
        "malformed-page",
        `readProjectionPage(${sessionId}): non-finite/negative seq ${String(seq)}`,
      );
    }
    if (seq <= previous) {
      throw new AdapterValidationError(
        "non-monotonic-page",
        `readProjectionPage(${sessionId}): events are not strictly increasing by seq (${previous} then ${seq})`,
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
  async function readProjectionPage(sessionId, cursor = undefined) {
    if (cursor != null) {
      throw new AdapterValidationError(
        "unsupported-cursor",
        "readProjectionPage: cursors are not part of the M1 slice; pass no cursor",
      );
    }
    if (typeof sessionId !== "string" || !sessionId) {
      throw new AdapterValidationError("invalid-session", "readProjectionPage: sessionId must be a non-empty string");
    }

    const snapshot = await sessionQuery.readSession(sessionId);
    assertArrayEvents(snapshot);
    const rawEvents = snapshot.events;
    // Validate the delivered window's internal consistency before bounding so
    // a bad log cannot be masked by tail-only slicing.
    assertStrictlyIncreasingUniqueSeq(rawEvents, sessionId);

    const bounded = rawEvents.slice(-maxEvents);
    const events = bounded.map(projectEvent);
    const asOfSeq = events.length ? events[events.length - 1].seq : -1;
    return { asOfSeq, events };
  }

  /**
   * Subscribe strictly to one selected session's durable stream. Returns a
   * disposer. Exists to move the pre-existing TB0 stream seam behind the
   * adapter; live-delta semantics are not developed by #27.
   */
  function observeSession(sessionId, listener) {
    if (typeof listener !== "function") {
      throw new AdapterValidationError("invalid-listener", "observeSession: listener must be a function");
    }
    const off = ctx.on("session/event", (session, event) => {
      if (session?.id === sessionId) listener(event);
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
    observeSession,
    getAgentState,
    maxEvents,
  });
}
