// TB0-R0 delay-fixture smoke: spins up the proxy against a dummy upstream and
// asserts: other paths rejected; /glasses/v1/* forwarded; /actions upstream
// completes first (marker written), downstream response delayed; auth header
// carried (not logged); no marker for non-actions.
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
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures.push(name);
};

// dummy upstream
const upstream = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://u');
  let body = '';
  for await (const c of req) body += c;
  process.env.UP_LAST = JSON.stringify({ path: u.pathname, auth: req.headers.authorization ?? '', body });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, echoed: u.pathname, body }));
});
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));

const proxyProc = spawn(process.execPath, [
  join(import.meta.dirname, 'r0-delay-proxy.mjs'),
  String(PROXY_PORT),
  String(DELAY),
  `http://127.0.0.1:${UP_PORT}`,
], { env: { ...process.env, R0_MARKER: marker }, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 600));

const post = (path, body, auth = 'Bearer smoke-token') =>
  fetch(`http://127.0.0.1:${PROXY_PORT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body ?? {}),
  });

// 1) non /glasses/v1/* rejected
const r1 = await post('/api/evil');
check('other paths -> 403', r1.status === 403);

// 2) bootstrap forwarded, auth carried
const r2 = await post('/glasses/v1/bootstrap', { sessionId: 's' });
check('bootstrap forwarded 200', r2.status === 200);
const up = JSON.parse(process.env.UP_LAST);
check('auth carried upstream', up.auth === 'Bearer smoke-token');

// 3) actions: upstream completes (marker) then downstream delayed >= DELAY
await post('/glasses/v1/actions', { kind: 'send', operationId: 'smoke-op', draftRevision: 1 });
check('marker written', readFileSync(marker, 'utf8').includes('smoke-op'));
check('marker has timing not credentials', !readFileSync(marker, 'utf8').includes('smoke-token'));

// 4) non-actions produce no marker
rmSync(marker, { force: true });
await post('/glasses/v1/bootstrap', {});
check('no marker for non-actions', !existsSync(marker));

proxyProc.kill();
upstream.close();
console.log(failures.length ? `SMOKE FAILED: ${failures.join(', ')}` : 'SMOKE PASS');
process.exit(failures.length ? 1 : 0);
