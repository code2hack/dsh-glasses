import { resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { createFixtureGithubAdapter, createGitAdapter, createGithubAdapter, createSessionProbe, createSessionLogReader, bootstrapMarker } from "./adapters.js";
import { createCodexAdapter } from "./codex.js";
import { DEFAULT_CODEX_THINKING, DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_MAX_ACTIVE, formatReport } from "./core.js";
import { createDispatcher } from "./dispatcher.js";
import { createDshAdapter } from "./dsh.js";
import { runReconcileLoop } from "./loop.js";
import { createStateStore } from "./state.js";

export const name = "dsh-ticket-dispatcher";
export const inject = ["agentDefaultModel", "agents", "sessions"];

const envState = process.env.DISPATCHER_STATE_PATH ?? resolve(process.env.XDG_STATE_HOME ?? `${process.env.HOME}/.local/state`, "dsh-glasses/ticket-dispatcher/state.json");
const envMax = Number(process.env.DISPATCHER_MAX_ACTIVE ?? DEFAULT_MAX_ACTIVE);
const envHeartbeat = Number(process.env.DISPATCHER_HEARTBEAT_INTERVAL_MS ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
const envThinking = process.env.DISPATCHER_CODEX_THINKING ?? DEFAULT_CODEX_THINKING;
const envPasses = Number(process.env.DISPATCHER_MAX_PASSES ?? 0);
const envFetch = process.env.DISPATCHER_FETCH !== "false";

export const Config = z.object({
  repo: z.string().default("code2hack/dsh-glasses"),
  repoRoot: z.string().default(process.cwd()),
  worktreeRoot: z.string().default(""),
  statePath: z.string().default(envState),
  baseSha: z.string().default(process.env.DISPATCHER_BASE_SHA ?? ""),
  baseRef: z.string().default(process.env.DISPATCHER_BASE_REF ?? "origin/main"),
  fetch: z.boolean().default(envFetch),
  maxActive: z.number().default(envMax),
  /** Protocol-v2 runtime setting: polling/heartbeat interval in ms (default 120000). */
  heartbeatIntervalMs: z.number().default(envHeartbeat),
  /** Backwards-compatible alias for heartbeatIntervalMs. */
  intervalMs: z.number().default(Number.NaN),
  maxPasses: z.number().default(envPasses),
  /** Protocol-v2 runtime setting: Codex thinking effort (default "max"). No profile/model overrides. */
  codexThinking: z.string().default(envThinking),
  codexBin: z.string().default(process.env.CODEX_BIN ?? "codex"),
  codexControlSocket: z.string().default(process.env.DISPATCHER_CODEX_CONTROL_SOCKET ?? ""),
  fixturesPath: z.string().default(""),
  wakeAgents: z.boolean().default(false),
  stayAlive: z.boolean().default(false),
});

function argumentsOf(ctx, config) {
  const args = [...(ctx.get("cmdlineArgs")?.get() ?? [])];
  const command = args.find((arg) => arg === "status" || arg === "reconcile") ?? "status";
  const value = (flag, fallback) => {
    const index = args.indexOf(flag);
    return index < 0 ? fallback : args[index + 1];
  };
  const heartbeatFlag = args.includes("--heartbeat-interval-ms");
  const heartbeatIntervalMs = Number(heartbeatFlag ? value("--heartbeat-interval-ms", config.heartbeatIntervalMs) : value("--interval-ms", config.intervalMs));
  const finalHeartbeat = Number.isFinite(heartbeatIntervalMs)
    ? heartbeatIntervalMs
    : Number.isFinite(config.intervalMs)
      ? config.intervalMs
      : config.heartbeatIntervalMs;
  const codexThinking = value("--codex-thinking", config.codexThinking);
  const maxActive = Number(value("--max-active", config.maxActive));
  const maxPasses = Number(value("--max-passes", config.maxPasses));
  const baseSha = value("--base-sha", config.baseSha);
  const baseRef = value("--base-ref", config.baseRef);
  const fetch = args.includes("--no-fetch") ? false : args.includes("--fetch") ? true : config.fetch;
  const stayAlive = args.includes("--stay-alive") || config.stayAlive;
  if (!Number.isInteger(maxActive) || maxActive < 1) throw new Error("--max-active must be a positive integer");
  if (!Number.isInteger(finalHeartbeat) || finalHeartbeat < 1) throw new Error("heartbeat interval must be a positive integer (ms)");
  if (!Number.isInteger(maxPasses) || maxPasses < 0) throw new Error("--max-passes must be a non-negative integer");
  if (!/^[a-z0-9]+$/i.test(codexThinking)) throw new Error("--codex-thinking must be a codex reasoning-effort token (e.g. max)");
  return { command, maxActive, heartbeatIntervalMs: finalHeartbeat, maxPasses, baseSha, baseRef, fetch, stayAlive, codexThinking };
}

async function run(ctx, config) {
  await ctx.get("loader")?.await();
  const options = argumentsOf(ctx, config);
  const worktreeRoot = config.worktreeRoot || resolve(config.repoRoot, "../dsh-glasses-tickets");
  const github = config.fixturesPath ? createFixtureGithubAdapter(config.fixturesPath) : createGithubAdapter({ repo: config.repo });
  const dsh = createDshAdapter(ctx, { sessionLogReader: createSessionLogReader(process.env.DSH_HOME) });
  if (!config.wakeAgents) {
    delete dsh.wakeAgent;
    delete dsh.continueAgent;
  }
  const project = config.repo.split("/").filter(Boolean).at(-1) || "dsh-glasses";
  const codex = createCodexAdapter({
    bin: config.codexBin,
    controlSocket: config.codexControlSocket,
    clientName: "dsh-ticket-dispatcher",
    clientVersion: "0.1.0",
  });
  const dispatcher = createDispatcher({
    github,
    git: createGitAdapter(config.repoRoot, worktreeRoot),
    dsh,
    codex,
    stateStore: createStateStore(config.statePath),
    repoRoot: config.repoRoot,
    worktreeRoot,
    baseSha: options.baseSha,
    baseRef: options.baseRef,
    fetch: options.fetch,
    maxActive: options.maxActive,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    codexThinking: options.codexThinking,
    project,
    wakeAgents: config.wakeAgents,
    sessionProbe: createSessionProbe(process.env.DSH_HOME),
    sessionLogReader: createSessionLogReader(process.env.DSH_HOME),
    bootstrapMarker,
  });
  const emit = (report) => process.stdout.write(formatReport(report));
  if (options.command === "reconcile" && (options.stayAlive || options.maxPasses > 0)) {
    const shutdown = new AbortController();
    const stop = () => shutdown.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await runReconcileLoop({ reconcile: dispatcher.reconcile, emit, intervalMs: options.heartbeatIntervalMs, maxPasses: options.maxPasses, signal: shutdown.signal });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  } else {
    emit(await dispatcher[options.command]());
  }
  ctx.get("appExit")?.(0);
}

export function apply(ctx, config) {
  run(ctx, config).catch((error) => {
    process.stderr.write(`dsh-ticket-dispatcher: ${error instanceof Error ? error.message : String(error)}\n`);
    ctx.get("appExit")?.(1);
  });
}

export { createDispatcher } from "./dispatcher.js";
export * from "./core.js";
export * from "./codex.js";
