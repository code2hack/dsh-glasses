// Reproducible host-only TB0 at-most-once Send recovery test.
// Drives a disposable DSH instance (spawns it) through the plugin's public
// /glasses/v1/* surface and the host session.prompt RPC. No browser needed.
//
// Env:
//   DSH_BIN   (default: dsh on PATH)
//   DSH_HOME  (default: /tmp/dsh-tb0-home)
//   SESSION_ID (default: session-tb0-disposable)
//   PORT      (default: 3190)
//   TOKEN     (if absent, a fresh random dev token is minted and exported)
//   KEEP      (if set, do not delete the state unit between cases)
//
// Merge gate covered: no client-visible rejected->accepted; no concurrent
// duplicate dispatch; draft revision never decreases; newer draft never
// cleared; cold session can Send; every crash boundary => 0 or 1 durable
// user/message (correlated by source.rpcId === operationId).

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { rm, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const execFileP = promisify(execFile);
const DIR = process.env.DSH_HOME ?? "/tmp/dsh-tb0-home";
let SID = process.env.SESSION_ID ?? "session-tb0-disposable";
const WORK = process.env.WORKSPACE_DIR ?? "/tmp/dsh-tb0-workspace";
const PORT = Number(process.env.PORT ?? 3190);
const BASE = `http://127.0.0.1:${PORT}`;
let TOKEN = process.env.TOKEN ?? `dev-tb0-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const PLUGIN_DIR = new URL("../", import.meta.url).pathname;

const results = [];
const ok = (name) => { results.push([name, "PASS"]); console.log(`✓ ${name}`); };
const fail = (name, detail) => { results.push([name, "FAIL"]); console.log(`✗ ${name}: ${detail}`); };
const sessionLog = () => `${DIR}/sessions/--${WORK.slice(1).replace(/\//g, "-")}--/${SID}/session.jsonl.zstd`;

function digestOf(v) {
  const str = JSON.stringify(v, Object.keys(v).sort());
  return createHash("sha256").update(str).digest("hex");
}

async function countDurable(opId) {
  try {
    const { stdout } = await execFileP("zstd", ["-dc", sessionLog()]);
    let c = 0;
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (e?.type === "user/message") {
        const src = e?.data?.source ?? e?.message?.source;
        if (src?.kind === "user" && src?.rpcId === opId) c++;
      }
    }
    return c;
  } catch {
    return 0;
  }
}

async function http(method, path, body, token = TOKEN, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, text }; }
  } finally { clearTimeout(t); }
}

const mutation = (b) => http("POST", "/glasses/v1/draft/mutations", b);
const actions = (b) => http("POST", "/glasses/v1/actions", b);
const bootstrap = () => http("GET", "/glasses/v1/bootstrap");
async function promptHost(content, rpcId = randomUUID()) {
  return http("POST", "/api/session.prompt", {
    type: "client-request", rpcId, method: "session.prompt",
    payload: { sessionId: SID, mode: "queue", content: [{ type: "text", text: content }] },
  }, TOKEN, 120000);
}

