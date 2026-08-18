// TB0-H0 read-only runtime proof plugin for dsh-glasses.
//
// Loads as an out-of-tree DSH (cordis) plugin on the pinned rc.7 runtime.
// Exposes the authenticated /glasses/v1/* read projection only:
//   GET  /glasses/v1/bootstrap         bounded history + status + draft projection
//   GET  /glasses/v1/stream            live SSE projection (monotonic seq, heartbeat, resume)
//   POST /glasses/v1/draft/mutations   501 NOT_IMPLEMENTED (proves namespace/auth only)
//   POST /glasses/v1/actions           501 NOT_IMPLEMENTED (proves namespace/auth only)
//
// Session identity comes ONLY from the runtime environment
// (DSH_GLASSES_TB0_SESSION_ID); never from committed config. The dev bearer
// credential comes from DSH_GLASSES_TB0_TOKEN.
//
// Seams pinned from installed @deepseek-ai/dsh@0.1.0-rc.7 sources:
//   ctx.webServer      — @deepseek-ai/dsh-host-webserver  (register exact/prefix routes)
//   ctx.sessionQuery   — @deepseek-ai/dsh-session-query   (readSession -> bounded snapshot)
//   ctx.sessions       — @deepseek-ai/dsh-session         ('session/event' channel, monotonic seq)
//   ctx.agents         — @deepseek-ai/dsh-agent           (get(sessionId) -> AgentHandle.status)

import { randomUUID, timingSafeEqual } from "node:crypto";
import z from "@deepseek-ai/schemastery";

export const name = "dsh-glasses-plugin";

// Session id and token MUST come from the runtime environment (never committed
// config). schemastery `.default()` does not lazy-evaluate, so resolve them at
// module scope into plain string defaults.
const ENV_SESSION_ID = process.env.DSH_GLASSES_TB0_SESSION_ID ?? "";
const ENV_TOKEN = process.env.DSH_GLASSES_TB0_TOKEN ?? "";

export const Config = z.object({
  sessionId: z.string().default(ENV_SESSION_ID),
  token: z.string().default(ENV_TOKEN),
  heartbeatMs: z.number().default(15000),
  bootstrapMaxEvents: z.number().default(200),
});

export const inject = ["webServer", "sessionQuery", "sessions", "agents"];

const PROTOCOL_MAJOR = 1;

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function projectEvent(evt) {
  // Minimal, TB0-only projection: no raw DSH event objects are exposed.
  return { seq: evt.seq, type: evt.type };
}

export async function apply(ctx, config) {
  const { sessionId, token, heartbeatMs, bootstrapMaxEvents } = config;
  if (!sessionId) {
    throw new Error("dsh-glasses-plugin: DSH_GLASSES_TB0_SESSION_ID is required (runtime env, never committed)");
  }
  if (!token) {
    throw new Error("dsh-glasses-plugin: DSH_GLASSES_TB0_TOKEN is required (dev bearer credential)");
  }

  const serverGeneration = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const log = (...args) => console.log("[dsh-glasses-plugin]", ...args);

  const requireAuth = (req) => {
    const h = req.headers.authorization ?? "";
    const m = /^Bearer\s+(.+)$/.exec(h);
    return !!m && safeEqual(m[1], token);
  };

  const readSnapshot = async () => {
    const snap = await ctx.sessionQuery.readSession(sessionId);
    const events = Array.isArray(snap?.events) ? snap.events : [];
    const bounded = events.slice(-bootstrapMaxEvents);
    const asOfSeq = bounded.length ? bounded[bounded.length - 1].seq : -1;
    let status = "unavailable";
    try {
      const agent = ctx.agents.get(sessionId);
      if (agent) status = agent.status === "running" ? "running" : "idle";
    } catch {
      /* agent absent or not-yet-published -> unavailable */
    }
    return { events: bounded, asOfSeq, status };
  };

  const handleBootstrap = async (req, res) => {
    if (!requireAuth(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });
    try {
      const { events, asOfSeq, status } = await readSnapshot();
      return sendJson(res, 200, {
        ok: true,
        protocolMajor: PROTOCOL_MAJOR,
        serverGeneration,
        attachment: { attachmentId: `tb0:${sessionId}:${serverGeneration}`, sessionId, status },
        history: { asOfSeq, events: events.map(projectEvent) },
      });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  };

  const handleStream = async (req, res) => {
    if (!requireAuth(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("event: hello\n");
    res.write(`data: ${JSON.stringify({ protocolMajor: PROTOCOL_MAJOR, serverGeneration, sessionId })}\n\n`);

    let lastSeq = -1;
    let closed = false;
    let gapFlag = false;

    const t0 = Date.now();
    const heartbeat = setInterval(() => {
      if (closed) return;
      res.write(`: hb ${Date.now() - t0}\n\n`);
    }, heartbeatMs);

    const onEvent = (session, evt) => {
      if (closed) return;
      if (session.id !== sessionId) return;
      const s = typeof evt?.seq === "number" ? evt.seq : -1;
      if (lastSeq !== -1 && s !== lastSeq + 1 && s > lastSeq + 1) {
        gapFlag = true;
        res.write(`id: ${s}\nevent: gap\ndata: ${JSON.stringify({ reason: "sequence-gap", lastSeq, nextSeq: s })}\n\n`);
      }
      lastSeq = Math.max(lastSeq, s);
      res.write(`id: ${s}\nevent: projection\n`);
      res.write(`data: ${JSON.stringify({ ...projectEvent(evt), generation: serverGeneration })}\n\n`);
    };

    // 'session/event' is emitted on the host cordis Context (see dsh-session
    // Context.Events); filter by the configured session id below.
    const offEvents = ctx.on("session/event", onEvent);

    req.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      offEvents?.();
    });
  };

  const handleStub = (route) => (req, res) => {
    if (!requireAuth(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });
    return sendJson(res, 501, { ok: false, error: "NOT_IMPLEMENTED", route });
  };

  const handleGlassesRoot = (req, res) =>
    sendJson(res, 404, { ok: false, error: "not-found", namespace: "/glasses/v1" });

  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/glasses/v1/bootstrap", handler: handleBootstrap }), "glasses.bootstrap");
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/glasses/v1/stream", handler: handleStream }), "glasses.stream");
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/glasses/v1/draft/mutations", handler: handleStub("/glasses/v1/draft/mutations") }), "glasses.draft");
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/glasses/v1/actions", handler: handleStub("/glasses/v1/actions") }), "glasses.actions");
  // Prove the namespace prefix registration also works and catches unknown sub-paths.
  ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: "/glasses/v1", handler: handleGlassesRoot }), "glasses.prefix");

  log(`ready: session=${sessionId} generation=${serverGeneration}`);
}
