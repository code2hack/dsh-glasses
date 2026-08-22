// T27-06: pure client atomic snapshot staging.
//
// Proves that stageSnapshot(raw) accepts only wire-law-valid snapshots, builds
// a DETACHED conversation state through the same pure C0 reducer, and never
// mutates anything — globals, previously staged state, or the raw input — on
// failure. Atomicity is structural: the client mirrors the frozen server wire
// law (plugins/.../snapshot.js validateSnapshotWire) in vanilla asset JS.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildCanonicalSnapshot, validateSnapshotWire as serverValidateWire, M1_BOOTSTRAP_MAX_EVENTS } from '../../../plugins/dsh-glasses-plugin/lib/snapshot.js';

const SESSION = 'session-client-a';
const c0Source = readFileSync(new URL('../app/src/main/assets/c0-core.js', import.meta.url), 'utf8');
const snapSource = readFileSync(new URL('../app/src/main/assets/snapshot-core.js', import.meta.url), 'utf8');

function loadCore() {
  const context = { console };
  vm.runInNewContext(c0Source, context, { filename: 'c0-core.js' });
  vm.runInNewContext(snapSource, context, { filename: 'snapshot-core.js' });
  assert.ok(context.GlassesSnapshotCore, 'GlassesSnapshotCore installed');
  return context;
}
const context = loadCore();
const core = context.GlassesSnapshotCore;

const RESULTS = [];
const record = (name, pass, detail) => {
  RESULTS.push({ name, verdict: pass ? 'PASS' : 'FAIL', detail: detail ?? null });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};

function canonicalRaw(over = {}) {
  return buildCanonicalSnapshot({
    sessionId: SESSION,
    attachmentId: `att-${'0'.repeat(36)}`,
    projected: {
      asOfSeq: 4,
      events: [
        { seq: 1, type: 'user/message', blockId: 'message:u-u1', message: { role: 'user', id: 'u1', text: 'hello' } },
        { seq: 2, type: 'assistant/chunk', blockId: 'partial:1:1', turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
        { seq: 3, type: 'assistant/chunk', blockId: 'partial:1:1', turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'par' } },
        { seq: 4, type: 'assistant/message', blockId: 'message:a-a1', turn: 1, step: 1, message: { role: 'assistant', id: 'a1', text: 'final' } },
      ],
    },
    agentState: 'idle',
    serverGeneration: 'gen-client-01',
    connectionEpoch: 'epoch-client-1',
    maxEvents: M1_BOOTSTRAP_MAX_EVENTS,
    ...over,
  });
}

// Serialize the staged snapshot + its detached conversation to a plain tree
// (items render list derived at stage time) so atomicity can be compared.
function snapshotPlain(staged) {
  return JSON.parse(JSON.stringify({
    protocolMajor: staged.protocolMajor,
    serverGeneration: staged.serverGeneration,
    connectionEpoch: staged.connectionEpoch,
    streamSequence: staged.streamSequence,
    attachment: staged.attachment,
    drafts: staged.drafts,
    items: staged.items,
  }));
}

