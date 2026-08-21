import { resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { createFixtureGithubAdapter, createGitAdapter, createGithubAdapter, createSessionProbe } from "./adapters.js";
import { DEFAULT_INTERVAL_MS, DEFAULT_MAX_ACTIVE, formatReport } from "./core.js";
import { createDispatcher } from "./dispatcher.js";
import { createDshAdapter } from "./dsh.js";
import { runReconcileLoop } from "./loop.js";
import { createStateStore } from "./state.js";

export const name = "dsh-ticket-dispatcher";
export const inject = ["agentDefaultModel", "agents", "sessions"];

const envState = process.env.DISPATCHER_STATE_PATH ?? resolve(process.env.XDG_STATE_HOME ?? `${process.env.HOME}/.local/state`, "dsh-glasses/ticket-dispatcher/state.json");
const envMax = Number(process.env.DISPATCHER_MAX_ACTIVE ?? DEFAULT_MAX_ACTIVE);
const envInterval = Number(process.env.DISPATCHER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
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
  intervalMs: z.number().default(envInterval),
  maxPasses: z.number().default(envPasses),
  fixturesPath: z.string().default(""),
  wakeAgents: z.boolean().default(true),
  stayAlive: z.boolean().default(false),
});

function argumentsOf(ctx, config) {
  const args = [...(ctx.get("cmdlineArgs")?.get() ?? [])];
  const command = args.find((arg) => arg === "status" || arg === "reconcile") ?? "status";
  const value = (flag, fallback) => {
    const index = args.indexOf(flag);
    return index < 0 ? fallback : args[index + 1];
  };
  const maxActive = Number(value("--max-active", config.maxActive));
  const intervalMs = Number(value("--interval-ms", config.intervalMs));
  const maxPasses = Number(value("--max-passes", config.maxPasses));
  const baseSha = value("--base-sha", config.baseSha);
  const baseRef = value("--base-ref", config.baseRef);
  const fetch = args.includes("--no-fetch") ? false : args.includes("--fetch") ? true : config.fetch;
  const stayAlive = args.includes("--stay-alive") || config.stayAlive;
  if (!Number.isInteger(maxActive) || maxActive < 1) throw new Error("--max-active must be a positive integer");
  if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new Error("--interval-ms must be a positive integer");
  if (!Number.isInteger(maxPasses) || maxPasses < 0) throw new Error("--max-passes must be a non-negative integer");
  return { command, maxActive, intervalMs, maxPasses, baseSha, baseRef, fetch, stayAlive };
}

async function run(ctx, config) {
  await ctx.get("loader")?.await();
  const options = argumentsOf(ctx, config);
  const worktreeRoot = config.worktreeRoot || resolve(config.repoRoot, "../dsh-glasses-tickets");
  const github = config.fixturesPath ? createFixtureGithubAdapter(config.fixturesPath) : createGithubAdapter({ repo: config.repo });
  const dsh = createDshAdapter(ctx);
  if (!config.wakeAgents) delete dsh.wakeAgent;
  const dshHome = process.env.DSH_HOME;
  const dispatcher = createDispatcher({
    github,
    git: createGitAdapter(config.repoRoot, worktreeRoot),
    dsh,
    stateStore: createStateStore(config.statePath),
    repoRoot: config.repoRoot,
    worktreeRoot,
    baseSha: options.baseSha,
    baseRef: options.baseRef,
    fetch: options.fetch,
    maxActive: options.maxActive,
    intervalMs: options.intervalMs,
    sessionProbe: createSessionProbe(dshHome),
  });
  const emit = (report) => process.stdout.write(formatReport(report));
  if (options.command === "reconcile" && (options.stayAlive || options.maxPasses > 0)) {
    const shutdown = new AbortController();
    const stop = () => shutdown.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await runReconcileLoop({ reconcile: dispatcher.reconcile, emit, intervalMs: options.intervalMs, maxPasses: options.maxPasses, signal: shutdown.signal });
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
    process.stderr.write(`dsh-ticket-dispatcher: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    ctx.get("appExit")?.(1);
  });
}

export { createDispatcher } from "./dispatcher.js";
export * from "./core.js";
