import { resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { createFixtureGithubAdapter, createGitAdapter, createGithubAdapter, createSessionProbe } from "./adapters.js";
import { DEFAULT_MAX_ACTIVE, formatReport } from "./core.js";
import { createDispatcher } from "./dispatcher.js";
import { createDshAdapter } from "./dsh.js";
import { createStateStore } from "./state.js";

export const name = "dsh-ticket-dispatcher";
export const inject = ["agentDefaultModel", "agents", "sessions"];

const envState = process.env.DISPATCHER_STATE_PATH ?? resolve(process.env.XDG_STATE_HOME ?? `${process.env.HOME}/.local/state`, "dsh-glasses/ticket-dispatcher/state.json");
const envMax = Number(process.env.DISPATCHER_MAX_ACTIVE ?? DEFAULT_MAX_ACTIVE);

export const Config = z.object({
  repo: z.string().default("code2hack/dsh-glasses"),
  repoRoot: z.string().default(process.cwd()),
  worktreeRoot: z.string().default(""),
  statePath: z.string().default(envState),
  baseSha: z.string().default(""),
  maxActive: z.number().default(envMax),
  fixturesPath: z.string().default(""),
  wakeAgents: z.boolean().default(false),
  stayAlive: z.boolean().default(false),
});

function argumentsOf(ctx, config) {
  const args = [...(ctx.get("cmdlineArgs")?.get() ?? [])];
  const command = args.find((arg) => arg === "status" || arg === "reconcile") ?? "status";
  const maxIndex = args.indexOf("--max-active");
  const maxActive = maxIndex < 0 ? config.maxActive : Number(args[maxIndex + 1]);
  if (!Number.isInteger(maxActive) || maxActive < 1) throw new Error("--max-active must be a positive integer");
  return { command, maxActive };
}

async function run(ctx, config) {
  await ctx.get("loader")?.await();
  const { command, maxActive } = argumentsOf(ctx, config);
  const baseSha = config.baseSha || process.env.DISPATCHER_BASE_SHA;
  if (!baseSha) throw new Error("baseSha or DISPATCHER_BASE_SHA is required");
  const github = config.fixturesPath ? createFixtureGithubAdapter(config.fixturesPath) : createGithubAdapter({ repo: config.repo });
  const dsh = createDshAdapter(ctx);
  if (!config.wakeAgents) delete dsh.wakeAgent;
  const dispatcher = createDispatcher({
    github,
    git: createGitAdapter(config.repoRoot),
    dsh,
    stateStore: createStateStore(config.statePath),
    repoRoot: config.repoRoot,
    worktreeRoot: config.worktreeRoot || undefined,
    baseSha,
    maxActive,
    sessionProbe: createSessionProbe(process.env.DSH_HOME),
  });
  process.stdout.write(formatReport(await dispatcher[command]()));
  if (!config.stayAlive) ctx.get("appExit")?.(0);
}

export function apply(ctx, config) {
  run(ctx, config).catch((error) => {
    process.stderr.write(`dsh-ticket-dispatcher: ${error instanceof Error ? error.message : String(error)}\n`);
    ctx.get("appExit")?.(1);
  });
}

export { createDispatcher } from "./dispatcher.js";
export * from "./core.js";
