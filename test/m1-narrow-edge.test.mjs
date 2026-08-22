// T27-09: disposable real-rc.2 NARROW-EDGE end-to-end (M1 #27).
//
// Full chain against a REAL pinned rc.2 disposable DSH, completely behind the
// G0-only dev proxy:
//
//   real disposable DSH (rc.2 + worktree plugin)
//     -> real dev/glasses-dev-proxy.mjs (exposes ONLY /glasses/v1/*)
//     -> authenticated bootstrap
//     -> snapshot-core client staging
//     -> actual shipped client DOM render (jsdom 29.1.1)
//
// Two real disposable sessions A and B carry distinct synthetic sentinels. M1
// attaches exactly one (A, opaque identity); B's id/label/content and every
// stock DSH surface (/api/status, /api/session.list, /api/session.prompt)
// never cross the glasses edge. Write routes and unknown /glasses/v1/* paths
// are 404; unauthenticated bootstrap is 401. The real bootstrap body is
// validated by the frozen wire law, staged by snapshot-core, and rendered
// EXACTLY ONCE by the shipped client assets in a fresh disposable DOM.
//
// Run:
//   DSH_BIN=/path/to/dsh node test/m1-narrow-edge.test.mjs
// (M1_TEST_PORT and M1_PROXY_PORT overridable; KEEP_HOME=1 keeps the home.)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  ensureHome,
  spawnInstance,
  startInstance,
  waitForServer,
  stopInstance,
  createSession,
  seedSyntheticHistory,
  httpReq,
  registerOwnedChild,
  unregisterOwnedChild,
  stopOwnedProcess,
  assertPortSpawnable,
} from "../plugins/dsh-glasses-plugin/test/disposable-runtime.mjs";
import { syntheticUserEvent, syntheticAssistantEvent } from "../plugins/dsh-glasses-plugin/test/zstd-jsonl.mjs";
import { validateSnapshotWire, M1_BOOTSTRAP_MAX_EVENTS } from "../plugins/dsh-glasses-plugin/lib/snapshot.js";
import { bootClientDom, chatTexts, sleep } from "../apps/glasses-android/test/dom-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROXY_MAIN = resolve(HERE, "..", "dev", "glasses-dev-proxy.mjs");
const SNAPSHOT_CORE_ASSET = resolve(HERE, "..", "apps", "glasses-android", "app", "src", "main", "assets", "snapshot-core.js");
const C0_CORE_ASSET = resolve(HERE, "..", "apps", "glasses-android", "app", "src", "main", "assets", "c0-core.js");

const DSH_PORT = Number(process.env.M1_TEST_PORT || 3196);
const PROXY_PORT = Number(process.env.M1_PROXY_PORT || 3216);
const TOKEN = `dev-m1-ne-${process.pid.toString(36)}-${Date.now().toString(36)}`;
const HOME = join(tmpdir(), `dsh-glasses-m1-narrow-${process.pid}`);

const SENTINEL_A_U = "M1-SYNTHETIC-USER-A";
const SENTINEL_A_A = "M1-SYNTHETIC-ASSISTANT-A";
const SENTINEL_B_U = "M1-SYNTHETIC-USER-B";
const SENTINEL_B_A = "M1-SYNTHETIC-ASSISTANT-B";

function loadClientCores() {
  const context = { console };
  vm.runInNewContext(readFileSync(C0_CORE_ASSET, "utf8"), context, { filename: "c0-core.js" });
  vm.runInNewContext(readFileSync(SNAPSHOT_CORE_ASSET, "utf8"), context, { filename: "snapshot-core.js" });
  if (!context.GlassesSnapshotCore) throw new Error("GlassesSnapshotCore not installed");
  return context;
}

const results = [];
const ok = (name) => results.push(["PASS", name]);
const fail = (name, error) => { results.push(["FAIL", name]); console.error(`FAIL ${name}: ${error}`); };
const scenario = async (name, fn) => { try { await fn(); ok(name); } catch (e) { fail(name, e); } };

let seed = null;
let configured = null;
let proxy = null;
let realA = null;
let realB = null;

