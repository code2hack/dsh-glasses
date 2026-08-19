// TB0-R0 delay-fixture smoke: spins up the proxy against a dummy upstream and
// proves that an /actions upstream response completes and is marked BEFORE the
// delayed downstream response settles. It also checks path restriction,
// authorization forwarding without logging, and no marker for non-actions.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const UP_PORT = 32902;
const PROXY_PORT = 32903;
const DELAY = 3000;
const marker = join(tmpdir(), 'r0-smoke-marker.log');
rmSync(marker, { force: true });

const failures = [];
const check = (name, condition, detail = '') => {
  const pass = Boolean(condition);
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass || !detail ? '' : ` :: ${detail}`}`);
  if (!pass) failures.push(name);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

let lastUpstream = null;
const upstream = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://upstream.invalid');
  let body = '';
  for await (const chunk of req) body += chunk;
  lastUpstream = {
    path: url.pathname,
    auth: req.headers.authorization ?? '',
    body,
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, echoed: url.pathname, body }));
});
await new Promise((resolve) => upstream.listen(UP_PORT, '127.0.0.1', resolve));

const proxyProc = spawn(process.execPath, [
  join(import.meta.dirname, 'r0-delay-proxy.mjs'),
  String(PROXY_PORT),
  String(DELAY),
  `http://127.0.0.1:${UP_PORT}`,
], {
  env: { ...process.env, R0_MARKER: marker },
  stdio: 'inherit',
});

const post = (path, body, auth = 'Bearer smoke-token') =>
  fetch(`http://127.0.0.1:${PROXY_PORT}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });

try {
  // Wait for the child listener rather than relying on a fixed startup sleep.
  await waitUntil(async () => {
    try {
      const response = await post('/api/readiness');
      return response.status === 403;
    } catch (_) {
      return false;
    }
  }, 5000, 'proxy listener');

  // 1) non-/glasses/v1/* paths are rejected and never reach upstream.
  lastUpstream = null;
  const blocked = await post('/api/evil');
  check('other paths -> 403', blocked.status === 403, `status=${blocked.status}`);
  check('blocked path never reached upstream', lastUpstream === null, JSON.stringify(lastUpstream));

  // 2) an allowed non-actions path is forwarded and carries auth upstream.
  const bootstrap = await post('/glasses/v1/bootstrap', { sessionId: 'synthetic' });
  check('bootstrap forwarded 200', bootstrap.status === 200, `status=${bootstrap.status}`);
  check('auth carried upstream', lastUpstream?.auth === 'Bearer smoke-token', JSON.stringify(lastUpstream));

  // 3) upstream completion marker must exist while the client response remains
  // unresolved, then the response must settle only after the configured delay.
  rmSync(marker, { force: true });
  let actionSettled = false;
  const actionStarted = Date.now();
  const actionPromise = post('/glasses/v1/actions', {
    kind: 'send',
    operationId: 'smoke-op',
    draftRevision: 1,
  }).then((response) => {
    actionSettled = true;
    return response;
  });

  await waitUntil(() => existsSync(marker), 2500, 'upstream-complete marker');
  const markerObserved = Date.now();
  const markerText = readFileSync(marker, 'utf8');
  check('marker precedes downstream settlement', !actionSettled);
  check('marker records operation id', markerText.includes('smoke-op'));
  check('marker contains no credential', !markerText.includes('smoke-token'));

  const actionResponse = await actionPromise;
  const actionElapsed = Date.now() - actionStarted;
  check('actions response forwarded 200', actionResponse.status === 200, `status=${actionResponse.status}`);
  check(
    'downstream response delayed',
    actionElapsed >= DELAY - 100,
    `elapsed=${actionElapsed}ms delay=${DELAY}ms markerAt=${markerObserved - actionStarted}ms`,
  );

  // 4) non-actions requests do not write the response-loss marker.
  rmSync(marker, { force: true });
  await post('/glasses/v1/bootstrap', {});
  check('no marker for non-actions', !existsSync(marker));
} finally {
  proxyProc.kill('SIGTERM');
  await new Promise((resolve) => upstream.close(resolve));
  rmSync(marker, { force: true });
}

console.log(failures.length ? `SMOKE FAILED: ${failures.join(', ')}` : 'SMOKE PASS');
process.exit(failures.length ? 1 : 0);
