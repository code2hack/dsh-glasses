// T28-11: real pinned rc.2 durable/live/disconnect/restart integration.
// Requires an explicit unique disposable DSH_HOME outside ~/.dsh.
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  assertDisposableDshHome,
  ensureHome,
  httpReq,
  sleep,
  spawnInstance,
  startInstance,
  stopInstance,
  waitForServer,
} from "./disposable-runtime.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "live-append-plugin");
const ASSETS = resolve(HERE, "../../../apps/glasses-android/app/src/main/assets");
const HOME = assertDisposableDshHome(process.env.DSH_HOME);
const PORT = Number(process.env.M1_TEST_PORT || 39321);
const TOKEN = `m1-live-${process.pid.toString(36)}-${Date.now().toString(36)}`;
const FIXTURE_TOKEN = `fixture-${process.pid.toString(36)}-${Date.now().toString(36)}`;
const SENTINEL_1 = "M1-LIVE-FINAL-SENTINEL-ONE";
const SENTINEL_2 = "M1-LIVE-FINAL-SENTINEL-TWO";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const FIXTURE_AUTH = { authorization: `Bearer ${FIXTURE_TOKEN}`, "content-type": "application/json" };

function clientCores() {
  const context = { console };
  vm.runInNewContext(readFileSync(join(ASSETS, "c0-core.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(ASSETS, "snapshot-core.js"), "utf8"), context);
  return context;
}

function stageInstall(cores, state, body, sessionId) {
  const staged = cores.GlassesSnapshotCore.stageSnapshot(body, { expectedSessionId: sessionId });
  assert.equal(staged.ok, true, `snapshot stages: ${staged.code || "ok"}`);
  const installed = cores.C0Core.installCompleteSnapshot(state, staged.snapshot);
  assert.equal(installed.ok, true, `snapshot installs: ${installed.code || "ok"}`);
  return staged.snapshot;
}

function openSse({ epoch, base }) {
  const frames = [];
  const waiters = [];
  let response;
  let request;
  const opened = new Promise((resolveOpen, rejectOpen) => {
    request = http.get({
      host: "127.0.0.1",
      port: PORT,
      path: `/glasses/v1/stream?epoch=${encodeURIComponent(epoch)}&baseStreamSequence=${base}`,
      headers: AUTH,
    }, (res) => {
      response = res;
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => rejectOpen(new Error(`SSE ${res.statusCode}: ${Buffer.concat(chunks)}`)));
        return;
      }
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk.replaceAll("\r\n", "\n");
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary < 0) break;
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (!raw || raw.startsWith(":")) continue;
          const frame = { event: "message", id: "", data: null };
          for (const line of raw.split("\n")) {
            const split = line.indexOf(":");
            const field = split < 0 ? line : line.slice(0, split);
            const value = split < 0 ? "" : line.slice(split + 1).replace(/^ /, "");
            if (field === "event") frame.event = value;
            if (field === "id") frame.id = value;
            if (field === "data") frame.data = JSON.parse(value);
          }
          frames.push(frame);
          for (const waiter of waiters.splice(0)) waiter();
        }
      });
      resolveOpen();
    });
    request.on("error", rejectOpen);
  });
  const next = async (event, after = 0, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = frames.slice(after).find((frame) => frame.event === event);
      if (match) return match;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for SSE ${event}; frames=${JSON.stringify(frames)}`);
      await new Promise((resolveWait) => {
        const timer = setTimeout(resolveWait, Math.min(100, deadline - Date.now()));
        waiters.push(() => { clearTimeout(timer); resolveWait(); });
      });
    }
  };
  return {
    opened,
    frames,
    next,
    close() { response?.destroy(); request?.destroy(); },
  };
}

async function bootstrap() {
  const response = await httpReq({ port: PORT, path: "/glasses/v1/bootstrap", headers: AUTH });
  assert.equal(response.status, 200, response.text);
  return response.json;
}

async function append(sessionId, messageId, text) {
  const response = await httpReq({
    port: PORT,
    method: "POST",
    path: "/__test/m1/append",
    headers: FIXTURE_AUTH,
    body: { sessionId, messageId, text },
  });
  assert.equal(response.status, 200, response.text);
  return response.json.seq;
}

async function createLiveSession(sessionId, cwd) {
  const response = await httpReq({
    port: PORT,
    method: "POST",
    path: "/__test/m1/append",
    headers: FIXTURE_AUTH,
    body: { action: "create", sessionId, cwd },
  });
  assert.equal(response.status, 200, response.text);
}

function sentinelEvidence(body, sentinel) {
  const hits = [];
  for (const event of body.attachments[0].history.events) {
    for (const block of event.blocks || []) if (block.text === sentinel) hits.push({ seq: event.seq, blockId: block.blockId });
  }
  return hits;
}

let instance;
let stream1;
let stream2;
let stream3;
try {
  await ensureHome(HOME, PORT, { fixturePluginRoot: FIXTURE });
  const workspace = join(HOME, "workspace");
  await mkdir(workspace, { recursive: true });
  const env = { DSH_GLASSES_FIXTURE_TOKEN: FIXTURE_TOKEN };
  const sessionId = `m1-live-session-${process.pid}-${Date.now()}`;
  const started = await spawnInstance({ homeDir: HOME, port: PORT, sessionId, token: TOKEN, extraEnv: env });
  instance = { proc: started.proc };
  await waitForServer({ port: PORT, proc: started.proc, logBuf: started.logBuf, token: TOKEN });
  await createLiveSession(sessionId, workspace);
  const cores = clientCores();
  const state = cores.C0Core.createSyncState();

  const first = await bootstrap();
  stageInstall(cores, state, first, sessionId);
  stream1 = openSse({ epoch: first.connectionEpoch, base: first.streamSequence });
  await stream1.opened;
  const hello1 = await stream1.next("hello");
  assert.equal(cores.C0Core.acceptStreamHello(state, hello1.data).ok, true);

  const seq1 = await append(sessionId, "m1-live-final-one", SENTINEL_1);
  const live1 = await stream1.next("projection");
  assert.equal(live1.data.event.seq, seq1, "real session/event reaches SSE");
  assert.equal(cores.C0Core.applyStreamDelta(state, live1.data).ok, true, "real live delta installs");
  const liveItems = cores.C0Core.conversationItems(state.conversation);
  assert.equal(liveItems.filter((item) => JSON.stringify(item).includes(SENTINEL_1)).length, 1, `live sentinel installed exactly once: delta=${JSON.stringify(live1.data)} items=${JSON.stringify(liveItems)}`);

  const retained = JSON.stringify(cores.C0Core.conversationItems(state.conversation));
  stream1.close(); stream1 = null;
  cores.C0Core.markResyncRequired(state, "real-disconnect");
  assert.equal(state.syncState, "resyncing");
  assert.equal(state.writeEligible, false);
  assert.equal(JSON.stringify(cores.C0Core.conversationItems(state.conversation)), retained, "disconnect retains screen");

  const second = await bootstrap();
  assert.notEqual(second.connectionEpoch, first.connectionEpoch, "disconnect recovery gets fresh epoch");
  stageInstall(cores, state, second, sessionId);
  assert.equal(sentinelEvidence(second, SENTINEL_1).length, 1, "reconnect snapshot restores first sentinel once");
  stream2 = openSse({ epoch: second.connectionEpoch, base: second.streamSequence });
  await stream2.opened;
  const hello2 = await stream2.next("hello");
  assert.equal(cores.C0Core.acceptStreamHello(state, hello2.data).ok, true);
  await sleep(250);
  assert.equal(stream2.frames.filter((frame) => frame.event === "projection").length, 0, "reconnect does not replay committed semantics");

  const seq2 = await append(sessionId, "m1-live-final-two", SENTINEL_2);
  const live2 = await stream2.next("projection");
  assert.equal(live2.data.event.seq, seq2);
  assert.equal(cores.C0Core.applyStreamDelta(state, live2.data).ok, true, "live resumes after reconnect");
  stream2.close(); stream2 = null;

  await stopInstance(instance.proc, PORT); instance = null;
  instance = await startInstance({ homeDir: HOME, port: PORT, sessionId, token: TOKEN, extraEnv: env });
  const third = await bootstrap();
  assert.notEqual(third.connectionEpoch, second.connectionEpoch, "process restart gets fresh epoch");
  assert.notEqual(third.serverGeneration, second.serverGeneration, "process restart gets fresh generation");
  for (const sentinel of [SENTINEL_1, SENTINEL_2]) {
    const hits = sentinelEvidence(third, sentinel);
    assert.equal(hits.length, 1, `${sentinel}: durable source installed once after restart`);
    assert.equal(new Set(hits.map((hit) => hit.blockId)).size, 1, `${sentinel}: stableBlockIdCount==1`);
  }
  assert.equal(new Set(third.attachments[0].history.events.map((event) => event.seq)).size, third.attachments[0].history.events.length, "durable source seqs unique");

  const freshState = cores.C0Core.createSyncState();
  stageInstall(cores, freshState, third, sessionId);
  const freshItems = JSON.stringify(cores.C0Core.conversationItems(freshState.conversation));
  assert.equal(freshItems.split(SENTINEL_1).length - 1, 1, "fresh client reconstructs sentinel one once");
  assert.equal(freshItems.split(SENTINEL_2).length - 1, 1, "fresh client reconstructs sentinel two once");
  stream3 = openSse({ epoch: third.connectionEpoch, base: third.streamSequence });
  await stream3.opened;
  const hello3 = await stream3.next("hello");
  assert.equal(cores.C0Core.acceptStreamHello(freshState, hello3.data).ok, true);
  await sleep(250);
  assert.equal(stream3.frames.filter((frame) => frame.event === "projection").length, 0, "restart does not blindly replay semantic operations");

  console.log("m1-live-runtime.test.mjs: PASS");
} finally {
  stream1?.close();
  stream2?.close();
  stream3?.close();
  if (instance) await stopInstance(instance.proc, PORT);
  if (process.env.KEEP_HOME !== "1") await rm(HOME, { recursive: true, force: true });
}
