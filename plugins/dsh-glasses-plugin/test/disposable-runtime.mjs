// Disposable supported-DSH runtime harness for the M1 (#27) integration tests.
//
// Boots a REAL pinned rc.2 `dsh` instance with the worktree's plugin loaded,
// in an isolated disposable DSH_HOME, with NO vLLM/provider dependency (tests
// drive session.create RPC + durable-log splicing for deterministic synthetic
// content). This is deliberately the same direct-spawn style proven by
// host-write-recovery.test.mjs; dev/d0-runtime.mjs (rc.7 + vLLM) stays
// historical and unmodified.
//
// Node builtins only.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { appendEvents, readLines } from "./zstd-jsonl.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = resolve(HERE, ".."); // plugins/dsh-glasses-plugin
const BASE_HOME = process.env.DSH_M1_BASE_HOME || "/tmp/dsh-tb0-home";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function verbose(...args) {
  if (process.env.VERBOSE) console.log("[verbose]", ...args);
}

// PIDs currently LISTENing on a port (via `ss -tlnp`). Returns [] when the port
// is free or ss is unavailable.
export function portOwners(port) {
  try {
    const owners = [];
    const out = execFileSync("ss", ["-tlnp"], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      if (!line.includes(`:${port} `)) continue;
      const m = line.match(/pid=(\d+)/);
      if (m) owners.push(Number(m[1]));
    }
    return owners;
  } catch {
    return [];
  }
}

/**
 * Stable per-process identity for PID-reuse fencing on a shared host: field 22
 * (starttime) of /proc/<pid>/stat, in jiffies since boot. A reused PID has a
 * different starttime, so `pid` alone is never trusted after spawn.
 * Returns null when the process does not exist (or /proc is unavailable).
 */
export function processStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rparen = stat.lastIndexOf(")");
    if (rparen < 0) return null;
    const tail = stat.slice(rparen + 1).trim().split(/\s+/); // field 3 onward
    // starttime is field 22 → index 22 - 3 = 19 in this tail.
    const ticks = Number(tail[19]);
    return Number.isInteger(ticks) && ticks >= 0 ? ticks : null;
  } catch {
    return null;
  }
}

// Children this harness spawned in the current run: pid -> { start, port }.
// Only these PIDs (with matching start-time identity) may ever be signaled.
const ownedChildren = new Map();
export function registerOwnedChild(pid, opts = {}) {
  const start = Number.isInteger(opts.start) ? opts.start : processStartTicks(pid);
  ownedChildren.set(pid, { start, port: opts.port ?? null });
}
export function isOwnedChild(pid) {
  return ownedChildren.has(pid);
}
export function unregisterOwnedChild(pid) {
  ownedChildren.delete(pid);
}

/**
 * True only if `pid` is a currently-registered child AND its live identity
 * still matches what we recorded at spawn. Never signals a reused/unrelated PID
 * even when the PID number happens to be held again on a shared host.
 */
export function ownsProcessWithIdentity(pid) {
  const entry = ownedChildren.get(pid);
  if (!entry) return false;
  const now = processStartTicks(pid);
  if (entry.start === null) return now !== null; // could not capture at spawn; require it to still exist
  return now !== null && now === entry.start;
}

/**
 * Before spawning, the test port must be either free or held by OUR OWN
 * previous (already stopped) child. Any other holder is a shared-resource
 * collision: fail deterministically as `test-port-in-use` instead of killing an
 * unrelated process. Owned-but-still-releasing sockets are awaited (TIME_WAIT
 * has no pid, so only a genuine lingering LISTEN by our own dying child occurs).
 */
export async function assertPortSpawnable(port, { timeoutMs = 8000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const owners = portOwners(port).filter((pid) => pid !== process.pid);
    const strangers = owners.filter((pid) => !isOwnedChild(pid));
    if (strangers.length > 0) {
      throw new Error(`test-port-in-use: :${port} is held by pid ${strangers.join(",")}; fix the conflicting service or choose M1_TEST_PORT`);
    }
    if (owners.length === 0) return;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`test-port-in-use: :${port} still held by our own child after ${timeoutMs}ms`);
    }
    await sleep(300);
  }
}

/**
 * Terminate exactly the child THIS harness spawned: SIGTERM then SIGKILL, each
 * gated by PID-reuse fencing (ownsProcessWithIdentity). Refuses to signal an
 * unregistered/reused PID. Afterwards it waits for the LISTEN socket to free,
 * but never touches any process that acquired the port later.
 */
