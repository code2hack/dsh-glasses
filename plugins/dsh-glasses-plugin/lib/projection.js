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
//     tool call/result (tool:<callId>:call / tool:<callId>:result plus
//     tool:<callId>:result:content:<i> nested-result children), status/error/
//     request turn/tool-scoped identities.
//   * raw provider/storage/internal payloads and raw positional surfaceOp
//     semantics are NOT leaked: folding to stable block identity happens here.
//   * SURFACE REPLACEMENTS STAY MODEL-ONLY: a surface-eligible event whose
//     surfaceOp is not 'append' (e.g. {op:'replace',start,end} compaction
//     rewrite) remains in durable seq space but projects blocks: [] — the
//     human transcript keeps the append-origin events the user already read.
//     Only append-origin surface events derive human-transcript blocks
//     (rc.2 dsh-session/surface.isAppendSurfaceEvent is the oracle).
//   * UNKNOWN EVENTS FAIL CLOSED WHERE IT MATTERS (AC5): a recognized type is
//     projected or non-rendered by explicit rule; an unrecognized type is
//     skipped when it provably cannot change the visible conversation —
//     rc.2 marks it ignorable:true, OR it carries no SurfaceOp (a non-surface
//     meta record; observed rc.2 examples: permission/preset, sandbox/mode,
//     approval/policy, which DSH persists in the same seq-space log without an
//     ignorable marker). An unrecognized event that CARRIES a SurfaceOp is a
//     future surface rewrite of user-visible content → throws
//     'unsupported-required-event' so a session whose visible transcript
//     semantics changed cannot be silently gutted.
//   * empty-content user/assistant messages are VALID (a max-token cutoff
//     hosts usage only): the canonical event is accepted with blocks: [] and
//     the durable seq advances; nothing renders.

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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// rc.2 surface vocabulary (dsh-session lib/types/types.d.ts): only these
// message-producing event types may carry a SurfaceOp; a surfaceOp that is not
// exactly 'append' is a positional replacement copy (model-only).
const SURFACE_TYPES = new Set(["user/message", "assistant/message", "tool/result"]);

