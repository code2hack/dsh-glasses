#!/usr/bin/env node
/**
 * Canonical D0 clean-home entry point for the 16-scenario host-write recovery
 * suite. It creates a genuinely empty disposable home, uses d0-runtime `up` to
 * materialize the profile and self-seed session-tb0-disposable, shuts the
 * managed runtime down, then executes the existing recovery suite against that
 * preserved home.
 *
 * The legacy suite has one historical hard-coded state-file path. Rather than
 * mutating the checked-out source during a test, this wrapper writes a temporary
 * sibling copy with that single path made DSH_HOME-relative, runs it, and deletes
 * the generated file afterwards. The scenario body is otherwise byte-for-byte
 * identical.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = join(REPO_ROOT, 'dev', 'd0-runtime.mjs');
const SUITE = join(REPO_ROOT, 'plugins', 'dsh-glasses-plugin', 'test', 'host-write-recovery.test.mjs');

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result.stdout ?? '';
}

async function runStreaming(command, args, options = {}) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited code=${code} signal=${signal ?? 'none'}`));
    });
  });
}

async function main() {
  const home = process.env.D0_HOST_WRITE_HOME
    ? resolve(process.env.D0_HOST_WRITE_HOME)
    : await mkdtemp('/tmp/dsh-glasses-d0-host-write-');
  const workspace = join(home, 'workspace');
  const ports = new Set();
  while (ports.size < 3) ports.add(await freePort());
  const [dshPort, proxyPort, suitePort] = [...ports];

  console.error(`[d0-host-write] home=${home}`);
  console.error(`[d0-host-write] bootstrap ports dsh=${dshPort} proxy=${proxyPort}; suite=${suitePort}`);

  const upRaw = runCapture(process.execPath, [
    RUNTIME,
    'up',
    '--home', home,
    '--workspace', workspace,
    '--dsh-port', String(dshPort),
    '--proxy-port', String(proxyPort),
    '--advertise-host', '127.0.0.1',
  ], { cwd: REPO_ROOT });
  const up = JSON.parse(upRaw);
  if (!up.ok || up.seedSessionId !== 'session-tb0-disposable') {
    throw new Error(`D0 bootstrap did not self-seed the fixture session: ${upRaw}`);
  }

  try {
    runCapture(process.execPath, [RUNTIME, 'down', '--home', home], { cwd: REPO_ROOT });

    const original = await readFile(SUITE, 'utf8');
    const hardCoded = 'readFile("/tmp/dsh-tb0-home/storages/glasses_plugin.json", "utf8")';
    const replacement = 'readFile(`${DIR}/storages/glasses_plugin.json`, "utf8")';
    if (!original.includes(hardCoded)) {
      throw new Error('legacy host-write suite hard-coded state path changed; update D0 wrapper deliberately');
    }
    const generated = original.replaceAll(hardCoded, replacement);
    const generatedPath = join(dirname(SUITE), `.d0-host-write-${randomUUID()}.mjs`);
    await writeFile(generatedPath, generated, { encoding: 'utf8', mode: 0o600 });
    try {
      await runStreaming(process.execPath, [generatedPath], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DSH_HOME: home,
          WORKSPACE_DIR: workspace,
          SESSION_ID: 'session-tb0-disposable',
          PORT: String(suitePort),
        },
      });
    } finally {
      await rm(generatedPath, { force: true });
    }
  } catch (error) {
    try { runCapture(process.execPath, [RUNTIME, 'down', '--home', home], { cwd: REPO_ROOT }); } catch {}
    throw error;
  }

  console.log(JSON.stringify({
    ok: true,
    suite: 'host-write-recovery',
    cleanHomeSelfSeeded: true,
    home,
    seedSessionId: 'session-tb0-disposable',
    preservedHome: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(`[d0-host-write] FATAL: ${error?.stack ?? error}`);
  process.exit(2);
});
