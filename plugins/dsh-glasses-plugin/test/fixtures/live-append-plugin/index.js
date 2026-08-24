// Test-only pinned-rc.2 seam: commit one canonical assistant message through
// Session.append(), which also publishes the real session/event observed by
// dsh-glasses-plugin. This package is loaded only by disposable test profiles.
export const name = "dsh-glasses-live-test-fixture";
export const inject = ["webServer", "sessions"];

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16_384) throw new Error("fixture-body-too-large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function apply(ctx) {
  const token = process.env.DSH_GLASSES_FIXTURE_TOKEN || "";
  if (!token) throw new Error("DSH_GLASSES_FIXTURE_TOKEN is required");
  const handler = async (req, res) => {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "method-not-allowed" });
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { ok: false, error: "unauthorized" });
    try {
      const body = await readJson(req);
      if (body.action === "create") {
        if (ctx.sessions.get(body.sessionId)) return json(res, 409, { ok: false, error: "session-exists" });
        const session = ctx.sessions.create(body.sessionId, { meta: { cwd: body.cwd } });
        await ctx.sessions.flush(session);
        return json(res, 200, { ok: true, sessionId: session.id });
      }
      const session = ctx.sessions.get(body.sessionId);
      if (!session) return json(res, 404, { ok: false, error: "session-not-found" });
      if (typeof body.messageId !== "string" || !body.messageId || typeof body.text !== "string" || !body.text) {
        return json(res, 400, { ok: false, error: "invalid-fixture-event" });
      }
      const role = body.role || "assistant";
      const event = role === "user"
        ? session.append("user/message", {
          id: body.messageId,
          role: "user",
          content: [{ type: "text", text: body.text }],
          source: { kind: "user", rpcId: `fixture-${body.messageId}` },
        }, { surfaceOp: "append" })
        : session.append("assistant/message", {
          turn: 0,
          step: session.seq,
          message: {
            id: body.messageId,
            role: "assistant",
            content: [{ type: "text", text: body.text }],
            source: { kind: "model", provider: "fixture", model: "deterministic" },
          },
          usage: { inputTokens: 0, outputTokens: body.text.length },
        }, { surfaceOp: "append" });
      await ctx.sessions.flush(session);
      return json(res, 200, { ok: true, seq: event.seq, messageId: body.messageId });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message || error) });
    }
  };
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/__test/m1/append", handler }), "m1-live-test-fixture.append");
}
