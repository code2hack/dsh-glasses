import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(
  new URL('../app/src/main/assets/c0-core.js', import.meta.url),
  'utf8',
);
const context = {};
vm.runInNewContext(source, context, { filename: 'c0-core.js' });
const core = context.C0Core;
assert.ok(core, 'C0Core installed on the contextified global');

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

// ---- TB0-shape events (no blockId) still work and get canonical identities ----
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
    { key: 'message:u-u1', blockId: 'message:u-u1', role: 'user', text: 'hello', seq: 1, partial: false },
    { key: 'partial:1:1', blockId: 'partial:1:1', role: 'assistant', text: 'par', seq: 2, partial: true },
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
    { key: 'message:u-u1', blockId: 'message:u-u1', role: 'user', text: 'hello', seq: 1, partial: false },
    {
      key: 'message:a-a1',
      blockId: 'message:a-a1',
      role: 'assistant',
      text: 'partial replaced',
      seq: 5,
      partial: false,
      provider: 'p',
      model: 'm',
    },
  ],
);

// ---- M1 canonical snapshot replay: identical ordered block identities ----
const canonicalHistory = [
  { seq: 1, type: 'user/message', blockId: 'message:u-u9', message: { role: 'user', id: 'u9', text: 'again', rpcId: 'r' } },
  { seq: 2, type: 'assistant/chunk', blockId: 'partial:2:1', turn: 2, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
  { seq: 3, type: 'assistant/chunk', blockId: 'partial:2:1', turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'never-final' } },
  { seq: 4, type: 'assistant/chunk', blockId: 'partial:2:1', turn: 2, step: 1, chunk: { type: 'block-end', index: 0, text: 'never-final' } },
  { seq: 5, type: 'assistant/message', blockId: 'message:a-a9', turn: 2, step: 1, message: { role: 'assistant', id: 'a9', text: 'final answer', provider: 'p', model: 'm' } },
];

function replayItems(history) {
  const state = core.createConversationState();
  for (const event of history) core.applyConversationEvent(state, event);
  return JSON.parse(JSON.stringify(core.conversationItems(state)));
}

const firstReplay = replayItems(canonicalHistory);
const secondReplay = replayItems(canonicalHistory);
assert.deepEqual(secondReplay, firstReplay, 'replaying the same canonical history twice yields identical ordered block identities');
assert.deepEqual(
  firstReplay.map((item) => item.blockId),
  ['message:u-u9', 'message:a-a9'],
);
// The finalized assistant answer must render exactly once: never as a partial AND as final.
const assistantBlocks = firstReplay.filter((item) => item.blockId.startsWith('message:a-') || item.blockId.startsWith('partial:') && item.role === 'assistant');
assert.equal(assistantBlocks.length, 1, 'finalized assistant answer must render exactly once');
assert.equal(assistantBlocks[0].text, 'final answer');
assert.equal(assistantBlocks[0].partial, false);

// rpcId is NOT identity: a legacy-shaped user event with an empty durable id
// but a non-empty rpcId must resolve to the projection-identical seq fallback.
{
  const s = core.createConversationState();
  core.applyConversationEvent(s, {
    seq: 42,
    type: 'user/message',
    message: { role: 'user', id: '', text: 'annealed', rpcId: 'operation-transient-123' },
  });
  const items = JSON.parse(JSON.stringify(core.conversationItems(s)));
  assert.equal(items.length, 1);
  assert.equal(items[0].key, 'message:u-s42');
  assert.equal(items[0].blockId, 'message:u-s42');
  assert.equal(items[0].text, 'annealed');
}

// A normal chunk stream must be accepted and, on final-assistant-message, the
// reducer contains ONLY the finalized answer (never partial + final).
{
  const stream = [
    { seq: 10, type: 'user/message', blockId: 'message:u-u9', message: { role: 'user', id: 'u9', text: 'chunk stream' } },
    { seq: 11, type: 'assistant/chunk', blockId: 'partial:2:1', turn: 2, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    { seq: 12, type: 'assistant/chunk', blockId: 'partial:2:1', turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'par' } },
    { seq: 13, type: 'assistant/chunk', blockId: 'partial:2:1', turn: 2, step: 1, chunk: { type: 'text-delta', index: 1, text: 'tial' } },
    { seq: 14, type: 'assistant/chunk', blockId: 'partial:2:1', turn: 2, step: 1, chunk: { type: 'block-end', index: 0, text: 'partial' } },
    { seq: 20, type: 'assistant/message', blockId: 'message:a-a9', turn: 2, step: 1, message: { role: 'assistant', id: 'a9', text: 'final answer', provider: 'p', model: 'm' } },
  ];
  const s = core.createConversationState();
  for (const evt of stream) core.applyConversationEvent(s, evt);
  const items = JSON.parse(JSON.stringify(core.conversationItems(s)));
  assert.deepEqual(
    items.map((item) => item.blockId),
    ['message:u-u9', 'message:a-a9'],
  );
  const assistantBlocks = items.filter((item) => item.role === 'assistant');
  assert.equal(assistantBlocks.length, 1, 'chunk stream must resolve to exactly one assistant block');
  assert.equal(assistantBlocks[0].text, 'final answer');
  assert.equal(assistantBlocks[0].partial, false);
}

console.log('c0-core.test.mjs: PASS');
