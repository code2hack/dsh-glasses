// Narrow glasses projection for TB0-C0 and M1 (#27/#28).
// Raw DSH events never cross the glasses namespace. Only the fields needed to
// reconstruct one conversation (and the typed live categories required by M1
// #28 AC2) are retained.
//
// M1 (#27) canonical invariants (see docs/dev/plan-m1-27-sensei-2026-08-22.md):
//   * every renderable logical block carries a STABLE blockId
//   * DSH seq ordering is preserved verbatim (projection never reorders)
//   * duplicate/backwards seq data and duplicate render blockIds are rejected
//     before a snapshot may be created (validateCanonicalProjectionPage)
//
// M1 (#28) canonical extension (see docs/dev/plan-m1-28-chatgpt-2026-08-22.md):
//   * a canonical projected event is { seq, type, blocks[] }: the durable DSH
//     source type is preserved verbatim (projection never invents DSH event
//     types), and ZERO OR MORE typed projection blocks are DERIVED from it.
//   * one DSH source event may yield several display blocks (e.g. ordered
//     text/image content of one message), and a valid but non-renderable
//     source event yields blocks: [] while still advancing the durable
//     watermark.
//   * stable block identities: history/user/assistant message content children
//     keyed under the accepted root identity (message:u-<id>:content:<i> /
//     message:a-<id>:content:<i>), partial streams (partial:<turn>:<step>),
//     tool call/result (tool:<callId>:call / tool:<callId>:result),
//     status/error/request turn/tool-scoped identities.
//   * raw provider/storage/internal payloads and raw positional surfaceOp
//     semantics are NOT leaked: folding to stable block identity happens here.

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

// -- Stable block identity laws --------------------------------------------

// Root message identity (accepted #27 law): durable DSH message id preferred,
// deterministic seq fallback only when DSH gives none. rpcId is never identity.
function messageRoot(role, event) {
  const prefix = role === "user" ? "message:u-" : "message:a-";
  const id = stringOrEmpty(event?.data?.id ?? event?.data?.message?.id);
  if (id) return prefix + id;
  return prefix + "s" + String(event?.seq ?? "?");
}

// Child content block identity within one message: root identity + position.
// Durable message payloads are immutable, so rootId:content:<i> is deterministic
// and stable across snapshot/live/paging replay.
function contentBlockId(rootId, index) {
  return `${rootId}:content:${index}`;
}

function partialBlockId(event, data) {
  if (Number.isInteger(data?.turn) && Number.isInteger(data?.step)) {
    return `partial:${data.turn}:${data.step}`;
  }
  return `partial:s${String(event?.seq ?? "?")}`;
}

// -- Content-block projection ----------------------------------------------

/**
 * Project ordered message content blocks into typed projection blocks in EXACT
 * source order. Content kinds that are valid DSH but not rendered by this M1
 * slice (reasoning, unknown) are skipped (the event/watermark still advances).
 */
function projectContentBlocks(rootId, content) {
  const blocks = [];
  if (!Array.isArray(content)) return blocks;
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ blockId: contentBlockId(rootId, i), kind: "text", text: block.text });
    } else if (block.type === "image") {
      const ref = block.attachment;
      // Safe canonical image identity: opaque attachmentId (never path/URL).
      const attachmentId = typeof ref?.attachmentId === "string" ? ref.attachmentId : "";
      if (attachmentId) {
        blocks.push({
          blockId: contentBlockId(rootId, i),
          kind: "image",
          attachmentId,
          mediaType: typeof ref.mediaType === "string" ? ref.mediaType : "",
          width: Number.isInteger(ref.width) ? ref.width : null,
          height: Number.isInteger(ref.height) ? ref.height : null,
        });
      }
    } else if (block.type === "tool-call") {
      const id = stringOrEmpty(block.id);
      if (id) {
        blocks.push({
          blockId: contentBlockId(rootId, i),
          kind: "tool/call",
          callId: id,
          name: stringOrEmpty(block.name),
          arguments: stringOrEmpty(block.arguments),
        });
      }
    } else if (block.type === "tool-result") {
      blocks.push({
        blockId: contentBlockId(rootId, i),
        kind: "tool/result",
        callId: stringOrEmpty(block.toolCallId),
        text: textFromBlocks(block.content),
        error: block.isError === true,
      });
    }
    // Other content kinds (reasoning/unknown) are valid DSH but not projected.
  }
  return blocks;
}

