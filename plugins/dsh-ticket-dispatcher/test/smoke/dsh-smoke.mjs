import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createCodexAdapter, CodexControlClient } from "../../lib/codex.js";
import { claimBody, collapseClaimMarkers } from "../../lib/core.js";

const exec = promisify(execFile);
const sourcePackage = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = await mkdtemp(join(tmpdir(), "dsh-ticket-dispatcher-smoke-"));
const scratchRepo = join(root, "repo");
const worktreeRoot = join(root, "worktrees");
const dshHome = join(root, "dsh-home");
const profile = join(dshHome, "profiles/smoke");
const packageCopy = join(root, "package");
const fixturesPath = join(root, "fixtures.json");
const overlay = join(root, "overlay.yml");
const dshScope = process.env.DSH_SCOPE ?? "/home/code2hack/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";
const dshBin = process.env.DSH_BIN ?? "dsh";
const hostSettings = process.env.DSH_HOST_SETTINGS ?? `${process.env.HOME}/.dsh/settings.yaml`;

const run = (file, args, options = {}) => exec(file, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, ...options });
const git = (...args) => run("git", args, { cwd: scratchRepo });
const quote = (value) => JSON.stringify(value);
const writeFixtures = (data) => writeFile(fixturesPath, `${JSON.stringify(data, null, 2)}\n`);
const readFixtures = async () => JSON.parse(await readFile(fixturesPath, "utf8"));

const ticketRecord = (number, milestone, extras = {}) => ({
  number,
  state: "OPEN",
  blockers: [],
  url: `https://github.com/code2hack/dsh-glasses/issues/${number}`,
  milestone,
  body: `## Milestone\n${milestone}\n\n## What to build\n-\n`,
  ...extras,
});

function overlayText(statePath, options = {}) {
  const config = {
    baseSha: options.baseSha ?? baseSha,
    baseRef: options.baseRef ?? "HEAD",
    fetch: options.fetch ?? false,
    maxActive: options.maxActive ?? 3,
    stayAlive: options.stayAlive ?? false,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 200,
    maxPasses: options.maxPasses ?? 0,
    wakeAgents: options.wakeAgents ?? false,
    codexThinking: options.codexThinking ?? "max",
  };
  return `- id: headless-startup
  disabled: true
- id: headless-runner
  disabled: true
- insert:
    - id: ticket-dispatcher
      name: 'dsh-ticket-dispatcher'
      config:
        repoRoot: ${quote(scratchRepo)}
        worktreeRoot: ${quote(worktreeRoot)}
        statePath: ${quote(statePath)}
        fixturesPath: ${quote(fixturesPath)}
        baseSha: ${quote(config.baseSha)}
        baseRef: ${quote(config.baseRef)}
        fetch: ${config.fetch}
        maxActive: ${config.maxActive}
        stayAlive: ${config.stayAlive}
        heartbeatIntervalMs: ${config.heartbeatIntervalMs}
        maxPasses: ${config.maxPasses}
        wakeAgents: ${config.wakeAgents}
        codexThinking: ${quote(config.codexThinking)}
`;
}

function reportsOf(stdout) {
  const reports = [];
  let offset = 0;
  while (true) {
    const start = stdout.indexOf('{\n  "schemaVersion"', offset);
    if (start < 0) break;
    const end = stdout.indexOf("\nTicket Dispatcher:", start);
    if (end < 0) throw new Error(`incomplete dispatcher report:\n${stdout.slice(start)}`);
    reports.push(JSON.parse(stdout.slice(start, end)));
    offset = end + 1;
  }
  if (!reports.length) throw new Error(`dispatcher report missing:\n${stdout}`);
  return reports;
}

async function invoke(statePath, options = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await writeFile(overlay, overlayText(statePath, options));
    try {
      const result = await run(dshBin, ["--profile", "smoke", "--patch", overlay, "reconcile"], {
        env: { ...process.env, DSH_HOME: dshHome },
        timeout: 480_000,
      });
      if (result.stdout.trim()) return result;
      process.stderr.write(`WARN invoke attempt ${attempt} returned empty stdout (stderr=${JSON.stringify(result.stderr)})\n`);
    } catch (error) {
      if (attempt === 3) throw new Error(`dsh reconcile failed (${error.code ?? "?"}):\n${error.stderr ?? error.message}`);
      process.stderr.write(`WARN invoke attempt ${attempt} failed: ${error.code ?? ""} ${(error.stderr ?? error.message).split("\n").slice(-2).join(" ")}\n`);
    }
  }
  throw new Error("dsh reconcile produced no stdout in 3 attempts");
}