function isReplacementSurfaceEvent(evt) {
  return SURFACE_TYPES.has(evt?.type) && evt?.surfaceOp != null && evt.surfaceOp !== "append";
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
 *
 * Every projected content child carries its explicit canonical `contentIndex`
 * (= its position in the durable source content array). The page law validates
 * contentIndex against the `:content:<i>` blockId suffix; ordering is derived
 * from contentIndex (never by reparsing the opaque message id).
 */
function projectContentBlocks(rootId, content) {
  const blocks = [];
  if (!Array.isArray(content)) return blocks;
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ blockId: contentBlockId(rootId, i), kind: "text", text: block.text, contentIndex: i });
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
          contentIndex: i,
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
          contentIndex: i,
        });
      }
    } else if (block.type === "tool-result") {
      const callId = stringOrEmpty(block.toolCallId);
      if (callId) {
        blocks.push({
          blockId: contentBlockId(rootId, i),
          kind: "tool/result",
          callId,
          text: textFromBlocks(block.content),
          error: block.isError === true,
          contentIndex: i,
        });
      }
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

  // A replacement surface copy (surfaceOp != 'append') is a model-surface
  // rewrite (e.g. compaction summary) shadowing a range the user already read.
  // It must NOT render as another ordinary transcript message: it stays in
  // durable seq space with blocks: [] and the human transcript keeps the
  // append-origin history (rc.2 isAppendSurfaceEvent oracle).
  if (isReplacementSurfaceEvent(evt)) return projected;

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
    // rc.2 ToolResultMessage.content = [ToolResultBlock]; nested visible
    // content lives under ToolResultBlock.content (a ContentBlock[] that may
    // include images — never silently dropped).
    const resultBlock = Array.isArray(data?.message?.content) ? data?.message?.content?.[0] : undefined;
    const failed = resultBlock?.isError === true || Boolean(data?.error) === true;
    const shell = {
      blockId: `tool:${callId}:result`,
      kind: "tool/result",
      callId,
      error: failed,
    };
    const children = [];
    const nested = Array.isArray(resultBlock?.content) ? resultBlock.content : [];
    for (let i = 0; i < nested.length; i++) {
      const child = nested[i];
      if (!child || typeof child !== "object") continue;
      if (child.type === "text" && typeof child.text === "string") {
        children.push({
          blockId: `tool:${callId}:result:content:${i}`,
          kind: "text",
          role: "tool",
          text: child.text,
          contentIndex: i,
        });
      } else if (child.type === "image") {
        const ref = child.attachment;
        const attachmentId = typeof ref?.attachmentId === "string" ? ref.attachmentId : "";
        if (attachmentId) {
          children.push({
            blockId: `tool:${callId}:result:content:${i}`,
            kind: "image",
            role: "tool",
            attachmentId,
            mediaType: typeof ref.mediaType === "string" ? ref.mediaType : "",
            width: Number.isInteger(ref.width) ? ref.width : null,
            height: Number.isInteger(ref.height) ? ref.height : null,
            contentIndex: i,
          });
        }
      }
      // Nested reasoning/tool-call/tool-result content is not a visible render
      // block for this M1 slice; the child index is preserved in blockId only
      // when a block is derived (deterministic, never renumbered).
    }
    projected.blocks = [shell, ...children];
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

  // step/start, step/end, todo/write, session/end-seed and similar recognized
  // non-renderable DSH records: valid events with blocks: [] — the watermark
  // advances, nothing renders.
  if (KNOWN_NONRENDERABLE_TYPES.has(type)) return projected;

  // An unrecognized FUTURE type is safe to skip ONLY when it provably cannot
  // change the visible conversation.
  //   1. rc.2 marks it ignorable:true -> always skip.
  //   2. It carries NO SurfaceOp -> it is a non-surface meta record (observed
  //      rc.2 records include permission/preset, sandbox/mode, approval/policy,
  //      plus any future informational record DSH persists in the same log).
  //      It cannot be a replacement copy of anything the user saw and cannot
  //      gut the transcript, so skipping is safe.
  if (evt?.ignorable === true || evt?.surfaceOp == null) return projected;

  //   3. An unknown event carrying a SurfaceOp is a FUTURE surface rewrite of
  //      user-visible content whose shape we cannot render -> FAIL CLOSED
  //      (AC5): reject so writes are disabled and the caller takes its
  //      complete-resynchronization path instead of silently dropping a record
  //      that changed what the user saw.
  throw new ProjectionValidationError(
    "unsupported-required-event",
    `event ${String(seq)} has unknown required surface type ${JSON.stringify(type)} (surfaceOp ${JSON.stringify(evt.surfaceOp)})`,
  );
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
  "step/start", "step/end", "todo/write", "session/end-seed", "session/end",
]);
// Tool-result events project a status/result SHELL plus (when the nested
// rc.2 ToolResultBlock.content carries visible content) deterministic
// tool:<callId>:result:content:<i> text/image children.
const TOOL_RESULT_TYPE = "tool/result";

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
      // Empty-content user/assistant messages are VALID non-renderable events
      // (a max-token cutoff hosts usage only): blocks: [] is accepted and the
      // durable seq advances. When blocks exist they must obey the root/role law.
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
    } else if (type === TOOL_RESULT_TYPE) {
      // Nested rc.2 ToolResultBlock content is projected deterministically: a
      // status/result shell plus tool:<callId>:result:content:<i> children.
      // The shell is REQUIRED (fail closed); child roots must match it.
      const shellBlocks = event.blocks.filter((b) => b && b.kind === "tool/result");
      expect(shellBlocks.length >= 1, "tool-result-shell-mismatch", `tool/result event ${seq} lacks a result shell`);
      for (const shell of shellBlocks) {
        expect(typeof shell.callId === "string" && shell.callId !== "", "malformed-projected-event", `tool/result shell at seq ${seq} lacks callId`);
        expect(shell.blockId === `tool:${shell.callId}:result`, "blockId-root-mismatch", `tool result shell ${String(shell.blockId)} != tool:${shell.callId}:result`);
        const toolPattern = new RegExp(`^tool:${escapeRegExp(shell.callId)}:result:content:\\d+$`);
        for (const block of event.blocks) {
          if (block.kind === "text" || block.kind === "image") {
            expect(typeof block.blockId === "string" && toolPattern.test(block.blockId), "blockId-root-mismatch", `tool result child ${String(block.blockId)} not rooted under tool:${shell.callId}:result:content:<i>`);
            expect(block.role === "tool", "type-role-mismatch", `tool result child ${String(block.blockId)} must carry role 'tool'`);
          }
        }
      }
    }

    for (const block of event.blocks) {
      expect(typeof block.blockId === "string" && block.blockId !== "", "missing-blockId", `event ${seq} block lacks blockId`);
      expect(BLOCK_KINDS.has(block.kind), "unknown-block-kind", `block ${block.blockId} has unknown kind ${String(block.kind)}`);
      // Canonical content children carry an explicit contentIndex validated
      // against the :content:<i> suffix (ordering never reparses opaque ids).
      const contentMatch = /:content:(\d+)$/.exec(block.blockId);
      if (contentMatch) {
        expect(
          Number.isInteger(block.contentIndex) && block.contentIndex === Number(contentMatch[1]),
          "content-index-mismatch",
          `block ${block.blockId} contentIndex must equal its :content: suffix (${contentMatch[1]})`,
        );
      }
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
