#!/usr/bin/env node
/**
 * TB0-D0 disposable development runtime controller.
 *
 * Commands:
 *   node dev/d0-runtime.mjs up [options]
 *   node dev/d0-runtime.mjs status [--home PATH]
 *   node dev/d0-runtime.mjs down [--home PATH]
 *
 * `up` is intentionally strict: it initializes only a new/empty DSH_HOME and
 * refuses to reuse or erase an existing home. `down` terminates only PIDs whose
 * recorded Linux process start-ticks still match, and preserves the home.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_ROOT = join(REPO_ROOT, 'dev', 'd0-runtime');
const PLUGIN_SOURCE = join(REPO_ROOT, 'plugins', 'dsh-glasses-plugin');
const EXPECTED_DSH_VERSION = '0.1.0-rc.7';
const EXPECTED_PNPM_VERSION = '11.22.0';
const DEFAULT_HOME = '/tmp/dsh-glasses-d0-runtime';
const DEFAULT_DSH_PORT = 3196;
const DEFAULT_PROXY_PORT = 3202;
const DEFAULT_PROXY_HOST = '0.0.0.0';
const DEFAULT_VLLM_BASE = 'http://192.168.100.11:8887/v1';
const DEFAULT_MODEL_ID = 'lfm2.5-vl-3b';
const SEED_SESSION_ID = 'session-tb0-disposable';
const STATE_SCHEMA = 1;

const stderr = (...args) => console.error('[d0-runtime]', ...args);

function usage(exitCode = 0) {
  const text = `\nTB0-D0 disposable runtime\n\n` +
    `Usage:\n` +
    `  node dev/d0-runtime.mjs up [--home PATH] [--dsh-port N] [--proxy-port N]\n` +
    `       [--proxy-host HOST] [--advertise-host HOST] [--workspace PATH]\n` +
    `       [--vllm-base-url URL] [--model-id ID] [--dsh-bin PATH] [--pnpm-bin PATH]\n` +
    `  node dev/d0-runtime.mjs status [--home PATH]\n` +
    `  node dev/d0-runtime.mjs down [--home PATH]\n\n` +
    `Defaults: home=${DEFAULT_HOME}, dsh-port=${DEFAULT_DSH_PORT}, ` +
    `proxy-port=${DEFAULT_PROXY_PORT}, model=${DEFAULT_MODEL_ID}.\n`;
  (exitCode ? process.stderr : process.stdout).write(text);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === '-h' || command === '--help') usage(0);
  const options = {};
  while (args.length) {
    const token = args.shift();
    if (!token?.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === 'help') usage(0);
    const value = args.shift();
    if (value == null || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    options[key] = value;
  }
  return { command, options };
}

function integerOption(value, fallback, name) {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid --${name}: ${value}`);
  return n;
}

function commandPath(command) {
  if (command.includes('/')) return resolve(command);
  const found = spawnSync('which', [command], { encoding: 'utf8' });
  if (found.status !== 0 || !found.stdout.trim()) throw new Error(`command not found: ${command}`);
  return found.stdout.trim();
}

async function findPackageFromBin(binPath, expectedName) {
  let current = dirname(await realpath(binPath));
  for (let i = 0; i < 10; i += 1) {
    const pkgPath = join(current, 'package.json');
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
      if (pkg?.name === expectedName) return { path: pkgPath, pkg };
    } catch {}
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`could not locate ${expectedName} package.json from ${binPath}`);
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${basename(command)} ${args.join(' ')} failed (${result.status})\n` +
      `${result.stdout || ''}${result.stderr || ''}`.slice(-8000),
    );
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function ensureEmptyHome(home) {
  if (!isAbsolute(home)) throw new Error(`--home must be absolute: ${home}`);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const entries = await readdir(home);
  if (entries.length !== 0) {
    throw new Error(
      `refusing non-empty DSH_HOME ${home}; D0 never wipes/reuses a home. ` +
      `Choose a new path. Existing entries: ${entries.slice(0, 8).join(', ')}`,
    );
  }
  await chmod(home, 0o700).catch(() => {});
}

async function copyTemplate(relativePath, destination) {
  const source = join(TEMPLATE_ROOT, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

function renderTemplate(source, values) {
  let out = source;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`__${key}__`).join(String(value));
  }
  const unresolved = out.match(/__[A-Z0-9_]+__/g);
  if (unresolved) throw new Error(`unresolved template values: ${[...new Set(unresolved)].join(', ')}`);
  return out;
}

async function materializeRuntimeFiles(config) {
  const profile = join(config.home, 'profiles', 'web');
  const preset = join(config.home, '.agent-presets', 'a0-toolfree');
  await mkdir(profile, { recursive: true });
  await mkdir(preset, { recursive: true });

  const packageTemplate = await readFile(join(TEMPLATE_ROOT, 'profile', 'package.json.template'), 'utf8');
  const packageJson = renderTemplate(packageTemplate, {
    PLUGIN_FILE_SPEC: `file:${PLUGIN_SOURCE}`,
  });
  JSON.parse(packageJson);
  await writeFile(join(profile, 'package.json'), packageJson, 'utf8');

  await copyTemplate(join('profile', 'cordis.yml'), join(profile, 'cordis.yml'));
  await copyTemplate(join('profile', 'cordis.patch.yml'), join(profile, 'cordis.patch.yml'));
  await copyTemplate(join('profile', 'pnpm-workspace.yaml'), join(profile, 'pnpm-workspace.yaml'));

  const settingsTemplate = await readFile(join(TEMPLATE_ROOT, 'settings.yaml.template'), 'utf8');
  const settings = renderTemplate(settingsTemplate, {
    VLLM_BASE_URL: config.vllmBaseUrl,
    MODEL_ID: config.modelId,
    DSH_PORT: config.dshPort,
  });
  await writeFile(join(config.home, 'settings.yaml'), settings, 'utf8');

  await copyTemplate(join('preset', 'a0-toolfree', 'preset.yml'), join(preset, 'preset.yml'));
  await copyTemplate(join('preset', 'a0-toolfree', 'agent.cordis.yml'), join(preset, 'agent.cordis.yml'));
  return { profile, preset };
}

async function fileDigest(path) {
  const data = await readFile(path);
  return createHash('sha256').update(data).digest('hex');
}

async function listFilesRecursive(root) {
  const result = [];
  async function walk(dir, prefix = '') {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) result.push({ rel, full });
      else throw new Error(`unsupported entry while hashing ${root}: ${rel}`);
    }
  }
  await walk(root);
  return result;
}

async function treeDigest(root) {
  const files = await listFilesRecursive(root);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.rel);
    hash.update('\0');
    hash.update(await readFile(file.full));
    hash.update('\0');
  }
  return { digest: hash.digest('hex'), files: files.map((f) => f.rel) };
}

async function installAndRefreshPlugin(config, profilePath) {
  const pnpmVersion = runCapture(config.pnpmBin, ['--version']).stdout.trim();
  if (pnpmVersion !== EXPECTED_PNPM_VERSION) {
    throw new Error(`D0 pins pnpm ${EXPECTED_PNPM_VERSION}; found ${pnpmVersion}`);
  }
  stderr(`pnpm ${pnpmVersion}: installing disposable profile`);
  const install = runCapture(config.pnpmBin, ['install', '--reporter=append-only'], { cwd: profilePath });
  if (install.stdout.trim()) stderr(install.stdout.trim().split('\n').slice(-4).join('\n'));

  const installed = join(profilePath, 'node_modules', 'dsh-glasses-plugin');
  if (!existsSync(join(installed, 'package.json'))) throw new Error(`plugin install missing: ${installed}`);

  // pnpm `file:` dependencies are physical snapshots. Make the snapshot
  // deterministic on every D0 `up`: replace the entire package-owned `lib/`
  // from the current checkout and verify a content digest. This avoids the
  // stale-new-file failure that hid projection.js during C0 without changing
  // Node's package/peer-dependency resolution semantics.
  await rm(join(installed, 'lib'), { recursive: true, force: true });
  await cp(join(PLUGIN_SOURCE, 'lib'), join(installed, 'lib'), { recursive: true, force: true });
  await copyFile(join(PLUGIN_SOURCE, 'package.json'), join(installed, 'package.json'));

  const sourceTree = await treeDigest(join(PLUGIN_SOURCE, 'lib'));
  const installedTree = await treeDigest(join(installed, 'lib'));
  const sourcePackage = await fileDigest(join(PLUGIN_SOURCE, 'package.json'));
  const installedPackage = await fileDigest(join(installed, 'package.json'));
  if (sourceTree.digest !== installedTree.digest || sourcePackage !== installedPackage) {
    throw new Error('installed plugin mirror does not match current repo plugin source');
  }
  if (!sourceTree.files.includes('projection.js')) throw new Error('current plugin source is missing lib/projection.js');

  const ls = runCapture(config.pnpmBin, ['ls', 'dsh-glasses-plugin', '--depth', '0'], { cwd: profilePath });
  stderr(`plugin mirror: ${installed} (lib sha256 ${sourceTree.digest.slice(0, 16)}…)`);
  return {
    installedPath: installed,
    sourceLibDigest: sourceTree.digest,
    sourcePackageDigest: sourcePackage,
    pnpmList: ls.stdout.trim(),
  };
}

async function checkProvider(config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const url = config.vllmBaseUrl.replace(/\/$/, '') + '/models';
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`provider /models HTTP ${response.status}`);
    const body = await response.json();
    const ids = Array.isArray(body?.data) ? body.data.map((m) => String(m?.id ?? '')) : [];
    if (!ids.includes(config.modelId)) {
      throw new Error(`provider model ${config.modelId} absent; available=${ids.join(',')}`);
    }
    return { url, modelIds: ids };
  } finally {
    clearTimeout(timer);
  }
}

async function portIsOpen(host, port, timeoutMs = 400) {
  return await new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function assertPortFree(port, label) {
  if (await portIsOpen('127.0.0.1', port)) {
    throw new Error(`${label} port ${port} is already accepting TCP connections; D0 will not kill its owner`);
  }
}

function procStartTicks(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 0) return null;
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function procCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

function processMatches(record) {
  if (!record?.pid || !record?.startTicks) return false;
  return String(procStartTicks(record.pid)) === String(record.startTicks);
}

async function startDetachedProcess({ command, args, cwd, env, logPath, label }) {
  await mkdir(dirname(logPath), { recursive: true });
  const handle = await open(logPath, 'a', 0o600);
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', handle.fd, handle.fd],
    });
  } finally {
    await handle.close();
  }
  child.unref();
  await sleep(120);
  const startTicks = procStartTicks(child.pid);
  if (!startTicks) throw new Error(`${label} exited immediately; inspect ${logPath}`);
  return { pid: child.pid, startTicks, cmdline: procCmdline(child.pid), logPath };
}

async function waitUntil(fn, timeoutMs, label, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function fetchJson(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: response.status, body, headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
}

async function rpc(base, method, payload, timeoutMs = 20_000) {
  const body = { type: 'client-request', rpcId: `d0-${randomUUID()}`, method, payload };
  const response = await fetchJson(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, timeoutMs);
  const result = response.body?.result;
  if (response.status !== 200 || result?.ok !== true) {
    throw new Error(`${method} failed: HTTP ${response.status} ${JSON.stringify(response.body)}`);
  }
  return result.value;
}

async function ensureWorkspaceAndSessions(config, dshBase) {
  const workspaceValue = await rpc(dshBase, 'workspace.create', { path: config.workspacePath }, 30_000);
  const workspaceId = workspaceValue?.workspace?.workspaceId;
  if (!workspaceId) throw new Error(`workspace.create returned no workspaceId: ${JSON.stringify(workspaceValue)}`);

  const list = await rpc(dshBase, 'session.list', {});
  const existing = new Set((list?.items ?? []).map((item) => item?.sessionId));
  async function ensureSession(sessionId, agentPreset) {
    if (existing.has(sessionId)) return { sessionId, existing: true };
    const created = await rpc(dshBase, 'session.create', { workspaceId, sessionId, agentPreset }, 60_000);
    if (created?.sessionId !== sessionId) {
      throw new Error(`session.create identity mismatch: expected ${sessionId}, got ${created?.sessionId}`);
    }
    existing.add(sessionId);
    return { sessionId, existing: false };
  }

  const seed = await ensureSession(SEED_SESSION_ID, 'minimal');
  const fresh = await ensureSession(config.sessionId, 'a0-toolfree');
  const encodedWorkspace = `--${config.workspacePath.slice(1).replace(/\//g, '-')}--`;
  for (const sid of [SEED_SESSION_ID, config.sessionId]) {
    const logPath = join(config.home, 'sessions', encodedWorkspace, sid, 'session.jsonl.zstd');
    await waitUntil(async () => {
      try { return (await stat(logPath)).isFile(); } catch { return false; }
    }, 15_000, `durable session log ${sid}`);
  }
  return { workspaceId, seed, fresh };
}

async function waitBootstrap(base, token, expectedSession) {
  return await waitUntil(async () => {
    const response = await fetchJson(`${base}/glasses/v1/bootstrap`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status !== 200) return false;
    if (response.body?.attachment?.sessionId !== expectedSession) {
      throw new Error(`bootstrap session mismatch: ${response.body?.attachment?.sessionId ?? '(missing)'} != ${expectedSession}`);
    }
    return response;
  }, 30_000, 'authenticated glasses bootstrap');
}

function detectAdvertiseHost(explicit) {
  if (explicit) return explicit;
  try {
    const result = spawnSync('tailscale', ['ip', '-4'], { encoding: 'utf8' });
    if (result.status === 0) {
      const candidate = result.stdout.split(/\s+/).find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x));
      if (candidate) return candidate;
    }
  } catch {}
  return '127.0.0.1';
}

async function gitHead() {
  return runCapture('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).stdout.trim();
}

async function privateWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

async function readState(home) {
  const statePath = join(home, '.d0-runtime', 'state.json');
  let body;
  try { body = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { throw new Error(`cannot read D0 state ${statePath}: ${error.message}`); }
  if (body?.schemaVersion !== STATE_SCHEMA) throw new Error(`unsupported D0 state schema: ${body?.schemaVersion}`);
  return { statePath, state: body };
}

async function terminateRecorded(record, label) {
  if (!record?.pid) return { label, action: 'no-pid', stopped: true };
  if (!processMatches(record)) return { label, action: 'identity-mismatch-or-already-dead', stopped: true, pid: record.pid };
  process.kill(record.pid, 'SIGTERM');
  for (let i = 0; i < 25; i += 1) {
    if (!processMatches(record)) return { label, action: 'sigterm', stopped: true, pid: record.pid };
    await sleep(200);
  }
  if (processMatches(record)) process.kill(record.pid, 'SIGKILL');
  for (let i = 0; i < 15; i += 1) {
    if (!processMatches(record)) return { label, action: 'sigkill', stopped: true, pid: record.pid };
    await sleep(100);
  }
  return { label, action: 'failed', stopped: false, pid: record.pid };
}

async function statusForState(state) {
  const dshAlive = processMatches(state.processes?.dsh);
  const proxyAlive = processMatches(state.processes?.proxy);
  const dshBase = state.endpoints?.dshBase;
  const proxyLocalBase = state.endpoints?.proxyLocalBase;
  let dshBootstrap = null;
  let proxyBootstrap = null;
  let proxyApiBlocked = null;
  if (dshAlive && dshBase) {
    try { dshBootstrap = await fetchJson(`${dshBase}/glasses/v1/bootstrap`, { headers: { authorization: `Bearer ${state.provisioning.token}` } }, 3000); }
    catch (error) { dshBootstrap = { status: 0, error: error.message }; }
  }
  if (proxyAlive && proxyLocalBase) {
    try { proxyBootstrap = await fetchJson(`${proxyLocalBase}/glasses/v1/bootstrap`, { headers: { authorization: `Bearer ${state.provisioning.token}` } }, 3000); }
    catch (error) { proxyBootstrap = { status: 0, error: error.message }; }
    try { proxyApiBlocked = await fetchJson(`${proxyLocalBase}/api/status`, {}, 3000); }
    catch (error) { proxyApiBlocked = { status: 0, error: error.message }; }
  }

  let currentRepoHead = null;
  let currentPluginDigest = null;
  try { currentRepoHead = await gitHead(); } catch {}
  try { currentPluginDigest = (await treeDigest(join(PLUGIN_SOURCE, 'lib'))).digest; } catch {}
  const bootstrapSession = proxyBootstrap?.body?.attachment?.sessionId;
  const healthy = Boolean(
    dshAlive && proxyAlive && dshBootstrap?.status === 200 && proxyBootstrap?.status === 200 &&
    proxyApiBlocked?.status === 403 && bootstrapSession === state.provisioning.sessionId &&
    currentRepoHead === state.repoHead && currentPluginDigest === state.plugin.sourceLibDigest
  );
  return {
    healthy,
    processes: {
      dsh: { alive: dshAlive, pid: state.processes?.dsh?.pid ?? null },
      proxy: { alive: proxyAlive, pid: state.processes?.proxy?.pid ?? null },
    },
    endpoints: {
      dshBootstrapStatus: dshBootstrap?.status ?? null,
      proxyBootstrapStatus: proxyBootstrap?.status ?? null,
      proxyApiBlockedStatus: proxyApiBlocked?.status ?? null,
      bootstrapSession: bootstrapSession ?? null,
    },
    source: {
      recordedRepoHead: state.repoHead,
      currentRepoHead,
      repoMatches: currentRepoHead === state.repoHead,
      recordedPluginDigest: state.plugin.sourceLibDigest,
      currentPluginDigest,
      pluginMatches: currentPluginDigest === state.plugin.sourceLibDigest,
    },
  };
}

async function up(options) {
  const home = resolve(options.home ?? process.env.D0_HOME ?? DEFAULT_HOME);
  const dshPort = integerOption(options['dsh-port'], DEFAULT_DSH_PORT, 'dsh-port');
  const proxyPort = integerOption(options['proxy-port'], DEFAULT_PROXY_PORT, 'proxy-port');
  if (dshPort === proxyPort) throw new Error('DSH and proxy ports must differ');
  const proxyHost = options['proxy-host'] ?? DEFAULT_PROXY_HOST;
  const advertiseHost = detectAdvertiseHost(options['advertise-host'] ?? process.env.D0_ADVERTISE_HOST);
  const vllmBaseUrl = options['vllm-base-url'] ?? process.env.D0_VLLM_BASE_URL ?? DEFAULT_VLLM_BASE;
  const modelId = options['model-id'] ?? process.env.D0_MODEL_ID ?? DEFAULT_MODEL_ID;
  const dshBin = commandPath(options['dsh-bin'] ?? process.env.DSH_BIN ?? 'dsh');
  const pnpmBin = commandPath(options['pnpm-bin'] ?? process.env.PNPM_BIN ?? 'pnpm');

  const dshPackage = await findPackageFromBin(dshBin, '@deepseek-ai/dsh');
  if (dshPackage.pkg.version !== EXPECTED_DSH_VERSION) {
    throw new Error(`D0 pins @deepseek-ai/dsh@${EXPECTED_DSH_VERSION}; found ${dshPackage.pkg.version}`);
  }
  await assertPortFree(dshPort, 'DSH');
  await assertPortFree(proxyPort, 'proxy');
  await ensureEmptyHome(home);

  const workspaceRequested = resolve(options.workspace ?? join(home, 'workspace'));
  await mkdir(workspaceRequested, { recursive: true });
  const workspacePath = await realpath(workspaceRequested);
  const sessionId = `session-${randomUUID()}`;
  const token = `dev-d0-${randomBytes(24).toString('base64url')}`;
  const tb0Key = process.env.TB0VLLM_API_KEY ?? 'dev-keyless-a0';
  const config = { home, dshPort, proxyPort, proxyHost, advertiseHost, vllmBaseUrl, modelId, dshBin, pnpmBin, workspacePath, sessionId, token, tb0Key };

  const started = [];
  const statePath = join(home, '.d0-runtime', 'state.json');
  const logDir = join(home, '.d0-runtime', 'logs');
  try {
    const runtimeFiles = await materializeRuntimeFiles(config);
    const plugin = await installAndRefreshPlugin(config, runtimeFiles.profile);
    const provider = await checkProvider(config);
    stderr(`provider: ${config.modelId} present at ${provider.url}`);

    const dshBase = `http://127.0.0.1:${dshPort}`;
    const proxyLocalBase = `http://127.0.0.1:${proxyPort}`;
    const provisioningBase = `http://${advertiseHost}:${proxyPort}`;
    const childEnv = {
      ...process.env,
      DSH_HOME: home,
      DSH_GLASSES_TB0_SESSION_ID: sessionId,
      DSH_GLASSES_TB0_TOKEN: token,
      TB0VLLM_API_KEY: tb0Key,
    };

    stderr(`starting DSH ${EXPECTED_DSH_VERSION} on 127.0.0.1:${dshPort}`);
    const dsh = await startDetachedProcess({
      command: dshBin,
      args: ['--profile', 'web', '--port', String(dshPort)],
      cwd: REPO_ROOT,
      env: childEnv,
      logPath: join(logDir, 'dsh.log'),
      label: 'DSH',
    });
    started.push({ record: dsh, label: 'dsh' });

    await waitUntil(async () => {
      try { return (await rpc(dshBase, 'workspace.list', {}, 3000)) ? true : false; }
      catch { return false; }
    }, 30_000, 'DSH workspace API');

    const identities = await ensureWorkspaceAndSessions(config, dshBase);
    const bootstrap = await waitBootstrap(dshBase, token, sessionId);
    stderr(`fresh session ready: ${sessionId}; bootstrap asOf=${bootstrap.body?.history?.asOfSeq ?? '?'}`);

    stderr(`starting narrow proxy ${proxyHost}:${proxyPort} -> ${dshBase}`);
    const proxy = await startDetachedProcess({
      command: process.execPath,
      args: [join(REPO_ROOT, 'dev', 'glasses-dev-proxy.mjs')],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        GLASSES_UPSTREAM: dshBase,
        GLASSES_PROXY_HOST: proxyHost,
        GLASSES_PROXY_PORT: String(proxyPort),
      },
      logPath: join(logDir, 'proxy.log'),
      label: 'proxy',
    });
    started.push({ record: proxy, label: 'proxy' });

    await waitUntil(async () => {
      try { return (await fetchJson(`${proxyLocalBase}/api/status`, {}, 2000)).status === 403; }
      catch { return false; }
    }, 10_000, 'narrow proxy');
    const proxyBootstrap = await waitBootstrap(proxyLocalBase, token, sessionId);

    const repoHead = await gitHead();
    const state = {
      schemaVersion: STATE_SCHEMA,
      createdAt: new Date().toISOString(),
      stoppedAt: null,
      repoRoot: REPO_ROOT,
      repoHead,
      home,
      dsh: { version: dshPackage.pkg.version, packageJson: dshPackage.path, bin: dshBin, port: dshPort },
      pnpm: { version: EXPECTED_PNPM_VERSION, bin: pnpmBin },
      workspace: { path: workspacePath, workspaceId: identities.workspaceId },
      sessions: { seedSessionId: SEED_SESSION_ID, freshSessionId: sessionId },
      provider: { baseURL: vllmBaseUrl, modelId },
      plugin: {
        sourcePath: PLUGIN_SOURCE,
        installedPath: plugin.installedPath,
        sourceLibDigest: plugin.sourceLibDigest,
        sourcePackageDigest: plugin.sourcePackageDigest,
        pnpmList: plugin.pnpmList,
      },
      endpoints: { dshBase, proxyLocalBase, proxyBind: `${proxyHost}:${proxyPort}`, provisioningBase },
      provisioning: { endpoint: provisioningBase, sessionId, token },
      processes: { dsh, proxy },
      logs: { dsh: dsh.logPath, proxy: proxy.logPath },
      bootstrap: {
        dshAsOfSeq: bootstrap.body?.history?.asOfSeq ?? null,
        proxyAsOfSeq: proxyBootstrap.body?.history?.asOfSeq ?? null,
      },
    };
    await privateWriteJson(statePath, state);

    process.stdout.write(JSON.stringify({
      ok: true,
      command: 'up',
      home,
      stateFile: statePath,
      repoHead,
      workspaceId: identities.workspaceId,
      seedSessionId: SEED_SESSION_ID,
      provisioning: state.provisioning,
      endpoints: state.endpoints,
      processes: {
        dsh: { pid: dsh.pid, log: dsh.logPath },
        proxy: { pid: proxy.pid, log: proxy.logPath },
      },
      plugin: { installedPath: plugin.installedPath, sourceLibDigest: plugin.sourceLibDigest },
    }, null, 2) + '\n');
  } catch (error) {
    for (const item of [...started].reverse()) {
      try { await terminateRecorded(item.record, item.label); } catch {}
    }
    throw error;
  }
}

async function status(options) {
  const home = resolve(options.home ?? process.env.D0_HOME ?? DEFAULT_HOME);
  const { statePath, state } = await readState(home);
  const report = await statusForState(state);
  process.stdout.write(JSON.stringify({
    ok: report.healthy,
    command: 'status',
    home,
    stateFile: statePath,
    stoppedAt: state.stoppedAt ?? null,
    provisioning: {
      endpoint: state.provisioning.endpoint,
      sessionId: state.provisioning.sessionId,
      tokenStoredInState: true,
    },
    ...report,
    logs: state.logs,
  }, null, 2) + '\n');
  if (!report.healthy) process.exitCode = 1;
}

async function down(options) {
  const home = resolve(options.home ?? process.env.D0_HOME ?? DEFAULT_HOME);
  const { statePath, state } = await readState(home);
  const proxy = await terminateRecorded(state.processes?.proxy, 'proxy');
  const dsh = await terminateRecorded(state.processes?.dsh, 'dsh');
  const stopped = proxy.stopped && dsh.stopped;
  state.stoppedAt = new Date().toISOString();
  state.lastDown = { proxy, dsh };
  await privateWriteJson(statePath, state);
  process.stdout.write(JSON.stringify({
    ok: stopped,
    command: 'down',
    home,
    stateFile: statePath,
    preservedHome: true,
    processes: { proxy, dsh },
  }, null, 2) + '\n');
  if (!stopped) process.exitCode = 1;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'up') return await up(options);
  if (command === 'status') return await status(options);
  if (command === 'down') return await down(options);
  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`[d0-runtime] FATAL: ${error?.stack ?? error}`);
  process.exit(2);
});