// ---- Positive staging ----
{
  const raw = structuredClone(canonicalRaw());
  const res = core.stageSnapshot(raw, { protocolMajor: 1, expectedSessionId: SESSION });
  assert.equal(res.ok, true);
  const s = res.snapshot;
  assert.equal(s.attachment.sessionId, SESSION);
  assert.equal(s.attachment.capabilities.historyRead, true);
  for (const k of ['draftMutations', 'send', 'steer', 'interrupt', 'resolveRequest']) assert.equal(s.attachment.capabilities[k], false);
  assert.deepEqual(JSON.parse(JSON.stringify(s.drafts)), []);
  const items = JSON.parse(JSON.stringify(s.items));
  assert.deepEqual(items.map((i) => [i.role, i.text, i.partial]), [
    ['user', 'hello', false],
    ['assistant', 'final', false],
  ], 'final message replaces the partial (no partial survives)');
  record('positive: complete snapshot stages to detached state (no partial leak)', true);
}
{
  const raw = structuredClone(canonicalRaw({ streamSequence: -1, projected: { asOfSeq: -1, events: [] }, attachments: undefined }));
  const res = core.stageSnapshot(raw, { protocolMajor: 1, expectedSessionId: SESSION });
  assert.equal(res.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(res.snapshot.items)), []);
  record('positive: empty-history snapshot stages to empty conversation', true);
}
{
  // Detached conversation proves no global/DOM coupling: staging twice yields
  // two independent conversations.
  const a = core.stageSnapshot(structuredClone(canonicalRaw()), { expectedSessionId: SESSION });
  const b = core.stageSnapshot(structuredClone(canonicalRaw()), { expectedSessionId: SESSION });
  assert.notEqual(a.snapshot.conversation, b.snapshot.conversation);
  a.snapshot.conversation.messages.set('probe', { key: 'probe' });
  assert.equal(b.snapshot.conversation.messages.has('probe'), false);
  record('positive: staged conversation is detached (no shared reducer state)', true);
}
{
  // Ticket AC1 requires a label, not the specific literal; any non-empty label
  // is wire-valid (mirrors the frozen server law).
  const raw = structuredClone(canonicalRaw());
  raw.attachments[0].label = 'Renamed by operator';
  const res = core.stageSnapshot(raw, { expectedSessionId: SESSION });
  assert.equal(res.ok, true);
  assert.equal(res.snapshot.attachment.label, 'Renamed by operator');
  record('positive: arbitrary non-empty label accepted', true);
}
{
  // Structural detachment: after a SUCCESSFUL stage, mutating the raw snapshot
  // (deeply, into events/label/caps/generation/drafts) must not change ANY
  // part of the staged result — wire tree, items, or conversation.
  const raw = structuredClone(canonicalRaw());
  const res = core.stageSnapshot(raw, { expectedSessionId: SESSION });
  assert.equal(res.ok, true);
  const stagedBefore = JSON.stringify(snapshotPlain(res.snapshot));
  raw.attachments[0].history.events[0].message.text = 'MUTATED-AFTER-STAGE';
  raw.attachments[0].history.events[2].chunk.text = 'MUTATED';
  raw.attachments[0].label = 'Mutated';
  raw.attachments[0].capabilities.send = true;
  raw.serverGeneration = 'mutated-gen';
  raw.drafts.push({ opId: 'x' });
  raw.streamSequence = 99;
  assert.equal(JSON.stringify(snapshotPlain(res.snapshot)), stagedBefore, 'raw mutation must not leak into staged wire/items');
  assert.equal(res.snapshot.attachment.history.events[0].message.text, 'hello');
  assert.equal(res.snapshot.serverGeneration, 'gen-client-01');
  assert.equal(res.snapshot.streamSequence, 4);
  assert.equal(res.snapshot.conversation.messages.get('message:u-u1').text, 'hello');
  record('positive: staged result fully detached from raw (post-success mutation)', true);
}

