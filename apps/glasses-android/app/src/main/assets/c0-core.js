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

  root.C0Core = Object.freeze({
    wordRanges,
    clampCursor,
    moveCursor,
    insertClipboard,
    createConversationState,
    resetConversation,
    applyConversationEvent,
    conversationItems,
  });
})(globalThis);
