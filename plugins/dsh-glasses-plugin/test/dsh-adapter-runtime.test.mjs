// T27-02 runtime proof: the project-owned adapter (lib/dsh-adapter.js) exercised
// against a REAL disposable pinned rc.2 runtime with the worktree plugin loaded.
//
// This is a SUPERSET gate over the mock-ctx unit suite (dsh-adapter.test.mjs):
// the same adapter seam calls must succeed against an actual supported DSH
// process, and the resulting projection must remain canonical even though a
// real runtime produced it. Synthetic durable content is spliced into the real
// session log (zstd-JSONL, the same container DSH writes), then cold-read
// through the real runtime + real adapter — no vLLM, no device.
//
// Run:
//   DSH_BIN=/home/code2hack/.npm-global/bin/dsh node plugins/dsh-glasses-plugin/test/dsh-adapter-runtime.test.mjs

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import {
  ensureHome,
  spawnInstance,
  startInstance,
  waitForServer,
  stopInstance,
  createSession,
  seedSyntheticHistory,
  httpReq,
} from "./disposable-runtime.mjs";
import { syntheticUserEvent, syntheticAssistantEvent } from "./zstd-jsonl.mjs";
import { validateSnapshotWire } from "../lib/snapshot.js";

// Open the SSE stream with auth, read until the hello frame, then disconnect.
// This exercises the production stream seam which now subscribes through
// adapter.observeSession (SPEC §5 isolation) against the real runtime.
function openStreamUntilHello(port, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/glasses/v1/stream", headers: { authorization: `Bearer ${token}` } },
      (res) => {
        let buf = "";
        const timer = setTimeout(() => { req.destroy(); reject(new Error("stream hello timeout")); }, 8000);
        res.on("data", (chunk) => {
          buf += chunk.toString();
          if (buf.includes("event: hello") && buf.includes('"protocolMajor":1')) {
            clearTimeout(timer);
            req.destroy();
            resolve(buf);
          }
        });
        res.on("error", (e) => { clearTimeout(timer); reject(e); });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const PORT = Number(process.env.M1_TEST_PORT || 3191);
const TOKEN = `dev-m1-${process.pid.toString(36)}-${Date.now().toString(36)}`;
const HOME = join(tmpdir(), `dsh-glasses-m1-adapter-${process.pid}`);

const results = [];
const ok = (name) => results.push(["PASS", name]);
const fail = (name, error) => { results.push(["FAIL", name]); console.error(`FAIL ${name}: ${error}`); };
const scenario = async (name, fn) => { try { await fn(); ok(name); } catch (e) { fail(name, e); } };

let seed = null;
let configured = null;
const sessionA = `session-a-${process.pid.toString(36)}-${Date.now().toString(36)}`;
// DSH assigns its own sessionId on create; the configured one must equal what
// session.create returns, so we create-then-restart with the real returned id.

try {
  // spawnInstance -> assertPortSpawnable fails deterministically (test-port-in-use)
  // when a NON-harness process holds :PORT; we never kill a stranger's process.
  await ensureHome(HOME, PORT);
  const seedId = `seed-${process.pid.toString(36)}`;

  await scenario("adapter-runtime: dispose instance boots with auth + reaches HTTP surface", async () => {
    seed = await spawnInstance({ homeDir: HOME, port: PORT, sessionId: seedId, token: TOKEN });
    await waitForServer({ port: PORT, proc: seed.proc, logBuf: seed.logBuf, token: TOKEN });
  });

  // Create a real session A (no LLM needed: agentPreset minimal).
  const dirA = join(HOME, "workspace-a");
  await mkdir(dirA, { recursive: true });
  const realA = await createSession({ port: PORT, cwd: dirA, homeDir: HOME });
  // DSH may return a different id than our placeholder when created; bind it.
  if (typeof realA !== "string" || !realA.startsWith("session-")) throw new Error(`unexpected session id ${realA}`);

  await stopInstance(seed.proc, PORT); seed = null;

  await scenario("adapter-runtime: seed real synthetic durable events into session log", async () => {
    // Splice the SAME container DSH writes; next seq is derived from the tail.
    const nextTag = `A-u-${process.pid.toString(36)}`;
    const nextId = await seedSyntheticHistory(HOME, realA, [
      syntheticUserEvent({ id: `m1su-${nextTag}`, text: "M1-SYNTHETIC-USER-A", rpcId: `synth-user-${realA.slice(-6)}` }),
      syntheticAssistantEvent({ id: `m1sa-${nextTag}`, text: "M1-SYNTHETIC-ASSISTANT-A", provider: "synthetic", model: "harmless" }),
    ]);
    if (nextId < 5) throw new Error(`seeding did not advance seq (got ${nextId})`);
  });

  await scenario("adapter-runtime: authenticated bootstrap serves canonical M1 snapshot of the real session", async () => {
    configured = await startInstance({ homeDir: HOME, port: PORT, sessionId: realA, token: TOKEN });
    const r = await httpReq({ port: PORT, path: "/glasses/v1/bootstrap", headers: { authorization: `Bearer ${TOKEN}` } });
    if (r.status !== 200) throw new Error(`bootstrap ${r.status}: ${r.text}`);
    const body = r.json;
    const attachments = body.attachments;
    if (!Array.isArray(attachments) || attachments.length !== 1) throw new Error(`expected exactly one attachment (got ${JSON.stringify(attachments)})`);
    if (attachments[0].sessionId !== realA) throw new Error(`attached session ${attachments[0].sessionId} != ${realA}`);
    if (attachments[0].attachmentId === realA || attachments[0].attachmentId.includes(realA)) throw new Error("attachmentId must be opaque, not encoding sessionId");
    if (body.connectionEpoch && typeof body.connectionEpoch !== "string" && !body.connectionEpoch) throw new Error("connectionEpoch missing");
    const events = attachments[0].history?.events;
    if (!Array.isArray(events) || !events.length) throw new Error("no canonical events");
    if (body.streamSequence !== attachments[0].history.asOfSeq) throw new Error("streamSequence must equal history.asOfSeq");
    // strictly increasing unique seq, within asOfSeq
    let prev = -1;
    for (const ev of events) {
      if (!Number.isInteger(ev.seq) || ev.seq <= prev) throw new Error(`non-monotonic/dup seq ${ev.seq}`);
      if (ev.seq > attachments[0].history.asOfSeq) throw new Error(`event seq ${ev.seq} > asOfSeq`);
      prev = ev.seq;
    }
    const texts = events.flatMap((e) => (Array.isArray(e.blocks) ? e.blocks.filter((b) => b.kind === "text").map((b) => b.text) : []));
    if (!texts.some((t) => typeof t === "string" && t.includes("M1-SYNTHETIC-USER-A"))) throw new Error("synthetic user sentinel missing from real-runtime projection");
    if (!texts.some((t) => typeof t === "string" && t.includes("M1-SYNTHETIC-ASSISTANT-A"))) throw new Error("synthetic assistant sentinel missing from real-runtime projection");
    // agent projection agrees with attachment; state in SPEC vocabulary
    const state = attachments[0].state;
    if (!["idle", "running", "waiting-user", "unavailable", "unknown"].includes(state)) throw new Error(`bad agent state ${state}`);
    if (attachments[0].agent?.state !== state) throw new Error("agent.state must equal attachment.state");
    if (attachments[0].agent?.serverGeneration !== body.serverGeneration || attachments[0].history.serverGeneration !== body.serverGeneration) throw new Error("generation agreement broken (serverGeneration)");
    if (attachments[0].agent?.attachmentGeneration !== attachments[0].attachmentGeneration || attachments[0].history.attachmentGeneration !== attachments[0].attachmentGeneration) throw new Error("generation agreement broken (attachmentGeneration)");
    // drafts empty + all write capabilities false (AC5)
    if (!Array.isArray(body.drafts) || body.drafts.length !== 0) throw new Error("drafts must be []");
    const caps = attachments[0].capabilities || {};
    for (const key of ["liveUpdates", "draftMutations", "send", "steer", "interrupt", "resolveRequest"]) {
      if (caps[key] !== false) throw new Error(`capability ${key} must be false in M1`);
    }
    if (caps.historyRead !== true) throw new Error("historyRead must be true");
  });

  await scenario("adapter-runtime: fresh connectionEpoch, stable attachmentId+serverGeneration, wire law satisfied on real output", async () => {
    const r1 = await httpReq({ port: PORT, path: "/glasses/v1/bootstrap", headers: { authorization: `Bearer ${TOKEN}` } });
    const r2 = await httpReq({ port: PORT, path: "/glasses/v1/bootstrap", headers: { authorization: `Bearer ${TOKEN}` } });
    if (r1.status !== 200 || r2.status !== 200) throw new Error(`bootstrap status ${r1.status}/${r2.status}`);
    if (typeof r1.json.connectionEpoch !== "string" || !r1.json.connectionEpoch) throw new Error("connectionEpoch missing");
    if (r1.json.connectionEpoch === r2.json.connectionEpoch) throw new Error("connectionEpoch must be fresh per bootstrap");
    if (r1.json.serverGeneration !== r2.json.serverGeneration) throw new Error("serverGeneration must be stable per process");
    if (r1.json.attachments?.[0]?.attachmentId !== r2.json.attachments?.[0]?.attachmentId) throw new Error("attachmentId must be stable across bootstraps of one attachment lifetime");
    if (Object.hasOwn(r1.json, "ok")) throw new Error("canonical snapshot must not carry an ok envelope");
    const att = r1.json.attachments[0];
    if (att.attachmentId === r1.json.serverGeneration || att.attachmentId.includes(r1.json.serverGeneration)) throw new Error("attachmentId must be independent of serverGeneration");
    // The frozen wire law accepts the REAL runtime output as-is.
    const law = validateSnapshotWire(r1.json, { expectedSessionId: realA });
    if (!law.ok) throw new Error(`real bootstrap violates frozen wire law: ${law.code}: ${law.message}`);
    if (law.ok && validateSnapshotWire(r2.json, { expectedSessionId: realA }).ok !== true) throw new Error("second bootstrap violates frozen wire law");
  });

  await scenario("adapter-runtime: M1 write routes quarantined (404) and no draft/writeState leak", async () => {
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const m = await httpReq({ port: PORT, method: "POST", path: "/glasses/v1/draft/mutations", headers, body: { operationId: "x", expectedRevision: 0, mutation: { kind: "replace", text: "hi" } } });
    if (m.status !== 404) throw new Error(`draft/mutations not quarantined: ${m.status}`);
    const a = await httpReq({ port: PORT, method: "POST", path: "/glasses/v1/actions", headers, body: { kind: "send", operationId: "x", draftRevision: 0 } });
    if (a.status !== 404) throw new Error(`actions not quarantined: ${a.status}`);
    const u = await httpReq({ port: PORT, path: "/glasses/v1/nonexistent", headers: { authorization: `Bearer ${TOKEN}` } });
    if (u.status !== 404) throw new Error(`unknown /glasses/v1 path not 404: ${u.status}`);
    const b = await httpReq({ port: PORT, path: "/glasses/v1/bootstrap", headers: { authorization: `Bearer ${TOKEN}` } });
    if ("draft" in (b.json || {}) || "writeState" in (b.json || {})) throw new Error("TB0 draft/writeState leaked into M1 bootstrap");
  });

  await scenario("adapter-runtime: unauthenticated bootstrap is rejected", async () => {
    const r = await httpReq({ port: PORT, path: "/glasses/v1/bootstrap" });
    if (r.status !== 401) throw new Error(`bootstrap unauth ${r.status} (wanted 401)`);
  });

  await scenario("adapter-runtime: stream seam (adapter.observeSession) opens authenticated against the real runtime", async () => {
    const hello = await openStreamUntilHello(PORT, TOKEN);
    if (!hello.includes("event: hello") || !hello.includes('"protocolMajor":1')) {
      throw new Error(`stream hello missing protocolMajor: ${JSON.stringify(hello).slice(0, 200)}`);
    }
  });
} catch (error) {
  fail("dsh-adapter-runtime.fatal", error?.stack || error);
} finally {
  if (configured) await stopInstance(configured.proc, PORT);
  if (seed) await stopInstance(seed.proc, PORT);
  if (process.env.KEEP_HOME !== "1") await rm(HOME, { recursive: true, force: true }).catch(() => {});
}

console.log("\n=== dsh-adapter-runtime SUMMARY ===");
for (const [r, n] of results) console.log(`${r} ${n}`);
const failed = results.filter(([r]) => r === "FAIL");
if (failed.length) { console.log(`FAILED: ${failed.length}`); process.exit(1); }
console.log(`ALL PASS (${results.length} checks)`);
process.exit(0);
