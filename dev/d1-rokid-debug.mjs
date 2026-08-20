#!/usr/bin/env node
/**
 * TB0-D1 reproducible Rokid debug helper.
 *
 * Run on the active ADB host (normally u4090). It intentionally does not
 * contain SSH orchestration; Spark workers invoke it through the existing SSH
 * workflow. All semantic controls remain SYNTHETIC_DEBUG_CONTROL.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_ADB = '/opt/android-sdk/platform-tools/adb';
const DEFAULT_SERIAL = '1906092617103125';
const DEFAULT_PACKAGE = 'com.code2hack.glasses';
const DEFAULT_CDP_PORT = 9333;
const MAX_CLIPBOARD_CHARS = 16_384;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function usage(exitCode = 0) {
  const text = `\nTB0-D1 Rokid debug helper\n\n` +
    `Usage:\n` +
    `  node dev/d1-rokid-debug.mjs provision --stdin [common options]\n` +
    `  node dev/d1-rokid-debug.mjs state [common options]\n` +
    `  node dev/d1-rokid-debug.mjs clipboard (--stdin | --text TEXT) [common options]\n` +
    `  node dev/d1-rokid-debug.mjs control NAME [NAME ...] [common options]\n\n` +
    `Common options:\n` +
    `  --adb PATH       default ${DEFAULT_ADB}\n` +
    `  --serial SERIAL  default ${DEFAULT_SERIAL}\n` +
    `  --package NAME   default ${DEFAULT_PACKAGE}\n` +
    `  --cdp-port N     first local port to try, default ${DEFAULT_CDP_PORT}\n` +
    `  --timeout-ms N   default 30000\n`;
  (exitCode ? process.stderr : process.stdout).write(text);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const tokens = [...argv];
  const command = tokens.shift();
  if (!command || command === '--help' || command === '-h') usage(0);
  const options = {};
  const positionals = [];
  const booleanFlags = new Set(['stdin']);
  while (tokens.length) {
    const token = tokens.shift();
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === 'help') usage(0);
    if (booleanFlags.has(key)) {
      options[key] = true;
      continue;
    }
    const value = tokens.shift();
    if (value == null || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    options[key] = value;
  }
  return { command, options, positionals };
}

function numberOption(value, fallback, name) {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 120_000) throw new Error(`invalid --${name}: ${value}`);
  return n;
}

function configFrom(options) {
  return {
    adb: options.adb ?? process.env.ADB ?? DEFAULT_ADB,
    serial: options.serial ?? process.env.SERIAL ?? DEFAULT_SERIAL,
    packageName: options.package ?? process.env.D1_PACKAGE ?? DEFAULT_PACKAGE,
    cdpPort: numberOption(options['cdp-port'], DEFAULT_CDP_PORT, 'cdp-port'),
    timeoutMs: numberOption(options['timeout-ms'], 30_000, 'timeout-ms'),
  };
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${(result.stderr || result.stdout || '').trim().slice(-2000)}`);
  }
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function adb(config, args, options) {
  return run(config.adb, ['-s', config.serial, ...args], options);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function sha256Utf8(value) {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

async function ensureDevice(config) {
  const state = adb(config, ['get-state']).stdout.trim();
  if (state !== 'device') throw new Error(`ADB serial ${config.serial} is not healthy: ${state || '(empty)'}`);
  const packagePath = adb(config, ['shell', 'pm', 'path', config.packageName], { allowFailure: true });
  if (packagePath.status !== 0 || !packagePath.stdout.includes('package:')) {
    throw new Error(`package not installed: ${config.packageName}`);
  }
  const dump = adb(config, ['shell', 'dumpsys', 'package', config.packageName]).stdout;
  if (!/DEBUGGABLE/i.test(dump)) throw new Error(`installed package is not debuggable: ${config.packageName}`);
}

function mainComponent(config) {
  return `${config.packageName}/.MainActivity`;
}

function clipboardComponent(config) {
  return `${config.packageName}/.DebugClipboardSeedActivity`;
}

async function startMain(config) {
  adb(config, ['shell', 'am', 'start', '-W', '-n', mainComponent(config)]);
  return await waitPid(config);
}

async function restartMain(config) {
  adb(config, ['shell', 'am', 'force-stop', config.packageName]);
  await sleep(250);
  return await startMain(config);
}

async function waitPid(config) {
  const deadline = Date.now() + config.timeoutMs;
  while (Date.now() < deadline) {
    const result = adb(config, ['shell', 'pidof', '-s', config.packageName], { allowFailure: true });
    const pid = Number(result.stdout.trim());
    if (Number.isInteger(pid) && pid > 0) return pid;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${config.packageName} pid`);
}

async function localPortFree(port) {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function createForward(config, pid) {
  const remote = `localabstract:webview_devtools_remote_${pid}`;
  for (let port = config.cdpPort; port < config.cdpPort + 100; port += 1) {
    if (!(await localPortFree(port))) continue;
    const result = adb(config, ['forward', `tcp:${port}`, remote], { allowFailure: true });
    if (result.status === 0) return { port, remote, created: true };
  }
  throw new Error(`could not allocate an ADB CDP forward from tcp:${config.cdpPort}`);
}

function removeForward(config, forward) {
  if (!forward?.created) return;
  adb(config, ['forward', '--remove', `tcp:${forward.port}`], { allowFailure: true });
}

async function fetchJson(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeC0Signature(state) {
  if (!state || typeof state !== 'object') return null;
  const pick = (key) => (key in state ? state[key] : null);
  return {
    endpoint: pick('endpoint'),
    expectedSession: pick('expectedSession'),
    generation: pick('generation'),
    lastSeq: pick('lastSeq'),
    streamOpen: pick('streamOpen'),
    streamVerified: pick('streamVerified'),
    identityFailure: pick('identityFailure'),
    mode: pick('mode'),
    hudVisible: pick('hudVisible'),
  };
}

// Non-secret liveness probe; never captures token or clipboard body.
const PROBE_EXPRESSION = `(() => {
  const hasC0 = typeof window.c0DebugState === 'function';
  const cs = hasC0 ? window.c0DebugState.call(window) : null;
  const t = Number(performance && performance.timeOrigin) || 0;
  const sig = cs && typeof cs === 'object' ? {
    endpoint: cs.endpoint ?? null,
    expectedSession: cs.expectedSession ?? null,
    generation: cs.generation ?? null,
    lastSeq: cs.lastSeq ?? null,
    streamOpen: cs.streamOpen ?? null,
    streamVerified: cs.streamVerified ?? null,
    identityFailure: cs.identityFailure ?? null,
    mode: cs.mode ?? null,
    hudVisible: cs.hudVisible ?? null,
  } : null;
  return {
    hasC0,
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    timeOrigin: Number.isFinite(t) ? t : null,
    sig,
  };
})()`;

async function probeCandidate(target) {
  const cdp = new CdpSocket(target.webSocketDebuggerUrl, 5000);
  try {
    await cdp.connect();
    const info = await cdp.evaluate(PROBE_EXPRESSION);
    return { ok: true, info: info && typeof info === 'object' ? info : null };
  } catch (error) {
    return { ok: false, info: null, error: error.message };
  } finally {
    cdp.close();
  }
}

function selectFromProbes(preferred, probes) {
  const usable = [];
  for (let i = 0; i < preferred.length; i += 1) {
    const p = probes[i];
    if (p.ok && p.info && p.info.hasC0) usable.push({ target: preferred[i], info: p.info });
  }
  const diag = (idx, p) => (p.ok
    ? `cand${idx}:hasC0=${p.info?.hasC0 ?? false},ready=${p.info?.readyState ?? '?'},vis=${p.info?.visibilityState ?? '?'},focus=${p.info?.hasFocus ?? false},timeOrigin=${p.info?.timeOrigin ?? 'n/a'}`
    : `cand${idx}:probe-failed(${p.error ?? 'unknown'})`);
  const ambiguity = () => ({
    chosen: null,
    selection: {
      candidateCount: preferred.length,
      candidateCountUsable: usable.length,
      selectionReason: 'ambiguity-preserved',
    },
    diagnostics: probes.map(diag),
  });
  if (usable.length === 0) return ambiguity();

  if (usable.length === 1) {
    return { chosen: usable[0].target, selection: { candidateCount: preferred.length, candidateCountUsable: 1, selectionReason: 'unique' }, diagnostics: [] };
  }

  let chosen = null;
  let reason = null;
  const finite = usable.filter((u) => Number.isFinite(u.info.timeOrigin));
  if (finite.length >= 1) {
    const max = Math.max(...finite.map((u) => u.info.timeOrigin));
    const atMax = finite.filter((u) => u.info.timeOrigin === max);
    if (atMax.length === 1) { chosen = atMax[0].target; reason = 'newest-live-document'; }
  }
  if (!chosen) {
    const focused = usable.filter((u) => u.info.visibilityState === 'visible' && u.info.hasFocus === true);
    if (focused.length === 1) { chosen = focused[0].target; reason = 'focused-live-document'; }
  }
  if (!chosen) {
    const targetKey = (t) => `${String(t.title ?? '')}\u0000${String(t.url ?? '')}`;
    const sigs = usable.map((u) => JSON.stringify(u.info.sig));
    const mirrorEquivalent =
      sigs.every((v) => v === sigs[0]) && sigs[0] !== 'null' &&
      usable.every((u) => targetKey(u.target) === targetKey(usable[0].target));
    if (mirrorEquivalent) {
      const sorted = [...usable].sort((a, b) =>
        String(a.target.id ?? a.target.webSocketDebuggerUrl).localeCompare(
          String(b.target.id ?? b.target.webSocketDebuggerUrl)
        )
      );
      chosen = sorted[0].target;
      reason = 'equivalent-firmware-mirror';
    }
  }
  if (!chosen) return ambiguity();
  return { chosen, selection: { candidateCount: preferred.length, candidateCountUsable: usable.length, selectionReason: reason }, diagnostics: [] };
}

async function discoverTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json`, 2500);
      const pages = Array.isArray(targets)
        ? targets.filter((x) => x?.type === 'page' && typeof x.webSocketDebuggerUrl === 'string')
        : [];
      const preferred = pages.filter((x) =>
        String(x.url ?? '').startsWith('file:///android_asset/index.html') ||
        String(x.title ?? '').toLowerCase().includes('dsh-glasses')
      );
      if (preferred.length === 1) {
        return { target: preferred[0], selection: { candidateCount: 1, selectionReason: 'unique' } };
      }
      if (preferred.length === 0 && pages.length === 1) {
        return { target: pages[0], selection: { candidateCount: 1, selectionReason: 'unique' } };
      }
      if (preferred.length > 1) {
        const probes = await Promise.all(preferred.map((t) => probeCandidate(t)));
        const result = selectFromProbes(preferred, probes);
        if (result.chosen) return { target: result.chosen, selection: result.selection };
        last = `ambiguous WebView targets (sanitized): ${result.diagnostics.join(' | ')}`;
        throw new Error(last);
      }
      last = 'no page target yet';
    } catch (error) {
      last = error.message;
    }
    await sleep(200);
  }
  throw new Error(`timed out discovering dsh-glasses WebView target: ${last ?? 'unknown'}`);
}

function websocketFrame(opcode, body = Buffer.alloc(0)) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const mask = randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

class CdpSocket {
  constructor(url, timeoutMs) {
    this.url = new URL(url);
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.handshakeDone = false;
    this.handshakeBuffer = Buffer.alloc(0);
    this.expectedAccept = null;
    this.connectResolve = null;
    this.connectReject = null;
    this.pending = new Map();
    this.nextId = 1;
    this.fragmentOpcode = null;
    this.fragmentChunks = [];
  }

  async connect() {
    if (this.url.protocol !== 'ws:') throw new Error(`unsupported CDP websocket protocol: ${this.url.protocol}`);
    const host = this.url.hostname;
    const port = Number(this.url.port || 80);
    const path = `${this.url.pathname}${this.url.search}`;
    const key = randomBytes(16).toString('base64');
    this.expectedAccept = createHash('sha1').update(key + WS_GUID).digest('base64');

    await new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      const timer = setTimeout(() => reject(new Error('CDP websocket handshake timeout')), this.timeoutMs);
      this.socket = createConnection({ host, port });
      this.socket.once('connect', () => {
        this.socket.write(
          `GET ${path} HTTP/1.1\r\n` +
          `Host: ${host}:${port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      this.socket.on('data', (chunk) => this.onData(chunk));
      this.socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
        this.rejectAll(error);
      });
      this.socket.once('close', () => {
        clearTimeout(timer);
        this.rejectAll(new Error('CDP websocket closed'));
      });
      const originalResolve = this.connectResolve;
      this.connectResolve = () => {
        clearTimeout(timer);
        originalResolve();
      };
    });
  }

  onData(chunk) {
    if (!this.handshakeDone) {
      this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk]);
      const marker = this.handshakeBuffer.indexOf('\r\n\r\n');
      if (marker < 0) return;
      const head = this.handshakeBuffer.subarray(0, marker).toString('utf8');
      const leftover = this.handshakeBuffer.subarray(marker + 4);
      const lines = head.split('\r\n');
      if (!/^HTTP\/1\.1 101\b/.test(lines[0] ?? '')) {
        this.connectReject?.(new Error(`CDP websocket upgrade failed: ${lines[0] ?? '(missing status)'}`));
        this.socket?.destroy();
        return;
      }
      const headers = new Map();
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
      }
      if (headers.get('sec-websocket-accept') !== this.expectedAccept) {
        this.connectReject?.(new Error('CDP websocket accept mismatch'));
        this.socket?.destroy();
        return;
      }
      this.handshakeDone = true;
      this.connectResolve?.();
      this.connectResolve = null;
      this.connectReject = null;
      this.handshakeBuffer = Buffer.alloc(0);
      if (leftover.length) this.parseFrames(leftover);
      return;
    }
    this.parseFrames(chunk);
  }

  parseFrames(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const n = this.buffer.readBigUInt64BE(2);
        if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CDP websocket frame too large');
        length = Number(n);
        offset = 10;
      }
      const maskBytes = masked ? 4 : 0;
      if (this.buffer.length < offset + maskBytes + length) return;
      let payload = this.buffer.subarray(offset + maskBytes, offset + maskBytes + length);
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(length);
        for (let i = 0; i < length; i += 1) unmasked[i] = payload[i] ^ mask[i % 4];
        payload = unmasked;
      }
      this.buffer = this.buffer.subarray(offset + maskBytes + length);

      if (opcode === 0x9) {
        this.socket?.write(websocketFrame(0xA, payload));
        continue;
      }
      if (opcode === 0x8) {
        this.socket?.end();
        return;
      }
      if (opcode === 0x1 && !fin) {
        this.fragmentOpcode = opcode;
        this.fragmentChunks = [payload];
        continue;
      }
      if (opcode === 0x0 && this.fragmentOpcode != null) {
        this.fragmentChunks.push(payload);
        if (!fin) continue;
        payload = Buffer.concat(this.fragmentChunks);
        this.fragmentOpcode = null;
        this.fragmentChunks = [];
      } else if (opcode !== 0x1) {
        continue;
      }
      this.onMessage(payload.toString('utf8'));
    }
  }

  onMessage(text) {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message?.id == null) return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(`CDP ${waiter.method}: ${message.error.message ?? JSON.stringify(message.error)}`));
    else waiter.resolve(message.result);
  }

  rejectAll(error) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  async command(method, params = {}) {
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });
    this.socket.write(websocketFrame(0x1, Buffer.from(JSON.stringify({ id, method, params }), 'utf8')));
    return await result;
  }

  async evaluate(expression) {
    const response = await this.command('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response?.exceptionDetails) {
      const description = response.exceptionDetails?.exception?.description ?? response.exceptionDetails?.text ?? 'JavaScript exception';
      throw new Error(`CDP Runtime.evaluate failed: ${description}`);
    }
    return response?.result?.value;
  }

  close() {
    try { this.socket?.write(websocketFrame(0x8)); } catch {}
    try { this.socket?.destroy(); } catch {}
  }
}

async function withCdp(config, callback) {
  await ensureDevice(config);
  const pid = await startMain(config);
  const forward = await createForward(config, pid);
  let cdp = null;
  try {
    const { target, selection } = await discoverTarget(forward.port, config.timeoutMs);
    cdp = new CdpSocket(target.webSocketDebuggerUrl, config.timeoutMs);
    await cdp.connect();
    const value = await callback({ cdp, target, pid, port: forward.port });
    return { value, target, pid, port: forward.port, selection };
  } finally {
    cdp?.close();
    removeForward(config, forward);
  }
}

async function readC0State(config) {
  const result = await withCdp(config, async ({ cdp }) => {
    const state = await cdp.evaluate('(() => window.c0DebugState ? window.c0DebugState() : null)()');
    if (!state || typeof state !== 'object') throw new Error('c0DebugState() unavailable');
    return state;
  });
  return result;
}

function deviceIdentity(config, pid) {
  const model = adb(config, ['shell', 'getprop', 'ro.product.model']).stdout.trim();
  const fingerprint = adb(config, ['shell', 'getprop', 'ro.build.fingerprint']).stdout.trim();
  return { serial: config.serial, package: config.packageName, pid, model, fingerprint };
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function parseProvisioningDocument(raw) {
  let body;
  try { body = JSON.parse(raw); } catch { throw new Error('provision stdin is not valid JSON'); }
  const provisioning = body?.provisioning ?? body;
  const endpoint = String(provisioning?.endpoint ?? '').trim().replace(/\/$/, '');
  const sessionId = String(provisioning?.sessionId ?? '').trim();
  const token = String(provisioning?.token ?? '');
  if (!/^https?:\/\//.test(endpoint)) throw new Error('provision JSON has no valid provisioning.endpoint');
  if (!sessionId) throw new Error('provision JSON has no provisioning.sessionId');
  if (!token) throw new Error('provision JSON has no provisioning.token');
  return { endpoint, sessionId, token };
}

function sessionPrefix(sessionId) {
  return sessionId.length <= 12 ? sessionId : `${sessionId.slice(0, 12)}…`;
}

async function commandProvision(config, options) {
  if (!options.stdin) throw new Error('provision requires --stdin so the bearer is not exposed in argv');
  const provisioning = parseProvisioningDocument(await readStdin());
  await ensureDevice(config);

  const configured = await withCdp(config, async ({ cdp }) => {
    const expression = `(() => Boolean(window.GlassesBridge && window.GlassesBridge.configure(` +
      `${JSON.stringify(provisioning.endpoint)},${JSON.stringify(provisioning.token)},${JSON.stringify(provisioning.sessionId)})))()`;
    return await cdp.evaluate(expression);
  });
  if (configured.value !== true) throw new Error('GlassesBridge.configure returned false');

  await restartMain(config);
  const deadline = Date.now() + config.timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    try {
      const result = await readC0State(config);
      lastState = result.value;
      const good =
        lastState.endpoint === provisioning.endpoint &&
        lastState.expectedSession === provisioning.sessionId &&
        lastState.identityFailure == null &&
        lastState.streamVerified === true;
      if (good) {
        printJson({
          ok: true,
          command: 'provision',
          device: deviceIdentity(config, result.pid),
          endpoint: provisioning.endpoint,
          sessionPrefix: sessionPrefix(provisioning.sessionId),
          streamVerified: true,
          generation: lastState.generation ?? null,
          lastSeq: lastState.lastSeq ?? null,
          bearerEmitted: false,
          cdpSelection: { candidateCount: result.selection.candidateCount, selectionReason: result.selection.selectionReason },
        });
        return;
      }
    } catch {}
    await sleep(300);
  }
  throw new Error(`provisioning did not become live; endpoint/session/stream state did not converge`);
}

async function commandState(config) {
  const result = await readC0State(config);
  printJson({
    ok: true,
    command: 'state',
    device: deviceIdentity(config, result.pid),
    cdp: { port: result.port, title: result.target.title ?? '', url: result.target.url ?? '' },
    cdpSelection: { candidateCount: result.selection.candidateCount ?? null, selectionReason: result.selection.selectionReason ?? null },
    state: result.value,
  });
}

async function clipboardInput(options) {
  if (options.stdin && options.text != null) throw new Error('clipboard accepts either --stdin or --text, not both');
  if (options.stdin) return await readStdin();
  if (options.text != null) return String(options.text);
  throw new Error('clipboard requires --stdin or --text TEXT');
}

async function commandClipboard(config, options) {
  const text = await clipboardInput(options);
  if (text.length > MAX_CLIPBOARD_CHARS) throw new Error(`clipboard text exceeds ${MAX_CLIPBOARD_CHARS} characters`);
  await ensureDevice(config);
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  const launch = adb(config, [
    'shell', 'am', 'start', '-W', '-n', clipboardComponent(config), '--es', 'text_b64', encoded,
  ], { allowFailure: true });
  if (launch.status !== 0) throw new Error('debug clipboard Activity failed to launch');
  await sleep(150);

  const result = await withCdp(config, async ({ cdp }) => {
    return await cdp.evaluate('(() => String(window.GlassesBridge ? window.GlassesBridge.clipboardText() : ""))()');
  });
  const observed = String(result.value ?? '');
  const expectedDigest = sha256Utf8(text);
  const observedDigest = sha256Utf8(observed);
  const matches = observed === text;
  printJson({
    ok: matches,
    command: 'clipboard',
    device: deviceIdentity(config, result.pid),
    characters: text.length,
    utf8Bytes: Buffer.byteLength(text, 'utf8'),
    sha256: expectedDigest,
    observedSha256: observedDigest,
    matches,
    clipboardBodyEmitted: false,
    cdpSelection: { candidateCount: result.selection.candidateCount ?? null, selectionReason: result.selection.selectionReason ?? null },
  });
  if (!matches) process.exitCode = 1;
}

async function commandControl(config, names) {
  if (!names.length) throw new Error('control requires at least one semantic control name');
  for (const name of names) {
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(name)) throw new Error(`invalid semantic control name: ${name}`);
  }
  const result = await withCdp(config, async ({ cdp }) => {
    const before = await cdp.evaluate('(() => window.c0DebugState ? window.c0DebugState() : null)()');
    if (!before) throw new Error('c0DebugState() unavailable');
    const afterEach = [];
    for (const name of names) {
      const expression = `(async () => {` +
        `window.GlassesBridge.debugSemanticControl(${JSON.stringify(name)});` +
        `await new Promise(r => setTimeout(r, 180));` +
        `return window.c0DebugState ? window.c0DebugState() : null;` +
        `})()`;
      const state = await cdp.evaluate(expression);
      if (!state) throw new Error(`c0DebugState unavailable after ${name}`);
      afterEach.push({ name, state });
    }
    return { before, afterEach, after: afterEach.at(-1)?.state ?? before };
  });
  printJson({
    ok: true,
    command: 'control',
    provenance: 'SYNTHETIC_DEBUG_CONTROL',
    device: deviceIdentity(config, result.pid),
    cdpSelection: { candidateCount: result.selection.candidateCount ?? null, selectionReason: result.selection.selectionReason ?? null },
    controls: names,
    before: result.value.before,
    afterEach: result.value.afterEach,
    after: result.value.after,
  });
}

async function main() {
  const { command, options, positionals } = parseArgs(process.argv.slice(2));
  const config = configFrom(options);
  if (command === 'provision') return await commandProvision(config, options);
  if (command === 'state') return await commandState(config);
  if (command === 'clipboard') return await commandClipboard(config, options);
  if (command === 'control') return await commandControl(config, positionals);
  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`[d1-rokid-debug] FATAL: ${error?.message ?? error}`);
  process.exit(2);
});
