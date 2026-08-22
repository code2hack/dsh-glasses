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

  await scenario("adapter-runtime: authenticated bootstrap serves canonical adapter projection of the real session", async () => {
    configured = await startInstance({ homeDir: HOME, port: PORT, sessionId: realA, token: TOKEN });
    const r = await httpReq({ port: PORT, path: "/glasses/v1/bootstrap", headers: { authorization: `Bearer ${TOKEN}` } });
    if (r.status !== 200) throw new Error(`bootstrap ${r.status}: ${r.text}`);
    const body = r.json;
    if (body.attachment?.sessionId !== realA) throw new Error(`exposed session ${body.attachment?.sessionId} != ${realA}`);
    const events = body.history?.events;
    if (!Array.isArray(events) || !events.length) throw new Error("no canonical events");
    // strictly increasing unique seq
    let prev = -1;
    for (const ev of events) {
      if (!Number.isInteger(ev.seq) || ev.seq <= prev) throw new Error(`non-monotonic/dup seq ${ev.seq}`);
      prev = ev.seq;
    }
    if (body.history.asOfSeq !== events[events.length - 1].seq) throw new Error("asOfSeq mismatch");
    const texts = events.map((e) => e.message?.text ?? "").join("|");
    if (!texts.includes("M1-SYNTHETIC-USER-A")) throw new Error("synthetic user sentinel missing from real-runtime projection");
    if (!texts.includes("M1-SYNTHETIC-ASSISTANT-A")) throw new Error("synthetic assistant sentinel missing from real-runtime projection");
    // agent state must be in the SPEC vocabulary (this slice yields unavailable/idle/running)
    const state = body.attachment?.status;
    if (!["idle", "running", "unavailable", "waiting-user", "unknown"].includes(state)) throw new Error(`bad agent state ${state}`);
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
