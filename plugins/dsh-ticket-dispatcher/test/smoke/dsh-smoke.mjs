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
  // Disposable presets: `smoke` exposes the native subagent_codex reviewer;
  // `smoke-nocodex` composes the SAME agent surface without it (used to make
  // the reviewer deterministically UNAVAILABLE for the both-helpers-down leg).
  const smokePresetRows = (includeCodex) => {
    const rows = [
      "- id: persona",
      "  name: '@deepseek-ai/dsh-persona'",
      "  config:",
      "    text: You are the disposable smoke Ticket Lead DSH session.",
      "- id: agent-instructions",
      "  name: '@deepseek-ai/dsh-agent-instructions'",
      "  config:",
      "    maxBytes: 65536",
    ];
    if (includeCodex) {
      rows.push("", "- id: tool-subagent-codex", "  name: '@deepseek-ai/dsh-tool-subagent'", "  config:", "    provider: codex", "    toolName: subagent_codex", "    backgroundMode: one-shot", "    maxDepth: provider-managed");
    }
    rows.push("", "- id: filesystem", "  name: cordis:group", "  group: true", "  isolate:", "    fs: true", "  config:", "    - id: fs-local", "      name: '@deepseek-ai/dsh-fs-local'", "      config:", "        cwd: !!js process.env.DSH_CWD ?? process.cwd()", "    - id: str-replace-editor", "      name: '@deepseek-ai/dsh-tool-str-replace-editor'", "      config:", "        maxOutputChars: 16000", "");
    return rows.join("\n");
  };
  for (const name of ["smoke", "smoke-nocodex"]) {
    const presetDir = join(dshHome, ".agent-presets", name);
    await mkdir(presetDir, { recursive: true });
    await writeFile(join(presetDir, "preset.yml"), "name: Smoke\n");
    await writeFile(join(presetDir, "agent.cordis.yml"), smokePresetRows(name === "smoke"));
  }

  // ── Pinned-deployment report: WHICH exact DSH/Codex composition ran ──────
  // These pins are the validated deployment on this host. They are asserted
  // for equality, not just existence: if the pinned deployment moves, the
  // smoke fails loudly and the evidence/pins must be updated deliberately.
  const PINNED_DSH_VERSION = "0.1.0-rc.8";
  const PINNED_CODEX_VERSION = "0.148.0";
  const pinned = [];
  for (const bundle of ["dsh-base", "dsh-session-persistence-jsonl", "dsh-subagent-codex", "dsh-tool-subagent", "dsh-agent-presets"]) {
    const manifest = join(profile, "node_modules/@deepseek-ai", bundle, "package.json");
    const version = existsSync(manifest) ? JSON.parse(await readFile(manifest, "utf8")).version : "missing";
    assert.equal(version, PINNED_DSH_VERSION, `pinned bundle @deepseek-ai/${bundle} must equal ${PINNED_DSH_VERSION}, got ${version}`);
    pinned.push(`${bundle}=${version}`);
  }
  const codexVersion = (await run("codex", ["--version"], { env: process.env })).stdout.trim().split(/\s+/).pop() || "unknown";
  assert.equal(codexVersion, PINNED_CODEX_VERSION, `codex CLI must equal ${PINNED_CODEX_VERSION}, got ${codexVersion}`);
  smoke.push(`pinned: ${pinned.join(" ")} codex=${codexVersion}`);
  console.log(`SMOKE pinned: dsh/Codex deployment = ${pinned.join(" ")} codex=${codexVersion}`);

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
  // Outer non-mutation witness: capture the Ticket worktree identity BEFORE
  // the probe (and therefore before any Codex invocation) runs at all.
  const outerProbeWorktree = firstBindings[0].worktree;
  const outerBeforeHead = (await run("git", ["rev-parse", "HEAD"], { cwd: outerProbeWorktree })).stdout.trim();
  const outerBeforeStatus = (await run("git", ["status", "--porcelain"], { cwd: outerProbeWorktree })).stdout;
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
  assert.match(probeStdout, /CODEX-PROBE non-mutating=true/, "probe must witness byte-identical worktree state across both Codex invocations");
  const runTimes = [...probeStdout.matchAll(/CODEX-PROBE (fresh|fresh2) ms=(\d+) len=(\d+)/g)];
  assert.equal(runTimes.length, 2);
  assert.ok(Number(runTimes[0][3]) > 0 && Number(runTimes[1][3]) > 0, "both Codex invocations must return a result");
  // Outer witness: the probe process itself must not have mutated the worktree.
  assert.equal((await run("git", ["rev-parse", "HEAD"], { cwd: outerProbeWorktree })).stdout.trim(), outerBeforeHead, "probe/dispatcher must not mutate the Ticket worktree HEAD");
  assert.equal((await run("git", ["status", "--porcelain"], { cwd: outerProbeWorktree })).stdout, outerBeforeStatus, "probe/dispatcher must not leave uncommitted changes");
  smoke.push(`codex: tool=present fresh1_ms=${runTimes[0][2]} fresh2_ms=${runTimes[1][2]} non_mutating=true worktree=${firstBindings[0].worktree}`);

  // ── Phase 5: reviewer-availability fallback on a REAL agent ──────────────
  // CTO/acceptance: an AVAILABLE reviewer's technical REQUEST_CHANGES stays
  // blocking until the finding is addressed; a helper that is unavailable
  // never blocks. We exercise this with a REAL conversational DSH agent and
  // the REAL pinned native-Codex reviewer seam (dsh-subagent-codex app-server),
  // controlling the verdict only through the ONE deterministic channel the
  // real reviewer actually reads — the Ticket worktree content named in the
  // task — exactly as the production protocol intends. ChatGPT is NOT composed
  // in this disposable profile, so every run starts with ChatGPT unavailable.
  // The agent's completion is a byte-observable side effect (`DONE` file),
  // written only when the protocol permits; verdict evidence is read back from
  // the persisted session transcript (marker-anchored).
  const avModule = join(packageCopy, "availability-probe.mjs");
  const avOverlay = `${[
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
    `    - id: availability-probe`,
    `      name: ${quote(avModule)}`,
    `      config:`,
    `        sessionId: ${quote(firstBindings[0].sessionId)}`,
    `        worktree: ${quote(firstBindings[0].worktree)}`,
    `        number: ${firstBindings[0].number}`,
    `        branch: ${quote(firstBindings[0].branch)}`,
    `        baseSha: ${quote(firstBindings[0].baseSha)}`,
  ].join("\n")}`;
  await writeFile(overlay, avOverlay);
  await writeFile(avModule, availabilityProbeSource());
  const avWorktree = firstBindings[0].worktree;
  const availabilityScenarios = [
    // An available reviewer returns a technical REQUEST_CHANGES; the agent must
    // HONOR it as blocking (no DONE until addressed), fix, re-review, and only
    // then complete. The probe obtains the REQUEST_CHANGES verdict itself
    // (deterministic gate-check against the placeholder candidate) and the
    // agent is held to it.
    { name: "blocked-then-fixed", expect: true, requireBlock: true, gate: "fix-after-review" },
    // The same available reviewer keeps returning REQUEST_CHANGES while the
    // gate stays unmet (here the agent is told NOT to change the file): the
    // Ticket must remain open (no DONE) despite the agent working.
    { name: "stays-blocked", expect: false, requireBlock: true, gate: "do-not-fix" },
    // One helper unavailable (ChatGPT absent), the other available: continue
    // with the available reviewer and complete once it approves.
    { name: "one-helper-down", expect: true, requireBlock: false, gate: "approve" },
  ];
  const avail = {};
  for (const scenario of availabilityScenarios) {
    const avOut = await run(dshBin, ["--profile", "smoke", "--patch", overlay, "probe"], {
      env: {
        ...process.env,
        AV_SCENARIO: scenario.name,
        AV_EXPECT: String(scenario.expect),
        AV_GATE: scenario.gate,
        DSH_CWD: avWorktree,
        DSH_HOME: dshHome,
        DS4_API_KEY: process.env.DS4_API_KEY ?? "local-ds4",
      },
      timeout: 620_000,
    });
    const avStdout = avOut.stdout;
    assert.match(avStdout, new RegExp(`AVP scenario=${scenario.name} done=${scenario.expect}`), `availability scenario ${scenario.name} failed:\n${avStdout}\n${avOut.stderr}`);
    assert.match(avStdout, /AVP PASS/, `availability scenario ${scenario.name} did not pass its probe`);
    // Deterministic gate-check: the REAL pinner reviewer must have been called
    // by the probe and returned a real REQUEST_CHANGES against the placeholder
    // candidate for the blocking scenarios — the reviewer cannot be skipped.
    if (scenario.requireBlock) {
      assert.match(avStdout, new RegExp(`AVP gatecheck=${scenario.name} verdict=REQUEST_CHANGES`), `scenario ${scenario.name}: the available reviewer must have returned REQUEST_CHANGES in a real gate-check:\n${avStdout}`);
    }
    // Completion requires an approving verdict: the agent must have (re)run its
    // own subagent_codex review that approved after the gate was met.
    if (scenario.expect) {
      assert.ok(existsSync(join(avWorktree, "DONE")), `scenario ${scenario.name}: DONE must exist after approval:\n${avStdout}`);
    } else {
      assert.ok(!existsSync(join(avWorktree, "DONE")), `scenario ${scenario.name}: DONE must NOT exist while REQUEST_CHANGES stands:\n${avStdout}`);
    }
    avail[scenario.name] = scenario.expect;
  }

  let bothDownResult = "skip";

  // Both-helpers-unavailable leg: ChatGPT is NOT composed (this disposable
  // profile never includes it) AND the native Codex reviewer is made
  // deterministically UNAVAILABLE by composing the agent WITHOUT the
  // subagent_codex tool row (preset `smoke-nocodex`). Both helpers objectively
  // unavailable: per the protocol DSH continues alone and completes when its
  // own independent acceptance gate passes.
  const avNoCodexOverlay = `${[
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
    `        default: smoke-nocodex`,
    `    - id: availability-probe`,
    `      name: ${quote(avModule)}`,
    `      config:`,
    `        sessionId: ${quote(firstBindings[0].sessionId)}`,
    `        worktree: ${quote(firstBindings[0].worktree)}`,
    `        number: ${firstBindings[0].number}`,
    `        branch: ${quote(firstBindings[0].branch)}`,
    `        baseSha: ${quote(firstBindings[0].baseSha)}`,
  ].join("\n")}`;
  await writeFile(join(root, "overlay-nocodex.yml"), avNoCodexOverlay);
  const avOut = await run(dshBin, ["--profile", "smoke", "--patch", join(root, "overlay-nocodex.yml"), "probe"], {
    env: {
      ...process.env,
      AV_SCENARIO: "both-down",
      AV_EXPECT: "true",
      AV_GATE: "approve",
      AV_NO_REVIEWER: "1",
      DSH_CWD: avWorktree,
      DSH_HOME: dshHome,
      DS4_API_KEY: process.env.DS4_API_KEY ?? "local-ds4",
    },
    timeout: 300_000,
  });
  const avStdout = avOut.stdout;
  assert.match(avStdout, /AVP scenario=both-down done=true/, `both-down scenario failed:\n${avStdout}\n${avOut.stderr}`);
  bothDownResult = "complete";

  avail["both-down"] = bothDownResult;
  smoke.push(`availability: ${Object.entries(avail).map(([name, value]) => `${name}=${value}`).join(" ")}`);
  console.log(`SMOKE availability: real DSH agent + real pinned native-Codex reviewer; verdicts controlled by worktree gate; results ${JSON.stringify(avail)}`);

  // ── Phase 6: sequential-helper protocol matrix (fe547f22) ────────────────
  // Phase 5 proves the REAL-agent availability contract end-to-end. Phase 6
  // deterministically exercises the STRICT sequential routing matrix the
  // generated bootstrap now teaches (AGENTS §§4-10): ChatGPT FIRST; fresh
  // native Codex escalation ONLY on objective UNAVAILABLE or after the same
  // chain survives three unsuccessful ChatGPT loops; DSH alone only as last
  // resort; a mandatory helper-produced ordered plan before edits; a progress
  // checkpoint after EVERY completed to-do item; and sequential final-review
  // routing (ChatGPT PASS -> no Codex). ChatGPT is a scripted smoke-only
  // stand-in so its availability is deterministic; the escalation path still
  // drives the REAL pinned native-Codex seam (`subagent_codex` app-server,
  // Codex 0.148.0) where the protocol calls for it. Every helper call is
  // recorded in an event ledger (kind, helper, order, count, non-overlap) and
  // each scenario self-asserts its invariants before printing `SQP PASS`.
  const sqPath = join(sourcePackage, "test/smoke/sequential-helper-probe.mjs");
  const sqModule = join(packageCopy, "sequential-helper-probe.mjs");
  await writeFile(sqModule, await readFile(sqPath, "utf8"));
  const sqConfig = [
    `    - id: sequential-helper-probe`,
    `      name: ${quote(sqModule)}`,
    `      config:`,
    `        sessionId: ${quote(firstBindings[0].sessionId)}`,
    `        worktree: ${quote(firstBindings[0].worktree)}`,
    `        number: ${firstBindings[0].number}`,
    `        branch: ${quote(firstBindings[0].branch)}`,
    `        baseSha: ${quote(firstBindings[0].baseSha)}`,
  ];
  const sqOverlay = `${[
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
    ...sqConfig,
  ].join("\n")}`;
  const sqNoCodexOverlay = `${[
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
    `        default: smoke-nocodex`,
    ...sqConfig,
  ].join("\n")}`;
  await writeFile(join(root, "overlay-sq.yml"), sqOverlay);
  await writeFile(join(root, "overlay-sq-nocodex.yml"), sqNoCodexOverlay);

  const sqScenarios = [
    // ChatGPT planning succeeds -> plan obtained, zero Codex calls anywhere.
    { name: "plan-chatgpt-ok", expectDone: true, overlay: "overlay-sq.yml", assert: [/codex_calls=0/, /plan=chatgpt/] },
    // ChatGPT planning objectively UNAVAILABLE -> REAL fresh Codex plan (the
    // escalation MUST be attempted); if the Codex seam itself is objectively
    // unavailable the chain still completes (self-plan fallback), but the
    // attempt is always recorded. Ordinary checkpoints return ChatGPT-first.
    { name: "plan-codex-escalation", expectDone: true, overlay: "overlay-sq.yml", assert: [/plan=(codex|self)/, /SQP event codex kind=plan attempt=/] },
    // Progress checkpoint: first-line helper objectively UNAVAILABLE -> the
    // SAME checkpoint escalates to REAL fresh Codex exactly once; after that
    // the ordinary code path returns to ChatGPT-first.
    { name: "checkpoint-unavail-codex", expectDone: true, overlay: "overlay-sq.yml", assert: [/codex_calls=1/, /SQP event codex kind=checkpoint/, /final=PASS/] },
    // Hard problem: EXACTLY 3 ChatGPT loops then fresh Codex, NO 4th; afterward
    // an ordinary interaction returns to ChatGPT-first (scoped escalation).
    { name: "three-loops-chain", expectDone: true, overlay: "overlay-sq.yml", assert: [] },
    // Final ChatGPT PASS -> reviewer gate satisfied, zero Codex review calls.
    { name: "final-chatgpt-pass", expectDone: true, overlay: "overlay-sq.yml", assert: [/codex_calls=0/, /final=PASS/] },
    // Final ChatGPT UNAVAILABLE -> real fresh Codex exact-head review.
    { name: "final-chatgpt-unavail-codex", expectDone: true, overlay: "overlay-sq.yml", assert: [/escalation_outcome=(pass|unavailable)/, /SQP event codex kind=review-final attempt=/, /independent=(complete|no)/] },
    // Final review: exactly 3 non-pass ChatGPT loops -> Codex, no 4th ChatGPT.
    { name: "final-three-loops-codex", expectDone: true, overlay: "overlay-sq.yml", assert: [/codex_calls=[1-9]/, /escalation_outcome=(pass|unavailable)/, /SQP event codex kind=review-final attempt=/] },
    // Available reviewer's REQUEST_CHANGES stays BLOCKING until the finding is
    // applied (no DONE while it stands), then completes after re-approval.
    { name: "blocking-request-changes", expectDone: true, overlay: "overlay-sq.yml", assert: [/final=PASS/] },
    // BOTH helpers unavailable for planning -> DSH self-plans and continues;
    // both unavailable at final review -> independent acceptance only.
    { name: "plan-both-down", expectDone: true, overlay: "overlay-sq-nocodex.yml", noCodex: true, assert: [/plan=self/, /codex_calls=0/] },
    { name: "final-both-down", expectDone: true, overlay: "overlay-sq-nocodex.yml", noCodex: true, assert: [/final=UNAVAILABLE/, /codex_calls=0/] },
  ];

  const sqResults = {};
  const sqLedger = [];
  for (const scenario of sqScenarios) {
    const sqOut = await run(dshBin, ["--profile", "smoke", "--patch", join(root, scenario.overlay), "probe"], {
      env: {
        ...process.env,
        SQ_SCENARIO: scenario.name,
        SQ_NO_CODEX: scenario.noCodex ? "1" : "0",
        SQ_DSH_LIB: join(packageCopy, "lib/dsh.js"),
        DSH_CWD: firstBindings[0].worktree,
        DSH_HOME: dshHome,
        DS4_API_KEY: process.env.DS4_API_KEY ?? "local-ds4",
      },
      timeout: 840_000,
    });
    const sqStdout = sqOut.stdout;
    assert.match(sqStdout, new RegExp(`SQP scenario=${scenario.name} done=${scenario.expectDone}`), `sequential-helper scenario ${scenario.name} failed:\n${sqStdout}\n${sqOut.stderr}`);
    assert.match(sqStdout, new RegExp(`SQP PASS scenario=${scenario.name}`), `scenario ${scenario.name} did not pass its probe:\n${sqStdout}`);
    // Universal protocol invariant: ChatGPT and Codex are never in flight in
    // parallel -- every leg (including no-codex legs) must record the probe's
    // mechanical non-overlap guard as green.
    assert.match(sqStdout, /SQP event concurrency non_overlap=true/, `scenario ${scenario.name} must assert helper non-overlap:\n${sqStdout}`);
    // Universal exact-head invariant: every final-review request must be
    // immediately preceded by a committed candidate-head preparation (the
    // probe also asserts one preparation per request internally).
    assert.match(sqStdout, /kind=final-review-candidate \| (chatgpt|codex) kind=review-final/, `scenario ${scenario.name} must place a committed exact head immediately before every review request:\n${sqStdout}`);
    for (const re of scenario.assert) {
      assert.match(sqStdout, re, `scenario ${scenario.name} violated expected routing:\n${sqStdout}`);
    }
    const ledger = [...sqStdout.matchAll(/^SQP event ([^\r\n]+)$/gm)].map((m) => m[1]).join(" | ");
    sqLedger.push(`[${scenario.name}] ${ledger}`);
    sqResults[scenario.name] = "passed";
  }
  smoke.push(`sequential-helper: ${Object.entries(sqResults).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  for (const l of sqLedger) smoke.push("sequential-helper-event " + l);
  console.log(`SMOKE sequential-helper: deterministic protocol matrix PASS (${sqScenarios.length} legs; helper call order/counts recorded above)`);

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
    `import { execFileSync } from "node:child_process";`,
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
    "  const gitIn = (args) => execFileSync('git', ['-C', config.worktree, ...args], { encoding: 'utf8' });",
    "  const beforeHead = gitIn(['rev-parse', 'HEAD']).trim();",
    "  const beforeStatus = gitIn(['status', '--porcelain']);",
    "  const first = await runTask('fresh', 'Inspect the repository at your working directory. Report: (1) the exact first line of README.md, (2) the number of committed changes on the current branch. Inspect, reason, report only; do not modify the Ticket worktree.');",
    "  if (!first) throw new Error('first native Codex invocation returned an empty result');",
    "  const second = await runTask('fresh2', 'Inspect the repository at your working directory. Report: (1) the names of the top-level entries excluding .git, (2) whether the worktree contains uncommitted changes. Inspect, reason, report only; do not modify the Ticket worktree.');",
    "  if (!second) throw new Error('second native Codex invocation returned an empty result');",
    "  if (gitIn(['rev-parse', 'HEAD']).trim() !== beforeHead) throw new Error('Codex review mutated the Ticket worktree HEAD');",
    "  if (gitIn(['status', '--porcelain']) !== beforeStatus) throw new Error('Codex review left uncommitted changes in the Ticket worktree');",
    "  console.log('CODEX-PROBE non-mutating=true');",
    "  console.log('CODEX-PROBE PASS len=' + (first.length + second.length));",
    "  ctx.get('appExit')?.(0);",
    "}",
    "",
  ].join("\n")}`;
}

