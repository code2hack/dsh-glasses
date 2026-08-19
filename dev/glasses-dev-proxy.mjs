// Gentle G0 dev proxy: exposes ONLY the authenticated /glasses/v1/* projection
// to the private tailnet, forwarding to the loopback disposable DSH instance.
// Every other path (notably /api/* host RPC) is rejected. Debug-only, private
// network only; never use publicly / in front of an unrestricted API.
import { createServer } from "node:http";

const UPSTREAM = process.env.GLASSES_UPSTREAM ?? "http://127.0.0.1:3190";
const HOST = process.env.GLASSES_PROXY_HOST ?? "0.0.0.0";
const PORT = Number(process.env.GLASSES_PROXY_PORT ?? 3200);
const PREFIX = "/glasses/v1/";

function shouldProxy(path) {
  if (path === "/glasses/v1" || path.startsWith(PREFIX)) return true;
  return path === "/glasses/v1/";
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (!shouldProxy(url.pathname)) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "forbidden-by-dev-proxy" }));
    return;
  }
  const target = new URL(UPSTREAM + req.url);
  const upstreamReq = fetch(target, {
    method: req.method,
    headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : req,
    duplex: "half",
    redirect: "manual",
  });
  upstreamReq
    .then(async (ur) => {
      res.writeHead(ur.status, Object.fromEntries(ur.headers.entries()));
      if (ur.body) { for await (const chunk of ur.body) res.write(chunk); }
      res.end();
    })
    .catch((e) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
    });
});

server.listen(PORT, HOST, () => {
  console.log(`[glasses-dev-proxy] ${HOST}:${PORT} -> ${UPSTREAM} (${PREFIX}* only)`);
});
