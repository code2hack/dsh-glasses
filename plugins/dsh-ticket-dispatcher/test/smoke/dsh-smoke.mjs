import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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

const run = (file, args, options = {}) => exec(file, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, ...options });
const git = (...args) => run("git", args, { cwd: scratchRepo });
const quote = (value) => JSON.stringify(value);
const writeFixtures = (data) => writeFile(fixturesPath, `${JSON.stringify(data, null, 2)}\n`);
const readFixtures = async () => JSON.parse(await readFile(fixturesPath, "utf8"));

function overlayText(statePath, options = {}) {
  const config = {
    baseSha: options.baseSha ?? baseSha,
    baseRef: options.baseRef ?? "HEAD",
    fetch: options.fetch ?? false,
    maxActive: options.maxActive ?? 3,
    stayAlive: options.stayAlive ?? false,
    intervalMs: options.intervalMs ?? 100,
    maxPasses: options.maxPasses ?? 0,
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
        intervalMs: ${config.intervalMs}
        maxPasses: ${config.maxPasses}
        wakeAgents: false
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
  await writeFile(overlay, overlayText(statePath, options));
  return run(dshBin, ["--profile", "smoke", "--patch", overlay, "reconcile"], {
    env: { ...process.env, DSH_HOME: dshHome },
    timeout: 60_000,
  });
}

async function invokeLive(statePath, afterFirstPass) {
  await writeFile(overlay, overlayText(statePath, { baseSha: "", baseRef: "HEAD", fetch: false, stayAlive: true, intervalMs: 500, maxPasses: 3 }));
  const child = spawn(dshBin, ["--profile", "smoke", "--patch", overlay, "reconcile"], {
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let mutation;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!mutation && stdout.includes("Ticket Dispatcher:")) mutation = Promise.resolve().then(afterFirstPass);
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 60_000);
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

let baseSha;
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

  const originalFixtures = {
    tickets: [21, 22].map((number) => ({ number, state: "OPEN", blockers: [], url: `https://github.com/code2hack/dsh-glasses/issues/${number}` })),
    claims: [],
  };
  await writeFixtures(originalFixtures);
  const firstState = join(root, "state/first.json");
  const firstReport = reportsOf((await invoke(firstState)).stdout)[0];
  assert.deepEqual(firstReport.running.map((item) => item.number), [21, 22]);
  assert.equal(new Set(firstReport.running.map((item) => item.sessionId)).size, 2);
  assert.equal(new Set(firstReport.running.map((item) => item.worktree)).size, 2);
  assert.ok(firstReport.running.every((item) => item.live));
  for (const binding of firstReport.running) {
    assert.equal(binding.baseSha, baseSha);
    assert.equal((await stat(binding.worktree)).isDirectory(), true);
  }
  const saved = JSON.parse(await readFile(firstState, "utf8"));
  for (const number of [21, 22]) {
    assert.match(saved.tickets[number].bootstrapPrompt, /AGENTS\.md section 3/);
    assert.match(saved.tickets[number].bootstrapPrompt, new RegExp(`issues/${number}`));
  }

  const repeated = reportsOf((await invoke(firstState)).stdout)[0];
  assert.deepEqual(repeated.running.map((item) => item.sessionId), firstReport.running.map((item) => item.sessionId));
  const claimsAfterFirst = (await readFixtures()).claims;
  assert.equal(claimsAfterFirst.length, 2);

  const sessionEntriesBefore = await Promise.all(firstReport.running.map(async (binding) => [binding.sessionId, (await readdir(sessionParent(binding))).sort()]));
  await writeFixtures({ ...originalFixtures, claims: claimsAfterFirst });
  const restarted = reportsOf((await invoke(join(root, "state/restarted.json"))).stdout)[0];
  assert.deepEqual(restarted.running.map((item) => item.sessionId), firstReport.running.map((item) => item.sessionId));
  assert.ok(restarted.running.every((item) => item.live && item.validWorktree && item.sessionPersisted));
  const sessionEntriesAfter = await Promise.all(firstReport.running.map(async (binding) => [binding.sessionId, (await readdir(sessionParent(binding))).sort()]));
  assert.deepEqual(sessionEntriesAfter, sessionEntriesBefore);
  assert.equal((await readFixtures()).claims.length, 2);

  await writeFixtures({
    tickets: [
      { number: 31, state: "OPEN", blockers: [], url: "https://example.test/issues/31" },
      { number: 32, state: "OPEN", blockers: [99], blockerStates: { 99: "OPEN" }, url: "https://example.test/issues/32" },
    ],
    claims: [],
  });
  const liveBase = (await git("rev-parse", "HEAD")).stdout.trim();
  let movedBase;
  const liveResult = await invokeLive(join(root, "state/live.json"), async () => {
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
  assert.ok(later);
  const firstBinding = later.running.find((item) => item.number === 31);
  const laterBinding = later.running.find((item) => item.number === 32);
  assert.equal(firstBinding.baseSha, liveBase);
  assert.equal(laterBinding.baseSha, movedBase);
  assert.notEqual(firstBinding.baseSha, laterBinding.baseSha);
  assert.equal(new Set(liveReports.flatMap((report) => report.running.filter((item) => item.number === 31).map((item) => item.sessionId))).size, 1);

  const missing = {
    number: 41,
    sessionId: "session-deliberately-missing",
    branch: "workflow/ticket-41",
    worktree: join(worktreeRoot, `ticket-41-${movedBase.slice(0, 12)}`),
    baseSha: movedBase,
  };
  const missingClaim = `dispatcher-claim: ${JSON.stringify({ schemaVersion: 1, ticket: missing.number, sessionId: missing.sessionId, branch: missing.branch, worktree: missing.worktree, baseSha: missing.baseSha })}`;
  await writeFixtures({ tickets: [{ number: 41, state: "OPEN", blockers: [], url: "https://example.test/issues/41" }], claims: [missingClaim] });
  const invalid = reportsOf((await invoke(join(root, "state/invalid.json"), { baseSha: movedBase })).stdout)[0];
  const invalidFixtures = await readFixtures();
  assert.deepEqual(invalid.running, []);
  assert.deepEqual(invalid.invalid, [{ number: 41, reason: "stale-session" }]);
  assert.deepEqual(invalid.ready, [41]);
  assert.match(invalidFixtures.claims.at(-1), /^dispatcher-claim:void /);

  process.stdout.write("dsh-ticket-dispatcher smoke: PASS\n");
  process.stdout.write(`SMOKE live-reconcile: ticket=32 admitted_on_pass=${liveReports.indexOf(later) + 1} session=${laterBinding.sessionId}\n`);
  process.stdout.write(`SMOKE moving-base: ticket31=${firstBinding.baseSha} ticket32=${laterBinding.baseSha}\n`);
  process.stdout.write(`SMOKE restart-resume: live=true same_sessions=${restarted.running.map((item) => item.sessionId).join(",")}\n`);
  process.stdout.write("SMOKE invalid-claim: ticket=41 reason=stale-session tombstone=true ready=true\n");
} finally {
  if (process.env.KEEP_SMOKE) process.stdout.write(`smoke retained: ${root}\n`);
  else await rm(root, { recursive: true, force: true });
}
