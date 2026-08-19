// G0-only private proxy: expose exactly /glasses/v1/* from the loopback
// disposable DSH instance. Every stock DSH/API path remains unreachable.
import { createServer } from "node:http";

const UPSTREAM = process.env.GLASSES_UPSTREAM ?? "http://127.0.0.1:3190";
const HOST = process.env.GLASSES_PROXY_HOST ?? "0.0.0.0";
const PORT = Number(process.env.GLASSES_PROXY_PORT ?? 3200);
const PREFIX = "/glasses/v1/";
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

function shouldProxy(path) {
  return path === "/glasses/v1" || path === "/glasses/v1/" || path.startsWith(PREFIX);
}

function requestHeaders(incoming) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (value == null || lower === "host" || HOP_BY_HOP.has(lower)) continue;
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else headers.set(name, value);
  }
  headers.set("accept-encoding", "identity");
  return headers;
}

function responseHeaders(incoming) {
  const headers = {};
  incoming.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
  });
  return headers;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://proxy.invalid");
  if (!shouldProxy(url.pathname)) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "forbidden-by-dev-proxy" }));
    return;
  }

  const controller = new AbortController();
  const abortUpstream = () => controller.abort(new Error("downstream-closed"));
  res.once("close", abortUpstream);

  try {
    const upstreamResponse = await fetch(new URL(req.url ?? "/", UPSTREAM), {
      method: req.method,
      headers: requestHeaders(req.headers),
      body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : req,
      duplex: "half",
      redirect: "manual",
      signal: controller.signal,
    });

    if (res.destroyed) return;
    res.writeHead(upstreamResponse.status, responseHeaders(upstreamResponse.headers));
    if (upstreamResponse.body) {
      for await (const chunk of upstreamResponse.body) {
        if (res.destroyed) break;
        if (!res.write(chunk)) await new Promise((resolve) => res.once("drain", resolve));
      }
    }
    if (!res.destroyed && !res.writableEnded) res.end();
  } catch (error) {
    if (controller.signal.aborted || res.destroyed) return;
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
    } else {
      res.destroy(error instanceof Error ? error : undefined);
    }
  } finally {
    res.off("close", abortUpstream);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[glasses-dev-proxy] ${HOST}:${PORT} -> ${UPSTREAM} (${PREFIX}* only)`);
});
