import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(
  new URL('../app/src/main/assets/c0-core.js', import.meta.url),
  'utf8',
);
const context = { globalThis: {} };
vm.runInNewContext(source, context, { filename: 'c0-core.js' });
const core = context.globalThis.C0Core;

assert.deepEqual(
  JSON.parse(JSON.stringify(core.wordRanges('  alpha  beta\n'))),
  [
    { start: 2, end: 7, text: 'alpha' },
    { start: 9, end: 13, text: 'beta' },
  ],
);
assert.equal(core.moveCursor('one two', 0, 'right'), 1);
assert.equal(core.moveCursor('one two', 1, 'right'), 2);
assert.equal(core.moveCursor('one two', 0, 'left'), 0);

assert.deepEqual(
  JSON.parse(JSON.stringify(core.insertClipboard('one two', 1, 'new words'))),
  { changed: true, text: 'one new words two', cursorWord: 3 },
);
assert.deepEqual(
  JSON.parse(JSON.stringify(core.insertClipboard('one', 1, ' tail '))),
  { changed: true, text: 'one tail', cursorWord: 2 },
);
assert.equal(core.insertClipboard('one', 0, '   ').changed, false);

const conversation = core.createConversationState();
core.applyConversationEvent(conversation, {
  seq: 1,
  type: 'user/message',
  message: { role: 'user', id: 'u1', text: 'hello', rpcId: 'rpc1' },
});
core.applyConversationEvent(conversation, {
  seq: 2,
  type: 'assistant/chunk',
  turn: 1,
  step: 1,
  chunk: { type: 'block-start', index: 0, blockType: 'text' },
});
core.applyConversationEvent(conversation, {
  seq: 3,
  type: 'assistant/chunk',
  turn: 1,
  step: 1,
  chunk: { type: 'text-delta', index: 0, text: 'par' },
});
core.applyConversationEvent(conversation, {
  seq: 4,
  type: 'assistant/chunk',
  turn: 1,
  step: 1,
  chunk: { type: 'reasoning-delta', index: 1, text: 'must not render' },
});
assert.deepEqual(
  JSON.parse(JSON.stringify(core.conversationItems(conversation))),
  [
    { key: 'user:u1', role: 'user', text: 'hello', seq: 1, partial: false },
    { key: 'partial:1:1', role: 'assistant', text: 'par', seq: 2, partial: true },
  ],
);

core.applyConversationEvent(conversation, {
  seq: 5,
  type: 'assistant/message',
  turn: 1,
  step: 1,
  message: {
    role: 'assistant',
    id: 'a1',
    text: 'partial replaced',
    provider: 'p',
    model: 'm',
  },
});
assert.deepEqual(
  JSON.parse(JSON.stringify(core.conversationItems(conversation))),
  [
    { key: 'user:u1', role: 'user', text: 'hello', seq: 1, partial: false },
    {
      key: 'assistant:a1',
      role: 'assistant',
      text: 'partial replaced',
      seq: 5,
      partial: false,
      provider: 'p',
      model: 'm',
    },
  ],
);

console.log('c0-core.test.mjs: PASS');
