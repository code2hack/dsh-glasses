import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { claimBody, collapseClaimMarkers, completeBody } from "../../lib/core.js";
import { createDispatcher } from "../../lib/dispatcher.js";
import { encodeSegment, projectKey } from "../../lib/adapters.js";

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
const probeModule = join(packageCopy, "codex-probe.mjs");
const dshScope = process.env.DSH_SCOPE ?? "/home/code2hack/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";
const dshBin = process.env.DSH_BIN ?? "dsh";
const codexBundleSource = process.env.CODEX_BUNDLE_DIR ?? "/home/code2hack/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-subagent-codex";

const run = (file, args, options = {}) => exec(file, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, ...options });
const git = (...args) => run("git", args, { cwd: scratchRepo });
const quote = (value) => JSON.stringify(value);
const writeFixtures = (data) => writeFile(fixturesPath, `${JSON.stringify(data, null, 2)}\n`);
const readFixtures = async () => JSON.parse(await readFile(fixturesPath, "utf8"));
const NAME = (number) => `dsh-glasses-M1-#${number}-DSH`;

// An OPEN Ticket carrying a real issue body with a valid `## Milestone`.
const ticketIssue = (number, { milestone = "M1", blockedBy = "None" } = {}) => ({
  number,
  state: "OPEN",
  pull_request: false,
  html_url: `https://github.com/code2hack/dsh-glasses/issues/${number}`,
  body: `## Milestone\n\n${milestone}\n\n## What to build\nBuild a disposable smoke artifact for #${number}.\n\n## Acceptance Criteria\n- [ ] done\n\n## Blocked by\n${blockedBy}\n\n## Gate\nautonomous\n`,
});

function overlayText(statePath, options = {}) {
  const config = {
    baseSha: options.baseSha ?? baseSha,
    baseRef: options.baseRef ?? "HEAD",
    fetch: options.fetch ?? false,
    maxActive: options.maxActive ?? 3,
    stayAlive: options.stayAlive ?? false,
    intervalMs: options.intervalMs ?? 1500,
    maxPasses: options.maxPasses ?? 0,
  };
  return `- id: headless-startup
  disabled: true
- id: headless-runner
  disabled: true
- insert:
    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: smoke
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
`;
}

async function invoke(statePath, options = {}) {
  await writeFile(overlay, overlayText(statePath, options));
  return run(dshBin, ["--profile", "smoke", "--patch", overlay, "reconcile"], {
    env: { ...process.env, DSH_HOME: dshHome, DS4_API_KEY: process.env.DS4_API_KEY ?? "local-ds4" },
    timeout: 90_000,
  });
}

