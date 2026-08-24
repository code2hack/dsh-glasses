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
    blocks: [{ blockId: 'message:u-u1:content:0', kind: 'text', contentIndex: 0, role: 'user', text: 'hello' }],
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
    blocks: [{ blockId: 'message:a-a1:content:0', kind: 'text', contentIndex: 0, role: 'assistant', text: 'partial replaced' }],
  });
  const after = JSON.parse(JSON.stringify(core.conversationItems(conversation)));
  assert.deepEqual(after, [
    { key: 'message:u-u1:content:0', blockId: 'message:u-u1:content:0', kind: 'text', role: 'user', text: 'hello', seq: 1, order: 0, partial: false },
    { key: 'message:a-a1:content:0', blockId: 'message:a-a1:content:0', kind: 'text', role: 'assistant', text: 'partial replaced', seq: 5, order: 0, partial: false },
  ], 'final message replaces the partial stream (no partial survives)');
}

// ---- canonical snapshot replay: identical ordered stable block identities ----
const canonicalHistory = [
  { seq: 1, type: 'user/message', blocks: [{ blockId: 'message:u-u9:content:0', kind: 'text', contentIndex: 0, role: 'user', text: 'again' }] },
  { seq: 2, type: 'assistant/chunk', blocks: [{ blockId: 'partial:2:1', kind: 'partial', turn: 2, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }] },
  { seq: 3, type: 'assistant/chunk', blocks: [{ blockId: 'partial:2:1', kind: 'partial', turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'never-final' } }] },
  { seq: 4, type: 'assistant/chunk', blocks: [{ blockId: 'partial:2:1', kind: 'partial', turn: 2, step: 1, chunk: { type: 'block-end', index: 0, text: 'never-final' } }] },
  { seq: 5, type: 'assistant/message', turn: 2, step: 1, blocks: [{ blockId: 'message:a-a9:content:0', kind: 'text', contentIndex: 0, role: 'assistant', text: 'final answer' }] },
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
      { blockId: 'message:u-mix:content:0', kind: 'text', contentIndex: 0, role: 'user', text: 'see' },
      { blockId: 'message:u-mix:content:1', kind: 'image', contentIndex: 1, role: 'user', attachmentId: 'att-x', mediaType: 'image/png', width: 40, height: 30 },
      { blockId: 'message:u-mix:content:2', kind: 'text', contentIndex: 2, role: 'user', text: 'this' },
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

// ---- converged tool CALL: message content + dedicated event = ONE card ----
// The assistant message's nested ToolCallBlock and the dedicated durable
// tool/call event share the SINGULAR stable identity tool:<callId>:call. The
// reducer must fold them into exactly one tool card — never two call items
// and no duplicated visible content (AC2).
{
  const s = core.createConversationState();
  core.applyConversationEvent(s, {
    seq: 70,
    type: 'assistant/message',
    blocks: [
      { blockId: 'message:a-a70:content:0', kind: 'text', contentIndex: 0, role: 'assistant', text: 'calling' },
      { blockId: 'tool:c70:call', kind: 'tool/call', callId: 'c70', name: 'read', arguments: '{}' },
    ],
  });
  core.applyConversationEvent(s, {
    seq: 71,
    type: 'tool/call',
    blocks: [{ blockId: 'tool:c70:call', kind: 'tool/call', callId: 'c70', name: 'read', arguments: '{}' }],
  });
  const items = JSON.parse(JSON.stringify(core.conversationItems(s)));
  assert.deepEqual(items.map((i) => i.blockId), ['message:a-a70:content:0', 'tool:c70:call']);
  const calls = items.filter((i) => i.kind === 'tool/call');
  assert.equal(calls.length, 1, 'message ToolCallBlock + dedicated tool/call event fold to exactly ONE tool-call card');
  assert.equal(calls[0].key, 'tool:c70:call');
}