// ---- Never-throw / atomicity over negative fixtures ----
const NEGATIVES = [
  ['unsupported protocolMajor', (s) => { s.protocolMajor = 2; }, 'unsupported-protocolMajor'],
  ['missing serverGeneration', (s) => { delete s.serverGeneration; }, 'missing-serverGeneration'],
  ['empty serverGeneration', (s) => { s.serverGeneration = ''; }, 'missing-serverGeneration'],
  ['missing connectionEpoch', (s) => { delete s.connectionEpoch; }, 'missing-connectionEpoch'],
  ['wrong attachmentSetRevision', (s) => { s.attachmentSetRevision = 2; }, 'wrong-attachmentSetRevision'],
  ['zero attachments', (s) => { s.attachments = []; }, 'zero-attachments'],
  ['two attachments', (s) => { s.attachments.push(structuredClone(s.attachments[0])); }, 'two-attachments'],
  ['wrong configured sessionId', (s) => {}, 'wrong-sessionId'],
  ['wrong expectedServerGeneration', (s) => {}, 'serverGeneration-mismatch'],
  ['missing/empty attachmentId', (s) => { s.attachments[0].attachmentId = ''; }, 'missing-attachmentId'],
  ['attachmentId equals sessionId', (s) => { s.attachments[0].attachmentId = SESSION; }, 'attachmentId-encodes-session'],
  ['attachmentId contains sessionId', (s) => { s.attachments[0].attachmentId = `x-${SESSION}-y`; }, 'attachmentId-encodes-session'],
  ['attachmentId couples serverGeneration', (s) => { s.attachments[0].attachmentId = s.serverGeneration; }, 'attachmentId-couples-serverGeneration'],
  ['zero attachmentGeneration', (s) => { s.attachments[0].attachmentGeneration = 0; }, 'non-positive-attachmentGeneration'],
  ['missing attachment sessionId', (s) => { s.attachments[0].sessionId = ''; }, 'missing-attachment-sessionId'],
  ['wrong attachment label', (s) => { s.attachments[0].label = ''; }, 'missing-label'],
  ['non-zero attribution order', (s) => { s.attachments[0].order = 1; }, 'non-zero-order'],
  ['invalid attachment state', (s) => { s.attachments[0].state = 'ready'; }, 'invalid-attachment-state'],
  ['malformed attachment', (s) => { s.attachments[0] = null; }, 'malformed-attachment'],
  ['historyRead != true', (s) => { s.attachments[0].capabilities.historyRead = false; }, 'historyRead-not-true'],
  ['missing liveUpdates capability', (s) => { delete s.attachments[0].capabilities.liveUpdates; }, 'mutation-capability-enabled'],
  ['liveUpdates true', (s) => { s.attachments[0].capabilities.liveUpdates = true; }, 'mutation-capability-enabled'],
  ['draftMutations true', (s) => { s.attachments[0].capabilities.draftMutations = true; }, 'mutation-capability-enabled'],
  ['send true', (s) => { s.attachments[0].capabilities.send = true; }, 'mutation-capability-enabled'],
  ['steer true', (s) => { s.attachments[0].capabilities.steer = true; }, 'mutation-capability-enabled'],
  ['interrupt true', (s) => { s.attachments[0].capabilities.interrupt = true; }, 'mutation-capability-enabled'],
  ['resolveRequest true', (s) => { s.attachments[0].capabilities.resolveRequest = true; }, 'mutation-capability-enabled'],
  ['non-empty drafts', (s) => { s.drafts.push({ opId: 'x' }); }, 'non-empty-drafts'],
  ['drafts not array', (s) => { s.drafts = {}; }, 'drafts-not-array'],
  ['agent state != attachment state', (s) => { s.attachments[0].agent.state = 'running'; }, 'agent-state-mismatch'],
  ['agent wrong serverGeneration', (s) => { s.attachments[0].agent.serverGeneration = 'other'; }, 'agent-serverGeneration-mismatch'],
  ['agent wrong attachmentGeneration', (s) => { s.attachments[0].agent.attachmentGeneration = 9; }, 'agent-attachmentGeneration-mismatch'],
  ['missing agent projection', (s) => { delete s.attachments[0].agent; }, 'missing-agent-projection'],
  ['history wrong serverGeneration', (s) => { s.attachments[0].history.serverGeneration = 'other'; }, 'history-serverGeneration-mismatch'],
  ['history wrong attachmentGeneration', (s) => { s.attachments[0].history.attachmentGeneration = 9; }, 'history-attachmentGeneration-mismatch'],
  ['history.events not array', (s) => { s.attachments[0].history.events = {}; }, 'history-events-not-array'],
  ['history.events undefined (never throws)', (s) => { s.attachments[0].history.events = undefined; }, 'history-events-not-array'],
  ['history.events null (never throws)', (s) => { s.attachments[0].history.events = null; }, 'history-events-not-array'],
  ['1001 events beyond hard maximum', (s) => {
    s.streamSequence = 1000;
    s.attachments[0].history.asOfSeq = 1000;
    s.attachments[0].history.events = Array.from({ length: 1001 }, (_, i) => ({ seq: i, type: 'step/end' }));
  }, 'history-beyond-max'],
  ['malformed snapshot gets its generic code even when a generation fence is set', (s) => { s.protocolMajor = 2; }, 'unsupported-protocolMajor'],
  ['raw protocolMajor 2 cannot be widened by caller (opts.protocolMajor=2)', (s) => { s.protocolMajor = 2; }, 'unsupported-protocolMajor'],
  ['descending event sequence', (s) => { s.attachments[0].history.events = [{ seq: 4, type: 'step/end' }, { seq: 3, type: 'step/end' }, { seq: 4, type: 'step/end' }]; }, 'non-monotonic-seq'],
  ['duplicate sequence', (s) => { s.attachments[0].history.events = [{ seq: 2, type: 'step/end' }, { seq: 2, type: 'step/end' }, { seq: 4, type: 'step/end' }]; }, 'non-monotonic-seq'],
  ['event seq > asOfSeq', (s) => { s.attachments[0].history.events = [{ seq: 5, type: 'step/end' }, { seq: 4, type: 'step/end' }]; }, 'seq-beyond-asOfSeq'],
  ['duplicate message blockId', (s) => {
    s.streamSequence = 2;
    s.attachments[0].history.asOfSeq = 2;
    s.attachments[0].history.events = [
      { seq: 1, type: 'user/message', blockId: 'message:u-u1', message: { role: 'user', id: 'u1', text: 'a' } },
      { seq: 2, type: 'user/message', blockId: 'message:u-u1', message: { role: 'user', id: 'u1', text: 'b' } },
    ];
  }, 'duplicate-blockId'],
  ['message blockId wrong identity (prefix)', (s) => { s.attachments[0].history.events[0].blockId = 'message:a-u1'; }, 'type-blockId-mismatch'],
  ['chunk blockId wrong identity (prefix)', (s) => { s.attachments[0].history.events[1].blockId = 'message:a-1'; }, 'type-blockId-mismatch'],
  ['chunk blockId not its turn/step', (s) => { s.attachments[0].history.events[1].blockId = 'partial:9:9'; }, 'type-blockId-mismatch'],
  ['assistant message blockId not its id', (s) => { s.attachments[0].history.events[3].blockId = 'message:a-other'; }, 'type-blockId-mismatch'],
  ['projected event without type', (s) => { s.attachments[0].history.events[0].type = undefined; }, 'malformed-projected-event'],
  ['user/message wrong role', (s) => { s.attachments[0].history.events[0].message = { role: 'assistant', id: 'u1', text: 'x' }; }, 'type-role-mismatch'],
  ['message missing text', (s) => { s.attachments[0].history.events[0].message = { role: 'user', id: 'u1' }; }, 'malformed-projected-event'],
  ['malformed projected chunk (no chunk.type)', (s) => { s.attachments[0].history.events[1].chunk = {}; }, 'malformed-projected-event'],
  ['streamSequence != history.asOfSeq', (s) => { s.streamSequence = 99; }, 'streamSequence-mismatch'],
  ['envelope ok field present', (s) => { s.ok = true; }, 'envelope-ok-not-allowed'],
];

