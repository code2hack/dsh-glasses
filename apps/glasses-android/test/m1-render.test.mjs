// T27-07/T27-08: real-DOM (jsdom 29.1.1) render + M1 read-only evidence suite.
//
// Boots the actual index.html + c0-core / snapshot-core / app.js assets in a
// fresh disposable jsdom runtime (exactly once) and proves, against a live
// DOM, the three required runtime states and the M1 zero-reachability
// invariant:
//   1. no prior install + invalid bootstrap -> no session content becomes
//      visible (session stays hidden, bounded snapshot-rejected trace).
//   2. valid install + later invalid bootstrap -> previous rendered/installed
//      state stays byte-identical.
//   3. valid replacement bootstrap -> the whole staged snapshot replaces state
//      in ONE install path (no partial, no duplicate, no append).
// Plus: composer hidden, mode NAV, no paste/Send/mutation/send retry, no
// /draft/mutations or /actions POST, no openStream().
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCanonicalSnapshot, M1_BOOTSTRAP_MAX_EVENTS } from '../../../plugins/dsh-glasses-plugin/lib/snapshot.js';

const SESSION = 'render-session-a';
const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, '..', 'app', 'src', 'main', 'assets', 'index.html');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RESULTS = [];
function record(name, pass, detail) {
  RESULTS.push({ name, verdict: pass ? 'PASS' : 'FAIL', detail: detail ?? null });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

function eventsFor(userText, asstText, uid, aid) {
  return [
    { seq: 1, type: 'user/message', blockId: `message:u-${uid}`, message: { role: 'user', id: uid, text: userText } },
    { seq: 2, type: 'assistant/chunk', blockId: 'partial:1:1', turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    { seq: 3, type: 'assistant/chunk', blockId: 'partial:1:1', turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'par' } },
    { seq: 4, type: 'assistant/message', blockId: `message:a-${aid}`, turn: 1, step: 1, message: { role: 'assistant', id: aid, text: asstText } },
  ];
}
function validSnapshot({ generation, user, asst, asOfSeq = 4, epoch }) {
  // attachmentId is lifetime-stable and independent of serverGeneration (opaque).
  return buildCanonicalSnapshot({
    sessionId: SESSION,
    attachmentId: 'att-9f1e-render-8221b4',
    projected: { asOfSeq, events: eventsFor(user, asst, `u-${generation}`, `a-${generation}`) },
    agentState: 'idle',
    serverGeneration: generation,
    connectionEpoch: epoch || `epoch-${generation}`,
    maxEvents: M1_BOOTSTRAP_MAX_EVENTS,
  });
}
function invalidSnapshot() {
  const snap = validSnapshot({ generation: 'gen-bad', user: 'u', asst: 'a' });
  snap.protocolMajor = 2; // unsupported major -> staged rejection
  return snap;
}

async function boot({ responses, session = SESSION }) {
  const requests = [];
  const traces = [];
  let servedIndex = 0;
  const served = responses.slice();

  const dom = await JSDOM.fromFile(INDEX, {
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      const originalInfo = window.console.info.bind(window.console);
      window.console.info = (...args) => {
        traces.push(args.map(String).join(' '));
        originalInfo(...args);
      };
      window.GlassesBridge = {
        endpoint: () => 'http://dsh-render:7777',
        sessionId: () => session,
        configure: (base, token, sid) => { window.__configured = { base, sid }; return true; },
        fetch: (path, payload) => {
          requests.push({ path, hasBody: payload !== '' });
          const r = served[Math.min(servedIndex++, served.length - 1)];
          return JSON.stringify({ status: r.status, body: r.body });
        },
        openStream: () => { requests.push({ path: 'OPEN_STREAM', hasBody: false }); },
        closeStream: () => {},
        clipboardText: () => 'clip',
      };
    },
  });

  const w = dom.window;
  const $ = (id) => w.document.getElementById(id);
  const settled = async (label) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const gen = (w.c0DebugState && w.c0DebugState().generation) || '';
      const conn = String(($('conn') && $('conn').textContent) || '');
      if (gen !== '' || conn.startsWith('snapshot-rejected') || conn === 'session-mismatch' || conn === 'configure') return;
      await sleep(25);
    }
    throw new Error('runtime did not settle for ' + label);
  };

  return {
    dom, w,
    requests: () => requests.map((r) => r.path),
    traces: () => traces.slice(),
    $,
    settled,
    setResponses(next) { served.length = 0; for (const r of next) served.push(r); },
  };
}

const chatTexts = (rt) =>
  [...rt.$('chat').querySelectorAll('article.message')].map((el) => ({
    role: el.querySelector('.role')?.textContent,
    body: el.querySelector('.body')?.textContent,
  }));

// ---- State 1: no prior install + invalid bootstrap ----------------------
{
  const rt = await boot({ responses: [{ status: 200, body: invalidSnapshot() }] });
  await rt.settled('invalid-initial');
  const hidden = rt.$('session').classList.contains('hidden');
  const articles = rt.$('chat').querySelectorAll('article.message').length;
  const conn = rt.$('conn').textContent;
  const gen = (rt.w.c0DebugState().generation);
  record('state1: session stays hidden on invalid initial bootstrap', hidden === true, `hidden=${hidden}`);
  assert.equal(hidden, true);
  record('state1: no session content rendered (0 message articles)', articles === 0, `articles=${articles}`);
  assert.equal(articles, 0);
  record('state1: offline snapshot-rejected connection label', conn === 'snapshot-rejected', conn);
  assert.equal(conn, 'snapshot-rejected');
  assert.equal(gen, '');
  assert.ok(rt.traces().some((t) => t.includes('snapshot-rejected-no-install')), 'bounded rejection trace expected');
  assert.ok(!rt.requests().some((p) => p !== '/glasses/v1/bootstrap' && p !== 'OPEN_STREAM'), 'only bootstrap calls');
  assert.ok(!rt.requests().includes('OPEN_STREAM'), 'no openStream in M1');
  rt.dom.window.close();
  record('state1: bounded rejection trace emitted (no partial install)', true);
}

