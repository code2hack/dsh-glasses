// Repeatable smoke for the G0 narrow dev proxy.
// Asserts:
//   /glasses/v1/bootstrap                  -> forwarded (200) to OUR upstream
//   /api/session.list                      -> 403, upstream untouched
//   //other-host/glasses/v1/bootstrap      -> forwarded to OUR upstream ONLY (never other-host)
//   http://other-host/glasses/v1/bootstrap -> forwarded to OUR upstream ONLY (never other-host)
// Raw-socket requests are used to exercise absolute-form / authority-form
// request targets that node's fetch() would not allow.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';

const PROXY_PORT = 32190;
const UPSTREAM_PORT = 32191;
const PROXY_HOST = '127.0.0.1';

const hits = [];
const upstream = createServer((req, res) => {
  hits.push({ path: req.url, host: req.headers.host });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, path: req.url }));
});
await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

const proxy = spawn('node', ['dev/glasses-dev-proxy.mjs'], {
  env: {
    ...process.env,
    GLASSES_UPSTREAM: `http://127.0.0.1:${UPSTREAM_PORT}`,
    GLASSES_PROXY_HOST: PROXY_HOST,
    GLASSES_PROXY_PORT: String(PROXY_PORT),
  },
  stdio: 'ignore',
});
proxy.unref();

const base = `http://${PROXY_HOST}:${PROXY_PORT}`;
await new Promise((r) => setTimeout(r, 400));

function httpGet(pathname) {
  return new Promise((resolve, reject) => {
    const req = net.connect(PROXY_PORT, PROXY_HOST, () => {
      req.write(`GET ${pathname} HTTP/1.1\r\nHost: smoke.test\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(String(data)));
    req.on('error', reject);
  });
}

const raw = (await httpGet('//other-host/glasses/v1/bootstrap')).split('\r\n')[0];
const rawAbs = (await httpGet('http://other-host/glasses/v1/bootstrap')).split('\r\n')[0];

const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail }); }

// 1) plain allowed path -> 200 and upstream saw exactly that path, no foreign host
const r1 = await (await fetch(base + '/glasses/v1/bootstrap')).text();
check('bootstrap forwarded', r1.includes('"ok":true') && r1.includes('/glasses/v1/bootstrap'),
  `upstream body=${r1} hits=${JSON.stringify(hits)}`);

// 2) /api blocked -> 403 and upstream untouched by this path
const r2 = await fetch(base + '/api/session.list');
check('api blocked 403', r2.status === 403, `status=${r2.status}`);
const hitAfterApi = JSON.stringify(hits);
check('api never reached upstream', !hitAfterApi.includes('/api/session.list'), hitAfterApi);

// 3) authority-form -> our upstream only, no other-host connection
check('authority-form uses our upstream', raw.startsWith('HTTP/1.1 200'),
  `firstLine=${raw} hits=${JSON.stringify(hits)}`);
check('authority-form never selects other-host in host header',
  !JSON.stringify(hits).includes('other-host'),
  JSON.stringify(hits));

// 4) absolute-form -> our upstream only
check('absolute-form uses our upstream', rawAbs.startsWith('HTTP/1.1 200'),
  `firstLine=${rawAbs}`);
check('absolute-form never contacts other-host',
  !JSON.stringify(hits).includes('other-host'),
  JSON.stringify(hits));

proxy.kill('SIGKILL');
upstream.close();

let failed = 0;
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}${r.pass ? '' : ' :: ' + r.detail}`);
  if (!r.pass) failed++;
}
process.exit(failed ? 1 : 0);