function availabilityProbeSource() {
  return `${[
  `import { createDshAdapter } from ${quote(join(packageCopy, 'lib/dsh.js'))};`,
  "import { createUserMessage } from \"@deepseek-ai/dsh-llm\";",
  "import { existsSync, rmSync, writeFileSync } from \"node:fs\";",
  "import { join } from \"node:path\";",
  "",
  "export const name = 'availability-probe';",
  "export const inject = ['tools'];",
  "",
  "// apply() is deliberately NOT async (same pattern as the shipped dispatcher",
  "// and codex-probe) so loader.await() inside the body cannot self-deadlock.",
  "export function apply(ctx, config) {",
  "  probe(ctx, config).catch((error) => {",
  "    console.error('AVP ERROR ' + (error instanceof Error ? (error.stack || error.message) : String(error)));",
  "    ctx.get('appExit')?.(1);",
  "  });",
  "}",
  "",
  "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
  "const quote = (v) => JSON.stringify(String(v));",
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
  "  const entry = agents.get(binding.sessionId);",
  "  if (!entry) throw new Error('live Ticket DSH session unavailable: ' + binding.sessionId);",
  "  const agent = entry.followup ? entry : entry.agent;",
  "  if (!agent || typeof agent.followup !== 'function') throw new Error('agent object has no followup() \u2014 composition broken');",
  "  const worktree = binding.worktree;",
  "  const donePath = join(worktree, 'DONE');",
  "  const notePath = join(worktree, 'release-note.txt');",
  "  rmSync(donePath, { force: true });",
  "  const scenario = process.env.AV_SCENARIO || 'unknown';",
  "  const gate = process.env.AV_GATE || 'approve';",
  "  const noReviewer = process.env.AV_NO_REVIEWER === '1';",
  "  const expectDone = process.env.AV_EXPECT === 'true';",
  "  const marker = 'SCENARIO-' + scenario;",
  "  const required = 'AVAILABILITY-GATE-PASSED';",
  "  const placeholder = 'PLACEHOLDER-NOT-YET-APPROVED';",
  "  // Establish the scenario's deterministic candidate state on disk.",
  "  writeFileSync(notePath, gate === 'approve' ? required : placeholder);",
  "  const taskParts = [",
  "    'You are the Ticket Lead DSH session for Ticket #' + config.number + ' in worktree ' + quote(worktree) + '.',",
  "    'Run identifier marker: ' + marker + ' \u2014 keep this exact string in your reasoning so it is recorded.',",
  "    'This disposable profile has NO ChatGPT/mcp_chatgpt tool composed, so ChatGPT is UNAVAILABLE by design.',",
  "    'Acceptance gate: release-note.txt must contain EXACTLY the string ' + required + ' (nothing else).',",
  "  ];",
  "  let gatecheckVerdict = 'none';",
  "  if (noReviewer) {",
  "    console.log('AVP gatecheck=' + scenario + ' verdict=UNAVAILABLE (no subagent_codex composed)');",
  "  } else {",
  "    const tool = ctx.tools.get('subagent_codex', agent);",
  "    if (!tool) throw new Error('subagent_codex absent from the composed Ticket DSH session');",
  "    const gateCheckTask = 'REVIEW TASK (gate-check) for Ticket #' + config.number + ', worktree ' + quote(worktree) + '. Verify: (1) does release-note.txt contain EXACTLY the string ' + quote(required) + ' with no extra bytes, and (2) are there accidental uncommitted changes beyond release-note.txt/DONE? Start your answer with a verdict line: APPROVED if release-note.txt matches EXACTLY, otherwise REQUEST_CHANGES, then give the concrete reason in one sentence.';",
  "    const started = Date.now();",
  "    let gatecheck;",
  "    try {",
  "      gatecheck = await Promise.race([",
  "        tool.execute({ description: marker + ' gate-check', prompt: gateCheckTask }, { agent, signal: new AbortController().signal }),",
  "        new Promise((_, reject) => setTimeout(() => reject(new Error('gate-check timed out')), 180_000)),",
  "      ]);",
  "    } catch (error) {",
  "      console.error('AVP gatecheck=' + scenario + ' reviewer error: ' + String(error));",
  "      ctx.get('appExit')?.(1);",
  "      return;",
  "    }",
  "    const response = textOf(gatecheck);",
  "    const hasRC = /REQUEST_CHANGES/.test(response);",
  "    gatecheckVerdict = hasRC ? 'REQUEST_CHANGES' : (response ? 'OTHER' : 'EMPTY');",
  "    console.log('AVP gatecheck=' + scenario + ' verdict=' + gatecheckVerdict + ' ms=' + (Date.now() - started) + ' head=' + String(response).slice(0, 220).replace(/[\\r\\n]+/g, ' '));",
  "    if ((gate === 'fix-after-review' || gate === 'do-not-fix') && !hasRC) {",
  "      console.error('AVP gatecheck=' + scenario + ' expected a real REQUEST_CHANGES against the placeholder candidate');",
  "      ctx.get('appExit')?.(1);",
  "      return;",
  "    }",
  "  }",
  "  if (noReviewer) {",
  "    taskParts.push(",
  "      'The subagent_codex reviewer tool is ALSO not composed in this variant, so BOTH helpers (ChatGPT and the reviewer) are UNAVAILABLE.',",
  "      'Per the availability protocol you continue ALONE: ensure release-note.txt contains EXACTLY ' + required + ', then write an EMPTY file at ' + quote(donePath) + '.'",
  "    );",
  "  } else if (gate === 'fix-after-review') {",
  "    taskParts.push(",
  "      '1. The AVAILABLE native-Codex reviewer already returned REQUEST_CHANGES for the current candidate (release-note.txt must contain EXACTLY ' + required + '; current content is the placeholder).',",
  "      '2. Fix release-note.txt to EXACTLY ' + required + '.',",
  "      '3. Re-run the FINAL REVIEW by calling the subagent_codex tool with a self-contained task describing the exact gate; its output text is the reviewer verdict.',",
  "      '4. Strict: a REQUEST_CHANGES verdict is BLOCKING \u2014 you must NOT write DONE while it stands. Only when a review verdict contains APPROVED or PASS, write an EMPTY file at ' + quote(donePath) + '. If after 2 re-reviews it still returns REQUEST_CHANGES, leave DONE unwritten and stop.'",
  "    );",
  "  } else if (gate === 'do-not-fix') {",
  "    taskParts.push(",
  "      '1. The AVAILABLE native-Codex reviewer already returned REQUEST_CHANGES for the current candidate and it remains BLOCKING (release-note.txt must contain EXACTLY ' + required + '; current content is the placeholder).',",
  "      '2. In this scenario you MUST NOT change release-note.txt \u2014 a successor Ticket owns that gate.',",
  "      '3. Re-review at most twice via subagent_codex (same REQUEST_CHANGES verdict expected), then stop WITHOUT writing DONE.',",
  "      '4. Never write ' + quote(donePath) + ' in this scenario even if nothing else is wrong.'",
  "    );",
  "  } else {",
  "    taskParts.push(",
  "      '1. Ensure release-note.txt contains EXACTLY ' + required + '.',",
  "      '2. Run the FINAL REVIEW by calling the subagent_codex tool with a self-contained task describing the exact gate; its output text is the reviewer verdict.',",
  "      '3. If REQUEST_CHANGES: BLOCKING \u2014 fix ' + quote(notePath) + ' to EXACTLY ' + required + ' and re-review. When a verdict contains APPROVED or PASS, write an EMPTY file at ' + quote(donePath) + '.'",
  "    );",
  "  }",
  "  const prompt = taskParts.join(' ');",
  "  console.log('AVP scenario=' + scenario + ' gate=' + gate + ' no_reviewer=' + noReviewer + ' tool=present agent=' + agent.id + ' reviewer=' + gatecheckVerdict);",
  "  agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }));",
  "  const deadline = Date.now() + (expectDone ? 420_000 : 240_000);",
  "  while (Date.now() < deadline) {",
  "    if (existsSync(donePath)) break;",
  "    await sleep(2000);",
  "  }",
  "  const done = existsSync(donePath);",
  "  console.log('AVP scenario=' + scenario + ' done=' + done);",
  "  if (done !== expectDone) {",
  "    console.error('AVP scenario=' + scenario + ' expected_done=' + expectDone + ' but observed done=' + done);",
  "    ctx.get('appExit')?.(1);",
  "    return;",
  "  }",
  "  console.log('AVP PASS scenario=' + scenario);",
  "  ctx.get('appExit')?.(0);",
  "}",
  ""
].join("\n")}`;
}