let proc = null;
async function startInstance(sid = SID, extraEnv = {}) {
  if (proc) {
    proc.kill("SIGKILL");
    await sleep(3000);
    // wait until the old process actually released :PORT (EADDRINUSE guard)
    for (let i = 0; i < 40; i++) {
      try { await fetch(BASE + "/glasses/v1/bootstrap", { signal: AbortSignal.timeout(300) }); await sleep(200); continue; }
      catch { break; }
    }
  }
  SID = sid;
  proc = spawn("dsh", ["--profile", "web", "--port", String(PORT)], {
    cwd: PLUGIN_DIR,
    env: { ...process.env, DSH_HOME: DIR, DSH_GLASSES_TB0_SESSION_ID: SID, DSH_GLASSES_TB0_TOKEN: TOKEN, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logBuf = [];
  proc.stdout?.on("data", (d) => { logBuf.push(String(d)); if (process.env.VERBOSE) process.stdout.write("[child] " + String(d)); });
  proc.stderr?.on("data", (d) => { logBuf.push(String(d)); });
  // Verify the served instance really is on THIS session (kills stale-port
  // contamination from a previous instance that has not released :3190).
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    if (proc.exitCode !== null) break;
    try {
      const r = await bootstrap("");
      const got = r.json?.attachment?.sessionId;
      if (process.env.VERBOSE && i % 5 === 0) console.log("[verbose] boot-poll", i, "status", r.status, "got", got, "want", SID);
      if (r.status === 200 && got === SID) return;
      if (r.status === 200 && got && got !== SID) throw new Error("stale instance bound to port " + got);
    } catch (e) {
      if (String(e).includes("stale instance")) throw e;
    }
  }
  throw new Error("disposable instance did not come up on fresh session; child log:\n" + logBuf.join("").slice(-1500));
}

async function newSession() {
  const r = await http("POST", "/api/session.create", {
    type: "client-request", rpcId: randomUUID(), method: "session.create",
    payload: { cwd: WORK, agentPreset: "minimal" },
  }, TOKEN, 60000);
  const v = r.json?.result?.value;
  if (!v?.sessionId) throw new Error("session.create failed: " + JSON.stringify(r.json));
  // session.create may resolve BEFORE the durable log flush; wait for the log
  // file on disk so a subsequent instance can read this session back.
  const S = v.sessionId;
  const logPath = `${DIR}/sessions/--${WORK.slice(1).replace(/\//g, "-")}--/${S}/session.jsonl.zstd`;
  for (let i = 0; i < 20; i++) {
    try {
      const { stat } = await import("node:fs/promises");
      await stat(logPath);
      break;
    } catch {
      await sleep(500);
    }
  }
  if (process.env.VERBOSE) console.log("[verbose] newSession ->", S, "(log ready)");
  return S;
}

// thin helper: create a fresh session then run the instance against it
const SESSION_POOL = [];
async function prepareSessionPool(n = 26) {
  for (let i = 0; i < n; i++) SESSION_POOL.push(await newSession());
  if (process.env.VERBOSE) console.log("[verbose] session pool ready:", SESSION_POOL.length);
}
async function freshSession() {
  const sid = SESSION_POOL.shift();
  if (!sid) throw new Error("session pool exhausted");
  if (process.env.VERBOSE) console.log("[verbose] freshSession ->", sid);
  await startInstance(sid);
  return sid;
}

async function resetUnit() {
  await rm(`${DIR}/storages/glasses_plugin.json`, { force: true });
}

const scenario = async (name, fn) => {
  console.log(`\n== ${name} ==`);
  try { await fn(); } catch (e) { fail(name, e.message); }
};

let seq = 0;
const opId = (tag) => `${tag}-${seq++}`;

try {
  await startInstance();           // seed instance used to create fresh sessions
  ok("instance boot");
  await prepareSessionPool();       // pre-create all scenario sessions (settled before use)

  await scenario("auth: write routes require bearer", async () => {
    await freshSession();
    const r = await http("POST", "/glasses/v1/draft/mutations", { operationId: "x", expectedRevision: 0, mutation: { kind: "replace", text: "" } }, "");
    const a = await http("POST", "/glasses/v1/actions", { kind: "send", operationId: "x", draftRevision: 0 }, "");
    if (r.status === 401 && a.status === 401) ok("auth"); else fail("auth", `mutation ${r.status} actions ${a.status}`);
  });

  await scenario("mutation idempotency + operation-conflict", async () => {
    await freshSession();
    const id = opId("m");
    const b1 = { operationId: id, expectedRevision: 0, mutation: { kind: "replace", text: "t1" } };
    const r1 = await mutation(b1); if (r1.json.revision !== 1) throw new Error("expected rev1");
    const r2 = await mutation(b1); if (r2.json.status !== "stored") throw new Error("idempotency");
    const r3 = await mutation({ ...b1, mutation: { kind: "replace", text: "t2" } });
    if (r3.status !== 409 || r3.json.error !== "operation-conflict") throw new Error("conflict expected");
    ok("mutation idempotency + conflict");
  });

  await scenario("send: no false rejected; 0->1 acceptance; exactly one durable", async () => {
    const id = opId("s"); await freshSession();
    if (process.env.VERBOSE) console.log("[verbose] send scenario session", SID, "op", id);
    const mr = await mutation({ operationId: id + "-m", expectedRevision: 0, mutation: { kind: "replace", text: "send text" } });
    if (process.env.VERBOSE) console.log("[verbose] mutation resp", JSON.stringify(mr.json));
    const r = await actions({ kind: "send", operationId: id, draftRevision: 1 });
    if (process.env.VERBOSE) console.log("[verbose] first send resp", JSON.stringify(r.json));
    if (r.json.state === "rejected") throw new Error("client-visible rejected from zero evidence");
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const rr = await actions({ kind: "send", operationId: id, draftRevision: 1 });
      if (rr.json.state === "accepted") break;
      if (rr.json.state === "rejected") throw new Error("client-visible rejected from zero evidence");
      if (process.env.VERBOSE && i % 10 === 0) console.log("[verbose] poll", i, JSON.stringify(rr.json));
      if (i === 59) throw new Error("not accepted in time");
    }
    if (await countDurable(id) !== 1) throw new Error(`count=${await countDurable(id)}`);
    ok("send 0->1 acceptance, exactly one durable");
  });

  await scenario("concurrent identical -> one dispatch", async () => {
    const id = opId("c"); await freshSession();
    await mutation({ operationId: id + "-m", expectedRevision: 0, mutation: { kind: "replace", text: "conc text" } });
    const body = { kind: "send", operationId: id, draftRevision: 1 };
    const [x, y] = await Promise.all([actions(body), actions(body)]);
    if (process.env.VERBOSE) console.log("[verbose] conc resp", JSON.stringify(x.json), JSON.stringify(y.json));
    for (let i = 0; i < 30 && await countDurable(id) < 1; i++) await sleep(1000);
    await sleep(3000);
    const c = await countDurable(id);
    if (process.env.VERBOSE) console.log("[verbose] conc final count", c);
    if (c !== 1) throw new Error(`count=${c}`);
    ok("concurrent identical -> one dispatch");
  });

  await scenario("send-in-progress while unresolved", async () => {
    const id = opId("p"); await freshSession();
    await mutation({ operationId: id + "-m", expectedRevision: 0, mutation: { kind: "replace", text: "lock text" } });
    await actions({ kind: "send", operationId: id, draftRevision: 1 });
    const r2 = await actions({ kind: "send", operationId: opId("p2"), draftRevision: 1 });
    if (r2.status !== 409 || r2.json.error !== "send-in-progress") throw new Error(`got ${r2.status} ${r2.json.error}`);
    ok("send-in-progress");
  });

  await scenario("monotonic clear: revision never decreases", async () => {
    const id = opId("mono"); await freshSession();
    await mutation({ operationId: id + "-m", expectedRevision: 0, mutation: { kind: "replace", text: "mono text" } });
    await actions({ kind: "send", operationId: id, draftRevision: 1 });
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      if ((await actions({ kind: "send", operationId: id, draftRevision: 1 })).json.state === "accepted") break;
    }
    const after = (await bootstrap()).json;
    if (after.draft.revision !== 2) throw new Error(`cleared revision expected 2 got ${after.draft.revision}`);
    // stale mutation with the old 0-expected revision must be rejected (authoritative = 2)
    const stale = await mutation({ operationId: opId("mc-stale"), expectedRevision: 0, mutation: { kind: "replace", text: "x" } });
    if (stale.status !== 409 || stale.json.got !== 2) throw new Error(`stale should 409 got ${stale.status} ${JSON.stringify(stale.json)}`);
    ok("monotonic clear (D+1), stale mutations rejected");
  });

  await scenario("cold-session Send (restart, no warm)", async () => {
    const id = opId("cold"); await freshSession();
    await mutation({ operationId: id + "-m", expectedRevision: 0, mutation: { kind: "replace", text: "cold text" } });
    await actions({ kind: "send", operationId: id, draftRevision: 1 });
    let accepted = false;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const rr = await actions({ kind: "send", operationId: id, draftRevision: 1 });
      if (rr.json.state === "accepted") { accepted = true; break; }
    }
    if (!accepted) throw new Error("cold send not accepted");
    if (await countDurable(id) !== 1) throw new Error("cold count");
    ok("cold-session Send");
  });

  await scenario("crash after dispatch -> no double, no false rejected", async () => {
    const id = opId("crash"); await freshSession();
    await mutation({ operationId: id + "-m", expectedRevision: 0, mutation: { kind: "replace", text: "crash text" } });
    proc.kill("SIGKILL"); await sleep(1000);
    await startInstance(SID, { DSH_GLASSES_TEST_CRASH_AFTER_DISPATCH: "1" });
    let r;
    try { r = await actions({ kind: "send", operationId: id, draftRevision: 1 }); } catch { r = { status: 0, json: { state: "crash" } }; }
    if (r.json.state === "rejected") throw new Error("false rejected at crash");
    await sleep(1500); proc.kill("SIGKILL"); await sleep(1000);
    await startInstance(SID); // clean restart -> startup reconcile sweep
    // wake in case admission was durable
    try { await promptHost("continue"); } catch {}
    let state = "prepared/unknown";
    for (let i = 0; i < 40 && !["accepted", "rejected"].includes(state); i++) {
      await sleep(2000);
      const rr = await actions({ kind: "send", operationId: id, draftRevision: 1 });
      state = rr.json.state;
    }
    const c = await countDurable(id);
    if (state === "rejected" && c > 0) throw new Error("rejected with durable messages");
    if (c > 1) throw new Error(`count=${c}`);
    if (!["accepted", "rejected", "prepared", "dispatching", "unknown"].includes(state)) throw new Error(`bad state ${state}`);
    ok(`crash boundary -> state ${state}, durable ${c} (0 or 1)`);
  });

  await scenario("plugin restart reconciliation", async () => {
    await freshSession();
    const b = await bootstrap();
    if (b.json.writeState !== "ready") throw new Error(`unexpected writeState ${b.json.writeState}`);
    ok("restart reconciliation -> ready");
  });

  await scenario("two Send IDs race one draft -> one dispatch only", async () => {
    const id = opId("r");
    await freshSession();
    await mutation({ operationId: id + "-m", expectedRevision: 0, mutation: { kind: "replace", text: "race text" } });
    const a = await actions({ kind: "send", operationId: id, draftRevision: 1 });
    const b = await actions({ kind: "send", operationId: opId("r2"), draftRevision: 1 });
    if (b.status !== 409 || b.json.error !== "send-in-progress") throw new Error(`expected send-in-progress got ${b.status} ${JSON.stringify(b.json)}`);
    for (let i = 0; i < 60 && (await actions({ kind: "send", operationId: id, draftRevision: 1 })).json.state !== "accepted"; i++) await sleep(1000);
    if (await countDurable(id) !== 1) throw new Error(`count=${await countDurable(id)}`);
    ok("two Send IDs race one draft -> one dispatch");
  });

  await scenario("two replace IDs race one revision -> one applied, one conflicts", async () => {
    const id1 = opId("rr1"); const id2 = opId("rr2");
    await freshSession();
    const r1 = mutation({ operationId: id1, expectedRevision: 0, mutation: { kind: "replace", text: "first" } }).catch(() => ({ status: 0, json: {} }));
    const r2 = mutation({ operationId: id2, expectedRevision: 0, mutation: { kind: "replace", text: "second" } }).catch(() => ({ status: 0, json: {} }));
    const [a, b] = await Promise.all([r1, r2]);
    const applied = [a, b].filter((x) => x.status === 200);
    const conflicted = [a, b].filter((x) => x.status === 409);
    if (applied.length !== 1 || conflicted.length !== 1) throw new Error(`applied=${applied.length} conflicted=${conflicted.length}`);
    const after = (await bootstrap()).json.draft;
    if (after.revision !== 1) throw new Error(`revision ${after.revision}`);
    ok("two replace IDs race one revision -> one applied, one conflicts");
  });

  await scenario("replace races Send -> no lost state", async () => {
    const id = opId("rs");
    await freshSession();
    await mutation({ operationId: id + "-m", expectedRevision: 0, mutation: { kind: "replace", text: "orig" } });
    await actions({ kind: "send", operationId: id, draftRevision: 1 });
    const r = await mutation({ operationId: opId("rs-m2"), expectedRevision: 1, mutation: { kind: "replace", text: "newer" } });
    if (r.status !== 409 || !["draft-locked", "revision-conflict"].includes(r.json.error))
      throw new Error(`expected 409 draft-locked/revision-conflict got ${r.status} ${JSON.stringify(r.json)}`);
    const st = JSON.parse(await (await import("node:fs/promises")).readFile("/tmp/dsh-tb0-home/storages/glasses_plugin.json", "utf8"));
    const rec = Object.values(st.tables.state)[0];
    if (rec.draft.text !== "orig") throw new Error("lost state: draft text changed");
    ok("replace races Send -> draft-locked, no lost state");
  });

  await scenario("known rejection -> text retained, draft unlocked; fresh op proceeds", async () => {
    const id = opId("k");
    await freshSession();
    await mutation({ operationId: id + "-m", expectedRevision: 0, mutation: { kind: "replace", text: "rej text" } });
    // simulate pre-dispatch failure via an in-process restart with the hook
    proc.kill("SIGKILL"); await sleep(3000);
    await startInstance(SID, { DSH_GLASSES_TEST_FAIL_DISPATCH: "1" });
    const r = await actions({ kind: "send", operationId: id, draftRevision: 1 });
    if (r.json.state !== "rejected") throw new Error(`expected rejected got ${JSON.stringify(r.json)}`);
    proc.kill("SIGKILL"); await sleep(3000);
    await startInstance(SID);
    const b = await bootstrap();
    if (b.json.draft.text !== "rej text") throw new Error("text not retained");
    if (b.json.draft.locked !== false) throw new Error("draft still locked after rejection");
    if (b.json.draft.revision !== 1) throw new Error(`revision ${b.json.draft.revision}`);
    ok("known rejection -> text retained, draft unlocked");
  });

  await scenario(">1 matching source.rpcId -> invariant failure, draft never cleared", async () => {
    const id = opId("inv");
    await freshSession();
    await mutation({ operationId: id + "-m", expectedRevision: 0, mutation: { kind: "replace", text: "inv text" } });
    proc.kill("SIGKILL"); await sleep(3000);
    await startInstance(SID, { DSH_GLASSES_TEST_INVARIANT: "1" });
    const r = await actions({ kind: "send", operationId: id, draftRevision: 1 });
    if (r.status !== 500 || r.json.error !== "identity-invariant-failure") throw new Error(`got ${r.status} ${JSON.stringify(r.json)}`);
    const b = await bootstrap();
    if (b.json.draft.text !== "inv text" || b.json.draft.locked !== true) throw new Error("draft cleared/lost on invariant!");
    proc.kill("SIGKILL"); await sleep(3000);
    await startInstance(SID);
    ok(">1 rpcId matches -> invariant failure, draft retained+locked");
  });

  await scenario("accepted op retried after noise -> stored accepted, still one durable", async () => {
    const id = opId("retry");
    await freshSession();
    await mutation({ operationId: id + "-m", expectedRevision: 0, mutation: { kind: "replace", text: "retry text" } });
    await actions({ kind: "send", operationId: id, draftRevision: 1 });
    for (let i = 0; i < 60 && (await actions({ kind: "send", operationId: id, draftRevision: 1 })).json.state !== "accepted"; i++) await sleep(1000);
    for (let i = 0; i < 5; i++) await promptHost("noise " + i).catch(() => {});
    const r = await actions({ kind: "send", operationId: id, draftRevision: 1 });
    if (r.json.state !== "accepted") throw new Error(`expected accepted got ${JSON.stringify(r.json)}`);
    if (await countDurable(id) !== 1) throw new Error(`count=${await countDurable(id)}`);
    ok("accepted retried + long log -> stored accepted, exactly one durable");
  });

  console.log("\n=== SUMMARY ===");
  for (const [n, r] of results) console.log(`${r} ${n}`);
  const failed = results.filter(([, r]) => r === "FAIL");
  if (failed.length) { console.log(`FAILED: ${failed.length}`); process.exit(1); }
  console.log("ALL PASS");
  process.exit(0);
} catch (e) {
  console.error("FATAL", e);
  process.exit(2);
}
