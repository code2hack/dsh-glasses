/* Pure atomic snapshot staging for the M1 client.
 *
 * This file is a vanilla asset (no DOM, no native access, no imports — it must
 * run unchanged inside the WebView) and is the CLIENT mirror of the frozen wire
 * law pinned in plugins/dsh-glasses-plugin/lib/snapshot.js
 * (validateSnapshotWire). The client deliberately duplicates rather than
 * imports that law so an offline/stale client can never accept a snapshot the
 * server law rejects.
 *
 * Atomicity is structural: stageSnapshot(raw) reads the raw wire object,
 * validates EVERYTHING, and only on success builds a DETACHED conversation
 * state via the same pure C0 reducer used for live rendering. It never touches
 * global/DOM/installed state. On failure it returns {ok:false, code} and
 * discards everything; the caller keeps its previous visible state untouched.
 *
 * It never throws over untrusted input: all internal faults degrade to
 * {ok:false, code:"validator-error"}.
 */
(function installGlassesSnapshotCore(root) {
  'use strict';

  var M1_PROTOCOL_MAJOR = 1;
  var M1_ATTACHMENT_SET_REVISION = 1;
  var M1_ATTACHMENT_LABEL = 'Attached session';
  var M1_BOOTSTRAP_MAX_EVENTS = 1000;
  var M1_STATES = ['idle', 'running', 'waiting-user', 'unavailable', 'unknown'];
  var MUTATION_CAPABILITIES = ['draftMutations', 'send', 'steer', 'interrupt', 'resolveRequest'];

  function fail(code, message) {
    return { ok: false, code: code, message: message };
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // -------------------------------------------------------------------------
  // Frozen wire law (mirror of validateSnapshotWire).
  // Rejects with the SAME codes; malformed/untrusted input can never be
  // accepted, sorted, or partially installed.
  // -------------------------------------------------------------------------
  function validateWire(snapshot, expectedProtocolMajor, expectedSessionId) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return fail('not-snapshot', 'snapshot must be an object');
    if (hasOwn(snapshot, 'ok')) return fail('envelope-ok-not-allowed', 'the canonical snapshot carries no ok field');
    var KEYS = ['protocolMajor', 'serverGeneration', 'connectionEpoch', 'attachmentSetRevision', 'streamSequence', 'attachments', 'drafts'];
    for (var k = 0; k < KEYS.length; k++) {
      if (!hasOwn(snapshot, KEYS[k])) return fail('missing-' + KEYS[k], 'snapshot lacks required field ' + KEYS[k]);
    }

    if (snapshot.protocolMajor !== expectedProtocolMajor) return fail('unsupported-protocolMajor', 'protocolMajor ' + snapshot.protocolMajor + ' != ' + expectedProtocolMajor);
    if (typeof snapshot.serverGeneration !== 'string' || snapshot.serverGeneration === '') return fail('missing-serverGeneration', 'serverGeneration must be a non-empty string');
    if (typeof snapshot.connectionEpoch !== 'string' || snapshot.connectionEpoch === '') return fail('missing-connectionEpoch', 'connectionEpoch must be a non-empty string');
    if (snapshot.attachmentSetRevision !== M1_ATTACHMENT_SET_REVISION) return fail('wrong-attachmentSetRevision', 'attachmentSetRevision ' + snapshot.attachmentSetRevision + ' != 1');
    if (!Number.isInteger(snapshot.streamSequence)) return fail('malformed-streamSequence', 'streamSequence must be an integer');

    var atts = snapshot.attachments;
    if (!Array.isArray(atts)) return fail('zero-attachments', 'attachments must be an array');
    if (atts.length === 0) return fail('zero-attachments', 'exactly one attachment required');
    if (atts.length > 1) return fail('two-attachments', 'expected exactly one attachment');

    if (!Array.isArray(snapshot.drafts)) return fail('drafts-not-array', 'drafts must be an array');
    if (snapshot.drafts.length !== 0) return fail('non-empty-drafts', 'drafts must be []');

    var att = atts[0];
    if (!att || typeof att !== 'object') return fail('malformed-attachment', 'attachment must be an object');
    var sg = snapshot.serverGeneration;
    var attachmentGeneration = att.attachmentGeneration;

    if (expectedSessionId !== undefined && att.sessionId !== expectedSessionId) return fail('wrong-sessionId', 'attachment sessionId does not match expected session');
    if (typeof att.sessionId !== 'string' || att.sessionId === '') return fail('missing-attachment-sessionId', 'attachment sessionId must be non-empty');
    if (typeof att.attachmentId !== 'string' || att.attachmentId === '') return fail('missing-attachmentId', 'attachmentId must be a non-empty opaque string');
    if (att.attachmentId === att.sessionId || att.attachmentId.indexOf(att.sessionId) >= 0) return fail('attachmentId-encodes-session', 'attachmentId encodes sessionId');
    if (att.attachmentId === sg || att.attachmentId.indexOf(sg) >= 0) return fail('attachmentId-couples-serverGeneration', 'attachmentId couples serverGeneration');
    if (!Number.isInteger(attachmentGeneration) || attachmentGeneration <= 0) return fail('non-positive-attachmentGeneration', 'attachmentGeneration must be a positive integer');
    if (typeof att.label !== 'string' || att.label === '') return fail('missing-label', 'attachment label must be non-empty');
    if (att.order !== 0) return fail('non-zero-order', 'attachment order must be 0');
    if (M1_STATES.indexOf(att.state) < 0) return fail('invalid-attachment-state', 'attachment state not in vocabulary');

    var caps = att.capabilities;
    if (!caps || typeof caps !== 'object') return fail('malformed-capabilities', 'capabilities must be an object');
    if (caps.historyRead !== true) return fail('historyRead-not-true', 'historyRead must be true');
    for (var ci = 0; ci < MUTATION_CAPABILITIES.length; ci++) {
      var key = MUTATION_CAPABILITIES[ci];
      if (caps[key] !== false) return fail('mutation-capability-enabled', 'capability ' + key + ' must be false in M1');
    }
    if (caps.liveUpdates !== false) return fail('mutation-capability-enabled', 'capability liveUpdates must be false in M1');

    var agent = att.agent;
    if (!agent || typeof agent !== 'object') return fail('missing-agent-projection', 'attachment must include the agent projection');
    if (agent.state !== att.state) return fail('agent-state-mismatch', 'agent.state must equal attachment.state');
    if (agent.serverGeneration !== sg) return fail('agent-serverGeneration-mismatch', 'agent.serverGeneration must equal snapshot.serverGeneration');
    if (agent.attachmentGeneration !== attachmentGeneration) return fail('agent-attachmentGeneration-mismatch', 'agent.attachmentGeneration must equal attachment.attachmentGeneration');

    var history = att.history;
    if (!history || typeof history !== 'object') return fail('missing-history', 'attachment must include history');
    if (history.serverGeneration !== sg) return fail('history-serverGeneration-mismatch', 'history.serverGeneration must equal snapshot.serverGeneration');
    if (history.attachmentGeneration !== attachmentGeneration) return fail('history-attachmentGeneration-mismatch', 'history.attachmentGeneration must equal attachment.attachmentGeneration');
    if (!Number.isInteger(history.asOfSeq) || history.asOfSeq < -1) return fail('history-malformed-asOfSeq', 'history.asOfSeq must be an integer >= -1');
    // Array check BEFORE any .length access: this law never throws.
    if (!Array.isArray(history.events)) return fail('history-events-not-array', 'history.events must be an array');
    if (snapshot.streamSequence !== history.asOfSeq) return fail('streamSequence-mismatch', 'streamSequence must equal history.asOfSeq');
    if (history.events.length === 0 ? history.asOfSeq !== -1 : history.asOfSeq < 0) return fail('asOfSeq-mismatch', 'asOfSeq invalid for history size');
    if (history.events.length > M1_BOOTSTRAP_MAX_EVENTS) return fail('history-beyond-max', 'history exceeds the protocol hard maximum ' + M1_BOOTSTRAP_MAX_EVENTS);
    if (history.events.length > 0 && (history.events[history.events.length - 1] === null || typeof history.events[history.events.length - 1] !== 'object' || history.events[history.events.length - 1].seq !== history.asOfSeq)) {
      return fail('asOfSeq-mismatch', 'last event seq must equal asOfSeq');
    }

    // Canonical M1 (#28) events law (client mirror of the server law): every
    // history event is { seq, type, blocks[] } with typed, stable-blockId
    // projection blocks. Non-renderable DSH source events carry blocks: [].
    var REPEATABLE_KINDS = { partial: true, status: true };
    var BLOCK_KINDS = { text: true, image: true, 'partial': true, 'tool/call': true, 'tool/result': true, status: true, error: true, request: true };
    var previous = -1;
    var seenBlockIds = {};
    for (var ei = 0; ei < history.events.length; ei++) {
      var ev = history.events[ei];
      if (!ev || typeof ev !== 'object') return fail('malformed-projected-event', 'history event must be an object');
      if (!Number.isInteger(ev.seq) || ev.seq < 0) return fail('malformed-seq', 'event seq invalid');
      if (typeof ev.type !== 'string' || ev.type === '') return fail('malformed-type', 'history event must carry a non-empty type');
      if (ev.seq <= previous) return fail('non-monotonic-seq', 'event seq not strictly increasing');
      if (ev.seq > history.asOfSeq) return fail('seq-beyond-asOfSeq', 'event seq exceeds asOfSeq');
      previous = ev.seq;

      if (!Array.isArray(ev.blocks)) return fail('malformed-blocks', 'event lacks a blocks array');
      if (ev.type === 'user/message' || ev.type === 'assistant/message') {
        if (ev.blocks.length === 0) return fail('message-no-blocks', 'message event has no derived blocks');
        var msgPrefix = ev.type === 'user/message' ? 'message:u-' : 'message:a-';
        var wantedRole = ev.type === 'user/message' ? 'user' : 'assistant';
        var contentIndex = /:content:\d+$/;
        for (var mcj = 0; mcj < ev.blocks.length; mcj++) {
          var mblock = ev.blocks[mcj];
          if (mblock && mblock.kind === 'error') continue; // interruption error child escapes the role law
          if (!mblock || typeof mblock.blockId !== 'string' || mblock.blockId.indexOf(msgPrefix) !== 0 || !contentIndex.test(mblock.blockId)) {
            return fail('blockId-root-mismatch', 'message block not rooted under its role prefix');
          }
          if (mblock.kind === 'text' || mblock.kind === 'image') {
            if (mblock.role !== wantedRole) return fail('type-role-mismatch', 'message block role mismatch');
          }
        }
      } else if (ev.type === 'assistant/chunk') {
        if (ev.blocks.length < 1) return fail('chunk-no-block', 'chunk event carries no valid partial block');
        for (var bj = 0; bj < ev.blocks.length; bj++) {
          var pblock = ev.blocks[bj];
          if (!pblock || pblock.kind !== 'partial') return fail('chunk-wrong-kind', 'chunk event block is not partial');
          var expected = (Number.isInteger(pblock.turn) && Number.isInteger(pblock.step)) ? 'partial:' + pblock.turn + ':' + pblock.step : 'partial:s' + ev.seq;
          if (pblock.blockId !== expected) return fail('type-blockId-mismatch', 'chunk blockId does not match its turn/step');
        }
      }

      for (var bi = 0; bi < ev.blocks.length; bi++) {
        var block = ev.blocks[bi];
        if (!block || typeof block !== 'object') return fail('malformed-block', 'event block must be an object');
        if (typeof block.blockId !== 'string' || block.blockId === '') return fail('missing-blockId', 'event block lacks blockId');
        if (!hasOwn(BLOCK_KINDS, block.kind)) return fail('unknown-block-kind', 'block has unknown kind');
        // Structured per-kind shape law (mirror of the projection law).
        if (block.kind === 'text' && typeof block.text !== 'string') return fail('malformed-projected-event', 'text block lacks text');
        if (block.kind === 'image' && (typeof block.attachmentId !== 'string' || block.attachmentId === '')) return fail('malformed-projected-event', 'image block lacks attachmentId');
        if (block.kind === 'partial' && (!block.chunk || typeof block.chunk !== 'object' || typeof block.chunk.type !== 'string')) return fail('malformed-projected-event', 'partial block lacks chunk.type');
        if (block.kind === 'tool/call' && (typeof block.callId !== 'string' || block.callId === '')) return fail('malformed-projected-event', 'tool call block lacks callId');
        if (block.kind === 'tool/result' && (typeof block.callId !== 'string' || block.callId === '')) return fail('malformed-projected-event', 'tool result block lacks callId');
        if (block.kind === 'status' && (!Number.isInteger(block.turn) || (block.state !== 'running' && block.state !== 'idle'))) return fail('malformed-projected-event', 'status block malformed');
        if (block.kind === 'error' && typeof block.message !== 'string') return fail('malformed-projected-event', 'error block lacks message');
        if (!hasOwn(REPEATABLE_KINDS, block.kind) && hasOwn(seenBlockIds, block.blockId)) return fail('duplicate-blockId', 'duplicate blockId');
        seenBlockIds[block.blockId] = true;
      }
    }

    return { ok: true };
  }

  // Deterministic JSON-tree clone for wire detachment. The bootstrap body is
  // parsed JSON, so arrays/plain objects are sufficient; primitives pass
  // through by value. Nothing in the staged result may share a reference with
  // the caller's rawSnapshot.
  function cloneWire(value, seen) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      var arr = new Array(value.length);
      for (var i = 0; i < value.length; i++) arr[i] = cloneWire(value[i], seen);
      return arr;
    }
    var out = {};
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = cloneWire(value[key], seen);
    }
    return out;
  }

  // Build a DETACHED staged snapshot: normalized attachment block + a fresh
  // conversation state computed through the pure C0 reducer (never the live
  // reducer instance, never global state). The wire tree is fully cloned first
  // so mutating rawSnapshot after a successful stage cannot change ANY part of
  // the staged result. Returns {ok:true, snapshot:staged} — the only object any
  // later install step may adopt wholesale.
  function buildStaged(raw) {
    var attachment = raw.attachments[0];
    var history = attachment.history;
    var conversation = root.C0Core.createConversationState();
    for (var i = 0; i < history.events.length; i++) {
      root.C0Core.applyConversationEvent(conversation, history.events[i]);
    }
    var items = root.C0Core.conversationItems(conversation).map(function (item) {
      var copy = {};
      for (var key in item) copy[key] = item[key];
      return copy;
    });
    return {
      protocolMajor: raw.protocolMajor,
      serverGeneration: raw.serverGeneration,
      connectionEpoch: raw.connectionEpoch,
      attachmentSetRevision: raw.attachmentSetRevision,
      streamSequence: raw.streamSequence,
      attachment: {
        attachmentId: attachment.attachmentId,
        attachmentGeneration: attachment.attachmentGeneration,
        sessionId: attachment.sessionId,
        label: attachment.label,
        order: attachment.order,
        state: attachment.state,
        capabilities: cloneWire(attachment.capabilities),
        agent: cloneWire(attachment.agent),
        history: {
          serverGeneration: history.serverGeneration,
          attachmentGeneration: history.attachmentGeneration,
          asOfSeq: history.asOfSeq,
          events: cloneWire(history.events),
        },
      },
      drafts: cloneWire(raw.drafts),
      conversation: conversation,
      items: items,
    };
  }

  function stageSnapshot(rawSnapshot, opts) {
    opts = opts || {};
    var expectedSessionId = opts.expectedSessionId;
    var expectedServerGeneration = opts.expectedServerGeneration;
    try {
      // 0. The client ITSELF pins the supported protocol major; a caller may
      //    not widen it (AC3 unsupported-major invariant lives in the staging
      //    module, not in app.js remembering to pass 1).
      if (opts.protocolMajor !== undefined && opts.protocolMajor !== M1_PROTOCOL_MAJOR) {
        return fail('unsupported-protocolMajor', 'client supports protocolMajor ' + M1_PROTOCOL_MAJOR + ' only');
      }
      // 1. Validate the COMPLETE generic frozen wire law first (mirror of the
      //    server validateSnapshotWire against M1_PROTOCOL_MAJOR, including its
      //    contextual expectedSessionId option).
      var judged = validateWire(rawSnapshot, M1_PROTOCOL_MAJOR, expectedSessionId);
      if (!judged.ok) return judged;
      // 2. Client-only contextual fence, AFTER the generic law passed: a
      //    malformed snapshot is reported with its real generic code, never
      //    misclassified as a generation fence.
      if (expectedServerGeneration !== undefined && rawSnapshot.serverGeneration !== expectedServerGeneration) {
        return fail('serverGeneration-mismatch', 'serverGeneration ' + rawSnapshot.serverGeneration + ' != expected ' + expectedServerGeneration);
      }
      // 3. Build the fully detached staged result from a deep-cloned wire tree.
      return { ok: true, snapshot: buildStaged(cloneWire(rawSnapshot)) };
    } catch (e) {
      return fail('validator-error', String(e && e.message ? e.message : e));
    }
  }

  root.GlassesSnapshotCore = Object.freeze({
    stageSnapshot: stageSnapshot,
    M1_PROTOCOL_MAJOR: M1_PROTOCOL_MAJOR,
    M1_ATTACHMENT_LABEL: M1_ATTACHMENT_LABEL,
    M1_BOOTSTRAP_MAX_EVENTS: M1_BOOTSTRAP_MAX_EVENTS,
  });
})(globalThis);