async function invokeLive(statePath, options = {}, afterFirstPass) {
  await writeFile(overlay, overlayText(statePath, options));
  const child = spawn(dshBin, ["--profile", "smoke", "--patch", overlay, "reconcile"], {
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let mutation;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!mutation && stdout.includes("Ticket Dispatcher:")) mutation = Promise.resolve().then(afterFirstPass).catch((error) => { throw error; });
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 540_000);
  const code = await new Promise((resolveClose) => child.on("close", resolveClose));
  clearTimeout(timeout);
  await mutation;
  if (code !== 0) throw new Error(`live dispatcher exited ${code}:\n${stderr}\n${stdout}`);
  return { stdout, stderr };
}

function sessionParent(binding) {
  const cwdKey = `--${binding.worktree.slice(1).replaceAll("/", "-")}--`;
  return join(dshHome, "sessions", cwdKey);
}

/** First user text on a real Codex thread (byte-for-byte proof of the seed). */
function firstUserText(thread) {
  for (const entry of thread?.turns ?? []) {
    for (const item of entry?.items ?? []) {
      if (item?.type !== "userMessage") continue;
      return (item.content ?? []).map((part) => part?.text ?? "").join("");
    }
  }
  return "";
}

/** Count real Codex threads whose name matches exactly (duplicate-pair proof). */
async function countThreads(name) {
  const client = new CodexControlClient(await realCodex.socketPath(), { timeoutMs: 60_000 });
  try {
    await client.connect({ clientInfo: { name: "dsh-ticket-dispatcher-smoke", version: "0.0.0" } });
    const list = await client.request("thread/list", { searchTerm: name, limit: 50 });
    // The app-server surfaces the seeded name as `preview`; `name` is null there.
    return (list?.data ?? []).filter((entry) => (entry?.name ?? entry?.preview) === name).length;
  } finally {
    await client.close();
  }
}

/** Delete leaked threads from previous smoke runs so count assertions are deterministic. */
async function cleanupLeakedThreads() {
  const disposable = /^dsh-glasses-S\d+-#(21|22|31|32|41|51|52)-Codex$/;
  const client = new CodexControlClient(await realCodex.socketPath(), { timeoutMs: 60_000 });
  try {
    await client.connect({ clientInfo: { name: "dsh-ticket-dispatcher-smoke", version: "0.0.0" } });
    const list = await client.request("thread/list", { limit: 200 });
    for (const entry of list?.data ?? []) {
      const name = entry?.name ?? entry?.preview;
      if (name && disposable.test(name)) {
        await client.request("thread/delete", { threadId: entry.id });
        process.stdout.write(`  (cleanup) deleted leaked thread ${entry.id} ${name}\n`);
      }
    }
  } finally {
    await client.close();
  }
}

/** Wait until a real thread leaves the in-flight state; the single name-seed settles. */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForIdle(threadId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const thread = await realCodex.readThread({ threadId });
    if (thread.status === "idle") return;
    if (Date.now() > deadline) throw new Error(`real Codex thread ${threadId} did not settle to idle within ${timeoutMs}ms (status=${thread.status})`);
    await delay(2_000);
  }
}

