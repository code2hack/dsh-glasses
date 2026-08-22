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

// ---- Word/cursor helpers (unchanged surface) ----
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

// ---- M1 canonical reducer over blocks[] projection events ----
// text user block -> one typed text item with stable child identity
{
  const conversation = core.createConversationState();
  core.applyConversationEvent(conversation, {
    seq: 1,
    type: 'user/message',
    blocks: [{ blockId: 'message:u-u1:content:0', kind: 'text', role: 'user', text: 'hello' }],
  });
  core.applyConversationEvent(conversation, {
    seq: 2,
    type: 'assistant/chunk',
    blocks: [{ blockId: 'partial:1:1', kind: 'partial', turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }],
  });
  core.applyConversationEvent(conversation, {
    seq: 3,
    type: 'assistant/chunk',
    blocks: [{ blockId: 'partial:1:1', kind: 'partial', turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'par' } }],
  });
  core.applyConversationEvent(conversation, {
    seq: 4,
    type: 'assistant/chunk',
    blocks: [{ blockId: 'partial:1:1', kind: 'partial', turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 1, text: 'must not render' } }],
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(core.conversationItems(conversation))),
    [
      { key: 'message:u-u1:content:0', blockId: 'message:u-u1:content:0', kind: 'text', role: 'user', text: 'hello', seq: 1, order: 0, partial: false },
      { key: 'partial:1:1', blockId: 'partial:1:1', kind: 'partial', role: 'assistant', text: 'par', seq: 2, order: 0, partial: true },
    ],
  );

  // Final assistant message replaces the partial exactly once.
  core.applyConversationEvent(conversation, {
    seq: 5,
    type: 'assistant/message',
    turn: 1,
    step: 1,
    blocks: [{ blockId: 'message:a-a1:content:0', kind: 'text', role: 'assistant', text: 'partial replaced' }],
  });
  const after = JSON.parse(JSON.stringify(core.conversationItems(conversation)));
  assert.deepEqual(after, [
    { key: 'message:u-u1:content:0', blockId: 'message:u-u1:content:0', kind: 'text', role: 'user', text: 'hello', seq: 1, order: 0, partial: false },
    { key: 'message:a-a1:content:0', blockId: 'message:a-a1:content:0', kind: 'text', role: 'assistant', text: 'partial replaced', seq: 5, order: 0, partial: false },
  ], 'final message replaces the partial stream (no partial survives)');
}

// ---- canonical snapshot replay: identical ordered stable block identities ----
const canonicalHistory = [
  { seq: 1, type: 'user/message', blocks: [{ blockId: 'message:u-u9:content:0', kind: 'text', role: 'user', text: 'again' }] },
  { seq: 2, type: 'assistant/chunk', blocks: [{ blockId: 'partial:2:1', kind: 'partial', turn: 2, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }] },
  { seq: 3, type: 'assistant/chunk', blocks: [{ blockId: 'partial:2:1', kind: 'partial', turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'never-final' } }] },
  { seq: 4, type: 'assistant/chunk', blocks: [{ blockId: 'partial:2:1', kind: 'partial', turn: 2, step: 1, chunk: { type: 'block-end', index: 0, text: 'never-final' } }] },
  { seq: 5, type: 'assistant/message', turn: 2, step: 1, blocks: [{ blockId: 'message:a-a9:content:0', kind: 'text', role: 'assistant', text: 'final answer' }] },
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
  ['message:u-u9:content:0', 'message:a-a9:content:0'],
);
const assistantBlocks = firstReplay.filter((item) => item.blockId.startsWith('message:a-') || item.blockId.startsWith('partial:') && item.role === 'assistant');
assert.equal(assistantBlocks.length, 1, 'finalized assistant answer must render exactly once');
assert.equal(assistantBlocks[0].text, 'final answer');
assert.equal(assistantBlocks[0].partial, false);

// ---- ordered mixed content within ONE durable message (text/image/text) ----
{
  const s = core.createConversationState();
  core.applyConversationEvent(s, {
    seq: 30,
    type: 'user/message',
    blocks: [
      { blockId: 'message:u-mix:content:0', kind: 'text', role: 'user', text: 'see' },
      { blockId: 'message:u-mix:content:1', kind: 'image', role: 'user', attachmentId: 'att-x', mediaType: 'image/png', width: 40, height: 30 },
      { blockId: 'message:u-mix:content:2', kind: 'text', role: 'user', text: 'this' },
    ],
  });
  const items = JSON.parse(JSON.stringify(core.conversationItems(s)));
  assert.deepEqual(items.map((i) => [i.blockId, i.kind, i.text ?? i.attachmentId]), [
    ['message:u-mix:content:0', 'text', 'see'],
    ['message:u-mix:content:1', 'image', 'att-x'],
    ['message:u-mix:content:2', 'text', 'this'],
  ]);
}

