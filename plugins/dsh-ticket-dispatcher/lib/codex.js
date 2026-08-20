import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";

const exec = promisify(execFile);
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function rfc6455Frame(data, opcode = 0x1) {
  const mask = randomBytes(4);
  const length = data.length;
  const head = Buffer.alloc(10);
  let offset = 0;
  head[offset++] = 0x80 | opcode;
  if (length < 126) {
    head[offset++] = 0x80 | length;
  } else if (length < 65536) {
    head[offset++] = 0x80 | 126;
    head.writeUInt16BE(length, offset);
    offset += 2;
  } else {
    head[offset++] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(length), offset);
    offset += 8;
  }
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([head.subarray(0, offset), mask, masked]);
}

/**
 * Minimal RFC6455 WebSocket client over a Unix domain socket speaking JSON-RPC
 * 2.0 to the local Codex app-server control socket. Self-contained on purpose:
 * the plugin must not add a runtime socket dependency to the DSH deployment.
 */
export class CodexControlClient extends EventEmitter {
  constructor(socketPath, { timeoutMs = 60_000 } = {}) {
    super();
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = null;
    this.closed = false;
    this.handshaken = false;
  }

  async connect({ clientInfo = { name: "dsh-ticket-dispatcher", version: "0.1.0" } } = {}) {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error) => {
        if (settled) return;
        settled = true;
        if (error) {
          this.ready = null;
          reject(error);
        } else {
          resolve();
        }
      };
      this.#open(clientInfo).then(() => settle(), settle);
    });
    return this.ready;
  }

  async #open(clientInfo) {
    const key = randomBytes(16).toString("base64");
    const socket = connect(this.socketPath);
    this.socket = socket;
    socket.setNoDelay(true);
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.handshaken = false;

    const handshake =
      "GET / HTTP/1.1\r\n" +
      "Host: localhost\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Key: ${key}\r\n` +
      "Sec-WebSocket-Version: 13\r\n\r\n";

    socket.on("error", (error) => this.#failAll(error));
    socket.on("close", () => this.#failAll(new Error(`codex app-server closed: ${this.socketPath}`)));
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#process();
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`websocket handshake timeout: ${this.socketPath}`)), this.timeoutMs);
      const onClose = () => {
        clearTimeout(timer);
        reject(new Error(`websocket closed during handshake: ${this.socketPath}`));
      };
      this.once("handshake", () => {
        clearTimeout(timer);
        this.off("close", onClose);
        resolve();
      });
      this.once("close", onClose);
      socket.write(handshake);
    });

    await this.request("initialize", { clientInfo }, this.timeoutMs * 2);
  }

  #process() {
    if (!this.handshaken) {
      if (this.buffer.length >= 2) {
        const head = this.buffer.indexOf("\r\n\r\n");
        if (head < 0) return;
        const headers = this.buffer.slice(0, head).toString("utf8");
        if (!/^HTTP\/1\.1 101\b/.test(headers)) {
          this.#failAll(new Error(`websocket upgrade rejected: ${headers.split("\r\n")[0]}`));
          return;
        }
        if (!/sec-websocket-accept:\s*.+/i.test(headers)) {
          this.#failAll(new Error("websocket upgrade missing sec-websocket-accept"));
          return;
        }
        this.buffer = this.buffer.slice(head + 4);
        this.handshaken = true;
        this.emit("handshake");
      } else {
        return;
      }
    }
    while (true) {
      const parsed = this.#parseFrame();
      if (parsed === undefined) return;
      const { opcode, payload } = parsed;
      if (opcode === 0x9) { // ping -> pong
        try { this.socket?.write(rfc6455Frame(payload, 0xA)); } catch {}
        continue;
      }
      if (opcode === 0x8) { // close
        this.socket?.end();
        return;
      }
      if (opcode !== 0x1 && opcode !== 0x2) continue;
      let message;
      try {
        message = JSON.parse(payload.toString("utf8"));
      } catch {
        this.emit("protocol", `unparsed websocket text: ${payload.toString("utf8").slice(0, 200)}`);
        continue;
      }
      if (message && typeof message === "object" && Number.isInteger(message.id) && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(timer);
        if (message.error) reject(message.error);
        else resolve(message.result);
      } else if (message && typeof message === "object" && message.method) {
        this.emit("notification", message);
      }
    }
  }

  #parseFrame() {
    if (this.buffer.length < 2) return undefined;
    const b0 = this.buffer[0];
    const b1 = this.buffer[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    let length = b1 & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < 4) return undefined;
      length = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.buffer.length < 10) return undefined;
      length = Number(this.buffer.readBigUInt64BE(2));
      offset = 10;
    }
    const masked = (b1 & 0x80) !== 0;
    let mask;
    if (masked) {
      if (this.buffer.length < offset + 4) return undefined;
      mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (this.buffer.length < offset + length) return undefined;
    let payload = this.buffer.subarray(offset, offset + length);
    if (masked) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    this.buffer = this.buffer.subarray(offset + length);
    if (!fin) throw new Error("fragmented websocket frames are not implemented");
    return { opcode, payload };
  }

  request(method, params, timeoutMs = this.timeoutMs) {
    if (this.closed || !this.socket || this.socket.destroyed) {
      throw new Error(`codex app-server socket closed: ${this.socketPath}`);
    }
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject: (error) => reject(this.#normalizeError(method, error)),
        timer,
      });
      try {
        this.socket.write(rfc6455Frame(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  #normalizeError(method, error) {
    if (error instanceof Error) return error;
    return new Error(`codex ${method} ${error?.code ?? "error"}: ${error?.message ?? JSON.stringify(error)}`);
  }

  #failAll(error) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(this.#normalizeError("request", error));
    }
    this.pending.clear();
    this.emit("close", error);
  }

  async close() {
    this.closed = true;
    this.ready = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) {
      try { socket.write(Buffer.from([0x88, 0x00])); } catch {}
      socket.end();
      socket.destroy();
    }
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("codex app-server connection closed"));
    }
    this.pending.clear();
  }
}

