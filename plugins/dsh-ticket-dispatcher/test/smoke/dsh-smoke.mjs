import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
const firstState = join(root, "state/first.json");
const restartedState = join(root, "state/restarted.json");
const overlay = join(root, "overlay.yml");
const dshScope = process.env.DSH_SCOPE ?? "/home/code2hack/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";
const dshBin = process.env.DSH_BIN ?? "dsh";

const run = (file, args, options = {}) => exec(file, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, ...options });
const git = (...args) => run("git", args, { cwd: scratchRepo });
const quote = (value) => JSON.stringify(value);

function overlayText(statePath) {
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
        baseSha: ${quote(baseSha)}
        maxActive: 3
        wakeAgents: false
`;
}

function reportOf(stdout) {
  const start = stdout.indexOf('{\n  "schemaVersion"');
  const end = stdout.indexOf("\nTicket Dispatcher:", start);
  if (start < 0 || end < 0) throw new Error(`dispatcher report missing:\n${stdout}`);
  return JSON.parse(stdout.slice(start, end));
}

async function invoke(statePath) {
  await writeFile(overlay, overlayText(statePath));
  return run(dshBin, ["--profile", "smoke", "--patch", overlay, "reconcile"], {
    env: { ...process.env, DSH_HOME: dshHome },
    timeout: 60_000,
  });
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
  await writeFile(fixturesPath, `${JSON.stringify({
    tickets: [21, 22].map((number) => ({ number, state: "OPEN", blockers: [], url: `https://github.com/code2hack/dsh-glasses/issues/${number}` })),
    claims: [],
  }, null, 2)}\n`);

  const first = await invoke(firstState);
  const firstReport = reportOf(first.stdout);
  assert.deepEqual(firstReport.running.map((item) => item.number), [21, 22]);
  assert.equal(new Set(firstReport.running.map((item) => item.sessionId)).size, 2);
  assert.equal(new Set(firstReport.running.map((item) => item.worktree)).size, 2);
  for (const binding of firstReport.running) {
    assert.equal(binding.baseSha, baseSha);
    assert.equal((await stat(binding.worktree)).isDirectory(), true);
  }

  const saved = JSON.parse(await readFile(firstState, "utf8"));
  for (const number of [21, 22]) {
    const prompt = saved.tickets[number].bootstrapPrompt;
    assert.match(prompt, /AGENTS\.md section 3/);
    assert.match(prompt, new RegExp(`issues/${number}`));
  }

  const repeated = reportOf((await invoke(firstState)).stdout);
  assert.deepEqual(repeated.running.map((item) => item.sessionId), firstReport.running.map((item) => item.sessionId));

  const restartedResult = await invoke(restartedState);
  const restarted = reportOf(restartedResult.stdout);
  assert.deepEqual(restarted.running.map((item) => item.sessionId), firstReport.running.map((item) => item.sessionId));
  assert.ok(restarted.running.every((item) => item.validWorktree));
  assert.equal((JSON.parse(await readFile(fixturesPath, "utf8"))).claims.length, 2);

  process.stdout.write("dsh-ticket-dispatcher smoke: PASS\n");
  process.stdout.write(restartedResult.stdout.slice(restartedResult.stdout.indexOf('{\n  "schemaVersion"')));
} finally {
  if (process.env.KEEP_SMOKE) process.stdout.write(`smoke retained: ${root}\n`);
  else await rm(root, { recursive: true, force: true });
}