// ---- tool call/result, status running->idle, request, error projection blocks ----
{
  const s = core.createConversationState();
  core.applyConversationEvent(s, { seq: 40, type: 'turn/start', blocks: [{ blockId: 'status:turn:4', kind: 'status', turn: 4, state: 'running' }] });
  core.applyConversationEvent(s, { seq: 41, type: 'tool/call', blocks: [{ blockId: 'tool:c9:call', kind: 'tool/call', callId: 'c9', name: 'read', arguments: '{}' }] });
  core.applyConversationEvent(s, { seq: 42, type: 'request/context', blocks: [{ blockId: 'request:s42', kind: 'request', provider: 'openai', model: 'gpt-4o' }] });
  core.applyConversationEvent(s, { seq: 43, type: 'tool/result', blocks: [{ blockId: 'tool:c9:result', kind: 'tool/result', callId: 'c9', text: 'ok', error: false }] });
  core.applyConversationEvent(s, { seq: 44, type: 'turn/end', blocks: [{ blockId: 'status:turn:4', kind: 'status', turn: 4, state: 'idle' }, { blockId: 'error:turn:4', kind: 'error', turn: 4, message: 'timeout' }] });
  const items = JSON.parse(JSON.stringify(core.conversationItems(s)));
  assert.deepEqual(items.map((i) => i.blockId), [
    'status:turn:4', 'tool:c9:call', 'request:s42', 'tool:c9:result', 'error:turn:4',
  ]);
  // the same status block updated in place (running -> idle) — never a duplicate
  const statusItems = items.filter((i) => i.kind === 'status');
  assert.equal(statusItems.length, 1);
  assert.equal(statusItems[0].state, 'idle');
  assert.equal(items[0].seq, 40, 'chronological order preserved for non-message blocks');
}

// ---- non-renderable canonical events are no-ops for rendering ----
{
  const s = core.createConversationState();
  const changed = core.applyConversationEvent(s, { seq: 50, type: 'step/end', blocks: [] });
  assert.equal(changed, false);
  assert.equal(core.conversationItems(s).length, 0);
}

// ---- rpcId is NOT identity: seq-fallback identity is projection-stable ----
{
  const s = core.createConversationState();
  core.applyConversationEvent(s, {
    seq: 42,
    type: 'user/message',
    blocks: [{ blockId: 'message:u-s42:content:0', kind: 'text', role: 'user', text: 'annealed' }],
  });
  const items = JSON.parse(JSON.stringify(core.conversationItems(s)));
  assert.equal(items.length, 1);
  assert.equal(items[0].key, 'message:u-s42:content:0');
  assert.equal(items[0].blockId, 'message:u-s42:content:0');
  assert.equal(items[0].text, 'annealed');
}

// ---- chunk stream resolves to exactly one final assistant block ----
{
  const stream = [
    { seq: 10, type: 'user/message', blocks: [{ blockId: 'message:u-u9:content:0', kind: 'text', role: 'user', text: 'chunk stream' }] },
    { seq: 11, type: 'assistant/chunk', blocks: [{ blockId: 'partial:2:1', kind: 'partial', turn: 2, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }] },
    { seq: 12, type: 'assistant/chunk', blocks: [{ blockId: 'partial:2:1', kind: 'partial', turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'par' } }] },
    { seq: 13, type: 'assistant/chunk', blocks: [{ blockId: 'partial:2:1', kind: 'partial', turn: 2, step: 1, chunk: { type: 'text-delta', index: 1, text: 'tial' } }] },
    { seq: 14, type: 'assistant/chunk', blocks: [{ blockId: 'partial:2:1', kind: 'partial', turn: 2, step: 1, chunk: { type: 'block-end', index: 0, text: 'partial' } }] },
    { seq: 20, type: 'assistant/message', turn: 2, step: 1, blocks: [{ blockId: 'message:a-a9:content:0', kind: 'text', role: 'assistant', text: 'final answer' }] },
  ];
  const s = core.createConversationState();
  for (const evt of stream) core.applyConversationEvent(s, evt);
  const items = JSON.parse(JSON.stringify(core.conversationItems(s)));
  assert.deepEqual(items.map((item) => item.blockId), [
    'message:u-u9:content:0', 'message:a-a9:content:0',
  ]);
  const assistantBlocksFinal = items.filter((item) => item.role === 'assistant');
  assert.equal(assistantBlocksFinal.length, 1, 'chunk stream must resolve to exactly one assistant block');
  assert.equal(assistantBlocksFinal[0].text, 'final answer');
  assert.equal(assistantBlocksFinal[0].partial, false);
}

console.log('c0-core.test.mjs: PASS');
