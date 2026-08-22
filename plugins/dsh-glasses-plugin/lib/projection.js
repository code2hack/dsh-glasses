// Narrow, text-only glasses projection for TB0-C0.
// Raw DSH events never cross the glasses namespace. Only the fields needed to
// reconstruct one text conversation are retained.
//
// M1 (#27) canonical invariants (see docs/dev/plan-m1-27):
//   * every renderable logical block carries a STABLE blockId
//   * DSH seq ordering is preserved verbatim (projection never reorders)
//   * duplicate/backwards seq data and duplicate render blockIds are rejected
//     before a snapshot may be created (validateCanonicalProjection)

export class ProjectionValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ProjectionValidationError";
  }
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

// Stable block identity for a renderable logical block. Use the durable DSH
// message id when available; fall back deterministically to the event seq only
// when no durable id exists. The identity MUST NOT encode transient rpcId.
function messageBlockId(kind, id, seq) {
  const prefix = kind === "user" ? "message:u-" : "message:a-";
  if (id) return prefix + id;
  return prefix + "s" + String(seq);
}

function partialBlockId(event) {
  const { turn, step } = event?.data ?? {};
  if (Number.isInteger(turn) && Number.isInteger(step)) {
    return `partial:${turn}:${step}`;
  }
  return `partial:s${String(event?.seq ?? "?")}`;
}

function baseProjection(evt) {
  return {
    seq: numberOrNull(evt?.seq),
    type: stringOrEmpty(evt?.type),
  };
}

export function projectEvent(evt) {
  const projected = baseProjection(evt);
  const data = evt?.data ?? {};

  if (projected.type === "user/message") {
    const source = data?.source ?? {};
    return {
      ...projected,
      blockId: messageBlockId("user", stringOrEmpty(data?.id), projected.seq),
      message: {
        role: "user",
        id: stringOrEmpty(data?.id),
        text: textFromBlocks(data?.content),
        rpcId: source?.kind === "user" ? stringOrEmpty(source?.rpcId) : "",
      },
    };
  }

  if (projected.type === "assistant/message") {
    const message = data?.message ?? {};
    const source = message?.source ?? {};
    const usage = data?.usage ?? {};
    return {
      ...projected,
      blockId: messageBlockId("assistant", stringOrEmpty(message?.id), projected.seq),
      turn: numberOrNull(data?.turn),
      step: numberOrNull(data?.step),
      message: {
        role: "assistant",
        id: stringOrEmpty(message?.id),
        text: textFromBlocks(message?.content),
        provider: stringOrEmpty(source?.provider),
        model: stringOrEmpty(source?.model),
      },
      usage: {
        inputTokens: numberOrNull(usage?.inputTokens),
        outputTokens: numberOrNull(usage?.outputTokens),
      },
    };
  }

  if (projected.type === "assistant/chunk") {
    const chunk = data?.chunk;
    if (!chunk || typeof chunk.type !== "string") return projected;

    const chunkProjection = { type: chunk.type };
    if (Number.isInteger(chunk.index)) chunkProjection.index = chunk.index;

    switch (chunk.type) {
      case "block-start":
        chunkProjection.blockType = stringOrEmpty(chunk.blockType);
        break;
      case "text-delta":
        chunkProjection.text = stringOrEmpty(chunk.text);
        break;
      case "block-end":
        if (chunk?.block?.type === "text") {
          chunkProjection.text = stringOrEmpty(chunk.block.text);
        }
        break;
      default:
        // Reasoning/tool/usage/finish payloads are deliberately not projected.
        break;
    }

    return {
      ...projected,
      blockId: partialBlockId(evt),
      turn: numberOrNull(data?.turn),
      step: numberOrNull(data?.step),
      chunk: chunkProjection,
    };
  }

  return projected;
}

const MESSAGE_TYPES = new Set(["user/message", "assistant/message"]);
const PARTIAL_TYPES = new Set(["assistant/chunk"]);

/**
 * Reject — never silently sort or de-duplicate — a canonical PROJECTED page
 * before a snapshot may be created from it. Operates on the already-projected
 * canonical events (with blockId) that the snapshot builder actually receives,
 * so raw DSH payloads never leak upward for validation.
 *
 * Invariants:
 *   * events must be an array with globally strictly-increasing, unique seq
 *   * MESSAGE blockIds (message:u-* / message:a-*) must be unique — each IDs
 *     exactly one finalized/user message event; a repeated message blockId is a
 *     reject
 *   * PARTIAL blockIds (partial:<turn>:<step>) MAY recur across the
 *     assistant/chunk events of one logical turn/step — that repetition is
 *     expected (they mutate one rendered partial block), never a reject
 */
export function validateCanonicalProjectionPage(projectedEvents) {
  if (!Array.isArray(projectedEvents)) {
    throw new ProjectionValidationError("malformed-page", "events must be an array");
  }
  let previous = -1;
  const seenMessageBlockIds = new Set();
  for (const event of projectedEvents) {
    const seq = event?.seq;
    if (!Number.isInteger(seq) || seq < 0) {
      throw new ProjectionValidationError("malformed-seq", `invalid seq ${String(seq)}`);
    }
    if (seq <= previous) {
      throw new ProjectionValidationError("non-monotonic-seq", `seq ${seq} not strictly after ${previous}`);
    }
    previous = seq;

    if (MESSAGE_TYPES.has(event?.type)) {
      const id = event?.blockId;
      if (typeof id !== "string" || id === "") {
        throw new ProjectionValidationError("missing-blockId", `message event at seq ${seq} lacks a blockId`);
      }
      if (seenMessageBlockIds.has(id)) {
        throw new ProjectionValidationError("duplicate-blockId", `duplicate message blockId ${id}`);
      }
      seenMessageBlockIds.add(id);
    } else if (PARTIAL_TYPES.has(event?.type)) {
      const id = event?.blockId;
      if (typeof id !== "string" || !id.startsWith("partial:")) {
        throw new ProjectionValidationError("malformed-blockId", `chunk event at seq ${seq} lacks a partial blockId`);
      }
      // Repeated partial identity across a chunk stream is expected, not a reject.
    }
  }
  return true;
}

/**
 * Project a raw page and fail closed via validateCanonicalProjectionPage().
 * Convenience for tests / callers holding raw DSH events; the snapshot builder
 * (T27-04) consumes the already-projected page instead.
 */
export function projectAndValidatePage(rawEvents) {
  if (!Array.isArray(rawEvents)) {
    throw new ProjectionValidationError("malformed-page", "events must be an array");
  }
  const projected = rawEvents.map(projectEvent);
  validateCanonicalProjectionPage(projected);
  return projected;
}

/** Backward-compatible alias for projectAndValidatePage (raw input). */
export function validateCanonicalProjection(rawEvents) {
  return projectAndValidatePage(rawEvents);
}