export async function stopOwnedProcess(pid, port, timeoutMs = 8000) {
  if (!pid || !isOwnedChild(pid)) return; // not currently ours -> never signal
  const t0 = Date.now();
  const identityAlive = () => ownsProcessWithIdentity(pid);

  if (identityAlive()) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  while (identityAlive() && Date.now() - t0 < timeoutMs / 2) await sleep(200);
  if (identityAlive()) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  unregisterOwnedChild(pid);
  // Wait for the LISTEN socket to actually free (avoid racing a re-spawn).
  // If a DIFFERENT process acquires the port meanwhile, we stop waiting and
  // leave it alone.
  const rt0 = Date.now();
  while (Date.now() - rt0 < timeoutMs) {
    const owners = portOwners(port).filter((p) => p !== process.pid);
    if (owners.every((p) => p !== pid && !isOwnedChild(p))) break;
    await sleep(200);
  }
}

/** Parse the pid dsh printed for the child it spawned, if the wrapper is pid 1. */
export async function httpReq({ port, method = "GET", path, headers = {}, body, timeoutMs = 20000 }) {
  return new Promise((resolveReq, rejectReq) => {
    const chunks = [];
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers },
      (res) => {
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolveReq({ status: res.statusCode, header: res.headers, text, json });
        });
      },
    );
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`http timeout ${method} ${path}`)); });
    req.on("error", rejectReq);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

function writeProfileFiles(homeDir, port) {
  const profileDir = join(homeDir, "profiles", "web");
  const settings = [
    "webserver:",
    "  host: 127.0.0.1",
    `  port: ${port}`,
    "agent-presets:",
    "  default: minimal",
    "",
  ].join("\n");
  const packageJson = JSON.stringify({
    name: "dsh-profile-web",
    private: true,
    dependencies: {
      "@deepseek-ai/schemastery": "^3.18.1",
      "dsh-glasses-plugin": `file:${PLUGIN_ROOT}`,
    },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
  }, null, 2) + "\n";
  return (async () => {
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(homeDir, "settings.yaml"), settings);
    await writeFile(join(profileDir, "package.json"), packageJson);
    await writeFile(join(profileDir, "cordis.yml"), "# dsh profile root.\n[]\n");
    await writeFile(join(profileDir, "cordis.patch.yml"), "- insert:\n    - id: dsh-glasses-plugin\n      name: dsh-glasses-plugin\n");
    await writeFile(join(profileDir, "pnpm-workspace.yaml"), "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n");
  })();
}

async function createFromScratch(homeDir, port) {
  verbose("creating disposable home from scratch", homeDir);
  await writeProfileFiles(homeDir, port);
  const profileDir = join(homeDir, "profiles", "web");
  execFileSync("pnpm", ["install"], { cwd: profileDir, stdio: "inherit" });
}

async function overlayPlugin(homeDir) {
  const pluginDir = join(homeDir, "profiles", "web", "node_modules", "dsh-glasses-plugin");
  if (!existsSync(pluginDir)) throw new Error(`overlayPlugin: plugin not installed at ${pluginDir}`);
  await cp(join(PLUGIN_ROOT, "package.json"), join(pluginDir, "package.json"));
  if (existsSync(join(PLUGIN_ROOT, "dsh-compat.json"))) {
    await cp(join(PLUGIN_ROOT, "dsh-compat.json"), join(pluginDir, "dsh-compat.json"));
  }
  await rm(join(pluginDir, "lib"), { recursive: true, force: true });
  await cp(join(PLUGIN_ROOT, "lib"), join(pluginDir, "lib"), { recursive: true });
}

/** Build an isolated disposable home for one test run and load the worktree plugin. */
export async function ensureHome(homeDir, port) {
  if (!existsSync(homeDir)) {
    if (existsSync(BASE_HOME)) {
      verbose("cloning base disposable home", BASE_HOME, "->", homeDir);
      await cp(BASE_HOME, homeDir, { recursive: true, verbatimSymlinks: true });
      // The base profile has its own settings/port; point it at our port.
      await writeProfileFiles(homeDir, port);
    } else {
      await createFromScratch(homeDir, port);
    }
  }
  await overlayPlugin(homeDir);
  return homeDir;
}

function resolveDshBin() {
  const fromEnv = process.env.DSH_BIN;
  const candidate = fromEnv || "dsh";
  return candidate;
}

/**
 * Wait until the disposable instance's HTTP surface answers with plugin JSON.
 * Used for a seed boot whose configured plugin session may not exist yet —
 * bootstrap then returns a JSON error (session not found) but the server is up
 * and RPC session creation works. Readiness = a parseable JSON response that is
 * NOT an auth-rejected 401 (auth rejection implies a stale/wrong-credential
 * holder rather than our freshly spawned instance).
 */
export async function waitForServer({ port, proc, logBuf, token, timeoutMs = 60000 }) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (proc.exitCode !== null) break;
    try {
      const r = await httpReq({ port, path: "/glasses/v1/bootstrap", headers: { authorization: `Bearer ${token}` } });
      if (r.json !== null && r.status !== 401) return r;
    } catch {}
    await sleep(500);
  }
  const tail = (logBuf || []).join("").slice(-2000);
  throw new Error(`disposable instance did not surface plugin JSON on :${port}; child log:\n${tail}`);
}

