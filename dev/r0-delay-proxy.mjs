// TB0-R0 response-loss test fixture (repository copy, sanitized).
// Private test proxy: forwards ONLY /glasses/v1/* to an upstream; for /actions it
// buffers the full upstream response, records operation ID + timing only (never
// credentials), then delays the downstream response by DELAY_MS.
//
// No session ID, token, or endpoint credential is embedded or logged anywhere.
// Run: node dev/r0-delay-proxy.mjs [port] [delayMs] [upstream]
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const PORT = Number(process.argv[2] ?? 32901);
const DELAY_MS = Number(process.argv[3] ?? 15000);
const UPSTREAM = process.argv[4] ?? 'http://127.0.0.1:3190';
const MARKER = process.env.R0_MARKER ?? '/tmp/r0-delay-marker.log';

createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://proxy.invalid');
  if (!u.pathname.startsWith('/glasses/v1/')) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
    return;
  }
  const body = await new Promise((r) => {
    const c = [];
    req.on('data', (d) => c.push(d));
    req.on('end', () => r(Buffer.concat(c)));
  });

  const fwd = await fetch(
    UPSTREAM + u.pathname + u.search,
    {
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] ?? 'application/json',
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      },
      body: body.length ? body : undefined,
    },
  ).catch((e) => null);
  if (!fwd) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'upstream-unreachable' }));
    return;
  }

  const upBody = Buffer.from(await fwd.arrayBuffer());
  const slow = u.pathname === '/glasses/v1/actions';
  if (slow) {
    let op = '';
    try {
      op = String(JSON.parse(body.toString('utf8')).operationId || '');
    } catch (_) {}
    appendFileSync(
      MARKER,
      JSON.stringify({ t: Date.now(), op, upstreamStatus: fwd.status, marker: 'upstream-complete' }) + '\n',
    );
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  res.writeHead(fwd.status, {
    'content-type': fwd.headers.get('content-type') ?? 'application/json',
    'content-length': upBody.length,
  });
  res.end(upBody);
}).listen(PORT, '0.0.0.0', () => {
  console.log(`[r0-delay-proxy] 0.0.0.0:${PORT} -> ${UPSTREAM} delay(actions)=${DELAY_MS}ms`);
});