/** Mirror of the DSH persistence backend's per-segment dir encoding (`#` -> `~0023`). */
function encodeSegment(segment) {
  let out = "";
  for (const ch of String(segment)) {
    if (/^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

/** Read whatever session-log representation DSH persisted and decompress it. */
async function readSessionLog(sessionId, worktree) {
  const dir = join(sessionParent(worktree), encodeSegment(sessionId));
  for (const name of ["session.jsonl.zstd", "session.jsonl.zst", "session.jsonl"]) {
    try {
      const path = join(dir, name);
      await stat(path);
      return name.endsWith("jsonl") ? (await readFile(path, "utf8")) : (await run("zstd", ["-dc", path])).stdout;
    } catch {}
  }
  const entries = [];
  try { entries.push(...(await readdir(dir)).sort()); } catch {}
  throw new Error(`no session log for ${sessionId} (${dir}: ${entries.join(", ")})`);
}

let baseSha;
let realCodex;
try {
  await mkdir(scratchRepo, { recursive: true });
  await run("git", ["init", "--quiet"], { cwd: scratchRepo });
  await git("config", "user.name", "Dispatcher Smoke");
  await git("config", "user.email", "dispatcher-smoke@example.invalid");
  await writeFile(join(scratchRepo, "README.md"), "disposable dispatcher smoke repository\n");
  await git("add", "README.md");
  await git("commit", "--quiet", "-m", "smoke base");
  baseSha = (await git("rev-parse", "HEAD")).stdout.trim();

  await cp(sourcePackage, packageCopy, { recursive: true, filter: (path) => !path.includes("/node_modules") });
  await mkdir(join(packageCopy, "node_modules"), { recursive: true });
  await symlink(dshScope, join(packageCopy, "node_modules/@deepseek-ai"), "dir");
  await mkdir(join(profile, "node_modules"), { recursive: true });
  await symlink(dshScope, join(profile, "node_modules/@deepseek-ai"), "dir");
  await symlink(packageCopy, join(profile, "node_modules/dsh-ticket-dispatcher"), "dir");
  await writeFile(join(profile, "package.json"), `${JSON.stringify({
    name: "dsh-profile-smoke",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } },
  }, null, 2)}\n`);
  await writeFile(join(profile, "cordis.yml"), "[]\n");
  await writeFile(join(profile, "cordis.patch.yml"), "[]\n");
  // Real model provider/default for the wake phase (local DS4 vLLM; no product change).
  await mkdir(dshHome, { recursive: true });
  await cp(hostSettings, join(dshHome, "settings.yaml"));

  realCodex = createCodexAdapter({ clientName: "dsh-ticket-dispatcher-smoke", clientVersion: "0.0.0", replyTimeoutMs: 300_000, seedGraceMs: 180_000 });

  process.stdout.write(`SMOKE host: dsh=${dshBin} dsh-home=${dshHome} codex-socket=${await realCodex.socketPath()}\n`);
  await cleanupLeakedThreads();

  // ---------------------------------------------------------------- Phase 0
  // Real pair admission: 2 disposable Tickets -> 2 named DSH sessions + 2 named
  // persistent Codex threads, each seeded with EXACTLY the Codex name and idle.
  const originalFixtures = { tickets: [21, 22].map((number) => ticketRecord(number, "S1")), claims: [] };
  await writeFixtures(originalFixtures);
  const firstState = join(root, "state/first.json");
  const firstReport = reportsOf((await invoke(firstState, { maxActive: 2 })).stdout)[0];
  assert.deepEqual(firstReport.running.map((item) => item.number), [21, 22]);
  for (const binding of firstReport.running) {
    assert.equal(binding.dshName, `dsh-glasses-S1-#${binding.number}-DSH`);
    assert.equal(binding.codexName, `dsh-glasses-S1-#${binding.number}-Codex`);
    assert.equal(binding.sessionId, binding.dshName, "DSH session id must be the deterministic name");
    assert.ok(binding.codexThreadId, "binding must pin the real Codex thread");
    assert.equal(binding.codex?.thinkingEffort, "max", "default thinking effort must be max");
    assert.equal(binding.codex?.firstPrompt, binding.codexName, "seed text must be byte-for-byte the Codex name");
    assert.equal(binding.baseSha, baseSha);
    assert.equal((await stat(binding.worktree)).isDirectory(), true);
    assert.equal(binding.sessionPersisted, true, "named DSH session must be durably persisted");
    // Real Codex thread, seeded with exactly the name (verified below after the
    // duplicate-thread count, so the idle/single-turn proof also stands).
  }
  // No spurious extra Codex threads: each name resolves to exactly one thread,
  // and the single name-seed is left to settle idle (never a second prompt).
  for (const binding of firstReport.running) {
    assert.equal(await countThreads(binding.codexName), 1);
    const thread = await realCodex.readThread({ threadId: binding.codexThreadId });
    assert.equal(firstUserText(thread), binding.codexName, "no second bootstrap prompt may exist on the real thread");
    const userTurns = thread.turns?.filter((entry) => (entry.items ?? []).some((item) => item.type === "userMessage")).length ?? 0;
    assert.equal(userTurns, 1, "the real thread must contain exactly one user turn");
    await waitForIdle(binding.codexThreadId, 120_000);
  }

  // ---------------------------------------------------------------- Phase 1
  // Repeated reconcile creates neither a second DSH session nor a second thread.
  const repeated = reportsOf((await invoke(firstState, { maxActive: 2 })).stdout)[0];
  assert.deepEqual(repeated.running.map((item) => item.sessionId), firstReport.running.map((item) => item.sessionId));
  for (const binding of repeated.running) assert.equal(await countThreads(binding.codexName), 1);
  assert.equal((await readFixtures()).claims.length, 2);

  // ---------------------------------------------------------------- Phase 2
  // Restart (new process, new state, same DSH home + same Codex daemon):
  // reconstructs the SAME pair — same session ids, same thread ids, advanced
  // Ticket-Lead HEAD preserved.
  const progressedBinding = firstReport.running[0];
  await writeFile(join(progressedBinding.worktree, "lead-progress.txt"), "Ticket Lead progress\n");
  await run("git", ["add", "lead-progress.txt"], { cwd: progressedBinding.worktree });
  await run("git", ["commit", "--quiet", "-m", "lead progress"], { cwd: progressedBinding.worktree });
  const progressedHead = (await run("git", ["rev-parse", "HEAD"], { cwd: progressedBinding.worktree })).stdout.trim();
  assert.notEqual(progressedHead, progressedBinding.baseSha);

  const restarted = reportsOf((await invoke(join(root, "state/restarted.json"), { maxActive: 2 })).stdout)[0];
  assert.deepEqual(restarted.running.map((item) => item.sessionId), firstReport.running.map((item) => item.sessionId));
  assert.deepEqual(restarted.running.map((item) => item.codexThreadId), firstReport.running.map((item) => item.codexThreadId));
  assert.ok(restarted.running.every((item) => item.live && item.validWorktree && item.sessionPersisted));
  assert.deepEqual(restarted.invalid, []);
  for (const binding of restarted.running) assert.equal(await countThreads(binding.codexName), 1);

  // ---------------------------------------------------------------- Phase 3
  // Moving base with rollback preservation: ticket 31 keeps its historical SHA,
  // ticket 32 admitted later against the new exact base.
  await writeFixtures({
    tickets: [
      ticketRecord(31, "S1"),
      ticketRecord(32, "S1", { blockers: [99], blockerStates: { 99: "OPEN" } }),
    ],
    claims: [],
  });
  const liveBase = (await git("rev-parse", "HEAD")).stdout.trim();
  let movedBase;
  const liveResult = await invokeLive(join(root, "state/live.json"), { stayAlive: true, maxPasses: 3, maxActive: 2, heartbeatIntervalMs: 300, baseSha: "", baseRef: "HEAD" }, async () => {
    await writeFile(join(scratchRepo, "README.md"), "disposable dispatcher smoke repository\nmoving base\n");
    await git("add", "README.md");
    await git("commit", "--quiet", "-m", "move smoke base");
    movedBase = (await git("rev-parse", "HEAD")).stdout.trim();
    const fixtures = await readFixtures();
    fixtures.tickets.find((ticket) => ticket.number === 32).blockerStates[99] = "CLOSED";
    await writeFixtures(fixtures);
  });
  const liveReports = reportsOf(liveResult.stdout);
  assert.equal(liveReports.length, 3);
  assert.deepEqual(liveReports[0].running.map((item) => item.number), [31]);
  const later = liveReports.find((report) => report.running.some((item) => item.number === 32));
  assert.ok(later, "blocker release must admit the successor within the bounded loop");
  const firstBinding = later.running.find((item) => item.number === 31);
  const laterBinding = later.running.find((item) => item.number === 32);
  assert.equal(firstBinding.baseSha, liveBase);
  assert.equal(laterBinding.baseSha, movedBase);
  assert.notEqual(firstBinding.baseSha, laterBinding.baseSha);
  assert.equal(new Set(liveReports.flatMap((report) => report.running.filter((item) => item.number === 31).map((item) => item.sessionId))).size, 1);
  for (const binding of liveReports.flatMap((r) => r.running)) assert.equal(await countThreads(binding.codexName), 1);

  // ---------------------------------------------------------------- Phase 4
  // REAL wake + watchdog: a fresh admission with wakeAgents on a real model.
  // The bootstrap followup is proof the DSH Ticket Lead began work; the
  // lifecycle-grounded watchdog then supervises the SAME session and retires
  // the Ticket on a durable closeout marker without any further wake.
  await writeFixtures({ tickets: [ticketRecord(41, "S2")], claims: [] });
  const wakeState = join(root, "state/wake.json");
  const wakeReport = reportsOf((await invoke(wakeState, { maxActive: 1, wakeAgents: true, codexThinking: "max" })).stdout)[0];
  assert.equal(wakeReport.running.length, 1);
  const woken = wakeReport.running[0];
  assert.equal(woken.dshName, "dsh-glasses-S2-#41-DSH");
  assert.equal(woken.sessionId, woken.dshName);
  assert.equal(woken.codex?.thinkingEffort, "max");
  // DSH began work: the bootstrap followup (containing the session identity)
  // was delivered into the real session log.
  const logText = await readSessionLog(woken.sessionId, woken);
  assert.match(logText, /assigned DSH session id is dsh-glasses-S2-#41-DSH/, "wake must deliver the bootstrap start into the real DSH session");

  // Watchdog: after a durable closeout marker appears, the pair is retired and
  // never woken again; the quiesced unfinished session is continued in place.
  const watchState = join(root, "state/watch.json");
  let closeoutApplied = false;
  const watchResult = await invokeLive(watchState, { stayAlive: true, maxPasses: 5, maxActive: 1, wakeAgents: true, heartbeatIntervalMs: 500 }, async () => {
    if (closeoutApplied) return;
    closeoutApplied = true;
    const fixtures = await readFixtures();
    const claim = collapseClaimMarkers(fixtures.claims).find((candidate) => candidate.number === 41);
    assert.ok(claim, "claim for 41 must exist before the closeout injection");
    fixtures.claims.push(`dispatcher-closeout: ${JSON.stringify({ schemaVersion: 1, ticket: 41, headSha: movedBase ?? claim.baseSha, codexThreadId: claim.codex?.threadId })}`);
    await writeFixtures(fixtures);
  });
  const watchReports = reportsOf(watchResult.stdout);
  assert.ok(watchReports.length > 1);
  const finalWatch = watchReports.at(-1);
  assert.deepEqual(finalWatch.running, [], "completed Ticket must be retired from the running set");
  assert.deepEqual(finalWatch.completed.map((item) => item.number), [41]);
  assert.equal(await countThreads("dsh-glasses-S2-#41-Codex"), 1, "pair retirement must not duplicate threads");

  // ---------------------------------------------------------------- Phase 5
  // Legacy deterministic paths (still against the real seams): missing session
  // is voided stale without touching Codex; branch readmission reuses the exact
  // deterministic DSH name after the durable void.
  const missing = {
    number: 51,
    sessionId: "dsh-glasses-S3-#51-DSH",
    branch: "workflow/ticket-51",
    worktree: join(worktreeRoot, `ticket-51-${movedBase.slice(0, 12)}`),
    baseSha: movedBase,
  };
  const missingClaim = `dispatcher-claim: ${JSON.stringify({ schemaVersion: 1, ticket: 51, sessionId: missing.sessionId, branch: missing.branch, worktree: missing.worktree, baseSha: missing.baseSha })}`;
  await writeFixtures({ tickets: [ticketRecord(51, "S3")], claims: [missingClaim] });
  const invalid = reportsOf((await invoke(join(root, "state/invalid.json"), { baseSha: movedBase })).stdout)[0];
  assert.deepEqual(invalid.running, []);
  assert.deepEqual(invalid.invalid, [{ number: 51, reason: "stale-session" }]);
  assert.deepEqual(invalid.ready, [51]);
  assert.match((await readFixtures()).claims.at(-1), /^dispatcher-claim:void /);

  await writeFixtures({ tickets: [ticketRecord(52, "S3")], claims: [] });
  const readmitState = join(root, "state/readmit.json");
  const originalReadmit = reportsOf((await invoke(readmitState, { baseSha: "", baseRef: "HEAD" })).stdout)[0].running[0];
  assert.equal(originalReadmit.sessionId, "dsh-glasses-S3-#52-DSH");
  await rm(join(sessionParent(originalReadmit), encodeSegment(originalReadmit.sessionId)), { recursive: true, force: true });
  const voidedReadmit = reportsOf((await invoke(readmitState, { baseSha: "", baseRef: "HEAD" })).stdout)[0];
  assert.deepEqual(voidedReadmit.invalid, [{ number: 52, reason: "stale-session" }]);
  assert.equal(JSON.parse(await readFile(readmitState, "utf8")).tickets[52].baseSha, originalReadmit.baseSha);
  await git("worktree", "remove", "--force", originalReadmit.worktree);
  await writeFile(join(scratchRepo, "README.md"), "disposable dispatcher smoke repository\nreadmission base\n");
  await git("add", "README.md");
  await git("commit", "--quiet", "-m", "move readmission base");
  const readmitBase = (await git("rev-parse", "HEAD")).stdout.trim();
  const readmitted = reportsOf((await invoke(readmitState, { baseSha: "", baseRef: "HEAD" })).stdout)[0].running[0];
  assert.equal(readmitted.baseSha, readmitBase);
  assert.notEqual(readmitted.baseSha, originalReadmit.baseSha);
  assert.equal(readmitted.branch, originalReadmit.branch);
  assert.equal(readmitted.sessionId, originalReadmit.sessionId, "readmission reuses the exact deterministic name");
  assert.equal(readmitted.live, true);
  assert.equal((await run("git", ["branch", "--show-current"], { cwd: readmitted.worktree })).stdout.trim(), readmitted.branch);
  assert.equal(await countThreads(readmitted.codexName), 1);

  const scratchWt = (await run("git", ["worktree", "list"], { cwd: scratchRepo })).stdout;
  assert.ok(scratchWt.includes(worktreeRoot), "all dispatcher worktrees stay under the dispatcher root");
  const states = [...new Set(firstReport.running.map((item) => item.sessionId))];
  process.stdout.write("dsh-ticket-dispatcher smoke: PASS\n");
  process.stdout.write(`SMOKE pair-admission: sessions=${states.join(",")} threads=${firstReport.running.map((item) => item.codexThreadId).join(",")}\n`);
  process.stdout.write(`SMOKE named-sessions: ${firstReport.running.map((item) => `${item.dshName}@${item.sessionId}`).join(" | ")}\n`);
  process.stdout.write(`SMOKE codex-first-prompt-exact: ${firstReport.running.map((item) => `${item.codexName}=${item.codex.firstPrompt}`).join(" | ")}\n`);
  process.stdout.write(`SMOKE restart-reconstruct: same_sessions=${restarted.running.length}/${firstReport.running.length} same_threads=true live=true invalid=0\n`);
  process.stdout.write(`SMOKE moving-base: ticket31=${firstBinding.baseSha} ticket32=${laterBinding.baseSha}\n`);
  process.stdout.write(`SMOKE real-wake: dsh_session=${woken.sessionId} codex_thread=${woken.codexThreadId} thinking=${woken.codex.thinkingEffort}\n`);
  process.stdout.write(`SMOKE watchdog-completed: retired_ticket=41 running_after=${finalWatch.running.length} thread_count=1\n`);
  process.stdout.write(`SMOKE invalid-claim: ticket=51 reason=stale-session tombstone=true ready=true\n`);
  process.stdout.write(`SMOKE branch-readmission: ticket=52 same_name=true new_base=${readmitted.baseSha}\n`);
  process.stdout.write("SMOKE scope: no product code or Rokid touched (scratch repo/worktrees only)\n");
} finally {
  if (process.env.KEEP_SMOKE) process.stdout.write(`smoke retained: ${root}\n`);
  else await rm(root, { recursive: true, force: true });
}
