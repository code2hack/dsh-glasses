import assert from 'node:assert/strict';
import { buildCanonicalSnapshot, M1_BOOTSTRAP_MAX_EVENTS } from '../../../plugins/dsh-glasses-plugin/lib/snapshot.js';
import { bootClientDom as boot, chatTexts, sleep } from './dom-harness.mjs';

const SESSION = 'fault-session-a';

function events(label) {
  return [
    { seq: 1, type: 'user/message', blocks: [{ blockId: `message:u-${label}:content:0`, kind: 'text', role: 'user', text: `${label}-question`, contentIndex: 0 }] },
    { seq: 2, type: 'assistant/chunk', blocks: [{ blockId: 'partial:1:1', kind: 'partial', turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }] },
    { seq: 3, type: 'assistant/chunk', blocks: [{ blockId: 'partial:1:1', kind: 'partial', turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'partial' } }] },
    { seq: 4, type: 'assistant/message', turn: 1, step: 1, blocks: [{ blockId: `message:a-${label}:content:0`, kind: 'text', role: 'assistant', text: `${label}-answer`, contentIndex: 0 }] },
  ];
}

function snapshot(label) {
  return buildCanonicalSnapshot({
    sessionId: SESSION,
    attachmentId: 'att-fault-stable-9f1e',
    projected: { asOfSeq: 4, events: events(label) },
    agentState: 'idle',
    serverGeneration: `gen-${label}`,
    connectionEpoch: `epoch-${label}`,
    maxEvents: M1_BOOTSTRAP_MAX_EVENTS,
  });
}

function hello(snap) {
  const attachment = snap.attachments[0];
  return {
    protocolMajor: 1,
    serverGeneration: snap.serverGeneration,
    connectionEpoch: snap.connectionEpoch,
    attachmentId: attachment.attachmentId,
    attachmentGeneration: attachment.attachmentGeneration,
    sessionId: SESSION,
    baseStreamSequence: 4,
    baseHistoryAsOfSeq: 4,
  };
}

function delta(snap) {
  return {
    ...hello(snap),
    streamSequence: 5,
    event: { seq: 5, type: 'step/end', blocks: [] },
  };
}

async function ready(rt, snap) {
  await rt.settled(snap.serverGeneration);
  rt.w.glassesOnStream(snap.connectionEpoch, 'open', null);
  rt.w.glassesOnLine(snap.connectionEpoch, 'hello', JSON.stringify(hello(snap)), '');
  assert.equal(rt.w.c0DebugState().syncState, 'ready');
}

const cases = [
  ['missing transport sequence', (rt, e1) => { const d = delta(e1); delete d.streamSequence; rt.w.glassesOnLine(e1.connectionEpoch, 'projection', JSON.stringify(d), ''); }],
  ['+2 stream gap', (rt, e1) => { const d = delta(e1); d.streamSequence = 6; rt.w.glassesOnLine(e1.connectionEpoch, 'projection', JSON.stringify(d), '6'); }],
  ['duplicate stream sequence', (rt, e1) => { const d = delta(e1); d.streamSequence = 4; rt.w.glassesOnLine(e1.connectionEpoch, 'projection', JSON.stringify(d), '4'); }],
  ['backwards stream sequence', (rt, e1) => { const d = delta(e1); d.streamSequence = 3; rt.w.glassesOnLine(e1.connectionEpoch, 'projection', JSON.stringify(d), '3'); }],
  ['wrong base stream sequence', (rt, e1) => { const d = delta(e1); d.baseStreamSequence = 3; d.streamSequence = 4; rt.w.glassesOnLine(e1.connectionEpoch, 'projection', JSON.stringify(d), '4'); }],
  ['malformed JSON', (rt, e1) => rt.w.glassesOnLine(e1.connectionEpoch, 'projection', '{bad', '5')],
  ['malformed canonical event', (rt, e1) => { const d = delta(e1); d.event.blocks = {}; rt.w.glassesOnLine(e1.connectionEpoch, 'projection', JSON.stringify(d), '5'); }],
  ['wrong connection epoch', (rt, e1) => { const d = delta(e1); d.connectionEpoch = 'epoch-forged'; rt.w.glassesOnLine(e1.connectionEpoch, 'projection', JSON.stringify(d), '5'); }],
  ['wrong server generation', (rt, e1) => { const d = delta(e1); d.serverGeneration = 'gen-forged'; rt.w.glassesOnLine(e1.connectionEpoch, 'projection', JSON.stringify(d), '5'); }],
  ['wrong attachment generation', (rt, e1) => { const d = delta(e1); d.attachmentGeneration += 1; rt.w.glassesOnLine(e1.connectionEpoch, 'projection', JSON.stringify(d), '5'); }],
  ['source sequence backwards', (rt, e1) => { const d = delta(e1); d.event.seq = 3; rt.w.glassesOnLine(e1.connectionEpoch, 'projection', JSON.stringify(d), '5'); }],
  ['source sequence conflict', (rt, e1) => { const d = delta(e1); d.event = { seq: 4, type: 'step/end', blocks: [] }; rt.w.glassesOnLine(e1.connectionEpoch, 'projection', JSON.stringify(d), '5'); }],
  ['overflow signal', (rt, e1) => rt.w.glassesOnLine(e1.connectionEpoch, 'resync-required', JSON.stringify({ reason: 'overflow' }), '')],
  ['stream close', (rt, e1) => rt.w.glassesOnStream(e1.connectionEpoch, 'closed', null)],
  ['network disconnect', (rt, e1) => rt.w.glassesOnStream(e1.connectionEpoch, 'error', 'network')],
];