function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

// -- Canonical projected event ---------------------------------------------

/**
 * Project ONE raw rc.2 durable event into the canonical glasses representation
 * { seq, type, blocks[] }. `type` is the canonicalized DSH source type
 * (verbatim string). The projector NEVER invents DSH event types and NEVER
 * leaks raw DSH payload structure into blocks beyond safe canonical fields.
 */
export function projectEvent(evt) {
  const seq = numberOrNull(evt?.seq);
  const type = stringOrEmpty(evt?.type);
  const projected = { seq, type, blocks: [] };
  const data = evt?.data ?? {};

  if (type === "user/message") {
    const root = messageRoot("user", evt);
    projected.blocks = projectContentBlocks(root, data?.content);
    return withRole(projected, "user");
  }

  if (type === "assistant/message") {
    const root = messageRoot("assistant", evt);
    projected.blocks = projectContentBlocks(root, data?.message?.content);
    if (Number.isInteger(data?.turn)) projected.turn = data.turn;
    if (Number.isInteger(data?.step)) projected.step = data.step;
    if (data?.interrupted === true) {
      // Interruption is not silently dropped: a bounded error projection
      // marks the interrupted turn (safe canonical message).
      projected.blocks.push({ blockId: `error:message:${root}`, kind: "error", message: "interrupted" });
    }
    return withRole(projected, "assistant");
  }

  if (type === "assistant/chunk") {
    const chunk = data?.chunk;
    if (!chunk || typeof chunk.type !== "string") return projected;
    const partial = {
      blockId: partialBlockId(evt, data),
      kind: "partial",
      turn: Number.isInteger(data?.turn) ? data.turn : null,
      step: Number.isInteger(data?.step) ? data.step : null,
      chunk: { type: chunk.type },
    };
    if (Number.isInteger(chunk.index)) partial.chunk.index = chunk.index;
    // Bounded canonical stream: only text-bearing chunk kinds carry their text;
    // reasoning deltas are folded client-side and never leak raw tokens.
    if (typeof chunk.text === "string" && (chunk.type === "text-delta" || chunk.type === "block-end")) partial.chunk.text = chunk.text;
    if (typeof chunk.blockType === "string") partial.chunk.blockType = chunk.blockType;
    if (chunk?.block && typeof chunk.block?.type === "string") {
      partial.chunk.block = { type: chunk.block.type };
      if (typeof chunk.block.text === "string") partial.chunk.block.text = chunk.block.text;
    }
    projected.blocks = [partial];
    return projected;
  }

  if (type === "tool/call") {
    const callId = stringOrEmpty(data?.callId);
    if (!callId) return projected;
    projected.blocks = [{
      blockId: `tool:${callId}:call`,
      kind: "tool/call",
      callId,
      name: stringOrEmpty(data?.name),
      arguments: stringOrEmpty(data?.arguments),
    }];
    return projected;
  }

  if (type === "tool/result") {
    const callId = stringOrEmpty(data?.message?.source?.callId ?? data?.callId);
    if (!callId) return projected;
    const resultBlock = Array.isArray(data?.message?.content) ? data?.message?.content?.[0] : undefined;
    const failed = Boolean(resultBlock?.isError) === true || Boolean(data?.error);
    const text = textFromBlocks(resultBlock?.content ?? data?.message?.content);
    projected.blocks = [{
      blockId: `tool:${callId}:result`,
      kind: "tool/result",
      callId,
      text,
      error: failed,
    }];
    return projected;
  }

  if (type === "turn/start") {
    const turn = numberOrNull(data?.turn);
    if (!Number.isInteger(turn)) return projected;
    projected.blocks = [{ blockId: `status:turn:${turn}`, kind: "status", turn, state: "running" }];
    return projected;
  }

  if (type === "turn/end") {
    const turn = numberOrNull(data?.turn);
    if (!Number.isInteger(turn)) return projected;
    projected.blocks = [{ blockId: `status:turn:${turn}`, kind: "status", turn, state: "idle" }];
    const reason = data?.reason ?? {};
    if (reason?.kind === "error") {
      projected.blocks.push({
        blockId: `error:turn:${turn}`,
        kind: "error",
        turn,
        message: typeof reason?.error?.message === "string" ? reason.error.message : "turn failed",
      });
    }
    return projected;
  }

  if (type === "request/context") {
    projected.blocks = [{
      blockId: `request:s${seq}`,
      kind: "request",
      provider: typeof data?.provider === "string" ? data.provider : "",
      model: typeof data?.model === "string" ? data.model : "",
    }];
    return projected;
  }

  if (type === "request/header") {
    projected.blocks = [{
      blockId: `request:s${seq}`,
      kind: "request",
      reason: typeof data?.reason === "string" ? data.reason : "",
    }];
    return projected;
  }

  // step/start, step/end, todo/write, session/end-seed, unknown/future types:
  // valid DSH events with blocks: [] — watermark advances, nothing renders.
  return projected;
}