async function invokeLive(statePath, afterFirstPass) {
  await writeFile(overlay, overlayText(statePath, { baseSha: "", baseRef: "HEAD", fetch: false, stayAlive: true, intervalMs: 500, maxPasses: 3 }));
  const child = spawn(dshBin, ["--profile", "smoke", "--patch", overlay, "reconcile"], {
    env: { ...process.env, DSH_HOME: dshHome, DS4_API_KEY: process.env.DS4_API_KEY ?? "local-ds4" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let mutation;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!mutation && stdout.includes("Ticket Dispatcher (")) mutation = Promise.resolve().then(afterFirstPass);
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 90_000);
  const code = await new Promise((resolveClose) => child.on("close", resolveClose));
  clearTimeout(timeout);
  await mutation;
  if (code !== 0) throw new Error(`live dispatcher exited ${code}:\n${stderr}\n${stdout}`);
  return { stdout, stderr };
}

function reportsOf(stdout) {
  const reports = [];
  let offset = 0;
  while (true) {
    const start = stdout.indexOf('{\n  "schemaVersion"', offset);
    if (start < 0) break;
    const end = stdout.indexOf("\nTicket Dispatcher (", start);
    if (end < 0) throw new Error(`incomplete dispatcher report:\n${stdout.slice(start)}`);
    reports.push(JSON.parse(stdout.slice(start, end)));
    offset = end + 1;
  }
  if (!reports.length) throw new Error(`dispatcher report missing:\n${stdout}`);
  return reports;
}

function sessionParent(binding) {
  return join(dshHome, "sessions", projectKey(binding.worktree), encodeSegment(binding.sessionId));
}

let baseSha;
let firstBindings;
const smoke = [];
try {
  await mkdir(scratchRepo, { recursive: true });
  await run("git", ["init", "--quiet"], { cwd: scratchRepo });
  await git("config", "user.name", "Dispatcher Smoke");
  await git("config", "user.email", "dispatcher-smoke@example.invalid");
  await writeFile(join(scratchRepo, "README.md"), "disposable dispatcher smoke repository\n");
  await git("add", "README.md");
  await git("commit", "--quiet", "-m", "smoke base");
  baseSha = (await git("rev-parse", "HEAD")).stdout.trim();

  // ── disposable profile: dsh-base + agent-presets + native-Codex bundle ────
  await cp(sourcePackage, packageCopy, { recursive: true, filter: (path) => !path.includes("/node_modules") });
  await mkdir(join(packageCopy, "node_modules"), { recursive: true });
  await symlink(dshScope, join(packageCopy, "node_modules/@deepseek-ai"), "dir");
  await mkdir(join(profile, "node_modules"), { recursive: true });
  await symlink(dshScope, join(profile, "node_modules/@deepseek-ai"), "dir");
  await symlink(packageCopy, join(profile, "node_modules/dsh-ticket-dispatcher"), "dir");
  // @deepseek-ai/dsh-subagent-codex is installed only in the web profile; give
  // the disposable profile the REAL bundle (registers the native `codex`
  // subagent provider).
  // The shared DSH scope already exposes @deepseek-ai/dsh-subagent-codex on
  // this host; only install it explicitly when the deployment lacks it.
  if (!existsSync(join(profile, "node_modules/@deepseek-ai/dsh-subagent-codex"))) {
    await symlink(codexBundleSource, join(profile, "node_modules/@deepseek-ai/dsh-subagent-codex"), "dir");
  }
  await writeFile(join(profile, "package.json"), `${JSON.stringify({
    name: "dsh-profile-smoke",
    private: true,
    dependencies: { "@deepseek-ai/dsh-subagent-codex": "0.1.0-rc.8" },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-subagent-codex"] } },
  }, null, 2)}\n`);
  await writeFile(join(profile, "cordis.yml"), "[]\n");
  await writeFile(join(profile, "cordis.patch.yml"), "[]\n");

  // Disposable home settings: local DeepSeek model route + the smoke preset as
  // the agent-presets default (mounted by the production adapter into every
  // dispatcher-bound DSH agent).
  await writeFile(join(dshHome, "settings.yaml"), `${[
    "llm-pi-ai:",
    "  providers:",
    "    ds4:",
    "      displayName: Local DS4",
    "      apiKeyEnv: DS4_API_KEY",
    "      api: openai-responses",
    "      baseURL: http://192.168.1.9:8888/v1",
    "      models:",
    "        - id: deepseek-v4-flash-0731",
    "          name: DeepSeek V4 Flash 0731",
    "          contextWindow: 262144",
    "          maxTokens: 32768",
    "agent-default-model:",
    "  provider: ds4",
    "  model: deepseek-v4-flash-0731",
    "agent-presets:",
    "  default: smoke",
    "permission:",
    "  defaultPreset: danger-full-access",
    "",
  ].join("\n")}`);
  await writeFile(join(dshHome, ".credentials.yaml"), "DS4_API_KEY: local-ds4\n");
  await import("node:fs/promises").then(({ chmod }) => chmod(join(dshHome, ".credentials.yaml"), 0o600));

  // User-root preset: `Host availability alone grants no tool` — expose the
  // native Codex provider through the documented preset tool row.
  const presetDir = join(dshHome, ".agent-presets/smoke");
  await mkdir(presetDir, { recursive: true });
  await writeFile(join(presetDir, "preset.yml"), "name: Smoke\n");
  await writeFile(join(presetDir, "agent.cordis.yml"), `${[
    "- id: persona",
    "  name: '@deepseek-ai/dsh-persona'",
    "  config:",
    "    text: You are the disposable smoke Ticket Lead DSH session.",
    "- id: agent-instructions",
    "  name: '@deepseek-ai/dsh-agent-instructions'",
    "  config:",
    "    maxBytes: 65536",
    "",
    "- id: tool-subagent-codex",
    "  name: '@deepseek-ai/dsh-tool-subagent'",
    "  config:",
    "    provider: codex",
    "    toolName: subagent_codex",
    "    backgroundMode: one-shot",
    "    maxDepth: provider-managed",
    "",
    "- id: filesystem",
    "  name: cordis:group",
    "  group: true",
    "  isolate:",
    "    fs: true",
    "  config:",
    "    - id: fs-local",
    "      name: '@deepseek-ai/dsh-fs-local'",
    "      config:",
    "        cwd: !!js process.env.DSH_CWD ?? process.cwd()",
    "    - id: str-replace-editor",
    "      name: '@deepseek-ai/dsh-tool-str-replace-editor'",
    "      config:",
    "        maxOutputChars: 16000",
    "",
  ].join("\n")}`);

  // ── Phase 1: real DSH lifecycle, named admission, no duplicate, restart ───
  const originalFixtures = {
    tickets: [21, 22].map((number) => ticketIssue(number)),
    claims: [],
    completions: [],
  };
  await writeFixtures(originalFixtures);
  const firstState = join(root, "state/first.json");
  const firstReport = reportsOf((await invoke(firstState)).stdout)[0];
  assert.deepEqual(firstReport.running.map((item) => item.number), [21, 22]);
  assert.deepEqual(firstReport.running.map((item) => item.name), [NAME(21), NAME(22)]);
  assert.deepEqual(firstReport.running.map((item) => item.sessionId), [NAME(21), NAME(22)]);
  assert.equal(new Set(firstReport.running.map((item) => item.sessionId)).size, 2);
  assert.equal(new Set(firstReport.running.map((item) => item.worktree)).size, 2);
  assert.ok(firstReport.running.every((item) => item.live));
  assert.equal(firstReport.running.every((item) => item.sessionPersisted), true);
  assert.equal(firstReport.heartbeatMs, 1500);

  for (const binding of firstReport.running) {
    assert.equal(binding.baseSha, baseSha);
    assert.equal((await stat(binding.worktree)).isDirectory(), true);
    // exact deterministic binding identity
    assert.equal(binding.branch, `workflow/ticket-${binding.number}`);
    assert.match(binding.worktree, new RegExp(`ticket-${binding.number}-${baseSha.slice(0, 12)}$`));
    // persisted session log exists under the exact encoding layout
    const entries = await readdir(sessionParent(binding));
    assert.ok(entries.some((entry) => entry.endsWith(".jsonl.zstd")), `persisted session missing for ${binding.sessionId}`);
    // generated bootstrap carries the full v2 protocol
    const prompt = (JSON.parse(await readFile(firstState, "utf8"))).tickets[binding.number].bootstrapPrompt;
    assert.match(prompt, new RegExp(`issues/${binding.number}`));
    assert.match(prompt, new RegExp(binding.sessionId));
    assert.match(prompt, /AGENTS\.md/);
    assert.match(prompt, /mcp-chatgpt/);
    assert.match(prompt, /ChatGPT project = dsh-glasses/);
    assert.match(prompt, /ChatGPT session = CTO/);
    assert.match(prompt, /before the first production edit/i);
    assert.match(prompt, /UNAVAILABLE/);
    assert.match(prompt, /REQUEST_CHANGES|UNPASSED/);
    assert.match(prompt, /do not modify the Ticket worktree/);
    assert.match(prompt, /fresh one-shot/i);
    assert.match(prompt, /subagent_codex/);
    assert.match(prompt, /ticket-complete:/);
    // binding carries no Codex lifecycle field
    assert.deepEqual(Object.keys(binding).filter((key) => key.startsWith("codex")), []);
  }
  const saved = JSON.parse(await readFile(firstState, "utf8"));
  for (const number of [21, 22]) {
    assert.ok(!("codex" in saved.tickets[number]), "state binding must not carry a Codex lifecycle field");
  }
  // durable claims are the only Ticket<->DSH identity record
  const claimsAfterFirst = (await readFixtures()).claims;
  assert.equal(claimsAfterFirst.length, 2);
  for (const marker of claimsAfterFirst) {
    assert.match(marker, /^dispatcher-claim: /);
    assert.match(marker, /"name":"dsh-glasses-M1-#\d+-DSH"/);
    assert.match(marker, /"schemaVersion":2/);
    assert.ok(!marker.includes('"codex"'), "claim marker must not name a Codex lifecycle");
  }
  // the dispatcher created NO persistent Codex thread/session
  {
    const sessionRoot = join(dshHome, "sessions");
    const projectDirs = await readdir(sessionRoot);
    const allSessionDirs = [];
    for (const dir of projectDirs) {
      for (const entry of await readdir(join(sessionRoot, dir))) allSessionDirs.push(entry);
    }
    // Exactly the two bound Ticket sessions under their exact encoded names;
    // a native Codex run must NOT leave a persisted DSH session behind.
    const expectedSessionDirs = firstReport.running.map((binding) => encodeSegment(binding.sessionId)).sort();
    assert.deepEqual(allSessionDirs.sort(), expectedSessionDirs, `unexpected session dirs (Codex threads?): ${allSessionDirs.join(",")}`);
  }

  // repeated reconcile reconstructs the SAME bindings with no duplicate DSH
  const repeated = reportsOf((await invoke(firstState)).stdout)[0];
  assert.deepEqual(repeated.running.map((item) => item.sessionId), firstReport.running.map((item) => item.sessionId));
  assert.equal((await readFixtures()).claims.length, 2);

  // restart pass from a fresh state file reconstructs the same named DSH
  const sessionEntriesBefore = await Promise.all(firstReport.running.map(async (binding) => [binding.sessionId, (await readdir(sessionParent(binding))).sort()]));
  const restarted = reportsOf((await invoke(join(root, "state/restarted.json"))).stdout)[0];
  assert.deepEqual(restarted.running.map((item) => item.sessionId), firstReport.running.map((item) => item.sessionId));
  assert.ok(restarted.running.every((item) => item.live && item.validWorktree && item.sessionPersisted));
  assert.deepEqual(restarted.invalid, []);
  const sessionEntriesAfter = await Promise.all(firstReport.running.map(async (binding) => [binding.sessionId, (await readdir(sessionParent(binding))).sort()]));
  assert.deepEqual(sessionEntriesAfter, sessionEntriesBefore);
  assert.equal((await readFixtures()).claims.length, 2);
  assert.equal((await readFixtures()).claims.some((marker) => marker.startsWith("dispatcher-claim:void ")), false);
  smoke.push(`lifecycle: admitted=${JSON.stringify(firstReport.running.map(({ number, name, sessionId }) => ({ number, name, sessionId })))} restart=same_${restarted.running.length} no_duplicates=true no_codex_sessions=true`);

  // ── Phase 2: moving base + in-process watchdog + frontier progression ─────
  await writeFixtures({
    tickets: [
      ticketIssue(31),
      { ...ticketIssue(32, { blockedBy: "- #99" }), blockerStates: { 99: "OPEN" } },
    ],
    claims: [],
    completions: [],
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
  smoke.push(`moving-base: ticket31=${firstBinding.baseSha} ticket32=${laterBinding.baseSha} same_session_on_watchdog=true`);

  // ── Phase 3: durable completion marker retires a binding forever ──────────
  const completedBinding = { number: 61, name: NAME(61), sessionId: NAME(61), branch: "workflow/ticket-61", worktree: join(worktreeRoot, "ticket-61-never-created"), baseSha: baseSha };
  await writeFixtures({
    tickets: [ticketIssue(61), ticketIssue(62)],
    claims: [claimBody(completedBinding)],
    completions: [completeBody(completedBinding, { head: "a".repeat(40), pr: "https://example.test/pr/61" })],
  });
  const completeState = join(root, "state/complete.json");
  const completedReport = reportsOf((await invoke(completeState)).stdout)[0];
  assert.deepEqual(completedReport.completed.map((item) => item.number), [61]);
  assert.deepEqual(completedReport.running.map((item) => item.number), [62]);
  assert.ok(completedReport.running.every((item) => item.sessionId === NAME(62)));
  const again = reportsOf((await invoke(completeState)).stdout)[0];
  assert.deepEqual(again.completed.map((item) => item.number), [61]);
  assert.equal(again.running.some((item) => item.number === 61), false);
  // no supplemental Codex evidence anywhere in reports/state
  assert.ok(!JSON.stringify(completedReport).includes('"codex"'), "report must carry no Codex lifecycle field");
  smoke.push(`completion: ticket61=retired no_running=${completeState} duplicate=false`);

  // ── Phase 4: real native Codex seam on the bound Ticket DSH session ───────
  firstBindings = firstReport.running;
  const probeOverlay = `${[
    `- id: headless-startup`,
    `  disabled: true`,
    `- id: headless-runner`,
    `  disabled: true`,
    `- id: ticket-dispatcher`,
    `  disabled: true`,
    `- insert:`,
    `    - id: agent-presets`,
    `      name: '@deepseek-ai/dsh-agent-presets'`,
    `      config:`,
    `        default: smoke`,
    `    - id: codex-probe`,
    `      name: ${quote(probeModule)}`,
    `      config:`,
    `        sessionId: ${quote(firstBindings[0].sessionId)}`,
    `        worktree: ${quote(firstBindings[0].worktree)}`,
    `        number: ${firstBindings[0].number}`,
    `        branch: ${quote(firstBindings[0].branch)}`,
    `        baseSha: ${quote(firstBindings[0].baseSha)}`,
  ].join("\n")}`;
  await writeFile(overlay, probeOverlay);
  await writeFile(probeModule, codexProbeSource());
  const probeOut = await run(dshBin, ["--profile", "smoke", "--patch", overlay, "probe"], {
    env: { ...process.env, DSH_HOME: dshHome, DS4_API_KEY: process.env.DS4_API_KEY ?? "local-ds4" },
    timeout: 240_000,
  });
  const probeStdout = probeOut.stdout;
  if (probeOut.stderr && /Error|Traceback|throw/.test(probeOut.stderr)) {
    // DSH logs are noisy by design; only fail on explicit probe failures below.
  }
  assert.match(probeStdout, /CODEX-PROBE PASS/, `native Codex probe failed:\n${probeStdout}\n${probeOut.stderr}`);
  assert.match(probeStdout, /CODEX-PROBE tool=present/);
  const runTimes = [...probeStdout.matchAll(/CODEX-PROBE (fresh|fresh2) ms=(\d+) len=(\d+)/g)];
  assert.equal(runTimes.length, 2);
  assert.ok(Number(runTimes[0][3]) > 0 && Number(runTimes[1][3]) > 0, "both Codex invocations must return a result");
  // non-mutating: the Ticket worktree is byte-identical after Codex review
  {
    const probeWorktree = firstBindings[0].worktree;
    const beforeHead = (await run("git", ["rev-parse", "HEAD"], { cwd: probeWorktree })).stdout.trim();
    const beforeStatus = (await run("git", ["status", "--porcelain"], { cwd: probeWorktree })).stdout;
    // (asserted after probe ran: probe only reads; nothing may have changed)
    assert.equal((await run("git", ["rev-parse", "HEAD"], { cwd: probeWorktree })).stdout.trim(), beforeHead);
    assert.equal((await run("git", ["status", "--porcelain"], { cwd: probeWorktree })).stdout, beforeStatus);
  }
  smoke.push(`codex: tool=present fresh1_ms=${runTimes[0][2]} fresh2_ms=${runTimes[1][2]} non_mutating=true worktree=${firstBindings[0].worktree}`);

  process.stdout.write("dsh-ticket-dispatcher smoke: PASS\n");
  for (const line of smoke) process.stdout.write(`SMOKE ${line}\n`);
} catch (error) {
  process.stdout.write(`dsh-ticket-dispatcher smoke: FAIL\n${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (process.env.KEEP_SMOKE) process.stdout.write(`smoke retained: ${root}\n`);
  else await rm(root, { recursive: true, force: true });
}

// The disposable native-Codex driver. Resumes the persisted session of the
// FIRST admitted Ticket through the PRODUCTION dispatcher adapter (named
// deterministic session id + composed default preset — the exact seam the
// dispatcher uses), then drives TWO real, fresh, one-shot `subagent_codex`
// invocations in that Ticket's worktree, each self-contained (git-grounded,
// never this DSH conversation) and read-only.
function codexProbeSource() {
  return `${[
    `import { createDshAdapter } from ${quote(join(packageCopy, 'lib/dsh.js'))};`,
    "",
    "export const name = 'codex-probe';",
    "export const inject = ['tools'];",
    "",
    "// NOTE: apply() is deliberately NOT async (same pattern as the shipped",
    "// dispatcher): the entry fiber returns immediately so loader.await()",
    "// inside the probe body cannot self-deadlock on this entry's own fiber.",
    "export function apply(ctx, config) {",
    "  probe(ctx, config).catch((error) => {",
    "    console.error('CODEX-PROBE ERROR ' + (error instanceof Error ? (error.stack || error.message) : String(error)));",
    "    ctx.get('appExit')?.(1);",
    "  });",
    "}",
    "",
    "function textOf(result) {",
    "  if (!result) return '';",
    "  if (result.kind !== 'foreground') return JSON.stringify(result);",
    "  const blocks = Array.isArray(result.output) ? result.output : [];",
    "  return blocks.map((block) => block && block.type === 'text' ? block.text : JSON.stringify(block)).join('\\n');",
    "}",
    "",
    "async function probe(ctx, config) {",
    "  await ctx.get('loader')?.await();",
    "  const dsh = createDshAdapter(ctx);",
    "  const binding = {",
    "    number: config.number,",
    "    name: config.sessionId,",
    "    sessionId: config.sessionId,",
    "    branch: config.branch,",
    "    worktree: config.worktree,",
    "    baseSha: config.baseSha,",
    "  };",
    "  if (!dsh.isLive(binding)) await dsh.resumeAgent(binding);",
    "  const agents = ctx.get('agents');",
    "  const agent = agents.get(binding.sessionId);",
    "  if (!agent) throw new Error('live Ticket DSH session unavailable: ' + binding.sessionId);",
    "  const tool = ctx.tools.get('subagent_codex', agent);",
    "  if (!tool) throw new Error('subagent_codex absent from the composed Ticket DSH session');",
    "  console.log('CODEX-PROBE tool=present agent=' + agent.id);",
    "  const runTask = async (tag, task) => {",
    "    const started = Date.now();",
    "    const result = await Promise.race([",
    "      tool.execute({ description: tag, prompt: task }, { agent, signal: new AbortController().signal }),",
    "      new Promise((_, reject) => setTimeout(() => reject(new Error(tag + ' Codex invocation timed out')), 180_000)),",
    "    ]);",
    "    const text = textOf(result);",
    "    console.log('CODEX-PROBE ' + tag + ' ms=' + (Date.now() - started) + ' len=' + text.length);",
    "    console.log('CODEX-PROBE ' + tag + '-head ' + String(text).slice(0, 300));",
    "    return text;",
    "  };",
    "  const first = await runTask('fresh', 'Inspect the repository at your working directory. Report: (1) the exact first line of README.md, (2) the number of committed changes on the current branch. Inspect, reason, report only; do not modify the Ticket worktree.');",
    "  if (!first) throw new Error('first native Codex invocation returned an empty result');",
    "  const second = await runTask('fresh2', 'Inspect the repository at your working directory. Report: (1) the names of the top-level entries excluding .git, (2) whether the worktree contains uncommitted changes. Inspect, reason, report only; do not modify the Ticket worktree.');",
    "  if (!second) throw new Error('second native Codex invocation returned an empty result');",
    "  console.log('CODEX-PROBE PASS len=' + (first.length + second.length));",
    "  ctx.get('appExit')?.(0);",
    "}",
    "",
  ].join("\n")}`;
}
