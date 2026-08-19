// TB0-H0 read-only runtime proof plugin for dsh-glasses.
//
// Loads as an out-of-tree DSH (cordis) plugin on the pinned rc.7 runtime.
// Exposes the authenticated /glasses/v1/* read projection only:
//   GET  /glasses/v1/bootstrap         bounded history + status + draft projection
//   GET  /glasses/v1/stream            live SSE projection (monotonic seq, heartbeat, resume)
//   POST /glasses/v1/draft/mutations   durable draft writes (monotonic revision)
//   POST /glasses/v1/actions           Send-only action (operationId + ledger + 0-or-1)
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

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
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

export const inject = ["webServer", "sessionQuery", "sessions", "agents", "storage", "apiProxy"];

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
      // Reconcile unresolved operations (under the session-wide mutex) before
      // composing authoritative draft/write state.
      try {
        await chainSession(() => reconcileUnresolved());
      } catch (e) {
        log("bootstrap reconcile failed:", String(e?.message ?? e));
      }
      let draftProj = { revision: 0, text: "", locked: false };
      let writeState = "ready";
      try {
        const st = await readState();
        draftProj = { revision: st.draft.revision, text: st.draft.text, locked: !!st.draft.lockedByOperationId };
        const unresolved = Object.values(st.operations).some((o) => ["prepared", "dispatching", "unknown"].includes(o.state));
        writeState = unresolved ? "reconciling" : "ready";
      } catch {
        /* storage not yet materialized -> defaults */
      }
      return sendJson(res, 200, {
        ok: true,
        protocolMajor: PROTOCOL_MAJOR,
        serverGeneration,
        attachment: { attachmentId: `tb0:${sessionId}:${serverGeneration}`, sessionId, status },
        history: { asOfSeq, events: events.map(projectEvent) },
        draft: draftProj,
        writeState,
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

  // ---- TB0 host-write slice (amended contract) ---------------------------
  // Single atomic state document per session (KvUnit `glasses_plugin`, table
  // `state`, key = sessionId). At-most-once comes from: never calling
  // session.prompt more than once per operationId, and settling only on exact
  // durable positive evidence (user/message.source.rpcId === operationId).
  // See docs/TRACER_BULLET_TB0_WRITE.md.
  const STATE_UNIT = { name: "glasses_plugin", version: 1, tables: ["state"], hasGlobal: false };
  let _kvUnit = null;
  const units = async () => {
    if (_kvUnit) return _kvUnit;
    const backend = ctx.storage?.backend?.get?.("json");
    const kv = backend?.kv;
    if (!kv) throw new Error("storage backend 'json' unavailable");
    _kvUnit = await kv.open(STATE_UNIT);
    return _kvUnit;
  };

  const emptyState = () => ({
    schemaVersion: 1,
    sessionId,
    draft: { revision: 0, text: "", lockedByOperationId: undefined, lastMutation: undefined },
    operations: {},
    mutations: {}, // operationId -> { digest, revision } (append-only, no pruning)
  });
  const readState = async () => {
    const u = await units();
    const snap = await u.loadAll();
    const rec = snap.tables.state?.[sessionId] ?? emptyState();
    if (!rec.mutations) rec.mutations = {};
    return rec;
  };
  const writeState = async (st) => {
    const u = await units();
    await u.putRecord("state", sessionId, st);
  };

  const currentSeq = async () => {
    const snap = await ctx.sessionQuery.readSession(sessionId);
    const evts = Array.isArray(snap?.events) ? snap.events : [];
    return evts.length ? evts[evts.length - 1].seq : -1;
  };

  const stableStringify = (v) => {
    if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
    if (v && typeof v === "object") {
      const keys = Object.keys(v).sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
    }
    return JSON.stringify(v);
  };
  const digestOf = (v) => createHash("sha256").update(stableStringify(v)).digest("hex");

  const readFullEvents = async () => {
    const snap = await ctx.sessionQuery.readSession(sessionId);
    return Array.isArray(snap?.events) ? snap.events : [];
  };

  // Count-based exact durable reconciliation over the COMPLETE raw log:
  //  0 -> unknown (unless exact rejection), 1 -> accepted, >1 -> invariant failure.
  // Durable-discard settlement is intentionally omitted in TB0 (canceled
  // inbox splices carry no identifying inserted payload); absence stays unknown.
  const reconcileOperation = async (op) => {
    const events = await readFullEvents();
    let count = 0;
    for (const e of events) {
      if (e?.type !== "user/message") continue;
      const data = e?.data ?? e; // rc.7 nests the event payload under .data
      const src = data?.source ?? e?.message?.source;
      if (src?.kind === "user" && src?.rpcId === op.operationId) count++;
    }
    return { count };
  };

  const settle = async (st, opId, state, lastError) => {
    const op = st.operations[opId];
    if (!op) return;
    op.state = state;
    if (lastError) op.lastError = lastError;
    if (state === "accepted") {
      // Monotonic clear: submitted revision D -> cleared revision D+1 so the
      // plugin-authoritative revision never decreases and old mutations stay invalid.
      st.draft = { revision: st.draft.revision + 1, text: "", lockedByOperationId: undefined, lastMutation: st.draft?.lastMutation };
    } else if (state === "rejected") {
      // Known rejection: retain text and revision but RELEASE the draft lock so
      // a fresh operation can proceed.
      st.draft = { ...st.draft, lockedByOperationId: undefined };
    }
    await writeState(st);
  };

  // Per-session serialization: read state -> validate -> prepare -> lock ->
  // dispatch -> settle all run one-at-a-time per configured session, so
  // concurrent duplicate and cross-operation requests cannot double-dispatch.
  // Test-only fault hooks are env-gated and inert by default.
  const sessionChains = new Map();
  const chainSession = (fn) => {
    const prev = sessionChains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    sessionChains.set(sessionId, next);
    return next;
  };

  const readStateForBootstrap = async () => {
    const u = await units();
    const snap = await u.loadAll();
    return snap.tables.state?.[sessionId] ?? emptyState();
  };

  // Reconcile unresolved operations from durable facts (never re-dispatch).
  // Runs on startup and on bootstrap. Returns true if state changed.
  const reconcileUnresolved = async () => {
    const st = await readState();
    let changed = false;
    for (const op of Object.values(st.operations)) {
      if (!["prepared", "dispatching", "unknown"].includes(op.state)) continue;
      const { count } = await reconcileOperation(op);
      if (count === 1) {
        op.state = "accepted";
        st.draft = { revision: st.draft.revision + 1, text: "", lockedByOperationId: undefined, lastMutation: st.draft?.lastMutation };
        changed = true;
      } else if (count > 1) {
        log("identity-invariant failure op=" + op.operationId + " count=" + count);
        op.invariantFailure = true;
        changed = true; // persist the failure marker; draft never cleared
      }
    }
    if (changed) await writeState(st);
    return changed;
  };

  // Startup reconcile sweep under the session-wide mutex.
  chainSession(() => reconcileUnresolved()).catch((e) => log("startup reconcile errors:", String(e?.message ?? e)));

  const readBody = async (req) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const handleDraftMutations = async (req, res) => {
    if (!requireAuth(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });
    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { ok: false, error: "bad-body" });
    }
    if (!body || typeof body !== "object") return sendJson(res, 400, { ok: false, error: "bad-body" });
    const opId = typeof body.operationId === "string" ? body.operationId : "";
    if (!opId) return sendJson(res, 400, { ok: false, error: "operationId-required" });
    return await chainSession(() => handleDraftMutationsInner(res, body, opId));
  };

  const handleDraftMutationsInner = async (res, body, opId) => {
    try {
      const mutation = body.mutation;
      if (!mutation || mutation.kind !== "replace" || typeof mutation.text !== "string")
        return sendJson(res, 400, { ok: false, error: "unsupported-mutation" });
      const expectedRevision = body.expectedRevision;
      if (typeof expectedRevision !== "number") return sendJson(res, 400, { ok: false, error: "expectedRevision-required" });
      const digest = digestOf({ operationId: opId, expectedRevision, mutation });

      const st = await readState();
      if (st.draft.lockedByOperationId)
        return sendJson(res, 409, { ok: false, error: "draft-locked", lockedByOperationId: st.draft.lockedByOperationId });

      // Append-only per-operation mutation result store (no pruning for TB0).
      const prior = st.mutations?.[opId];
      if (prior) {
        if (prior.digest === digest)
          return sendJson(res, 200, { ok: true, revision: prior.revision, status: "stored" });
        return sendJson(res, 409, { ok: false, error: "operation-conflict", operationId: opId });
      }

      if (expectedRevision !== st.draft.revision)
        return sendJson(res, 409, {
          ok: false,
          error: "revision-conflict",
          expected: expectedRevision,
          got: st.draft.revision,
          draft: st.draft,
        });

      st.draft.revision += 1;
      st.draft.text = mutation.text;
      st.draft.lastMutation = { operationId: opId, digest };
      if (!st.mutations) st.mutations = {};
      st.mutations[opId] = { digest, revision: st.draft.revision };
      await writeState(st);
      return sendJson(res, 200, { ok: true, revision: st.draft.revision, expectedRevision, status: "applied" });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  };

  const handleActions = async (req, res) => {
    if (!requireAuth(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });
    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { ok: false, error: "bad-body" });
    }
    if (!body || typeof body !== "object") return sendJson(res, 400, { ok: false, error: "bad-body" });
    try {
      if (body.kind !== "send") return sendJson(res, 400, { ok: false, error: "unknown-action", kind: body.kind ?? null });
      const opId = typeof body.operationId === "string" ? body.operationId : "";
      if (!opId) return sendJson(res, 400, { ok: false, error: "operationId-required" });
      return await chainSession(() => handleActionsInner(req, res, body, opId, null));
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  };

  const handleActionsInner = async (req, res, body, opId, _digest) => {
    try {
      const st = await readState();
      const digest = digestOf({
        kind: "send",
        sessionId,
        operationId: opId,
        draftRevision: body.draftRevision ?? null,
        contentDigest: body.contentDigest ?? null,
        text: st.draft.text ?? "",
      });
      const op = st.operations[opId];
      if (op) {
        if (op.requestDigest !== digest)
          return sendJson(res, 409, { ok: false, error: "operation-conflict", operationId: opId });
        switch (op.state) {
          case "accepted":
          case "rejected":
            return sendJson(res, 200, { ok: true, operationId: opId, state: op.state, reconciled: true });
          case "prepared":
          case "dispatching":
          case "unknown": {
            const { count } = await reconcileOperation(op);
            if (count > 1) {
              op.invariantFailure = true;
              await writeState(st);
              return sendJson(res, 500, { ok: false, error: "identity-invariant-failure", operationId: opId, count });
            }
            if (count === 1) {
              await settle(st, opId, "accepted");
              return sendJson(res, 200, { ok: true, operationId: opId, state: "accepted", reconciled: true });
            }
            return sendJson(res, 200, { ok: true, operationId: opId, state: op.state, reconciled: true, pending: true });
          }
        }
      }

      // New dispatch path: prepare + lock (one write) → dispatching (one write)
      // → session.prompt EXACTLY ONCE with rpcId === operationId.
      if (st.draft.lockedByOperationId && st.draft.lockedByOperationId !== opId)
        return sendJson(res, 409, { ok: false, error: "send-in-progress", lockedByOperationId: st.draft.lockedByOperationId });
      if (typeof body.draftRevision !== "number" || body.draftRevision !== st.draft.revision)
        return sendJson(res, 409, { ok: false, error: "draft-revision-mismatch", expected: st.draft.revision, got: body.draftRevision ?? null });
      if (!st.draft.text) return sendJson(res, 409, { ok: false, error: "empty-draft" });

      const preDispatchSeq = await currentSeq();
      const frozenText = st.draft.text;
      const newOp = {
        operationId: opId,
        state: "prepared",
        requestDigest: digest,
        draftRevisionAtPrepare: st.draft.revision,
        frozenText,
        frozenTextDigest: digestOf({ text: frozenText }),
        preDispatchSeq,
        lastError: undefined,
      };
      st.operations[opId] = newOp;
      st.draft.lockedByOperationId = opId;
      await writeState(st); // prepared + draft lock (one durable write)
      if (process.env.DSH_GLASSES_TEST_CRASH_AFTER_PREPARED === "1") {
        console.log("[dsh-glasses-plugin] [test] crash after prepared (op=" + opId + ")");
        process.exit(1);
      }

      newOp.state = "dispatching";
      await writeState(st); // dispatching (one durable write)

      let admitted;
      try {
        admitted = await ctx.apiProxy.sessions.prompt({
          rpcId: opId,
          payload: { sessionId, mode: "queue", content: [{ type: "text", text: frozenText }] },
        });
      } catch (e) {
        await settle(st, opId, "rejected", String(e?.message ?? e));
        return sendJson(res, 200, { ok: true, operationId: opId, state: "rejected", reason: "dispatch-failure" });
      }
      if (!admitted?.result?.ok) {
        await settle(st, opId, "rejected", JSON.stringify(admitted?.result?.error ?? {}).slice(0, 300));
        return sendJson(res, 200, { ok: true, operationId: opId, state: "rejected", reason: "dispatch-failure" });
      }

      // accepted:true — do NOT clear draft yet; reconcile durable facts.
      if (process.env.DSH_GLASSES_TEST_CRASH_AFTER_DISPATCH === "1") {
        console.log("[dsh-glasses-plugin] [test] crash after dispatch (op=" + opId + ")");
        process.exit(1);
      }
      const { count } = await reconcileOperation(newOp);
      if (count > 1) {
        newOp.invariantFailure = true;
        await writeState(st);
        return sendJson(res, 500, { ok: false, error: "identity-invariant-failure", operationId: opId, count });
      }
      if (count === 1) {
        await settle(st, opId, "accepted");
        return sendJson(res, 202, { ok: true, operationId: opId, state: "accepted", accepted: true });
      }
      newOp.state = "unknown";
      await writeState(st);
      return sendJson(res, 202, { ok: true, operationId: opId, state: "unknown", accepted: "pending" });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  };

  const handleGlassesRoot = (req, res) =>
    sendJson(res, 404, { ok: false, error: "not-found", namespace: "/glasses/v1" });

  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/glasses/v1/bootstrap", handler: handleBootstrap }), "glasses.bootstrap");
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/glasses/v1/stream", handler: handleStream }), "glasses.stream");
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/glasses/v1/draft/mutations", handler: handleDraftMutations }), "glasses.draft");
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/glasses/v1/actions", handler: handleActions }), "glasses.actions");
  // Prove the namespace prefix registration also works and catches unknown sub-paths.
  ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: "/glasses/v1", handler: handleGlassesRoot }), "glasses.prefix");

  log(`ready: session=${sessionId} generation=${serverGeneration}`);
}