// Capture a frozen valid staged snapshot; every negative must leave it intact.
const baseline = core.stageSnapshot(structuredClone(canonicalRaw()), { expectedSessionId: SESSION });
assert.equal(baseline.ok, true);
const baselinePlain = snapshotPlain(baseline.snapshot);
const globalsBefore = Object.keys(context).slice().sort();

for (const [name, mutate, expectCode] of NEGATIVES) {
  const raw = structuredClone(canonicalRaw());
  mutate(raw);
  // The fixture deliberately mutated raw; the baseline for "stageSnapshot must
  // not mutate its input" is captured AFTER that mutation, before staging.
  const rawBefore = JSON.stringify(raw);
  const opts = {};
  if (name === 'wrong configured sessionId') opts.expectedSessionId = 'session-other';
  if (name === 'wrong expectedServerGeneration') { opts.expectedServerGeneration = 'gen-other'; }
  if (name === 'malformed snapshot gets its generic code even when a generation fence is set') { opts.expectedServerGeneration = 'gen-other'; }
  if (name === 'raw protocolMajor 2 cannot be widened by caller (opts.protocolMajor=2)') { opts.protocolMajor = 2; }
  let res;
  try {
    res = core.stageSnapshot(raw, opts);
  } catch (e) {
    record(`negative: ${name} -> ${expectCode}`, false, `THREW: ${e.message}`);
    continue;
  }
  const pass = !res.ok && res.code === expectCode;
  record(`negative: ${name} -> ${expectCode}`, pass, res.ok ? 'not rejected' : res.code);
  assert.equal(pass, true);
  // Atomicity 1: raw input never mutated.
  assert.equal(JSON.stringify(raw), rawBefore, `raw mutated during ${name}`);
  // Atomicity 2: previously staged state byte-identical to baseline.
  assert.deepEqual(snapshotPlain(baseline.snapshot), baselinePlain, `previous staged state changed during ${name}`);
  // Atomicity 3: module globals unchanged.
  assert.deepEqual(Object.keys(context).slice().sort(), globalsBefore, `globals changed during ${name}`);
}