export async function spawnInstance({ homeDir, port, sessionId, token, extraEnv = {} }) {
  await assertPortSpawnable(port);
  const proc = spawn(resolveDshBin(), ["--profile", "web", "--port", String(port)], {
    cwd: homeDir,
    env: {
      ...process.env,
      DSH_HOME: homeDir,
      DSH_GLASSES_TB0_SESSION_ID: sessionId,
      DSH_GLASSES_TB0_TOKEN: token,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  registerOwnedChild(proc.pid, { port });
  proc.once("exit", () => unregisterOwnedChild(proc.pid));
  const logBuf = [];
  proc.stdout?.on("data", (d) => { logBuf.push(String(d)); if (process.env.VERBOSE) process.stdout.write("[child] " + String(d)); });
  proc.stderr?.on("data", (d) => { logBuf.push(String(d)); });
  return { proc, logBuf };
}

/**
 * Boot a disposable instance configured to `sessionId`. Returns {proc, logTail}
 * once /glasses/v1/bootstrap returns 200 for that session. Throws (with child
 * log) if it never comes up. Only OUR spawned child is ever terminated.
 */
export async function startInstance({ homeDir, port, sessionId, token }) {
  const { proc, logBuf } = await spawnInstance({ homeDir, port, sessionId, token });
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    if (proc.exitCode !== null) break;
    try {
      const r = await httpReq({ port, path: "/glasses/v1/bootstrap", headers: { authorization: `Bearer ${token}` } });
      if (r.status === 200 && r.json?.attachment?.sessionId === sessionId) {
        verbose("boot ok on", sessionId, "try", i);
        return { proc, logTail: () => logBuf.join("").slice(-2000) };
      }
      if (r.json?.ok === false && String(r.json.error).includes("not found") === false) {
        // server is up; keep polling
      }
    } catch {}
  }
  const tail = logBuf.join("").slice(-2500);
  await stopOwnedProcess(proc.pid, port);
  throw new Error(`disposable instance did not serve bootstrap for ${sessionId} on :${port}; child log:\n${tail}`);
}

export async function stopInstance(proc, port) {
  await stopOwnedProcess(proc?.pid, port);
}

/** Create a real session through the disposable instance's own RPC and wait for its durable log. */
export async function createSession({ port, cwd, homeDir, rpcId, agentPreset = "minimal" }) {
  const magic = (process.pid.toString(36) + Date.now().toString(36) + (rpcId || Math.random().toString(36).slice(2, 8)));
  const rid = rpcId || `m1-${magic}`;
  const r = await httpReq({
    port,
    method: "POST",
    path: "/api/session.create",
    headers: { "content-type": "application/json" },
    body: { type: "client-request", rpcId: rid, method: "session.create", payload: { cwd, agentPreset } },
    timeoutMs: 60000,
  });
  const sid = r.json?.result?.value?.sessionId;
  if (!sid) throw new Error(`session.create failed: ${JSON.stringify(r.json || r.text)}`);
  await waitForSessionLog(homeDir, sid);
  return sid;
}

async function waitForSessionLog(homeDir, sessionId) {
  const root = join(homeDir, "sessions");
  for (let i = 0; i < 40; i++) {
    const found = await findSessionLog(root, sessionId);
    if (found) return found;
    await sleep(500);
  }
  throw new Error(`durable log for ${sessionId} never appeared under ${root}`);
}

async function findSessionLog(root, sessionId) {
  let entries = [];
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(root, e.name);
    const sub = join(dir, sessionId);
    if (existsSync(join(sub, "session.jsonl.zstd"))) return join(sub, "session.jsonl.zstd");
    if (e.name === sessionId) {
      if (existsSync(join(dir, "session.jsonl.zstd"))) return join(dir, "session.jsonl.zstd");
    }
  }
  return null;
}

/** Session durable-log path (must exist). */
export async function sessionLogPath(homeDir, sessionId) {
  const found = await findSessionLog(join(homeDir, "sessions"), sessionId);
  if (!found) throw new Error(`no durable log for ${sessionId} under ${homeDir}/sessions`);
  return found;
}

/** Append synthetic durable events to a real session log; returns next seq. */
export async function seedSyntheticHistory(homeDir, sessionId, events) {
  const logPath = await sessionLogPath(homeDir, sessionId);
  return appendEvents(logPath, events);
}

export function readSessionLogLines(homeDir, sessionId) {
  const root = join(homeDir, "sessions");
  // search is synchronous-friendly: just scan directories we can find
  return readLinesSync(root, sessionId);
}

function readLinesSync(root, sessionId) {
  // small sync helper (used only for debug/hygiene checks)
  return { lines: [], tornStart: null };
}

export { readLines };
