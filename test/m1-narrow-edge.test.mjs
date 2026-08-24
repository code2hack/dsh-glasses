// T28-12: full real rc.2 -> plugin -> narrow proxy -> production app.js DOM.
// Requires an explicit unique disposable DSH_HOME outside ~/.dsh.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDisposableDshHome,
  assertPortSpawnable,
  ensureHome,
  httpReq,
  registerOwnedChild,
  sleep,
  spawnInstance,
  stopInstance,
  stopOwnedProcess,
  unregisterOwnedChild,
  waitForServer,
} from "../plugins/dsh-glasses-plugin/test/disposable-runtime.mjs";
import { validateSnapshotWire } from "../plugins/dsh-glasses-plugin/lib/snapshot.js";
import { bootClientDom, chatTexts } from "../apps/glasses-android/test/dom-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROXY_MAIN = resolve(HERE, "..", "dev", "glasses-dev-proxy.mjs");
const FIXTURE = resolve(HERE, "..", "plugins", "dsh-glasses-plugin", "test", "fixtures", "live-append-plugin");
const HOME = assertDisposableDshHome(process.env.DSH_HOME);
const DSH_PORT = Number(process.env.M1_TEST_PORT || 39331);
const PROXY_PORT = Number(process.env.M1_PROXY_PORT || 39332);
const TOKEN = `m1-narrow-${process.pid}-${Date.now()}`;
const FIXTURE_TOKEN = `m1-fixture-${process.pid}-${Date.now()}`;
const SESSION_A = `m1-narrow-a-${process.pid}-${Date.now()}`;
const SESSION_B = `m1-narrow-b-${process.pid}-${Date.now()}`;
const AUTH = { authorization: `Bearer ${TOKEN}` };
const FIXTURE_AUTH = { authorization: `Bearer ${FIXTURE_TOKEN}`, "content-type": "application/json" };
const TEXT = {
  oldUser: "M1-NARROW-OLD-USER-A",
  oldAssistant: "M1-NARROW-OLD-ASSISTANT-A",
  midUser: "M1-NARROW-MID-USER-A",
  midAssistant: "M1-NARROW-MID-ASSISTANT-A",
  recentUser: "M1-NARROW-RECENT-USER-A",
  recentAssistant: "M1-NARROW-RECENT-ASSISTANT-A",
  liveReading: "M1-NARROW-LIVE-READING-A",
  liveFollowing: "M1-NARROW-LIVE-FOLLOWING-A",
  foreign: "M1-NARROW-FOREIGN-B",
};

async function fixture(body) {
  const response = await httpReq({ port: DSH_PORT, method: "POST", path: "/__test/m1/append", headers: FIXTURE_AUTH, body });
  assert.equal(response.status, 200, response.text);
  return response.json;
}

async function append(sessionId, messageId, text, role = "assistant") {
  return fixture({ sessionId, messageId, text, role });
}

async function proxyJson(path, headers = AUTH) {
  const response = await httpReq({ port: PROXY_PORT, path, headers });
  assert.equal(response.status, 200, response.text);
  return response.json;
}

function openSse(snapshot, extraHeaders = {}) {
  const frames = [];
  const wake = [];
  let request;
  let response;
  const opened = new Promise((resolveOpen, rejectOpen) => {
    request = http.get({
      host: "127.0.0.1",
      port: PROXY_PORT,
      path: `/glasses/v1/stream?epoch=${encodeURIComponent(snapshot.connectionEpoch)}&baseStreamSequence=${snapshot.streamSequence}`,
      headers: { ...AUTH, ...extraHeaders },
    }, (res) => {
      response = res;
      if (res.statusCode !== 200) return rejectOpen(new Error(`SSE ${res.statusCode}`));
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
          const frame = { event: "message", id: "", dataText: "", data: null };
          for (const line of raw.split("\n")) {
            const split = line.indexOf(":");
            const field = split < 0 ? line : line.slice(0, split);
            const value = split < 0 ? "" : line.slice(split + 1).replace(/^ /, "");
            if (field === "event") frame.event = value;
            if (field === "id") frame.id = value;
            if (field === "data") frame.dataText = value;
          }
          try { frame.data = JSON.parse(frame.dataText); } catch {}
          frames.push(frame);
          for (const notify of wake.splice(0)) notify();
        }
      });
      resolveOpen();
    });
    request.on("error", rejectOpen);
  });
  async function next(event, after = 0, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = frames.slice(after).find((candidate) => candidate.event === event);
      if (frame) return frame;
      if (Date.now() >= deadline) throw new Error(`timeout waiting for ${event}: ${JSON.stringify(frames)}`);
      await new Promise((resolveWait) => {
        const timer = setTimeout(resolveWait, Math.min(100, deadline - Date.now()));
        wake.push(() => { clearTimeout(timer); resolveWait(); });
      });
    }
  }
  return { opened, frames, next, close() { response?.destroy(); request?.destroy(); } };
}

