/* Pure C0 reducer helpers. This file intentionally has no DOM/native access so
 * the same logic can be replay-tested on the host. */
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
    return { messages: new Map(), partials: new Map() };
  }

  function resetConversation(state) {
    state.messages.clear();
    state.partials.clear();
  }

  function partialKey(event) {
    return String(event.turn ?? '?') + ':' + String(event.step ?? '?');
  }

  function partialText(partial) {
    return [...partial.blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter((entry) => entry[1].kind === 'text')
      .map((entry) => entry[1].text)
      .join('');
  }

  function applyConversationEvent(state, event) {
    if (!event || typeof event !== 'object') return false;
    const seq = finiteNumber(event.seq, -1);

    if (event.type === 'user/message' && event.message?.role === 'user') {
      const id = text(event.message.id) || text(event.message.rpcId) || String(seq);
      state.messages.set('user:' + id, {
        key: 'user:' + id,
        role: 'user',
        text: text(event.message.text),
        seq: seq,
        partial: false,
      });
      return true;
    }

    if (event.type === 'assistant/chunk' && event.chunk && typeof event.chunk.type === 'string') {
      const key = partialKey(event);
      let partial = state.partials.get(key);
      if (!partial) {
        partial = { key: 'partial:' + key, role: 'assistant', firstSeq: seq, lastSeq: seq, blocks: new Map() };
        state.partials.set(key, partial);
      }
      partial.firstSeq = partial.firstSeq < 0 ? seq : Math.min(partial.firstSeq, seq);
      partial.lastSeq = Math.max(partial.lastSeq, seq);
      const index = Number.isInteger(event.chunk.index) ? event.chunk.index : 0;

      switch (event.chunk.type) {
        case 'block-start':
          partial.blocks.set(index, {
            kind: event.chunk.blockType === 'text' ? 'text' : 'other',
            text: '',
          });
          break;
        case 'text-delta': {
          const previous = partial.blocks.get(index);
          partial.blocks.set(index, {
            kind: 'text',
            text: (previous?.kind === 'text' ? previous.text : '') + text(event.chunk.text),
          });
          break;
        }
        case 'block-end':
          if (typeof event.chunk.text === 'string') {
            partial.blocks.set(index, { kind: 'text', text: event.chunk.text });
          }
          break;
        default:
          break;
      }
      return true;
    }

    if (event.type === 'assistant/message' && event.message?.role === 'assistant') {
      const key = partialKey(event);
      state.partials.delete(key);
      const id = text(event.message.id) || key || String(seq);
      state.messages.set('assistant:' + id, {
        key: 'assistant:' + id,
        role: 'assistant',
        text: text(event.message.text),
        seq: seq,
        partial: false,
        provider: text(event.message.provider),
        model: text(event.message.model),
      });
      return true;
    }

    return false;
  }

  function conversationItems(state) {
    const items = [...state.messages.values()];
    for (const partial of state.partials.values()) {
      const body = partialText(partial);
      if (!body) continue;
      items.push({
        key: partial.key,
        role: 'assistant',
        text: body,
        seq: partial.firstSeq,
        partial: true,
      });
    }
    return items.sort((a, b) => a.seq - b.seq || a.key.localeCompare(b.key));
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