function withRole(projected, role) {
  for (const block of projected.blocks) {
    if (block.kind === "text" || block.kind === "image") {
      block.role = role;
    }
  }
  return projected;
}

// -- Page validation (wire law for projected pages) ------------------------

const MESSAGE_TYPES = new Set(["user/message", "assistant/message"]);
const PARTIAL_TYPES = new Set(["assistant/chunk"]);
const BLOCK_KINDS = new Set(["text", "image", "partial", "tool/call", "tool/result", "status", "error", "request"]);
// Kinds that may legitimately share a blockId across DIFFERENT source seqs
// (two source events update the same stable logical block — never a
// duplication). All other kinds must be unique within a page.
const REPEATABLE_KINDS = new Set(["partial", "status"]);
// DSH source types that are valid but carry no derived render blocks.
const KNOWN_NONRENDERABLE_TYPES = new Set([
  "step/start", "step/end", "todo/write", "session/end-seed", "session/end", "unknown",
]);

function expect(condition, code, message) {
  if (!condition) throw new ProjectionValidationError(code, message);
}

function validateBlockShape(block, seq) {
  if (block.kind === "text" && typeof block.text !== "string") {
    throw new ProjectionValidationError("malformed-projected-event", `text block ${String(block.blockId)} at seq ${seq} lacks text`);
  }
  if (block.kind === "image" && (typeof block.attachmentId !== "string" || block.attachmentId === "")) {
    throw new ProjectionValidationError("malformed-projected-event", `image block ${String(block.blockId)} at seq ${seq} lacks attachmentId`);
  }
  if (block.kind === "partial" && (!block.chunk || typeof block.chunk !== "object" || typeof block.chunk.type !== "string")) {
    throw new ProjectionValidationError("malformed-projected-event", `partial block ${String(block.blockId)} at seq ${seq} lacks chunk.type`);
  }
  if (block.kind === "tool/call" && (typeof block.callId !== "string" || block.callId === "")) {
    throw new ProjectionValidationError("malformed-projected-event", `tool call block ${String(block.blockId)} at seq ${seq} lacks callId`);
  }
  if (block.kind === "tool/result" && (typeof block.callId !== "string" || block.callId === "")) {
    throw new ProjectionValidationError("malformed-projected-event", `tool result block ${String(block.blockId)} at seq ${seq} lacks callId`);
  }
  if (block.kind === "status") {
    if (!Number.isInteger(block.turn) || (block.state !== "running" && block.state !== "idle")) {
      throw new ProjectionValidationError("malformed-projected-event", `status block ${String(block.blockId)} at seq ${seq} is malformed`);
    }
  }
  if (block.kind === "error" && typeof block.message !== "string") {
    throw new ProjectionValidationError("malformed-projected-event", `error block ${String(block.blockId)} at seq ${seq} lacks message`);
  }
}