async function spawnProxy() {
  await assertPortSpawnable(PROXY_PORT);
  const proc = spawn(process.execPath, [PROXY_MAIN], {
    env: {
      ...process.env,
      GLASSES_UPSTREAM: `http://127.0.0.1:${DSH_PORT}`,
      GLASSES_PROXY_HOST: "127.0.0.1",
      GLASSES_PROXY_PORT: String(PROXY_PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  registerOwnedChild(proc.pid, { port: PROXY_PORT });
  proc.once("exit", () => unregisterOwnedChild(proc.pid));
  const deadline = Date.now() + 30000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`proxy exited ${proc.exitCode}`);
    try {
      const r = await httpReq({ port: PROXY_PORT, path: "/glasses/v1/bootstrap", headers: { authorization: `Bearer ${TOKEN}` } });
      if (r.json !== null && r.status !== 401) return proc;
    } catch {}
    if (Date.now() > deadline) throw new Error("proxy did not come up");
    await sleep(400);
  }
}

const auth = { authorization: `Bearer ${TOKEN}` };
const JSON_HEADERS = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

try {
  await ensureHome(HOME, DSH_PORT);

  const seedId = `seed-${process.pid.toString(36)}`;
  await scenario("narrow: disposable rc.2 instance boots with auth + reaches HTTP surface", async () => {
    seed = await spawnInstance({ homeDir: HOME, port: DSH_PORT, sessionId: seedId, token: TOKEN });
    await waitForServer({ port: DSH_PORT, proc: seed.proc, logBuf: seed.logBuf, token: TOKEN });
  });

  const dirA = join(HOME, "workspace-a");
  const dirB = join(HOME, "workspace-b");
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });

  await scenario("narrow: two REAL disposable sessions A and B created", async () => {
    realA = await createSession({ port: DSH_PORT, cwd: dirA, homeDir: HOME });
    realB = await createSession({ port: DSH_PORT, cwd: dirB, homeDir: HOME });
    if (!realA || !realB || realA === realB) throw new Error(`bad session ids A=${realA} B=${realB}`);
  });

  await stopInstance(seed.proc, DSH_PORT); seed = null;

  await scenario("narrow: distinct synthetic sentinels spliced into A and B logs", async () => {
    const tag = process.pid.toString(36);
    const idA = await seedSyntheticHistory(HOME, realA, [
      syntheticUserEvent({ id: `ne-a-u-${tag}`, text: SENTINEL_A_U, rpcId: `synth-a-${realA.slice(-6)}` }),
      syntheticAssistantEvent({ id: `ne-a-a-${tag}`, text: SENTINEL_A_A, provider: "synthetic", model: "harmless" }),
    ]);
    const idB = await seedSyntheticHistory(HOME, realB, [
      syntheticUserEvent({ id: `ne-b-u-${tag}`, text: SENTINEL_B_U, rpcId: `synth-b-${realB.slice(-6)}` }),
      syntheticAssistantEvent({ id: `ne-b-a-${tag}`, text: SENTINEL_B_A, provider: "synthetic", model: "harmless" }),
    ]);
    if (idA < 5 || idB < 5) throw new Error(`seeding did not advance seq (A=${idA} B=${idB})`);
  });

  await scenario("narrow: instance configured for session A", async () => {
    configured = await startInstance({ homeDir: HOME, port: DSH_PORT, sessionId: realA, token: TOKEN });
  });

  await scenario("narrow: G0-only dev proxy exposed in front of DSH", async () => {
    proxy = await spawnProxy();
  });

  let realBody = null;
  await scenario("narrow: authenticated bootstrap through proxy: exactly one A attachment, B never crosses the edge", async () => {
    const r = await httpReq({ port: PROXY_PORT, path: "/glasses/v1/bootstrap", headers: auth });
    if (r.status !== 200) throw new Error(`proxy bootstrap ${r.status}: ${r.text}`);
    if (Object.hasOwn(r.json, "ok")) throw new Error("canonical snapshot must not carry an ok envelope");
    const atts = r.json.attachments || [];
    if (atts.length !== 1) throw new Error(`expected exactly one attachment (got ${atts.length})`);
    const a0 = atts[0];
    if (a0.sessionId !== realA) throw new Error(`attached session ${a0.sessionId} != ${realA}`);
    if (a0.attachmentId === realA || a0.attachmentId.includes(realA) || a0.attachmentId.includes(r.json.serverGeneration)) {
      throw new Error("attachmentId must be opaque and independent of sessionId/serverGeneration");
    }
    const flat = JSON.stringify(r.json);
    if (flat.includes(realB)) throw new Error("session B id must never cross the glasses edge");
    for (const b of [SENTINEL_B_U, SENTINEL_B_A]) {
      if (flat.includes(b)) throw new Error(`B sentinel ${b} must never cross the glasses edge`);
    }
    for (const a of [SENTINEL_A_U, SENTINEL_A_A]) {
      if (!flat.includes(a)) throw new Error(`A sentinel ${a} missing in bootstrap`);
    }
    realBody = r.json;
  });

  await scenario("narrow: one attachment only + A-only content renders exactly once in the projection", async () => {
    const a0 = realBody.attachments[0];
    const events = a0.history?.events || [];
    if (!events.length || events.length > M1_BOOTSTRAP_MAX_EVENTS) throw new Error(`history out of bound: ${events.length}`);
    if (a0.history.asOfSeq !== a0.history.events[events.length - 1]?.seq) throw new Error("last event seq must equal asOfSeq");
    if (realBody.streamSequence !== a0.history.asOfSeq) throw new Error("streamSequence must equal history.asOfSeq");
    const counts = {};
    for (const ev of events) {
      const t = ev.message?.text;
      if (t) counts[t] = (counts[t] || 0) + 1;
    }
    if (counts[SENTINEL_A_U] !== 1 || counts[SENTINEL_A_A] !== 1) {
      throw new Error(`A sentinel must appear exactly once each: ${JSON.stringify(counts)}`);
    }
    if (counts[SENTINEL_B_U] || counts[SENTINEL_B_A]) throw new Error("B sentinel leaked into A projection");
    if (a0.attachmentGeneration !== 1 || realBody.attachmentSetRevision !== 1) throw new Error("M1 revision fields must be 1");
    if (!Array.isArray(realBody.drafts) || realBody.drafts.length !== 0) throw new Error("drafts must be []");
    const caps = a0.capabilities || {};
    for (const key of ["liveUpdates", "draftMutations", "send", "steer", "interrupt", "resolveRequest"]) {
      if (caps[key] !== false) throw new Error(`capability ${key} must be false`);
    }
    if (caps.historyRead !== true) throw new Error("historyRead must be true");
    if (!["idle", "running", "waiting-user", "unavailable", "unknown"].includes(a0.state)) throw new Error(`bad agent state ${a0.state}`);
    if (a0.agent?.state !== a0.state) throw new Error("agent.state must equal attachment.state");
    const law = validateSnapshotWire(realBody, { expectedSessionId: realA });
    if (!law.ok) throw new Error(`real bootstrap violates frozen wire law: ${law.code}: ${law.message}`);
  });

  await scenario("narrow: fresh connectionEpoch + stable attachment identity through the proxy", async () => {
    const r2 = await httpReq({ port: PROXY_PORT, path: "/glasses/v1/bootstrap", headers: auth });
    if (r2.status !== 200) throw new Error(`second bootstrap ${r2.status}`);
    if (realBody.connectionEpoch === r2.json.connectionEpoch) throw new Error("connectionEpoch must be fresh per bootstrap");
    if (realBody.serverGeneration !== r2.json.serverGeneration) throw new Error("serverGeneration must be stable per process");
    if (realBody.attachments[0].attachmentId !== r2.json.attachments[0].attachmentId) throw new Error("attachmentId must be stable");
  });

  await scenario("narrow: negatives — stock DSH 403, write/unknown 404, unauth 401 (all through proxy)", async () => {
    const status = await httpReq({ port: PROXY_PORT, path: "/api/status" });
    if (status.status !== 403) throw new Error(`/api/status ${status.status} (wanted 403)`);
    const lst = await httpReq({ port: PROXY_PORT, path: "/api/session.list" });
    if (lst.status !== 403) throw new Error(`/api/session.list ${lst.status} (wanted 403)`);
    const prm = await httpReq({ port: PROXY_PORT, method: "POST", path: "/api/session.prompt", headers: JSON_HEADERS, body: { text: "hi" } });
    if (prm.status !== 403) throw new Error(`/api/session.prompt ${prm.status} (wanted 403)`);
    const mut = await httpReq({ port: PROXY_PORT, method: "POST", path: "/glasses/v1/draft/mutations", headers: JSON_HEADERS, body: { operationId: "x", expectedRevision: 0, mutation: { kind: "replace", text: "hi" } } });
    if (mut.status !== 404) throw new Error(`/glasses/v1/draft/mutations ${mut.status} (wanted 404)`);
    const act = await httpReq({ port: PROXY_PORT, method: "POST", path: "/glasses/v1/actions", headers: JSON_HEADERS, body: { kind: "send", operationId: "x", draftRevision: 0 } });
    if (act.status !== 404) throw new Error(`/glasses/v1/actions ${act.status} (wanted 404)`);
    const unk = await httpReq({ port: PROXY_PORT, path: "/glasses/v1/nonexistent", headers: auth });
    if (unk.status !== 404) throw new Error(`/glasses/v1/nonexistent ${unk.status} (wanted 404)`);
    const una = await httpReq({ port: PROXY_PORT, path: "/glasses/v1/bootstrap" });
    if (una.status !== 401) throw new Error(`unauthenticated bootstrap ${una.status} (wanted 401)`);
  });

  await scenario("narrow: real bootstrap is accepted by snapshot-core for A and rejected for B", async () => {
    const ctx = loadClientCores();
    const stagedA = ctx.GlassesSnapshotCore.stageSnapshot(realBody, { expectedSessionId: realA });
    if (!stagedA.ok) throw new Error(`stage for A rejected: ${JSON.stringify(stagedA)}`);
    if (stagedA.snapshot.attachment.sessionId !== realA) throw new Error("staged attachment must carry session A");
    const stagedItems = ctx.C0Core.conversationItems(stagedA.snapshot.conversation);
    if (stagedItems.length !== 2) throw new Error(`expected 2 staged items, got ${stagedItems.length}`);
    const stagedB = ctx.GlassesSnapshotCore.stageSnapshot(realBody, { expectedSessionId: realB });
    if (stagedB.ok || stagedB.code !== "wrong-sessionId") throw new Error(`stage for B must reject wrong-sessionId: ${JSON.stringify(stagedB)}`);
  });

  await scenario("narrow: real bootstrap renders exactly once in the shipped client DOM assets", async () => {
    const rt = await bootClientDom({ responses: [{ status: 200, body: realBody }], session: realA });
    await rt.settled("narrow-real-render");
    const items = chatTexts(rt);
    if (items.length !== 2) throw new Error(`expected 2 rendered articles, got ${items.length}`);
    if (items[0].role !== "you" || items[0].body !== SENTINEL_A_U) throw new Error("user A sentinel not rendered as you");
    if (items[1].role !== "assistant" || items[1].body !== SENTINEL_A_A) throw new Error("assistant A sentinel not rendered");
    const docText = rt.w.document.body.textContent || "";
    const occurrences = (s) => docText.split(s).length - 1;
    if (occurrences(SENTINEL_A_U) !== 1 || occurrences(SENTINEL_A_A) !== 1) throw new Error(`A sentinel must render exactly once (u=${occurrences(SENTINEL_A_U)} a=${occurrences(SENTINEL_A_A)})`);
    for (const b of [SENTINEL_B_U, SENTINEL_B_A, realB]) {
      if (docText.includes(b)) throw new Error(`B surface ${b} leaked into rendered DOM`);
    }
    const state = rt.w.c0DebugState();
    if (state.installed !== true) throw new Error("client must be installed");
    if (state.generation !== realBody.serverGeneration) throw new Error("client generation must adopt the bootstrap generation");
    if (rt.$("composer").classList.contains("hidden") !== true) throw new Error("composer must stay hidden");
    if (rt.$("mode").textContent !== "NAV") throw new Error("HUD must stay NAV");
    if (!rt.$("wsv").textContent.toLowerCase().includes("readonly")) throw new Error("write state must be readonly");
    const paths = rt.requests();
    for (const bad of ["/glasses/v1/draft/mutations", "/glasses/v1/actions", "OPEN_STREAM"]) {
      if (paths.includes(bad)) throw new Error(`write/live path ${bad} must not be called`);
    }
    rt.dom.window.close();
  });
} catch (error) {
  fail("narrow: fatal", error?.stack || error);
} finally {
  if (proxy) await stopOwnedProcess(proxy.pid, PROXY_PORT);
  if (configured) await stopInstance(configured.proc, DSH_PORT);
  if (seed) await stopInstance(seed.proc, DSH_PORT);
  if (process.env.KEEP_HOME !== "1") await rm(HOME, { recursive: true, force: true }).catch(() => {});
}

console.log("\n=== m1-narrow-edge SUMMARY ===");
for (const [r, n] of results) console.log(`${r} ${n}`);
const failed = results.filter(([r]) => r === "FAIL");
if (failed.length) { console.log(`FAILED: ${failed.length}`); process.exit(1); }
console.log(`ALL PASS (${results.length} checks)`);
process.exit(0);