for (const [name, inject] of cases) {
  const e1 = snapshot(`e1-${name.replaceAll(' ', '-')}`);
  const e2 = snapshot(`e2-${name.replaceAll(' ', '-')}`);
  const rt = await boot({ session: SESSION, responses: [{ status: 200, body: e1 }, { status: 200, body: e2 }] });
  await ready(rt, e1);
  const before = JSON.stringify(chatTexts(rt));
  inject(rt, e1);
  const faulted = rt.w.c0DebugState();
  assert.equal(faulted.syncState, 'resyncing', `${name}: enters resync`);
  assert.equal(faulted.writeEligible, false, `${name}: write ineligible`);
  assert.equal(JSON.stringify(chatTexts(rt)), before, `${name}: no partial install`);
  assert.ok(rt.requests().includes('CLOSE_STREAM'), `${name}: old stream stopped`);
  assert.ok(!rt.requests().some((path) => path.includes('/draft/mutations') || path.includes('/actions')), `${name}: no writes`);

  const opensBeforeDelayed = rt.requests().filter((path) => path === 'OPEN_STREAM').length;
  const reconnectsBeforeDelayed = rt.traces().filter((trace) => trace.includes('reconnect-scheduled')).length;
  rt.w.glassesOnLine(e1.connectionEpoch, 'projection', JSON.stringify(delta(e1)), '5');
  rt.w.glassesOnStream(e1.connectionEpoch, 'closed', null);
  await sleep(25);
  assert.equal(JSON.stringify(chatTexts(rt)), before, `${name}: delayed E1 callbacks cannot mutate during resync`);
  assert.equal(rt.requests().filter((path) => path === 'OPEN_STREAM').length, opensBeforeDelayed, `${name}: delayed callbacks do not reopen E1`);
  assert.equal(rt.traces().filter((trace) => trace.includes('reconnect-scheduled')).length, reconnectsBeforeDelayed, `${name}: duplicate callbacks do not reschedule recovery`);

  rt.w.run();
  assert.equal(rt.w.c0DebugState().connectionEpoch, e2.connectionEpoch, `${name}: fresh epoch installed`);
  assert.notEqual(e2.connectionEpoch, e1.connectionEpoch, `${name}: epoch changed`);
  assert.deepEqual(chatTexts(rt).map((item) => item.body), [`e2-${name.replaceAll(' ', '-')}-question`, `e2-${name.replaceAll(' ', '-')}-answer`], `${name}: complete replacement`);
  const recoveredOpen = rt.requestDetails().filter((request) => request.path === 'OPEN_STREAM').at(-1);
  assert.deepEqual({ epoch: recoveredOpen.epoch, baseStreamSequence: recoveredOpen.baseStreamSequence }, { epoch: e2.connectionEpoch, baseStreamSequence: 4 }, `${name}: exact E2 stream base`);
  if (name === 'wrong server generation') {
    assert.notEqual(e2.serverGeneration, e1.serverGeneration, 'generation replacement: G2 differs from G1');
    assert.equal(rt.w.c0DebugState().generation, e2.serverGeneration, 'generation replacement: complete G2 snapshot installed');
    assert.ok(!JSON.stringify(chatTexts(rt)).includes('e1-wrong-server-generation'), 'generation replacement: no G1 content retained');
  }
  await ready(rt, e2);
  assert.equal(rt.w.c0DebugState().syncState, 'ready', `${name}: E2 hello reaches ready`);
  const recovered = JSON.stringify(chatTexts(rt));
  rt.w.glassesOnLine(e1.connectionEpoch, 'projection', JSON.stringify(delta(e1)), '5');
  assert.equal(JSON.stringify(chatTexts(rt)), recovered, `${name}: delayed old delta rejected after recovery`);
  if (name === 'wrong server generation') assert.equal(rt.w.c0DebugState().generation, e2.serverGeneration, 'generation replacement: delayed G1 leaves G2 installed');
  const ids = rt.w.c0DebugState().conversation.map((item) => item.blockId);
  assert.equal(new Set(ids).size, ids.length, `${name}: final block ids unique`);
  rt.dom.window.close();
  console.log(`PASS ${name}`);
}

// A history response issued under E1 must not install if E1 enters resync while
// the synchronous native bridge call is returning it.
{
  const e1 = snapshot('history-e1');
  let rt;
  const stalePage = {
    toJSON() {
      rt.w.glassesOnLine(e1.connectionEpoch, 'projection', '{fault-during-history', '5');
      return {
        ...hello(e1), beforeSeq: 1, limit: 50,
        events: [{ seq: 0, type: 'step/end', blocks: [] }],
        hasMore: false, nextBeforeSeq: null,
      };
    },
  };
  rt = await boot({ session: SESSION, responses: [{ status: 200, body: e1 }, { status: 200, body: stalePage }] });
  await ready(rt, e1);
  const before = JSON.stringify(rt.w.c0DebugState().conversation);
  const beforePaging = { oldestLoadedSeq: rt.w.c0DebugState().oldestLoadedSeq, nextBeforeSeq: rt.w.c0DebugState().nextBeforeSeq };
  rt.w.loadOlderHistory();
  assert.equal(rt.w.c0DebugState().syncState, 'resyncing');
  assert.equal(JSON.stringify(rt.w.c0DebugState().conversation), before, 'stale history response must not mutate after resync');
  assert.deepEqual({ oldestLoadedSeq: rt.w.c0DebugState().oldestLoadedSeq, nextBeforeSeq: rt.w.c0DebugState().nextBeforeSeq }, beforePaging, 'stale history response must not mutate paging state');
  assert.ok(!rt.traces().some((trace) => trace.includes('history-page-accepted')), 'stale history response must not be accepted');
  rt.dom.window.close();
  console.log('PASS stale history response after resync');
}

console.log(`ALL PASS (${cases.length + 1} fault scenarios)`);