/**
 * Reject — never silently sort or de-duplicate — a canonical PROJECTED page
 * before a snapshot may be created from it. Operates on the already-projected
 * canonical events ({seq,type,blocks[]}) the snapshot builder actually receives.
 *
 * Invariants:
 *   * events is an array with globally strictly-increasing, unique seq
 *   * every event carries a non-empty type and a `blocks` array
 *   * every block carries a stable non-empty blockId and a known, well-formed
 *     kind
 *   * message content child block ids are rooted under the event's OWN role
 *     prefix, content children keep their role, and ids are unique within the
 *     page
 *   * chunk partial blocks carry the EXACT identity for their turn/step
 *   * repeatable kinds (partial/status) may update the same blockId across
 *     events; all other kinds must be unique within the page
 */
export function validateCanonicalProjectionPage(projectedEvents) {
  expect(Array.isArray(projectedEvents), "malformed-page", "events must be an array");
  let previous = -1;
  const seenBlockIds = new Set();
  for (const event of projectedEvents) {
    const seq = event?.seq;
    expect(Number.isInteger(seq) && seq >= 0, "malformed-seq", `invalid seq ${String(seq)}`);
    expect(seq > previous, "non-monotonic-seq", `seq ${seq} not strictly after ${previous}`);
    previous = seq;

    const type = event?.type;
    expect(typeof type === "string" && type !== "", "malformed-type", `event ${seq} lacks a type`);
    expect(Array.isArray(event?.blocks), "malformed-blocks", `event ${seq} lacks a blocks array`);

    if (MESSAGE_TYPES.has(type)) {
      expect(event.blocks.length > 0, "message-no-blocks", `message event ${seq} has no derived blocks`);
      const expectedPrefix = type === "user/message" ? "message:u-" : "message:a-";
      const wantedRole = type === "user/message" ? "user" : "assistant";
      for (const block of event.blocks) {
        // Interruption error children escape the role-prefix law; every other
        // child must be rooted under the event's OWN role prefix.
        if (block.kind === "error") continue;
        expect(
          typeof block.blockId === "string" && block.blockId.startsWith(expectedPrefix) && /:content:\d+$/.test(block.blockId),
          "blockId-root-mismatch",
          `block ${String(block.blockId)} not rooted under ${expectedPrefix}`,
        );
        if (block.kind === "text" || block.kind === "image") {
          expect(block.role === wantedRole, "type-role-mismatch", `block ${String(block.blockId)} has role ${String(block.role)}, wanted ${wantedRole}`);
        }
      }
    } else if (PARTIAL_TYPES.has(type)) {
      expect(event.blocks.length >= 1, "chunk-no-block", `chunk event ${seq} has no partial block`);
      for (const block of event.blocks) {
        expect(block.kind === "partial", "chunk-wrong-kind", `chunk event ${seq} block is not partial`);
        const expected = Number.isInteger(block.turn) && Number.isInteger(block.step)
          ? `partial:${block.turn}:${block.step}`
          : `partial:s${seq}`;
        expect(block.blockId === expected, "type-blockId-mismatch", `chunk blockId ${String(block.blockId)} != expected ${expected}`);
      }
    }

    for (const block of event.blocks) {
      expect(typeof block.blockId === "string" && block.blockId !== "", "missing-blockId", `event ${seq} block lacks blockId`);
      expect(BLOCK_KINDS.has(block.kind), "unknown-block-kind", `block ${block.blockId} has unknown kind ${String(block.kind)}`);
      validateBlockShape(block, seq);
      if (!REPEATABLE_KINDS.has(block.kind) && seenBlockIds.has(block.blockId)) {
        expect(false, "duplicate-blockId", `duplicate blockId ${block.blockId}`);
      }
      seenBlockIds.add(block.blockId);
    }
  }
  return true;
}

/**
 * Project a raw page and fail closed via validateCanonicalProjectionPage().
 * Convenience for tests / callers holding raw DSH events; the snapshot builder
 * consumes the already-projected page instead.
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