// ---- State 2: valid install, then later invalid bootstrap keeps screen ----
{
  const v1 = validSnapshot({ generation: 'gen-v1', user: 'first-request', asst: 'first-answer' });
  const rt = await boot({ responses: [{ status: 200, body: v1 }, { status: 200, body: invalidSnapshot() }] });
  await rt.settled('valid-initial');
  const first = chatTexts(rt);
  assert.equal(first.length, 2);
  const firstSnapshot = JSON.stringify(first);
  const genV1 = rt.w.c0DebugState().generation;
  assert.equal(genV1, 'gen-v1');

  // Later invalid bootstrap through the app's own run() re-entry.
  rt.w.run();
  await sleep(120);
  const after = chatTexts(rt);
  record('state2: previous screen kept on later invalid bootstrap', JSON.stringify(after) === firstSnapshot, 'changed=' + (JSON.stringify(after) !== firstSnapshot));
  assert.equal(JSON.stringify(after), firstSnapshot);
  record('state2: generation remains the installed one', rt.w.c0DebugState().generation === 'gen-v1', rt.w.c0DebugState().generation);
  assert.equal(rt.w.c0DebugState().generation, 'gen-v1');
  record('state2: bounded keep-previous reject trace emitted', rt.traces().some((t) => t.includes('snapshot-rejected-keep-previous')), 'trace missing');
  assert.ok(rt.traces().some((t) => t.includes('snapshot-rejected-keep-previous')));
  assert.equal(rt.$('session').classList.contains('hidden'), false, 'session must remain visible');
  rt.dom.window.close();
}

// ---- State 3: valid replacement snapshot replaces state atomically --------
{
  const v1 = validSnapshot({ generation: 'gen-v1', user: 'first-request', asst: 'first-answer' });
  const v2 = validSnapshot({ generation: 'gen-v2', user: 'second-request', asst: 'second-answer' });
  const rt = await boot({ responses: [{ status: 200, body: v1 }, { status: 200, body: v2 }] });
  await rt.settled('valid-initial');
  assert.equal(chatTexts(rt).length, 2);

  rt.w.run();
  await sleep(120);
  const replaced = chatTexts(rt);
  record('state3: valid replacement replaces content (no append/partial)', JSON.stringify(replaced) === JSON.stringify([
    { role: 'you', body: 'second-request' },
    { role: 'assistant', body: 'second-answer' },
  ]), JSON.stringify(replaced));
  assert.deepEqual(replaced, [
    { role: 'you', body: 'second-request' },
    { role: 'assistant', body: 'second-answer' },
  ]);
  assert.equal(rt.w.c0DebugState().generation, 'gen-v2');
  assert.equal(rt.w.c0DebugState().lastSeq, 4);
  assert.equal(rt.$('asof').textContent, '4');
  assert.ok(!JSON.stringify(replaced).includes('first-request'), 'old content must be fully replaced');
  record('state3: exact-once render in a fresh runtime + atomic replacement', true);

  // ---- M1 read-only reachability on the same installed runtime -------------
  const composerHidden = rt.$('composer').classList.contains('hidden');
  const modeText = rt.$('mode').textContent;
  const wsv = rt.$('wsv').textContent;
  record('m1: composer hidden', composerHidden === true, `composerHidden=${composerHidden}`);
  assert.equal(composerHidden, true);
  record('m1: HUD in NAV (no Input mode reached)', modeText === 'NAV', modeText);
  assert.equal(modeText, 'NAV');
  record('m1: write state readonly', wsv.toLowerCase().includes('readonly'), wsv);
  assert.ok(wsv.toLowerCase().includes('readonly'));

  const paths = rt.requests();
  record('m1: no POST /draft/mutations', !paths.includes('/glasses/v1/draft/mutations'), JSON.stringify(paths));
  assert.ok(!paths.includes('/glasses/v1/draft/mutations'));
  record('m1: no POST /actions', !paths.includes('/glasses/v1/actions'), JSON.stringify(paths));
  assert.ok(!paths.includes('/glasses/v1/actions'));
  record('m1: no auto openStream', !paths.includes('OPEN_STREAM'), JSON.stringify(paths));
  assert.ok(!paths.includes('OPEN_STREAM'));

  // Semantic write controls are exhausted without entering Input/mutation.
  for (const name of ['send', 'paste', 'COMMAND', 'COMMAND_LONG', 'RIGHT', 'SECONDARY']) {
    rt.w.handleSemanticControl(name, 'test-bridge');
  }
  record('m1: write controls are read-only no-ops', rt.$('mode').textContent === 'NAV' && rt.$('composer').classList.contains('hidden'), 'mode=' + rt.$('mode').textContent);
  assert.equal(rt.$('mode').textContent, 'NAV');
  assert.equal(rt.$('composer').classList.contains('hidden'), true);
  rt.dom.window.close();
}

console.log('=== m1-render SUMMARY ===');
for (const r of RESULTS) console.log(`${r.verdict} ${r.name}`);
for (const r of RESULTS) console.log(`RESULT\t${JSON.stringify(r)}`);
const failed = RESULTS.filter((r) => r.verdict !== 'PASS');
if (failed.length) { console.log(`FAILED: ${failed.length}`); process.exit(1); }
console.log(`ALL PASS (${RESULTS.length} checks)`);