async function runDaemonCommand(bin, args, timeoutMs) {
  const { stdout } = await exec(bin, args, { encoding: "utf8", timeout: timeoutMs });
  return stdout.trim();
}

/**
 * Adapter over the REAL local Codex app-server persistent-thread seam.
 * Threads are created through `thread/start` (inheriting the running
 * daemon/profile/model per owner directive), named via `thread/name/set`,
 * seeded with exactly one `turn/start` whose input is the exact Codex name,
 * and afterwards left idle. No exec/one-shot Codex invocation is used.
 */
export function createCodexAdapter({
  bin = process.env.CODEX_BIN ?? "codex",
  controlSocket = "",
  codexHome = process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`,
  clientName = "dsh-ticket-dispatcher",
  clientVersion = "0.1.0",
  commandTimeoutMs = 60_000,
  replyTimeoutMs = 600_000,
  seedGraceMs = 300_000,
  clientFactory = (path, options) => new CodexControlClient(path, options),
} = {}) {
  const daemonVersion = async () => {
    try {
      const output = await runDaemonCommand(bin, ["app-server", "daemon", "version"], commandTimeoutMs);
      const parsed = JSON.parse(output);
      if (!parsed.socketPath) throw new Error(`codex daemon version reported no socketPath: ${output}`);
      return parsed;
    } catch (error) {
      throw new Error(`codex daemon unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const ensureDaemon = async () => {
    if (controlSocket) return { socketPath: controlSocket };
    const output = await runDaemonCommand(bin, ["app-server", "daemon", "start"], commandTimeoutMs);
    const parsed = JSON.parse(output);
    if (!parsed.socketPath) throw new Error(`codex daemon start reported no socketPath: ${output}`);
    return parsed;
  };

  const resolveSocketPath = async () => controlSocket || (await ensureDaemon()).socketPath;

  const withClient = async (operation) => {
    const path = await resolveSocketPath();
    const client = clientFactory(path, { timeoutMs: replyTimeoutMs });
    try {
      await client.connect({ clientInfo: { name: clientName, version: clientVersion } });
      return await operation(client);
    } finally {
      await client.close().catch(() => {});
    }
  };

  const summarize = (thread, extra = {}) => ({
    threadId: thread?.id ?? null,
    threadPath: thread?.path ?? null,
    threadName: thread?.name ?? thread?.preview ?? null,
    cwd: thread?.cwd ?? null,
    model: thread?.model ?? null,
    status: thread?.status?.type ?? null,
    turns: thread?.turns ?? [],
    ...extra,
  });

  /**
   * Wait for the seed turn to be TERMINAL on the REAL app-server before the
   * dispatcher crosses the bootstrap boundary into DSH startup planning
   * (AGENTS.md Codex: first prompt is exactly the name, then the thread stays
   * idle). Authoritative completion is the `turn/completed` notification; a
   * read-poll fallback covers a missed notification. If the seed has not
   * reached a terminal state within `seedGraceMs` the pair publication FAILS
   * (per CTO, an in-flight seed is not "idle seeded").
   */
  const waitSeedAccepted = async (client, threadId, turnId, turnStartedAt) => {
    if (!turnId) throw new Error("codex turn/start returned no turn id");
    const deadline = turnStartedAt + replyTimeoutMs;
    const grace = turnStartedAt + seedGraceMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      };
      const onNotification = (message) => {
        if (message?.method !== "turn/completed") return;
        const params = message.params ?? {};
        if (params.threadId !== threadId) return;
        finish(null, { ...params, viaNotification: true });
      };
      const poll = async () => {
        if (settled) return;
        try {
          const read = await client.request("thread/read", { threadId, includeTurns: true });
          const status = read?.thread?.status?.type;
          if (status == null || ["idle", "done", "completed", "ready", "waiting"].includes(status)) {
            finish(null, { threadId, turnId, status, viaPoll: true });
          } else if (["error", "failed"].includes(status)) {
            finish(new Error(`codex seed turn ended ${status} for thread ${threadId}`));
          }
        } catch {}
      };
      const softTimer = setTimeout(() => finish(new Error(`codex seed turn did not finish within seedGraceMs=${seedGraceMs}ms for thread ${threadId}`)), Math.max(0, grace - Date.now()));
      const hardTimer = setTimeout(() => finish(new Error(`codex turn/completed timed out for thread ${threadId}`)), Math.max(0, deadline - Date.now()));
      const pollTimer = setInterval(poll, 4_000);
      const cleanup = () => {
        clearTimeout(softTimer);
        clearTimeout(hardTimer);
        clearInterval(pollTimer);
        client.off("notification", onNotification);
      };
      client.on("notification", onNotification);
      // Grace-delayed first poll so fast turns never depend on a missed notification.
      setTimeout(poll, 1_500);
    });
  };

  /** Create one named persistent thread whose ONLY first prompt is exactly `name`. */
  const createThread = async ({ cwd, name, thinkingEffort = "max" }) => {
    return withClient(async (client) => {
      const started = await client.request("thread/start", {
        cwd,
        config: { model_reasoning_effort: thinkingEffort },
      });
      const thread = started.thread;
      if (!thread?.id) throw new Error("codex thread/start returned no thread");
      await client.request("thread/name/set", { threadId: thread.id, name });
      const turn = await client.request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: name }],
        effort: thinkingEffort,
      });
      await waitSeedAccepted(client, thread.id, turn.turn?.id, Date.now());
      const read = await client.request("thread/read", { threadId: thread.id, includeTurns: true });
      const full = read.thread ?? {};
      const turns = full.turns ?? [];
      const firstUserText = turns
        .flatMap((entry) => entry.items ?? [])
        .filter((item) => item.type === "userMessage")
        .flatMap((item) => item.content ?? [])
        .map((part) => part.text)
        .join("");
      return summarize(full, {
        thinkingEffort,
        firstPrompt: firstUserText || null,
        daemonModel: started.model ?? null,
        inheritedModel: started.model ?? null,
      });
    });
  };

  /** Reconstruct an existing persistent thread (same threadId/name), never a replacement. */
  const readThread = async ({ threadId, name } = {}) => {
    return withClient(async (client) => {
      let thread;
      if (threadId) {
        const read = await client.request("thread/read", { threadId, includeTurns: true });
        thread = read.thread;
      } else if (name) {
        // The app-server surfaces the seeded name as `preview` on thread/list;
        // `name` is unreliable there, so match the observable identity field.
        const list = await client.request("thread/list", { searchTerm: name, limit: 50 });
        const found = (list?.data ?? []).find((entry) => (entry?.name ?? entry?.preview) === name);
        if (!found) throw new Error(`codex thread not found by name: ${name}`);
        const read = await client.request("thread/read", { threadId: found.id, includeTurns: true });
        thread = read.thread;
      } else {
        throw new Error("codex readThread requires threadId or name");
      }
      if (!thread?.id) throw new Error("codex thread/read returned no thread");
      return summarize(thread);
    });
  };

  /** Send one turn (review/debug) to an existing thread; returns after completion. */
  const sendMessage = async ({ threadId, input, thinkingEffort }, timeoutMs = replyTimeoutMs) => {
    return withClient(async (client) => {
      const turn = await client.request("turn/start", {
        threadId,
        input: Array.isArray(input) ? input : [{ type: "text", text: String(input) }],
        ...(thinkingEffort ? { effort: thinkingEffort } : {}),
      });
      await waitSeedAccepted(client, threadId, turn.turn?.id, Date.now());
      const read = await client.request("thread/read", { threadId, includeTurns: true });
      return summarize(read.thread ?? { id: threadId });
    });
  };

  const deleteThread = async (threadId) => {
    if (!threadId) return { threadId };
    return withClient(async (client) => {
      await client.request("thread/delete", { threadId });
      return { threadId };
    });
  };

  return {
    daemonVersion,
    ensureDaemon,
    socketPath: resolveSocketPath,
    createThread,
    readThread,
    sendMessage,
    deleteThread,
  };
}

export { rfc6455Frame };