// ---- converged tool RESULT: ordered nested content[], never separated -------
// Nested text->image->text ToolResultBlock content folds into the tool card as
// an ORDERED content[] (kinds preserved in exact order), and the children do
// NOT become stray message articles. The legacy shell-only fixture (text rides
// the shell, e.g. the tool/projection lifecycle test above) still falls back to
// entry.text — both forms keep ONE card.
{
  const s = core.createConversationState();
  core.applyConversationEvent(s, {
    seq: 80,
    type: 'assistant/message',
    blocks: [
      { blockId: 'tool:r80:result', kind: 'tool/result', callId: 'r80', error: false },
      { blockId: 'tool:r80:result:content:0', kind: 'text', role: 'tool', text: 'A', contentIndex: 0 },
      { blockId: 'tool:r80:result:content:1', kind: 'image', role: 'tool', attachmentId: 'att-1', mediaType: 'image/webp', width: 10, height: 10, contentIndex: 1 },
      { blockId: 'tool:r80:result:content:2', kind: 'text', role: 'tool', text: 'B', contentIndex: 2 },
    ],
  });
  core.applyConversationEvent(s, {
    seq: 81,
    type: 'tool/result',
    blocks: [
      { blockId: 'tool:r80:result', kind: 'tool/result', callId: 'r80', error: false },
      { blockId: 'tool:r80:result:content:0', kind: 'text', role: 'tool', text: 'A', contentIndex: 0 },
      { blockId: 'tool:r80:result:content:1', kind: 'image', role: 'tool', attachmentId: 'att-1', mediaType: 'image/webp', width: 10, height: 10, contentIndex: 1 },
      { blockId: 'tool:r80:result:content:2', kind: 'text', role: 'tool', text: 'B', contentIndex: 2 },
    ],
  });
  const items = JSON.parse(JSON.stringify(core.conversationItems(s)));
  assert.equal(items.length, 1, 'converged tool result renders exactly ONE card');
  assert.equal(items[0].kind, 'tool/result');
  assert.equal(items[0].key, 'tool:r80:result');
  assert.deepEqual(items[0].content, [
    { kind: 'text', text: 'A' },
    { kind: 'image', attachmentId: 'att-1', mediaType: 'image/webp', width: 10, height: 10 },
    { kind: 'text', text: 'B' },
  ], 'nested content[] preserves exact text->image->text order (never split into text[]+images[])');
  assert.equal(typeof items[0].text, 'undefined', 'a content[] tool result must not also expose the legacy separated text');
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
    blocks: [{ blockId: 'message:u-s42:content:0', kind: 'text', contentIndex: 0, role: 'user', text: 'annealed' }],
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
    { seq: 10, type: 'user/message', blocks: [{ blockId: 'message:u-u9:content:0', kind: 'text', contentIndex: 0, role: 'user', text: 'chunk stream' }] },
    { seq: 11, type: 'assistant/chunk', blocks: [{ blockId: 'partial:2:1', kind: 'partial', turn: 2, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }] },
    { seq: 12, type: 'assistant/chunk', blocks: [{ blockId: 'partial:2:1', kind: 'partial', turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'par' } }] },
    { seq: 13, type: 'assistant/chunk', blocks: [{ blockId: 'partial:2:1', kind: 'partial', turn: 2, step: 1, chunk: { type: 'text-delta', index: 1, text: 'tial' } }] },
    { seq: 14, type: 'assistant/chunk', blocks: [{ blockId: 'partial:2:1', kind: 'partial', turn: 2, step: 1, chunk: { type: 'block-end', index: 0, text: 'partial' } }] },
    { seq: 20, type: 'assistant/message', turn: 2, step: 1, blocks: [{ blockId: 'message:a-a9:content:0', kind: 'text', contentIndex: 0, role: 'assistant', text: 'final answer' }] },
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