async function spawnProxy() {
  await assertPortSpawnable(PROXY_PORT);
  const proc = spawn(process.execPath, [PROXY_MAIN], {
    env: {
      ...process.env,
      GLASSES_UPSTREAM: `http://127.0.0.1:${DSH_PORT}`,
      GLASSES_PROXY_HOST: "127.0.0.1",
      GLASSES_PROXY_PORT: String(PROXY_PORT),
      GLASSES_TEST_FAULTS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  registerOwnedChild(proc.pid, { port: PROXY_PORT });
  proc.once("exit", () => unregisterOwnedChild(proc.pid));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`proxy exited ${proc.exitCode}`);
    try {
      const response = await httpReq({ port: PROXY_PORT, path: "/api/status" });
      if (response.status === 403) return proc;
    } catch {}
    await sleep(200);
  }
  throw new Error("proxy did not start");
}

function occurrences(rt, text) {
  return (rt.w.document.body.textContent || "").split(text).length - 1;
}

function sendFrame(rt, epoch, frame) {
  rt.w.glassesOnLine(epoch, frame.event, frame.dataText, frame.id);
}

let instance;
let proxy;
let live;
let recoveryStream;
try {
  await ensureHome(HOME, DSH_PORT, { fixturePluginRoot: FIXTURE, bootstrapMaxEvents: 50 });
  const workspaceA = join(HOME, "workspace-a");
  const workspaceB = join(HOME, "workspace-b");
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });
  const started = await spawnInstance({
    homeDir: HOME,
    port: DSH_PORT,
    sessionId: SESSION_A,
    token: TOKEN,
    extraEnv: { DSH_GLASSES_FIXTURE_TOKEN: FIXTURE_TOKEN },
  });
  instance = { proc: started.proc };
  await waitForServer({ port: DSH_PORT, proc: started.proc, logBuf: started.logBuf, token: TOKEN });
  await fixture({ action: "create", sessionId: SESSION_A, cwd: workspaceA });
  await fixture({ action: "create", sessionId: SESSION_B, cwd: workspaceB });

  const initial = [["old-u", TEXT.oldUser, "user"], ["old-a", TEXT.oldAssistant, "assistant"]];
  for (let i = 0; i < 46; i += 1) initial.push([`filler-${i}`, `M1-NARROW-FILLER-${i}`, i % 2 ? "assistant" : "user"]);
  initial.push(
    ["mid-u", TEXT.midUser, "user"], ["mid-a", TEXT.midAssistant, "assistant"],
    ["recent-u", TEXT.recentUser, "user"], ["recent-a", TEXT.recentAssistant, "assistant"],
  );
  for (const [id, text, role] of initial) await append(SESSION_A, `m1-${id}`, text, role);
  await append(SESSION_B, "m1-foreign", TEXT.foreign, "assistant");

  proxy = await spawnProxy();
  const first = await proxyJson("/glasses/v1/bootstrap");
  const wire = validateSnapshotWire(first, { expectedSessionId: SESSION_A });
  assert.equal(wire.ok, true, `${wire.code}: ${wire.message}`);
  assert.equal(first.attachments.length, 1);
  assert.equal(first.attachments[0].capabilities.liveUpdates, true);
  assert.ok(!JSON.stringify(first).includes(SESSION_B));
  assert.ok(!JSON.stringify(first).includes(TEXT.foreign));
  assert.ok(!JSON.stringify(first).includes(TEXT.oldUser), "old page must be outside bounded bootstrap");

  const beforeSeq = first.attachments[0].history.events[0].seq;
  const historyPath = `/glasses/v1/history?epoch=${encodeURIComponent(first.connectionEpoch)}&beforeSeq=${beforeSeq}&limit=50`;
  const older = await proxyJson(historyPath);
  assert.ok(JSON.stringify(older).includes(TEXT.oldUser));
  assert.ok(JSON.stringify(older).includes(TEXT.oldAssistant));

  live = openSse(first);
  await live.opened;
  const hello = await live.next("hello");
  let openedStream;
  const rt = await bootClientDom({
    session: SESSION_A,
    endpoint: `http://127.0.0.1:${PROXY_PORT}`,
    responseFor: ({ path }) => path === "/glasses/v1/bootstrap"
      ? { status: 200, body: first }
      : path.startsWith("/glasses/v1/history?") ? { status: 200, body: older } : null,
    onOpenStream: (request) => { openedStream = request; },
  });
  await rt.settled("real-narrow-bootstrap");
  assert.deepEqual({ epoch: openedStream.epoch, base: openedStream.baseStreamSequence }, { epoch: first.connectionEpoch, base: first.streamSequence });
  rt.w.glassesOnStream(first.connectionEpoch, "open", null);
  sendFrame(rt, first.connectionEpoch, hello);
  assert.equal(rt.w.c0DebugState().syncState, "ready");

  const chat = rt.$("chat");
  Object.defineProperty(chat, "scrollHeight", { configurable: true, get: () => 1000 });
  Object.defineProperty(chat, "clientHeight", { configurable: true, get: () => 200 });
  chat.scrollTop = 100;
  chat.dispatchEvent(new rt.w.Event("scroll"));
  assert.equal(rt.w.c0DebugState().presentationMode, "history-reading");
  const anchorBeforePage = rt.w.c0DebugState().anchor?.blockId;
  chat.scrollTop = 0;
  chat.dispatchEvent(new rt.w.Event("scroll"));
  assert.equal(occurrences(rt, TEXT.oldUser), 1, "real older page prepends once");
  assert.equal(rt.w.c0DebugState().anchor?.blockId, anchorBeforePage, "paging preserves anchor");
  assert.equal(rt.w.c0DebugState().unread, false, "paging does not set unread");

  const frameCount = live.frames.length;
  await append(SESSION_A, "m1-live-reading", TEXT.liveReading);
  const readingDelta = await live.next("projection", frameCount);
  sendFrame(rt, first.connectionEpoch, readingDelta);
  assert.equal(rt.w.c0DebugState().presentationMode, "history-reading");
  assert.equal(rt.w.c0DebugState().unread, true);
  assert.equal(rt.w.c0DebugState().anchor?.blockId, anchorBeforePage, "live append preserves reading anchor");
  assert.equal(occurrences(rt, TEXT.liveReading), 1);

  chat.scrollTop = 800;
  chat.dispatchEvent(new rt.w.Event("scroll"));
  assert.equal(rt.w.c0DebugState().presentationMode, "following");
  assert.equal(rt.w.c0DebugState().unread, false);
  const nextFrame = live.frames.length;
  await append(SESSION_A, "m1-live-following", TEXT.liveFollowing);
  const followingDelta = await live.next("projection", nextFrame);
  sendFrame(rt, first.connectionEpoch, followingDelta);
  assert.equal(rt.w.c0DebugState().presentationMode, "following");
  assert.equal(rt.w.c0DebugState().unread, false);
  assert.equal(chat.scrollTop, chat.scrollHeight, "following pins new output");
  assert.equal(occurrences(rt, TEXT.liveFollowing), 1);
  const debug = rt.w.c0DebugState();
  assert.equal(debug.connectionEpoch, first.connectionEpoch);
  assert.equal(debug.streamSequence, followingDelta.data.streamSequence);
  assert.equal(debug.historyAsOfSeq, followingDelta.data.event.seq);
  assert.equal(debug.writeEligible, false);
  assert.ok(!JSON.stringify(debug).includes(TOKEN), "debug state must not expose bearer token");
  assert.ok(!rt.requests().some((path) => path.includes("/draft/mutations") || path.includes("/actions")));
  rt.dom.window.close();
  live.close(); live = null;

  const faultBody = await proxyJson("/glasses/v1/bootstrap");
  const faultStream = openSse(faultBody, { "x-glasses-test-fault": "malformed-projection" });
  await faultStream.opened;
  const faultHello = await faultStream.next("hello");
  const malformed = await faultStream.next("projection");
  assert.equal(malformed.data, null, "proxy injected malformed JSON frame");
  faultStream.close();
  const recovery = await proxyJson("/glasses/v1/bootstrap");
  recoveryStream = openSse(recovery);
  await recoveryStream.opened;
  const recoveryHello = await recoveryStream.next("hello");

  const faultRt = await bootClientDom({ responses: [{ status: 200, body: faultBody }, { status: 200, body: recovery }], session: SESSION_A });
  await faultRt.settled("real-fault-bootstrap");
  faultRt.w.glassesOnStream(faultBody.connectionEpoch, "open", null);
  sendFrame(faultRt, faultBody.connectionEpoch, faultHello);
  const retainedFaultScreen = JSON.stringify(chatTexts(faultRt));
  sendFrame(faultRt, faultBody.connectionEpoch, malformed);
  assert.equal(faultRt.w.c0DebugState().syncState, "resyncing");
  assert.equal(faultRt.w.c0DebugState().writeEligible, false);
  assert.equal(JSON.stringify(chatTexts(faultRt)), retainedFaultScreen, "malformed proxy frame retains screen");
  await sleep(1150);
  assert.equal(faultRt.w.c0DebugState().connectionEpoch, recovery.connectionEpoch);
  assert.notEqual(recovery.connectionEpoch, faultBody.connectionEpoch);
  const reopened = faultRt.requestDetails().filter((request) => request.path === "OPEN_STREAM").at(-1);
  assert.deepEqual({ epoch: reopened.epoch, base: reopened.baseStreamSequence }, { epoch: recovery.connectionEpoch, base: recovery.streamSequence });
  faultRt.w.glassesOnStream(recovery.connectionEpoch, "open", null);
  sendFrame(faultRt, recovery.connectionEpoch, recoveryHello);
  assert.equal(faultRt.w.c0DebugState().syncState, "ready");
  assert.equal(occurrences(faultRt, TEXT.liveReading), 1);
  assert.equal(occurrences(faultRt, TEXT.liveFollowing), 1);
  sendFrame(faultRt, faultBody.connectionEpoch, malformed);
  assert.equal(faultRt.w.c0DebugState().syncState, "ready", "old epoch rejected after resync");
  faultRt.dom.window.close();

  const blockedFixture = await httpReq({ port: PROXY_PORT, method: "POST", path: "/__test/m1/append", headers: FIXTURE_AUTH, body: {} });
  assert.equal(blockedFixture.status, 403, "narrow proxy never exposes fixture route");
  for (const path of ["/api/status", "/api/session.list"]) assert.equal((await httpReq({ port: PROXY_PORT, path })).status, 403);
  assert.equal((await httpReq({ port: PROXY_PORT, path: "/glasses/v1/bootstrap" })).status, 401);
  assert.equal((await httpReq({ port: PROXY_PORT, method: "POST", path: "/glasses/v1/actions", headers: { ...AUTH, "content-type": "application/json" }, body: {} })).status, 404);
  console.log("m1-narrow-edge.test.mjs: PASS");
} finally {
  live?.close();
  recoveryStream?.close();
  if (proxy) await stopOwnedProcess(proxy.pid, PROXY_PORT);
  if (instance) await stopInstance(instance.proc, DSH_PORT);
  if (process.env.KEEP_HOME !== "1") await rm(HOME, { recursive: true, force: true });
}
