/* Pure C0/C1 reducer helpers. This file intentionally has no DOM/native access so
 * the same logic can be replay-tested on the host.
 *
 * M1 (#28): the reducer consumes CANONICAL projected events
 * { seq, type, blocks[] } where blocks are typed projection blocks with stable
 * identities. Rendered conversation items are DERIVED from blocks, never from
 * raw DSH payloads. Durable-source deduplication is by event seq; two source
 * events that update the SAME stable block (e.g. status running->idle, or a
 * final assistant message replacing its partial stream) are NOT duplicates and
 * are both folded. */
(function installC0Core(root) {
  'use strict';

  function text(value) {
    return typeof value === 'string' ? value : '';
  }

  function finiteNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function wordRanges(value) {
    const source = text(value);
    const ranges = [];
    const re = /\S+/g;
    let match;
    while ((match = re.exec(source)) !== null) {
      ranges.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
    }
    return ranges;
  }

  function clampCursor(value, cursorWord) {
    const count = wordRanges(value).length;
    const index = Number.isInteger(cursorWord) ? cursorWord : 0;
    return Math.max(0, Math.min(count, index));
  }

  function moveCursor(value, cursorWord, direction) {
    const current = clampCursor(value, cursorWord);
    const count = wordRanges(value).length;
    if (direction === 'right') return Math.min(count, current + 1);
    if (direction === 'left') return Math.max(0, current - 1);
    return current;
  }

  /**
   * Paste a clipboard block immediately before the current word. The inserted
   * block is trimmed at its outer boundary and separated from neighboring text
   * when necessary. The returned cursor remains on the word that was current
   * before the paste (or at the new end sentinel).
   */
  function insertClipboard(value, cursorWord, clipboardValue) {
    const source = text(value);
    const clipboard = text(clipboardValue).trim();
    const ranges = wordRanges(source);
    const current = Math.max(0, Math.min(ranges.length, Number.isInteger(cursorWord) ? cursorWord : 0));
    if (!clipboard) return { changed: false, text: source, cursorWord: current };

    const position = current < ranges.length ? ranges[current].start : source.length;
    const left = source.slice(0, position);
    const right = source.slice(position);
    const prefix = left && !/\s$/.test(left) ? ' ' : '';
    const suffix = right && !/^\s/.test(right) ? ' ' : '';
    const insertedWords = wordRanges(clipboard).length;

    return {
      changed: true,
      text: left + prefix + clipboard + suffix + right,
      cursorWord: current < ranges.length ? current + insertedWords : ranges.length + insertedWords,
    };
  }

  function createConversationState() {
    return { messages: new Map(), partials: new Map(), blocks: new Map() };
  }

  function resetConversation(state) {
    state.messages.clear();
    state.partials.clear();
    state.blocks.clear();
  }

  // -------------------------------------------------------------------------
  // Canonical reducer over blocks[] projection events.
  // -------------------------------------------------------------------------

  // Content ordering for canonical children comes from the EXPLICIT canonical
  // `contentIndex` field that the page law validates against the :content:<i>
  // suffix — never by reparsing the opaque durable message id. Non-content
  // blocks (no contentIndex, no :content: suffix) order at 0; the key
  // localeCompare tiebreak keeps the total order deterministic.
  function contentOrder(block) {
    if (block && Number.isInteger(block.contentIndex) && block.contentIndex >= 0) {
      return block.contentIndex;
    }
    const m = /:content:(\d+)$/.exec(text(block && block.blockId));
    return m ? Number(m[2]) : 0;
  }

  function finalizeTurnStep(state, event) {
    // A finalized assistant message replaces its partial stream exactly once.
    const turn = event.turn;
    const step = event.step;
    if (Number.isInteger(turn) && Number.isInteger(step)) {
      return state.partials.delete('partial:' + turn + ':' + step);
    }
    return false;
  }

  // FOLD nested rc.2 ToolResultBlock content into its status/result SHELL at
  // the WIRE level. The projection law already validated the shell + stable
  // children; here the children are folded deterministically into a SINGLE
  // bounded conversation item so a tool result renders once and never
  // duplicates the same visible content as stray articles.
  //
  // The folded item retains an ORDERED `content[]` of its nested visible
  // children (text/image entries) sorted by the canonical contentIndex. The
  // DOM renderer WALKS content[] in exact order, so a mixed text->image->text
  // result is never flattened into "all text then all images". The result
  // SHELL remains the stable viewport anchor. A legacy shell-only fixture
  // (text riding the shell, no children) falls back to `entry.text`.
  function foldToolResult(state, event, seq, blocks) {
    let shell = null;
    for (const block of blocks) {
      if (block && block.kind === 'tool/result') { shell = block; break; }
    }
    if (!shell || typeof shell.blockId !== 'string' || !shell.blockId) return null;
    const key = shell.blockId;
    const entry = {
      key,
      blockId: key,
      kind: 'tool/result',
      callId: text(shell.callId),
      error: shell.error === true,
      seq,
      order: 0,
      partial: false,
    };
    const children = blocks.filter((b) => b && (b.kind === 'text' || b.kind === 'image') && b.role === 'tool');
    if (children.length) {
      const ordered = children.slice().sort((a, b) => contentOrder(a) - contentOrder(b));
      const content = [];
      for (const child of ordered) {
        if (child.kind === 'text') {
          const childText = text(child.text);
          if (childText) content.push({ kind: 'text', text: childText });
        } else {
          content.push({
            kind: 'image',
            attachmentId: text(child.attachmentId),
            mediaType: text(child.mediaType),
            width: Number.isInteger(child.width) ? child.width : null,
            height: Number.isInteger(child.height) ? child.height : null,
          });
        }
      }
      if (content.length) entry.content = content;
    } else if (typeof shell.text === 'string' && shell.text) {
      // Legacy/shell-only projection form: the result text rides the shell.
      entry.text = shell.text;
    }
    if (state.blocks.has(key)) {
      // Same-stable-block update: refresh payload, keep the first-seq anchor.
      const existing = state.blocks.get(key);
      for (const k of Object.keys(entry)) {
        if (k === 'key' || k === 'blockId' || k === 'kind' || k === 'seq' || k === 'order' || k === 'partial') continue;
        existing[k] = entry[k];
      }
    } else {
      state.blocks.set(key, entry);
    }
    return true;
  }

  function applyConversationEvent(state, event) {
    if (!event || typeof event !== 'object') return false;
    const seq = finiteNumber(event.seq, -1);
    if (seq < 0) return false;
    const blocks = Array.isArray(event.blocks) ? event.blocks : [];

    const finalizing = event.type === 'assistant/message';
    if (finalizing) {
      const removed = finalizeTurnStep(state, event);
      if (!blocks.length) return removed;
    } else if (!blocks.length) {
      return false;
    }

    if (event.type === 'tool/result') {
      const folded = foldToolResult(state, event, seq, blocks);
      if (folded !== null) return folded;
      // shell-less tool/result: fall through to the generic law-checked loop.
    }

    let changed = false;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const blockId = text(block.blockId);
      if (!blockId) continue;
      const kind = text(block.kind);
      if (!kind) continue;

      // A tool-scoped text/image block (tool:<callId>:result:content:<i>) is a
      // child of a converged tool-result card already folded into state.blocks.
      // It must NOT also become an independent message article — that would
      // render the same visible content twice (AC2 one-logical-invocation
      // renders once). The card alone is the article.
      const isToolResultChild = (kind === 'text' || kind === 'image') && blockId.startsWith('tool:');

      if (isToolResultChild) {
        continue;
      } else if (kind === 'text') {
        state.messages.set(blockId, {
          key: blockId,
          blockId,
          kind: 'text',
          role: text(block.role),
          text: text(block.text),
          seq,
          order: contentOrder(block),
          partial: false,
        });
        changed = true;
      } else if (kind === 'image') {
        state.messages.set(blockId, {
          key: blockId,
          blockId,
          kind: 'image',
          role: text(block.role),
          attachmentId: text(block.attachmentId),
          mediaType: text(block.mediaType),
          width: Number.isInteger(block.width) ? block.width : null,
          height: Number.isInteger(block.height) ? block.height : null,
          seq,
          order: contentOrder(block),
          partial: false,
        });
        changed = true;
      } else if (kind === 'partial') {
        let partial = state.partials.get(blockId);
        if (!partial) {
          partial = { key: blockId, blockId, role: 'assistant', kind: 'partial', firstSeq: seq, lastSeq: seq, blocks: new Map() };
          state.partials.set(blockId, partial);
        }
        partial.firstSeq = partial.firstSeq < 0 ? seq : Math.min(partial.firstSeq, seq);
        partial.lastSeq = Math.max(partial.lastSeq, seq);
        const chunk = block.chunk || {};
        const index = Number.isInteger(chunk.index) ? chunk.index : 0;
        switch (chunk.type) {
          case 'block-start':
            partial.blocks.set(index, { kind: chunk.blockType === 'text' ? 'text' : 'other', text: '' });
            break;
          case 'text-delta': {
            const previous = partial.blocks.get(index);
            partial.blocks.set(index, {
              kind: 'text',
              text: (previous && previous.kind === 'text' ? previous.text : '') + text(chunk.text),
            });
            break;
          }
          case 'block-end':
            if (typeof chunk.text === 'string') {
              partial.blocks.set(index, { kind: 'text', text: chunk.text });
            }
            break;
          default:
            break;
        }
        changed = true;
      } else {
        // tool/call | tool/result | status | error | request
        if (state.blocks.has(blockId)) {
          // A SAME-STABLE-BLOCK update (e.g. status running -> idle at a later
          // source seq) is folded IN PLACE: chronological anchor (firstSeq),
          // order and key are preserved; only the payload fields are refreshed.
          const existing = state.blocks.get(blockId);
          for (const key of Object.keys(block)) {
            if (key === 'blockId' || key === 'kind' || key === 'partial' || key === 'seq' || key === 'order') continue;
            existing[key] = block[key];
          }
          changed = true;
        } else {
          const entry = { key: blockId, blockId, kind, seq, order: contentOrder(block), partial: false };
          for (const key of Object.keys(block)) {
            if (key === 'blockId' || key === 'kind' || key === 'partial') continue;
            entry[key] = block[key];
          }
          state.blocks.set(blockId, entry);
          changed = true;
        }
      }
    }
    return changed;
  }

  function partialText(partial) {
    return [...partial.blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter((entry) => entry[1].kind === 'text')
      .map((entry) => entry[1].text)
      .join('');
  }

  function conversationItems(state) {
    const items = [];
    for (const item of state.messages.values()) items.push(item);
    for (const partial of state.partials.values()) {
      const body = partialText(partial);
      if (!body) continue;
      items.push({
        key: partial.key,
        blockId: partial.blockId,
        kind: 'partial',
        role: 'assistant',
        text: body,
        seq: partial.firstSeq,
        order: 0,
        partial: true,
      });
    }
    for (const item of state.blocks.values()) items.push(item);

    // Chronological by durable source seq; intra-event order by content index
    // (child blocks of one message) and finally a deterministic key tiebreak.
    return items.sort((a, b) => a.seq - b.seq || (a.order || 0) - (b.order || 0) || a.key.localeCompare(b.key));
  }

  // -------------------------------------------------------------------------
  // M1 synchronization state. Transport ordering and durable source ordering
  // are deliberately separate; older-page installation changes neither
  // forward watermark.
  // -------------------------------------------------------------------------

  function cloneWire(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function syncFail(state, code) {
    markResyncRequired(state, code);
    return { ok: false, code: code };
  }

  function canonicalFail(code, message) { return { ok: false, code: code, message: message }; }
  function own(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
  function regexEscape(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function canonicalToolResultLaw(event) {
    var shellCount = 0;
    var callId = '';
    for (var i = 0; i < event.blocks.length; i++) {
      var block = event.blocks[i];
      if (block && block.kind === 'tool/result') {
        shellCount += 1;
        callId = block.callId;
        if (typeof callId !== 'string' || !callId) return canonicalFail('malformed-projected-event', 'tool result shell lacks callId');
        if (block.blockId !== 'tool:' + callId + ':result') return canonicalFail('blockId-root-mismatch', 'tool result shell blockId mismatch');
      }
    }
    if (shellCount < 1) return canonicalFail('tool-result-shell-mismatch', 'tool result lacks shell');
    var childPattern = new RegExp('^tool:' + regexEscape(callId) + ':result:content:\\d+$');
    for (var j = 0; j < event.blocks.length; j++) {
      var child = event.blocks[j];
      if (child && (child.kind === 'text' || child.kind === 'image')) {
        if (typeof child.blockId !== 'string' || !childPattern.test(child.blockId)) return canonicalFail('blockId-root-mismatch', 'tool result child root mismatch');
        if (child.role !== 'tool') return canonicalFail('type-role-mismatch', 'tool result child role mismatch');
      }
    }
    return null;
  }

  function validateCanonicalTimeline(events, asOfSeq) {
    if (!Array.isArray(events)) return canonicalFail('malformed-blocks', 'events must be an array');
    var kinds = { text: true, image: true, partial: true, 'tool/call': true, 'tool/result': true, status: true, error: true, request: true };
    var repeatable = { partial: true, status: true, 'tool/call': true, 'tool/result': true };
    var reusableToolChild = /^tool:[^:]+:result:content:\d+$/;
    var seen = {};
    var previous = -1;
    for (var ei = 0; ei < events.length; ei++) {
      var event = events[ei];
      if (!event || typeof event !== 'object') return canonicalFail('malformed-projected-event', 'event must be object');
      if (!Number.isInteger(event.seq) || event.seq < 0) return canonicalFail('malformed-seq', 'event seq invalid');
      if (typeof event.type !== 'string' || !event.type) return canonicalFail('malformed-type', 'event type invalid');
      if (event.seq <= previous) return canonicalFail('non-monotonic-seq', 'event seq not increasing');
      if (Number.isInteger(asOfSeq) && event.seq > asOfSeq) return canonicalFail('seq-beyond-asOfSeq', 'event exceeds watermark');
      previous = event.seq;
      if (!Array.isArray(event.blocks)) return canonicalFail('malformed-blocks', 'event blocks invalid');

      if (event.type === 'user/message' || event.type === 'assistant/message') {
        var prefix = event.type === 'user/message' ? 'message:u-' : 'message:a-';
        var role = event.type === 'user/message' ? 'user' : 'assistant';
        var toolResidue = false;
        for (var mi = 0; mi < event.blocks.length; mi++) {
          var messageBlock = event.blocks[mi];
          var toolScoped = messageBlock && (messageBlock.kind === 'tool/call' || messageBlock.kind === 'tool/result' ||
            ((messageBlock.kind === 'text' || messageBlock.kind === 'image') && messageBlock.role === 'tool' && typeof messageBlock.blockId === 'string' && messageBlock.blockId.indexOf('tool:') === 0));
          if (messageBlock && messageBlock.kind === 'error') continue;
          if (toolScoped) { if (messageBlock.kind === 'tool/result' || messageBlock.role === 'tool') toolResidue = true; continue; }
          if (!messageBlock || typeof messageBlock.blockId !== 'string' || messageBlock.blockId.indexOf(prefix) !== 0 || !/:content:\d+$/.test(messageBlock.blockId)) return canonicalFail('blockId-root-mismatch', 'message block root mismatch');
          if ((messageBlock.kind === 'text' || messageBlock.kind === 'image') && messageBlock.role !== role) return canonicalFail('type-role-mismatch', 'message role mismatch');
        }
        if (toolResidue) { var messageToolFault = canonicalToolResultLaw(event); if (messageToolFault) return messageToolFault; }
      } else if (event.type === 'assistant/chunk') {
        if (!event.blocks.length) return canonicalFail('chunk-no-block', 'chunk has no partial');
        for (var pi = 0; pi < event.blocks.length; pi++) {
          var partial = event.blocks[pi];
          if (!partial || partial.kind !== 'partial') return canonicalFail('chunk-wrong-kind', 'chunk block not partial');
          var expected = Number.isInteger(partial.turn) && Number.isInteger(partial.step) ? 'partial:' + partial.turn + ':' + partial.step : 'partial:s' + event.seq;
          if (partial.blockId !== expected) return canonicalFail('type-blockId-mismatch', 'partial identity mismatch');
        }
      } else if (event.type === 'tool/result') {
        var toolFault = canonicalToolResultLaw(event); if (toolFault) return toolFault;
      }

      for (var bi = 0; bi < event.blocks.length; bi++) {
        var block = event.blocks[bi];
        if (!block || typeof block !== 'object') return canonicalFail('malformed-block', 'block must be object');
        if (typeof block.blockId !== 'string' || !block.blockId) return canonicalFail('missing-blockId', 'block id missing');
        if (!own(kinds, block.kind)) return canonicalFail('unknown-block-kind', 'unknown block kind');
        var suffix = /:content:(\d+)$/.exec(block.blockId);
        if (suffix && (!Number.isInteger(block.contentIndex) || block.contentIndex !== Number(suffix[1]))) return canonicalFail('content-index-mismatch', 'content index mismatch');
        if (block.kind === 'text' && typeof block.text !== 'string') return canonicalFail('malformed-projected-event', 'text missing');
        if (block.kind === 'image' && (typeof block.attachmentId !== 'string' || !block.attachmentId)) return canonicalFail('malformed-projected-event', 'image attachment missing');
        if (block.kind === 'partial' && (!block.chunk || typeof block.chunk !== 'object' || typeof block.chunk.type !== 'string')) return canonicalFail('malformed-projected-event', 'partial chunk malformed');
        if (block.kind === 'tool/call' && (typeof block.callId !== 'string' || !block.callId)) return canonicalFail('malformed-projected-event', 'tool call id missing');
        if (block.kind === 'tool/result' && (typeof block.callId !== 'string' || !block.callId)) return canonicalFail('malformed-projected-event', 'tool result id missing');
        if (block.kind === 'status' && (!Number.isInteger(block.turn) || (block.state !== 'running' && block.state !== 'idle'))) return canonicalFail('malformed-projected-event', 'status malformed');
        if (block.kind === 'error' && typeof block.message !== 'string') return canonicalFail('malformed-projected-event', 'error malformed');
        if (!own(repeatable, block.kind) && !reusableToolChild.test(block.blockId) && own(seen, block.blockId)) return canonicalFail('duplicate-blockId', 'duplicate block id');
        seen[block.blockId] = true;
      }
    }
    return { ok: true };
  }

  function conversationFromTimeline(timeline) {
    var conversation = createConversationState();
    timeline.forEach(function (event) { applyConversationEvent(conversation, event); });
    return conversation;
  }

  function createSyncState() {
    return {
      installed: false,
      syncState: 'empty',
      writeEligible: false,
      protocolMajor: null,
      serverGeneration: null,
      connectionEpoch: null,
      attachmentId: null,
      attachmentGeneration: null,
      sessionId: null,
      snapshotBaseHistoryAsOfSeq: -1,
      streamSequence: -1,
      historyAsOfSeq: -1,
      oldestLoadedSeq: null,
      nextBeforeSeq: null,
      timeline: new Map(),
      conversation: createConversationState(),
      presentationMode: 'following',
      unread: false,
      unreadFromStreamSequence: null,
      anchor: null,
    };
  }

  function installCompleteSnapshot(state, snapshot) {
    var attachment = snapshot && snapshot.attachment;
    var history = attachment && attachment.history;
    if (!snapshot || typeof snapshot !== 'object' || snapshot.protocolMajor !== 1 ||
        typeof snapshot.serverGeneration !== 'string' || !snapshot.serverGeneration ||
        typeof snapshot.connectionEpoch !== 'string' || !snapshot.connectionEpoch ||
        !attachment || typeof attachment.attachmentId !== 'string' || !attachment.attachmentId ||
        !Number.isInteger(attachment.attachmentGeneration) || attachment.attachmentGeneration < 1 ||
        typeof attachment.sessionId !== 'string' || !attachment.sessionId ||
        !history || !Array.isArray(history.events) || !Number.isInteger(history.asOfSeq) ||
        snapshot.streamSequence !== history.asOfSeq) return { ok: false, code: 'malformed-complete-snapshot' };
    var timeline = new Map();
    var historyLaw = validateCanonicalTimeline(history.events, history.asOfSeq);
    if (!historyLaw.ok) return { ok: false, code: historyLaw.code };
    var previous = -1;
    for (var i = 0; i < history.events.length; i++) {
      var event = history.events[i];
      previous = event.seq;
      timeline.set(event.seq, cloneWire(event));
    }
    if ((history.events.length === 0 && history.asOfSeq !== -1) ||
        (history.events.length > 0 && previous !== history.asOfSeq)) return { ok: false, code: 'malformed-complete-snapshot' };

    state.installed = true;
    state.syncState = 'awaiting-hello';
    state.writeEligible = false;
    state.protocolMajor = snapshot.protocolMajor;
    state.serverGeneration = snapshot.serverGeneration;
    state.connectionEpoch = snapshot.connectionEpoch;
    state.attachmentId = attachment.attachmentId;
    state.attachmentGeneration = attachment.attachmentGeneration;
    state.sessionId = attachment.sessionId;
    state.snapshotBaseHistoryAsOfSeq = history.asOfSeq;
    state.streamSequence = snapshot.streamSequence;
    state.historyAsOfSeq = history.asOfSeq;
    state.oldestLoadedSeq = timeline.size ? timeline.keys().next().value : null;
    state.nextBeforeSeq = state.oldestLoadedSeq;
    state.timeline = timeline;
    state.conversation = conversationFromTimeline(timeline);
    state.presentationMode = 'following';
    state.unread = false;
    state.unreadFromStreamSequence = null;
    state.anchor = null;
    return { ok: true, state: state };
  }

  function fenceCode(state, value) {
    if (!value || typeof value !== 'object') return 'malformed-sync-message';
    if (value.protocolMajor !== state.protocolMajor) return 'protocolMajor-mismatch';
    if (value.serverGeneration !== state.serverGeneration) return 'serverGeneration-mismatch';
    if (value.connectionEpoch !== state.connectionEpoch) return 'connectionEpoch-mismatch';
    if (value.attachmentId !== state.attachmentId) return 'attachmentId-mismatch';
    if (value.attachmentGeneration !== state.attachmentGeneration) return 'attachmentGeneration-mismatch';
    if (value.sessionId !== state.sessionId) return 'sessionId-mismatch';
    return null;
  }

  function acceptStreamHello(state, hello) {
    if (!state.installed || state.syncState !== 'awaiting-hello') return syncFail(state, 'hello-not-expected');
    var fence = fenceCode(state, hello);
    if (fence) return syncFail(state, fence);
    if (hello.baseStreamSequence !== state.streamSequence) return syncFail(state, 'baseStreamSequence-mismatch');
    if (hello.baseHistoryAsOfSeq !== state.snapshotBaseHistoryAsOfSeq) return syncFail(state, 'baseHistoryAsOfSeq-mismatch');
    state.syncState = 'ready';
    state.writeEligible = false;
    return { ok: true, state: state };
  }

  function applyStreamDelta(state, delta) {
    if (!state.installed || state.syncState !== 'ready') return syncFail(state, 'stream-not-ready');
    var fence = fenceCode(state, delta);
    if (fence) return syncFail(state, fence);
    if (delta.baseStreamSequence !== state.streamSequence) return syncFail(state, 'baseStreamSequence-mismatch');
    if (delta.streamSequence !== delta.baseStreamSequence + 1) return syncFail(state, 'stream-sequence-gap');
    if (delta.event.seq <= state.historyAsOfSeq) return syncFail(state, 'durable-seq-not-after-current');

    var timeline = new Map(state.timeline);
    timeline.set(delta.event.seq, cloneWire(delta.event));
    var orderedEvents = Array.from(timeline.entries()).sort(function (a, b) { return a[0] - b[0]; }).map(function (entry) { return entry[1]; });
    var deltaLaw = validateCanonicalTimeline(orderedEvents, delta.event.seq);
    if (!deltaLaw.ok) return syncFail(state, deltaLaw.code);
    timeline = new Map(orderedEvents.map(function (event) { return [event.seq, event]; }));
    var conversation = conversationFromTimeline(timeline);
    state.timeline = timeline;
    state.conversation = conversation;
    state.streamSequence = delta.streamSequence;
    state.historyAsOfSeq = delta.event.seq;
    if (state.oldestLoadedSeq === null) state.oldestLoadedSeq = delta.event.seq;
    if (state.presentationMode === 'history-reading') {
      state.unread = true;
      if (state.unreadFromStreamSequence === null) state.unreadFromStreamSequence = delta.streamSequence;
    } else {
      state.unread = false;
      state.unreadFromStreamSequence = null;
    }
    return { ok: true, state: state };
  }

  function prependHistoryPage(state, page, request) {
    if (!state.installed) return syncFail(state, 'snapshot-not-installed');
    var fence = fenceCode(state, page);
    if (fence) return syncFail(state, fence);
    if (page.baseHistoryAsOfSeq !== state.snapshotBaseHistoryAsOfSeq) return syncFail(state, 'baseHistoryAsOfSeq-mismatch');
    if (!request || page.beforeSeq !== request.beforeSeq) return syncFail(state, 'beforeSeq-mismatch');
    if (page.limit !== request.limit) return syncFail(state, 'limit-mismatch');
    if (!Array.isArray(page.events) || page.events.length > request.limit) return syncFail(state, 'page-beyond-limit');
    var previous = -1;
    var pageLaw = validateCanonicalTimeline(page.events, state.snapshotBaseHistoryAsOfSeq);
    if (!pageLaw.ok) return syncFail(state, pageLaw.code);
    for (var i = 0; i < page.events.length; i++) {
      var event = page.events[i];
      if (event.seq >= request.beforeSeq || event.seq > state.snapshotBaseHistoryAsOfSeq) return syncFail(state, 'event-not-before-cursor');
      previous = event.seq;
    }
    var expectedNext = page.hasMore && page.events.length ? page.events[0].seq : null;
    if (typeof page.hasMore !== 'boolean' || page.nextBeforeSeq !== expectedNext) return syncFail(state, 'nextBeforeSeq-mismatch');

    var timeline = new Map(state.timeline);
    for (var j = 0; j < page.events.length; j++) {
      var incoming = page.events[j];
      var existing = timeline.get(incoming.seq);
      if (existing && JSON.stringify(existing) !== JSON.stringify(incoming)) return syncFail(state, 'conflicting-source-seq');
      if (!existing) timeline.set(incoming.seq, cloneWire(incoming));
    }
    timeline = new Map(Array.from(timeline.entries()).sort(function (a, b) { return a[0] - b[0]; }));
    var mergedLaw = validateCanonicalTimeline(Array.from(timeline.values()), state.historyAsOfSeq);
    if (!mergedLaw.ok) return syncFail(state, mergedLaw.code);
    var conversation = conversationFromTimeline(timeline);
    state.timeline = timeline;
    state.conversation = conversation;
    state.oldestLoadedSeq = timeline.size ? timeline.keys().next().value : null;
    state.nextBeforeSeq = page.nextBeforeSeq;
    return { ok: true, state: state };
  }

  function enterFollowing(state) {
    state.presentationMode = 'following';
    state.unread = false;
    state.unreadFromStreamSequence = null;
    state.anchor = null;
    return state;
  }

  function enterHistoryReading(state, anchor) {
    state.presentationMode = 'history-reading';
    state.anchor = anchor ? cloneWire(anchor) : null;
    return state;
  }

  function markResyncRequired(state, reason) {
    state.syncState = 'resyncing';
    state.writeEligible = false;
    state.resyncReason = reason || 'resync-required';
    return state;
  }

  function reanchor(state, preferredBlockIds) {
    var ids = Array.isArray(preferredBlockIds) ? preferredBlockIds : [];
    var items = conversationItems(state.conversation);
    var available = new Set(items.map(function (item) { return item.blockId; }));
    var current = state.anchor && state.anchor.blockId;
    var chosen = current && available.has(current) ? current : null;
    for (var i = 0; !chosen && i < ids.length; i++) if (available.has(ids[i])) chosen = ids[i];
    var chosenItem = chosen ? items.find(function (item) { return item.blockId === chosen; }) : null;
    state.anchor = chosen ? { blockId: chosen, sourceSeq: chosenItem ? chosenItem.seq : null, offsetPx: state.anchor && state.anchor.offsetPx || 0 } : null;
    return state.anchor;
  }

  root.C0Core = Object.freeze({
    wordRanges,
    clampCursor,
    moveCursor,
    insertClipboard,
    createConversationState,
    resetConversation,
    applyConversationEvent,
    conversationItems,
    createSyncState,
    installCompleteSnapshot,
    acceptStreamHello,
    applyStreamDelta,
    prependHistoryPage,
    enterFollowing,
    enterHistoryReading,
    markResyncRequired,
    reanchor,
    validateCanonicalTimeline,
  });
})(globalThis);