// ---- Mirror convergence: the client generic law must match the server law ----
// For every representative fixture (excluding client-only generation fencing),
// generic acceptance AND rejection codes must be identical between
// validateSnapshotWire (frozen server law) and stageSnapshot (client mirror).
{
  const CONVERGENCE = [
    ['valid complete', (s) => {}],
    ['valid empty-history', (s) => { s.streamSequence = -1; s.attachments[0].history.asOfSeq = -1; s.attachments[0].history.events = []; }],
    ['valid seq-fallback identities', (s) => {
      s.streamSequence = 2;
      s.attachments[0].history.asOfSeq = 2;
      s.attachments[0].history.events = [
        { seq: 1, type: 'user/message', blockId: 'message:u-s1', message: { role: 'user', id: '', text: 'x' } },
        { seq: 2, type: 'assistant/chunk', blockId: 'partial:s2', chunk: { type: 'text-delta', index: 0, text: 'p' } },
      ];
    }],
    ['arbitrary non-empty label', (s) => { s.attachments[0].label = 'Renamed'; }],
    ['unsupported protocolMajor', (s) => { s.protocolMajor = 2; }],
    ['missing serverGeneration', (s) => { delete s.serverGeneration; }],
    ['missing connectionEpoch', (s) => { delete s.connectionEpoch; }],
    ['two attachments', (s) => { s.attachments.push(structuredClone(s.attachments[0])); }],
    ['attachmentId equals session', (s) => { s.attachments[0].attachmentId = SESSION; }],
    ['attachmentId couples serverGeneration', (s) => { s.attachments[0].attachmentId = s.serverGeneration; }],
    ['non-positive generation', (s) => { s.attachments[0].attachmentGeneration = 0; }],
    ['invalid state', (s) => { s.attachments[0].state = 'ready'; }],
    ['historyRead false', (s) => { s.attachments[0].capabilities.historyRead = false; }],
    ['missing liveUpdates', (s) => { delete s.attachments[0].capabilities.liveUpdates; }],
    ['liveUpdates true', (s) => { s.attachments[0].capabilities.liveUpdates = true; }],
    ['send true', (s) => { s.attachments[0].capabilities.send = true; }],
    ['non-empty drafts', (s) => { s.drafts.push({ op: 1 }); }],
    ['agent state mismatch', (s) => { s.attachments[0].agent.state = 'running'; }],
    ['history wrong generation', (s) => { s.attachments[0].history.serverGeneration = 'other'; }],
    ['history events not array', (s) => { s.attachments[0].history.events = {}; }],
    ['history events undefined', (s) => { s.attachments[0].history.events = undefined; }],
    ['history events null', (s) => { s.attachments[0].history.events = null; }],
    ['non-monotonic seq', (s) => { s.attachments[0].history.events = [{ seq: 4, type: 'step/end' }, { seq: 3, type: 'step/end' }, { seq: 4, type: 'step/end' }]; }],
    ['duplicate message blockId', (s) => {
      s.streamSequence = 2;
      s.attachments[0].history.asOfSeq = 2;
      s.attachments[0].history.events = [
        { seq: 1, type: 'user/message', blockId: 'message:u-u1', message: { role: 'user', id: 'u1', text: 'a' } },
        { seq: 2, type: 'user/message', blockId: 'message:u-u1', message: { role: 'user', id: 'u1', text: 'b' } },
      ];
    }],
    ['message blockId identity mismatch', (s) => { s.attachments[0].history.events[0].blockId = 'message:a-u1'; }],
    ['chunk turn/step identity mismatch', (s) => { s.attachments[0].history.events[1].blockId = 'partial:9:9'; }],
    ['event without type', (s) => { s.attachments[0].history.events[0].type = undefined; }],
    ['wrong role', (s) => { s.attachments[0].history.events[0].message = { role: 'assistant', id: 'u1', text: 'x' }; }],
    ['missing text', (s) => { s.attachments[0].history.events[0].message = { role: 'user', id: 'u1' }; }],
    ['chunk missing type', (s) => { s.attachments[0].history.events[1].chunk = {}; }],
    ['streamSequence mismatch', (s) => { s.streamSequence = 99; }],
    ['1001 events beyond hard maximum', (s) => {
      s.streamSequence = 1000;
      s.attachments[0].history.asOfSeq = 1000;
      s.attachments[0].history.events = Array.from({ length: 1001 }, (_, i) => ({ seq: i, type: 'step/end' }));
    }],
    ['envelope ok present', (s) => { s.ok = true; }],
  ];
  let converged = true;
  for (const [name, mutate] of CONVERGENCE) {
    const raw = structuredClone(canonicalRaw());
    mutate(raw);
    const serverRes = serverValidateWire(raw, { expectedSessionId: SESSION });
    const clientRes = core.stageSnapshot(raw, { protocolMajor: 1, expectedSessionId: SESSION });
    let pass = serverRes.ok === clientRes.ok;
    if (pass && !serverRes.ok) pass = serverRes.code === clientRes.code;
    if (!pass) {
      converged = false;
      record(`convergence: ${name}`, false, `server ${JSON.stringify(serverRes)} vs client ${JSON.stringify(clientRes)}`);
    }
    assert.equal(pass, true, `mirror divergence on "${name}": server ${JSON.stringify(serverRes)} vs client ${JSON.stringify(clientRes)}`);
  }
  if (converged) record('convergence: client generic law matches frozen server law (acceptance + codes)', true);
}

// ---- Never-throw over garbage input ----
{
  for (const [idx, blob] of [undefined, null, 42, 'garbage', { ok: true }].entries()) {
    const res = core.stageSnapshot(blob);
    assert.equal(res.ok, false, `blob${idx} must reject`);
    assert.equal(typeof res.code, 'string');
  }
  record('negative: stageSnapshot never throws over garbage input', true);
}

console.log('=== snapshot-core SUMMARY ===');
for (const r of RESULTS) console.log(`${r.verdict} ${r.name}`);
for (const r of RESULTS) console.log(`RESULT\t${JSON.stringify(r)}`);
const failed = RESULTS.filter((r) => r.verdict !== 'PASS');
if (failed.length) { console.log(`FAILED: ${failed.length}`); process.exit(1); }
console.log(`ALL PASS (${RESULTS.length} checks)`);