// ---- M1 synchronization reducer: complete snapshot + hello + delta + page ----
{
  const ev = (seq, role, body) => ({
    seq,
    type: role === 'user' ? 'user/message' : 'assistant/message',
    blocks: [{ blockId: `message:${role === 'user' ? 'u' : 'a'}-${seq}:content:0`, kind: 'text', contentIndex: 0, role, text: body }],
  });
  const snapshot = {
    protocolMajor: 1,
    serverGeneration: 'gen-sync-a',
    connectionEpoch: 'epoch-sync-a',
    streamSequence: 10,
    attachment: {
      attachmentId: 'att-sync-a', attachmentGeneration: 1, sessionId: 'session-sync-a',
      history: { asOfSeq: 10, events: [ev(9, 'user', 'nine'), ev(10, 'assistant', 'ten')] },
    },
  };
  const sync = core.createSyncState();
  assert.equal(core.installCompleteSnapshot(sync, snapshot).ok, true);
  assert.equal(sync.syncState, 'awaiting-hello');
  assert.deepEqual([...sync.timeline.keys()], [9, 10]);

  const hello = {
    protocolMajor: 1, serverGeneration: 'gen-sync-a', connectionEpoch: 'epoch-sync-a',
    attachmentId: 'att-sync-a', attachmentGeneration: 1, sessionId: 'session-sync-a',
    baseStreamSequence: 10, baseHistoryAsOfSeq: 10,
  };
  assert.equal(core.acceptStreamHello(sync, hello).ok, true);
  assert.equal(sync.syncState, 'ready');

  const delta = {
    protocolMajor: 1, serverGeneration: 'gen-sync-a', connectionEpoch: 'epoch-sync-a',
    attachmentId: 'att-sync-a', attachmentGeneration: 1, sessionId: 'session-sync-a',
    baseStreamSequence: 10, streamSequence: 11, event: ev(12, 'assistant', 'twelve'),
  };
  assert.equal(core.applyStreamDelta(sync, delta).ok, true);
  assert.equal(sync.streamSequence, 11);
  assert.equal(sync.historyAsOfSeq, 12);
  assert.deepEqual([...sync.timeline.keys()], [9, 10, 12]);
  assert.equal(sync.unread, false);

  core.enterHistoryReading(sync, { blockId: 'message:u-9:content:0', sourceSeq: 9, offsetPx: 7 });
  const modeBeforePage = sync.presentationMode;
  const unreadBeforePage = sync.unread;
  const page = {
    protocolMajor: 1, serverGeneration: 'gen-sync-a', connectionEpoch: 'epoch-sync-a',
    attachmentId: 'att-sync-a', attachmentGeneration: 1, sessionId: 'session-sync-a',
    baseHistoryAsOfSeq: 10, beforeSeq: 9, limit: 3,
    events: [ev(4, 'user', 'four'), ev(7, 'assistant', 'seven')], hasMore: true, nextBeforeSeq: 4,
  };
  assert.equal(core.prependHistoryPage(sync, page, { beforeSeq: 9, limit: 3 }).ok, true);
  assert.deepEqual([...sync.timeline.keys()], [4, 7, 9, 10, 12]);
  assert.equal(sync.streamSequence, 11, 'older page never advances transport watermark');
  assert.equal(sync.historyAsOfSeq, 12, 'older page never advances forward durable watermark');
  assert.equal(sync.presentationMode, modeBeforePage);
  assert.equal(sync.unread, unreadBeforePage);
  assert.equal(sync.nextBeforeSeq, 4);

  const timelineBeforeFault = JSON.stringify([...sync.timeline.entries()]);
  const badGap = { ...delta, baseStreamSequence: 11, streamSequence: 13, event: ev(13, 'assistant', 'gap') };
  assert.equal(core.applyStreamDelta(sync, badGap).code, 'stream-sequence-gap');
  assert.equal(JSON.stringify([...sync.timeline.entries()]), timelineBeforeFault, 'faulting delta installs nothing');
  assert.equal(sync.syncState, 'resyncing');
  assert.equal(sync.writeEligible, false);

  assert.equal(core.installCompleteSnapshot(sync, snapshot).ok, true);
  assert.equal(core.acceptStreamHello(sync, hello).ok, true);
  for (const [mutate, code] of [
    [(d) => { d.connectionEpoch = 'other'; }, 'connectionEpoch-mismatch'],
    [(d) => { d.serverGeneration = 'other'; }, 'serverGeneration-mismatch'],
    [(d) => { d.baseStreamSequence = 9; }, 'baseStreamSequence-mismatch'],
    [(d) => { d.streamSequence = 12; }, 'stream-sequence-gap'],
    [(d) => { d.event = ev(10, 'assistant', 'backwards'); }, 'durable-seq-not-after-current'],
    [(d) => { d.event = { seq: 12, type: 'assistant/message', blocks: {} }; }, 'malformed-blocks'],
  ]) {
    core.installCompleteSnapshot(sync, snapshot);
    core.acceptStreamHello(sync, hello);
    const candidate = JSON.parse(JSON.stringify(delta));
    mutate(candidate);
    const before = JSON.stringify([...sync.timeline.entries()]);
    assert.equal(core.applyStreamDelta(sync, candidate).code, code);
    assert.equal(JSON.stringify([...sync.timeline.entries()]), before);
  }

  for (const [badEvent, code] of [
    [{ seq: 12, type: 'step/end', blocks: [{ blockId: 'mystery:12', kind: 'mystery' }] }, 'unknown-block-kind'],
    [{ seq: 12, type: 'assistant/message', blocks: [{ blockId: 'message:u-wrong:content:0', kind: 'text', contentIndex: 0, role: 'user', text: 'wrong' }] }, 'blockId-root-mismatch'],
    [{ seq: 12, type: 'tool/result', blocks: [{ blockId: 'tool:r12:result:content:0', kind: 'text', contentIndex: 0, role: 'tool', text: 'orphan' }] }, 'tool-result-shell-mismatch'],
    [{ seq: 12, type: 'step/end', blocks: [{ blockId: 'message:u-9:content:0', kind: 'text', contentIndex: 0, role: 'user', text: 'reuse' }] }, 'duplicate-blockId'],
  ]) {
    core.installCompleteSnapshot(sync, snapshot);
    core.acceptStreamHello(sync, hello);
    const before = JSON.stringify([...sync.timeline.entries()]);
    assert.equal(core.applyStreamDelta(sync, { ...delta, event: badEvent }).code, code);
    assert.equal(JSON.stringify([...sync.timeline.entries()]), before);
    assert.equal(sync.syncState, 'resyncing');
    assert.equal(sync.writeEligible, false);
  }

  core.installCompleteSnapshot(sync, snapshot);
  const malformedPage = { ...page, events: [ev(4, 'user', 'four'), { seq: 7, type: 'step/end', blocks: [{ blockId: 'bad:7', kind: 'unknown' }] }] };
  const beforeMalformedPage = JSON.stringify([...sync.timeline.entries()]);
  assert.equal(core.prependHistoryPage(sync, malformedPage, { beforeSeq: 9, limit: 3 }).code, 'unknown-block-kind');
  assert.equal(JSON.stringify([...sync.timeline.entries()]), beforeMalformedPage);
  assert.equal(sync.syncState, 'resyncing');

  assert.equal(core.installCompleteSnapshot(core.createSyncState(), {
    protocolMajor: 1, serverGeneration: 'raw', connectionEpoch: 'raw', streamSequence: -1,
    attachments: [],
  }).code, 'malformed-complete-snapshot', 'raw wire snapshots are not the staged installation API');

  core.installCompleteSnapshot(sync, snapshot);
  core.enterHistoryReading(sync, { blockId: 'gone', sourceSeq: 8, offsetPx: 3 });
  assert.equal(core.reanchor(sync, ['message:u-9:content:0']).blockId, 'message:u-9:content:0');
  core.enterFollowing(sync);
  assert.equal(sync.presentationMode, 'following');
  assert.equal(sync.unread, false);
}

console.log('c0-core sync reducer: PASS');
