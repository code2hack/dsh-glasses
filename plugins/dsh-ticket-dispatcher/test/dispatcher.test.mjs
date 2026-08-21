import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createFixtureGithubAdapter, createGitAdapter } from "../lib/adapters.js";
import { createStateStore } from "../lib/state.js";
import { createDispatcher } from "../lib/dispatcher.js";
import { claimBody, collapseClaimMarkers, collapseCompleteMarkers, completeBody, voidClaimBody } from "../lib/core.js";

const run = promisify(execFile);

const BASE = "71059429be3d6f95ef9625adf5dea52db2cd51d2";
const NEXT = "e3f6cdbfe49cc295753859e3c7b600785885aa45";
const NAME = (number) => `dsh-glasses-M1-#${number}-DSH`;
const defaultTickets = () => [1, 2, 3, 4].map((number) => ({ number, state: "OPEN", milestone: "M1", blockers: number === 4 ? [3] : [], url: `https://example.test/issues/${number}` }));

function harness(options = {}) {
  const {
    fail,
    initialState,
    durableClaims = [],
    durableCompletions = [],
    maxActive = 3,
    records = defaultTickets(),
    baseSha = BASE,
    sharedWorktrees = new Set(),
    sharedBranches = new Set(),
    sharedSessions = new Set(),
    agentStatuses = new Map(),
    wakeAgents = false,
  } = options;
  let state = structuredClone(initialState ?? { schemaVersion: 2, tickets: {} });
  let saves = 0;
  let refSha = options.refSha ?? BASE;
  const live = new Set();
  const calls = [];
  const wakes = [];
  const github = {
    async listTickets() { return structuredClone(records); },
    async listClaims() { return collapseClaimMarkers(durableClaims); },
    async listCompletions() { return options.parseCompletions ? options.parseCompletions(durableCompletions) : collapseCompleteMarkers(durableCompletions); },
    async writeClaim(binding) {
      calls.push(`claim:${binding.number}`);
      if (fail === "claim") throw new Error("claim fault");
      durableClaims.push(claimBody(binding));
    },
    async voidClaim(binding, reason) {
      calls.push(`void:${binding.number}:${reason}`);
      if (fail === "void") throw new Error("void fault");
      durableClaims.push(voidClaimBody(binding, reason));
    },
    async writeComplete(binding) {
      calls.push(`complete:${binding.number}`);
      durableCompletions.push(completeBody(binding, { head: "a".repeat(40), pr: "https://example.test/pr" }));
    },
  };
  const git = {
    async resolveBase() {
      calls.push("resolve");
      if (fail === "resolve") throw new Error("cannot resolve base ref moving");
      return refSha;
    },
    async createWorktree(binding) {
      calls.push(`worktree:${binding.number}`);
      if (fail === "worktree") throw new Error("worktree fault");
      const worktreeCreated = !sharedWorktrees.has(binding.worktree);
      const branchCreated = !sharedBranches.has(binding.branch);
      sharedWorktrees.add(binding.worktree);
      sharedBranches.add(binding.branch);
      return { worktreeCreated, branchCreated };
    },
    async removeWorktree(binding, { removeBranch = true } = {}) {
      calls.push(`remove:${binding.number}:${removeBranch}`);
      sharedWorktrees.delete(binding.worktree);
      if (removeBranch) sharedBranches.delete(binding.branch);
    },
    async worktreeUsable(binding) { return sharedWorktrees.has(binding.worktree); },
  };
  const dsh = {
    isLive(binding) { return live.has(binding.sessionId); },
    isProgressing(binding) { return agentStatuses.get(binding.sessionId) === "running"; },
    isQuiescent(binding) { return live.has(binding.sessionId) && agentStatuses.get(binding.sessionId) === "idle"; },
    async createAgent(binding) {
      calls.push(`agent:${binding.number}`);
      if (fail === "agent") throw new Error("agent fault");
      live.add(binding.sessionId);
      sharedSessions.add(binding.sessionId);
      agentStatuses.set(binding.sessionId, "running");
    },
    async resumeAgent(binding) {
      calls.push(`resume:${binding.number}`);
      if (fail === "resume") throw new Error("cannot resume");
      live.add(binding.sessionId);
      agentStatuses.set(binding.sessionId, "running");
    },
    async disposeAgent(binding) {
      calls.push(`dispose:${binding.number}`);
      live.delete(binding.sessionId);
      agentStatuses.set(binding.sessionId, "idle");
    },
    ...(wakeAgents
      ? { async wakeAgent(binding, message) { calls.push(`wake:${binding.number}`); wakes.push(`${binding.number}:${message}`); } }
      : {}),
  };
  const stateStore = {
    async load() { return structuredClone(state); },
    async save(next) {
      saves++;
      if (fail === "state" && saves === 1) throw new Error("state fault");
      state = structuredClone(next);
    },
    async lock(fn) { return fn(); },
  };
  for (const id of options.initialLive ?? []) {
    live.add(id);
    sharedSessions.add(id);
  }
  let id = 0;
  const sessionProbe = options.sessionProbe
    ?? (async (binding) => ({ status: sharedSessions.has(binding.sessionId) ? "persisted" : "missing" }));
  const dispatcherOptions = {
    github, git, dsh, stateStore, repoRoot: "/repo", worktreeRoot: "/tickets",
    baseSha, baseRef: "moving", fetch: false, maxActive,
    sessionProbe,
    ...(options.sessionCleanup ? { sessionCleanup: options.sessionCleanup } : {}),
    uuid: () => `uuid-${++id}`,
  };
  const dispatcher = createDispatcher(dispatcherOptions);
  return {
    dispatcher, calls, wakes, durableClaims, durableCompletions, live, records, sharedBranches, sharedSessions, sharedWorktrees,
    setRef(value) { refSha = value; },
    state: () => structuredClone(state),
  };
}

test("one pass admits to capacity; every admitted DSH session is exactly named and unique", async () => {
  const h = harness({ maxActive: 2 });
  const first = await h.dispatcher.reconcile();
  assert.deepEqual(first.running.map((x) => x.number), [1, 2]);
  assert.deepEqual(first.running.map((x) => x.name), [NAME(1), NAME(2)]);
  assert.deepEqual(first.running.map((x) => x.sessionId), [NAME(1), NAME(2)]);
  assert.equal(new Set(first.running.map((x) => x.sessionId)).size, 2);
  assert.ok(first.running.every((x) => x.live));
  assert.deepEqual(first.capacityLimited, [3]);
  assert.equal(first.heartbeatMs, 120000);
  const creates = h.calls.filter((x) => x.startsWith("agent:")).length;
  await h.dispatcher.reconcile();
  assert.equal(h.calls.filter((x) => x.startsWith("agent:")).length, creates);
  assert.equal(h.calls.filter((x) => x.startsWith("resume:")).length, 0);
  assert.equal(h.durableClaims.length, 2);
});

test("dispatcher bindings, claim markers, and reports carry no Codex lifecycle state", async () => {
  const h = harness({ maxActive: 1 });
  const report = await h.dispatcher.reconcile();
  const binding = report.running[0];
  const keys = Object.keys(binding);
  assert.deepEqual(keys.sort(), [
    "baseSha", "branch", "live", "name", "number", "progressing", "recovered", "sessionId", "sessionPersisted", "status", "validWorktree", "worktree",
  ]);
  const persisted = h.state().tickets[String(binding.number)];
  assert.ok(!("codex" in persisted), "no Codex lifecycle field may be persisted");
  assert.deepEqual(Object.keys(persisted).sort(), [
    "baseSha", "bootstrapPrompt", "branch", "milestone", "name", "number", "sessionId", "status", "worktree",
  ]);
  assert.match(h.durableClaims[0], /"name":"dsh-glasses-M1-#1-DSH"/);
});

test("named admission is deterministic across restart; repeated reconcile never duplicates the DSH worker", async () => {
  const claims = [];
  const worktrees = new Set();
  const sessions = new Set();
  const first = harness({ durableClaims: claims, sharedWorktrees: worktrees, sharedSessions: sessions, maxActive: 1 });
  const admitted = (await first.dispatcher.reconcile()).running[0];
  const restarted = harness({ durableClaims: claims, sharedWorktrees: worktrees, sharedSessions: sessions, maxActive: 1, wakeAgents: true });
  const report = await restarted.dispatcher.reconcile();
  assert.equal(report.running[0].sessionId, admitted.sessionId);
  assert.equal(report.running[0].name, admitted.name);
  assert.equal(report.running[0].live, true);
  assert.equal(restarted.calls.includes("resume:1"), true);
  assert.equal(restarted.calls.includes("wake:1"), true);
  assert.equal(restarted.calls.includes("agent:1"), false);
});

test("admission reuses a persisted deterministic session instead of colliding (crash between flush and claim)", async () => {
  const sessions = new Set([NAME(1)]);
  const worktrees = new Set();
  const h = harness({ sharedSessions: sessions, sharedWorktrees: worktrees, maxActive: 1 });
  const report = await h.dispatcher.reconcile();
  assert.equal(report.running[0].sessionId, NAME(1));
  assert.equal(h.calls.includes("resume:1"), true);
  assert.equal(h.calls.includes("agent:1"), false);
});

for (const fault of ["worktree", "agent", "state", "claim"]) {
  test(`publication rollback at ${fault} is unclaimed and retryable`, async () => {
    const h = harness({ fail: fault, maxActive: 1 });
    await h.dispatcher.reconcile();
    assert.equal(h.durableClaims.length, 0);
    assert.equal(h.live.size, 0);
    assert.equal(h.sharedWorktrees.size, 0);
    assert.equal(h.state().tickets["1"].status, "failed");
  });
}

test("resolution failure reports deterministically and admits nothing", async () => {
  const h = harness({ fail: "resolve", baseSha: "", maxActive: 1 });
  const report = await h.dispatcher.reconcile();
  assert.equal(report.resolutionError, "cannot resolve base ref moving");
  assert.deepEqual(report.running, []);
  assert.deepEqual(report.ready, [1, 2, 3]);
  assert.equal(h.calls.some((call) => call.startsWith("worktree:")), false);
});

test("exact SHA override wins without resolving the ref", async () => {
  const h = harness({ fail: "resolve", baseSha: BASE, maxActive: 1 });
  const report = await h.dispatcher.reconcile();
  assert.equal(report.running[0].baseSha, BASE);
  assert.equal(h.calls.includes("resolve"), false);
});

test("new admissions resolve each pass while claimed bindings keep historical base", async () => {
  const records = [{ number: 1, state: "OPEN", milestone: "M1", blockers: [], url: "u1" }];
  const h = harness({ records, baseSha: "", refSha: BASE, maxActive: 2 });
  await h.dispatcher.reconcile();
  h.setRef(NEXT);
  records.push({ number: 2, state: "OPEN", milestone: "M1", blockers: [], url: "u2" });
  const report = await h.dispatcher.reconcile();
  assert.deepEqual(report.running.map(({ number, baseSha }) => ({ number, baseSha })), [
    { number: 1, baseSha: BASE },
    { number: 2, baseSha: NEXT },
  ]);
  assert.deepEqual(report.running.map(({ name }) => name), [NAME(1), NAME(2)]);
});

test("restart resumes a progressed worktree without recreating or voiding it", async () => {
  const binding = { number: 1, name: NAME(1), sessionId: NAME(1), branch: "workflow/ticket-1", worktree: "/tickets/progressed", baseSha: BASE };
  const claims = [claimBody(binding)];
  const h = harness({
    durableClaims: claims,
    sharedWorktrees: new Set([binding.worktree]),
    sharedSessions: new Set([binding.sessionId]),
    maxActive: 1,
  });
  const report = await h.dispatcher.reconcile();
  assert.equal(report.running[0].sessionId, binding.sessionId);
  assert.equal(report.running[0].validWorktree, true);
  assert.equal(report.running[0].live, true);
  assert.equal(report.running[0].recovered, undefined);
  assert.equal(h.calls.includes("worktree:1"), false);
  assert.equal(h.calls.some((call) => call.startsWith("void:1:")), false);
});

test("default indeterminate session probe attempts and succeeds at resume", async () => {
  const binding = { number: 1, name: NAME(1), sessionId: NAME(1), branch: "workflow/ticket-1", worktree: "/tickets/unknown", baseSha: BASE };
  const h = harness({
    durableClaims: [claimBody(binding)],
    sharedWorktrees: new Set([binding.worktree]),
    sessionProbe: async () => ({ status: "unknown" }),
    maxActive: 1,
  });
  const report = await h.dispatcher.reconcile();
  assert.equal(report.running[0].sessionId, binding.sessionId);
  assert.equal(report.running[0].sessionPersisted, false);
  assert.equal(report.running[0].live, true);
  assert.equal(h.calls.includes("resume:1"), true);
  assert.equal(h.calls.some((call) => call.startsWith("void:1:")), false);
});

test("indeterminate session probe voids once only after resume fails", async () => {
  const binding = { number: 1, name: NAME(1), sessionId: NAME(1), branch: "workflow/ticket-1", worktree: "/tickets/unknown-bad", baseSha: BASE };
  const h = harness({
    fail: "resume",
    durableClaims: [claimBody(binding)],
    sharedWorktrees: new Set([binding.worktree]),
    sessionProbe: async () => undefined,
    maxActive: 1,
  });
  const report = await h.dispatcher.reconcile();
  assert.deepEqual(report.invalid, [{ number: 1, reason: "invalid-claim" }]);
  assert.equal(h.calls.includes("resume:1"), true);
  assert.equal(h.calls.filter((call) => call === "void:1:invalid-claim").length, 1);
});

test("missing worktree is recreated before the claimed session resumes", async () => {
  const binding = { number: 1, name: NAME(1), sessionId: NAME(1), branch: "workflow/ticket-1", worktree: "/tickets/old", baseSha: BASE };
  const claims = [claimBody(binding)];
  const h = harness({ durableClaims: claims, sharedSessions: new Set([binding.sessionId]), maxActive: 1 });
  const report = await h.dispatcher.reconcile();
  assert.equal(report.running[0].sessionId, binding.sessionId);
  assert.equal(report.running[0].recovered, "worktree");
  assert.equal(report.running[0].live, true);
  assert.deepEqual(h.calls.slice(0, 2), ["worktree:1", "resume:1"]);
});

test("definitively missing persisted session is voided stale, then re-admitted under the same deterministic name with no duplicate", async () => {
  const binding = { number: 1, name: NAME(1), sessionId: NAME(1), branch: "workflow/ticket-1", worktree: "/tickets/old", baseSha: BASE };
  const claims = [claimBody(binding)];
  const h = harness({ durableClaims: claims, maxActive: 1 });
  const first = await h.dispatcher.reconcile();
  assert.deepEqual(first.running, []);
  assert.deepEqual(first.invalid, [{ number: 1, reason: "stale-session" }]);
  assert.equal(first.ready[0], 1);
  assert.equal(h.calls.includes("resume:1"), false);
  assert.match(claims.at(-1), /^dispatcher-claim:void /);
  const second = await h.dispatcher.reconcile();
  assert.equal(second.running[0].number, 1);
  // Deterministic identity: the same named session id is recreatable, never duplicated.
  assert.equal(second.running[0].sessionId, NAME(1));
  const third = await h.dispatcher.reconcile();
  assert.equal(third.running.length, 1);
  assert.equal(third.running[0].sessionId, NAME(1));
});

test("resume failure voids the claim instead of reporting false-running", async () => {
  const binding = { number: 1, name: NAME(1), sessionId: NAME(1), branch: "workflow/ticket-1", worktree: "/tickets/old", baseSha: BASE };
  const h = harness({ fail: "resume", durableClaims: [claimBody(binding)], sharedWorktrees: new Set([binding.worktree]), sharedSessions: new Set([binding.sessionId]), maxActive: 1 });
  const report = await h.dispatcher.reconcile();
  assert.deepEqual(report.running, []);
  assert.deepEqual(report.invalid, [{ number: 1, reason: "invalid-claim" }]);
  assert.equal(h.calls.includes("void:1:invalid-claim"), true);
});

test("failed tombstone publication stays invalid without consuming capacity or becoming eligible", async () => {
  const binding = { number: 1, name: NAME(1), sessionId: NAME(1), branch: "workflow/ticket-1", worktree: "/tickets/old", baseSha: BASE };
  const h = harness({ fail: "void", durableClaims: [claimBody(binding)], maxActive: 1 });
  const report = await h.dispatcher.reconcile();
  assert.deepEqual(report.running, []);
  assert.deepEqual(report.ready, [2, 3]);
  assert.deepEqual(report.invalid, [{ number: 1, reason: "void-failed" }]);
  assert.equal(h.state().tickets[1].status, "voiding");
});

test("resume cleanup removes a recreated worktree but preserves its pre-existing branch", async () => {
  const binding = { number: 1, name: NAME(1), sessionId: NAME(1), branch: "workflow/ticket-1", worktree: "/tickets/old", baseSha: BASE };
  const h = harness({
    fail: "resume",
    durableClaims: [claimBody(binding)],
    sharedBranches: new Set([binding.branch]),
    sharedSessions: new Set([binding.sessionId]),
    maxActive: 1,
  });
  await h.dispatcher.reconcile();
  assert.equal(h.calls.includes("remove:1:false"), true);
  assert.equal(h.sharedBranches.has(binding.branch), true);
  assert.equal(h.sharedWorktrees.has(binding.worktree), false);
});

test("a pre-marker publishing crash retries instead of becoming a false claim", async () => {
  const initialState = { schemaVersion: 2, tickets: { 1: { number: 1, status: "publishing", sessionId: "session-crashed", branch: "workflow/ticket-1", worktree: `/tickets/ticket-1-${BASE.slice(0, 12)}`, baseSha: BASE } } };
  const h = harness({ initialState, sharedWorktrees: new Set([initialState.tickets[1].worktree]), maxActive: 1 });
  const report = await h.dispatcher.reconcile();
  assert.equal(report.running[0].number, 1);
  assert.notEqual(report.running[0].sessionId, "session-crashed");
  assert.equal(report.running[0].sessionId, NAME(1));
});

test("an OPEN Ticket without a deterministically valid Milestone is never admitted and is reported", async () => {
  const records = [
    { number: 5, state: "OPEN", milestone: undefined, blockers: [], url: "u5" },
    { number: 6, state: "OPEN", milestone: "Bootstrap", blockers: [], url: "u6" },
  ];
  const h = harness({ records, maxActive: 2 });
  const report = await h.dispatcher.reconcile();
  assert.deepEqual(report.invalidMilestone, [5]);
  assert.deepEqual(report.running.map((x) => x.number), [6]);
  assert.deepEqual(report.ready, []);
});

test("an existing claim on an invalid-Milestone Ticket cannot abort the pass (dshName guard)", async () => {
  // Regression for the reviewer finding: claim reconciliation previously called
  // dshName() on a Ticket whose declared Milestone is invalid; dshName throws,
  // which aborted the whole reconcile pass. The guard makes the claim a
  // failed/stale-identity tombstone instead, and the pass completes with the
  // Ticket reported under invalidMilestone.
  const records = [
    { number: 5, state: "OPEN", milestone: undefined, blockers: [], url: "u5" },
    { number: 6, state: "OPEN", milestone: "Bootstrap", blockers: [], url: "u6" },
  ];
  const foreign = { number: 5, name: "dsh-glasses-legacy-#5-DSH", sessionId: "dsh-glasses-legacy-#5-DSH", branch: "workflow/ticket-5", worktree: "/tickets/ticket-5", baseSha: BASE };
  const h = harness({ records, durableClaims: [claimBody(foreign)], maxActive: 2 });
  const report = await h.dispatcher.reconcile(); // must complete, not throw
  assert.deepEqual(report.invalidMilestone, [5]);
  assert.deepEqual(report.running.map((x) => x.number), [6]);
  assert.deepEqual(report.ready, []);
  const tombstone = h.state().tickets[5];
  assert.equal(tombstone.status, "failed");
  assert.equal(tombstone.reason, "stale-identity");
});

// ── DSH liveness watchdog ─────────────────────────────────────────────────────

test("watchdog does not wake a live/progressing DSH session", async () => {
  const binding = { number: 1, name: NAME(1), sessionId: NAME(1), branch: "workflow/ticket-1", worktree: "/tickets/w", baseSha: BASE };
  const h = harness({
    durableClaims: [claimBody(binding)],
    sharedWorktrees: new Set([binding.worktree]),
    sharedSessions: new Set([binding.sessionId]),
    agentStatuses: new Map([[NAME(1), "running"]]),
    initialLive: [NAME(1)],
    wakeAgents: true,
    maxActive: 1,
  });
  const report = await h.dispatcher.reconcile();
  assert.equal(report.running[0].progressing, true);
  assert.equal(h.calls.filter((call) => call.startsWith("wake:")).length, 0);
  assert.equal(h.calls.filter((call) => call.startsWith("resume:")).length, 0);
});

test("watchdog wakes a live but quiescent DSH session with a minimal continuation instruction", async () => {
  const binding = { number: 1, name: NAME(1), sessionId: NAME(1), branch: "workflow/ticket-1", worktree: "/tickets/w", baseSha: BASE, bootstrapPrompt: "full bootstrap" };
  const h = harness({
    durableClaims: [claimBody(binding)],
    sharedWorktrees: new Set([binding.worktree]),
    sharedSessions: new Set([binding.sessionId]),
    agentStatuses: new Map([[NAME(1), "idle"]]),
    initialLive: [NAME(1)],
    wakeAgents: true,
    maxActive: 1,
  });
  const report = await h.dispatcher.reconcile();
  assert.equal(report.running[0].live, true);
  assert.equal(report.running[0].progressing, false);
  assert.equal(h.calls.filter((call) => call.startsWith("wake:")).length, 1);
  const [wake] = h.wakes;
  assert.match(wake, /1:Continue Ticket #1/);
  assert.match(wake, /TicketComplete/);
  assert.equal(wake.includes("full bootstrap"), false);
});

test("watchdog wakes a loaded quiescent session only once per pass and never wakes completed Tickets", async () => {
  const records = [
    { number: 1, state: "OPEN", milestone: "M1", blockers: [], url: "u1" },
    { number: 2, state: "OPEN", milestone: "M1", blockers: [], url: "u2" },
  ];
  const binding = { number: 1, name: NAME(1), sessionId: NAME(1), branch: "workflow/ticket-1", worktree: "/tickets/w", baseSha: BASE };
  const completed = { number: 2, name: NAME(2), sessionId: NAME(2), branch: "workflow/ticket-2", worktree: "/tickets/c", baseSha: BASE };
  const h = harness({
    records,
    durableClaims: [claimBody(binding), claimBody(completed)],
    durableCompletions: [completeBody(completed, { head: "a".repeat(40) })],
    sharedWorktrees: new Set([binding.worktree, completed.worktree]),
    sharedSessions: new Set([binding.sessionId, completed.sessionId]),
    agentStatuses: new Map([[NAME(1), "idle"], [NAME(2), "idle"]]),
    initialLive: [NAME(1), NAME(2)],
    wakeAgents: true,
    maxActive: 2,
  });
  const report = await h.dispatcher.reconcile();
  assert.deepEqual(report.running.map((x) => x.number), [1]);
  assert.deepEqual(report.completed.map((x) => x.number), [2]);
  assert.equal(h.calls.filter((call) => call.startsWith("wake:")).length, 1);
  assert.equal(h.calls.includes("dispose:2"), true);
});

test("a malformed completion marker (missing/bad head SHA) must NOT retire a binding, so the watchdog keeps supervising it", async () => {
  const binding = { number: 1, name: NAME(1), sessionId: NAME(1), branch: "workflow/ticket-1", worktree: "/tickets/w", baseSha: BASE };
  const h = harness({
    durableClaims: [claimBody(binding)],
    sharedWorktrees: new Set([binding.worktree]),
    sharedSessions: new Set([binding.sessionId]),
    agentStatuses: new Map([[NAME(1), "idle"]]),
    initialLive: [NAME(1)],
    wakeAgents: true,
    maxActive: 1,
    durableCompletions: ["ticket-complete: {\"schemaVersion\":1,\"ticket\":1,\"sessionId\":\"dsh-glasses-M1-#1-DSH\",\"head\":\"not-a-real-head\"}"],
  });
  const report = await h.dispatcher.reconcile();
  assert.deepEqual(report.completed, [], "malformed marker must not retire the binding");
  assert.equal(report.running[0].sessionId, NAME(1));
  assert.equal(h.calls.filter((call) => call.startsWith("wake:")).length, 1, "watchdog must keep waking the still-active Ticket Lead");
});

test("a closed Ticket is retired, never woken, and releases capacity", async () => {
  const records = [
    { number: 1, state: "CLOSED", milestone: "M1", blockers: [], url: "u1" },
  ];
  const binding = { number: 1, name: NAME(1), sessionId: NAME(1), branch: "workflow/ticket-1", worktree: "/tickets/w", baseSha: BASE };
  const h = harness({
    records,
    durableClaims: [claimBody(binding)],
    sharedWorktrees: new Set([binding.worktree]),
    sharedSessions: new Set([binding.sessionId]),
    agentStatuses: new Map([[NAME(1), "idle"]]),
    initialLive: [NAME(1)],
    wakeAgents: true,
    maxActive: 1,
  });
  const report = await h.dispatcher.reconcile();
  assert.deepEqual(report.running, []);
  assert.deepEqual(report.completed.map((x) => x.number), [1]);
  assert.equal(h.calls.filter((call) => call.startsWith("wake:")).length, 0);
  assert.equal(h.calls.includes("dispose:1"), true);
});

test("a claim marker under a legacy/arbitrary session id cannot hijack restart: the Ticket re-admits under the exact deterministic identity", async () => {
  const h = harness({
    records: [{ number: 1, state: "OPEN", milestone: "M1", blockers: [], url: "u1" }],
    durableClaims: [`dispatcher-claim: ${JSON.stringify({ schemaVersion: 2, ticket: 1, name: "legacy", sessionId: "legacy-session", branch: "workflow/ticket-1", worktree: "/tickets/legacy", baseSha: BASE })}`],
    maxActive: 1,
  });
  const report = await h.dispatcher.reconcile();
  assert.equal(report.running.length, 1);
  assert.equal(report.running[0].sessionId, NAME(1), "restart must not bind the legacy session id");
  assert.equal(h.calls.includes("agent:1"), true, "the Ticket must be re-admitted under the exact deterministic identity");
  const durable = h.state().tickets["1"];
  assert.equal(durable.sessionId, NAME(1));
  assert.equal(["claimed", "running"].includes(durable.status), true);
});

test("a persisted-session identity collision is a non-retriable terminal state: no resume, no claim void, no session deletion", async () => {
  const binding = { number: 1, name: NAME(1), sessionId: NAME(1), branch: "workflow/ticket-1", worktree: "/tickets/moved", baseSha: BASE };
  const h = harness({
    records: [{ number: 1, state: "OPEN", milestone: "M1", blockers: [], url: "u1" }],
    durableClaims: [claimBody(binding)],
    sharedWorktrees: new Set([binding.worktree]),
    sessionProbe: async () => ({ status: "collision", dirs: ["/other/session-dir"] }),
    maxActive: 1,
  });
  const first = await h.dispatcher.reconcile();
  assert.deepEqual(first.running, []);
  assert.deepEqual(first.invalid, [{ number: 1, reason: "identity-collision" }]);
  assert.equal(h.calls.includes("resume:1"), false);
  assert.equal(h.calls.some((call) => call.startsWith("void:1:")), false, "claim marker must be preserved");
  assert.equal(h.calls.some((call) => call.startsWith("agent:1:")), false, "no fresh agent may be created");
  const durable = h.state().tickets["1"];
  assert.equal(durable.status, "collision");
  assert.equal(durable.reason, "identity-collision");
  // A repeated pass does not thrash: still terminal, still no create/resume.
  const second = await h.dispatcher.reconcile();
  assert.deepEqual(second.invalid, [{ number: 1, reason: "identity-collision" }]);
  assert.equal(h.calls.filter((call) => call.startsWith("agent:")).length, 0);
  assert.equal(h.calls.filter((call) => call.startsWith("resume:")).length, 0);
});

test("an unclaimed Ticket whose deterministic id persists under another worktree becomes a durable terminal collision without deleting the orphan", async () => {
  const h = harness({
    records: [{ number: 1, state: "OPEN", milestone: "M1", blockers: [], url: "u1" }],
    durableClaims: [],
    sessionProbe: async () => ({ status: "collision", dirs: ["/old/worktree/ticket-1-old"] }),
    maxActive: 1,
  });
  const report = await h.dispatcher.reconcile();
  assert.deepEqual(report.running, []);
  assert.deepEqual(report.invalid, [{ number: 1, reason: "identity-collision" }]);
  const durable = h.state().tickets["1"];
  assert.equal(durable.status, "collision");
  assert.equal(durable.sessionId, NAME(1));
  assert.equal(h.calls.includes("worktree:1"), false, "nothing may be created while the orphan persists");
  assert.equal(h.calls.includes("agent:1"), false);
  assert.equal(h.durableClaims.length, 0);
});

test("a cleared identity collision re-admits the same deterministic id without ever auto-admitting into an active collision", async () => {
  let mode = "collision";
  const binding = { number: 1, name: NAME(1), sessionId: NAME(1), branch: "workflow/ticket-1", worktree: "/tickets/fresh", baseSha: BASE };
  const h = harness({
    records: [{ number: 1, state: "OPEN", milestone: "M1", blockers: [], url: "u1" }],
    durableClaims: [claimBody(binding)],
    sessionProbe: async () => (mode === "collision" ? { status: "collision", dirs: ["/other/session-dir"] } : { status: "missing" }),
    maxActive: 1,
  });
  const first = await h.dispatcher.reconcile();
  assert.deepEqual(first.invalid, [{ number: 1, reason: "identity-collision" }]);
  // Human/operator action removes the collided session log; a later pass must
  // detect the cleared collision and re-admit with the SAME deterministic id.
  mode = "missing";
  const second = await h.dispatcher.reconcile();
  assert.equal(second.running.length, 1);
  assert.equal(second.running[0].sessionId, NAME(1));
  assert.equal(h.calls.includes("agent:1"), true);
});

test("a failed configured-origin fetch with a resolvable stale origin/main admits no Ticket", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dispatcher-fetch-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await run("git", ["init", "--quiet", repo]);
  const git = (...args) => run("git", args, { cwd: repo });
  await git("config", "user.name", "Dispatcher");
  await git("config", "user.email", "dispatcher@example.invalid");
  await writeFile(join(repo, "file"), "base\n");
  await git("add", "file");
  await git("commit", "--quiet", "-m", "base");
  const base = (await git("rev-parse", "HEAD")).stdout.trim();

  // origin/main is resolvable locally but STALE, and a configured origin exists
  // whose fetch fails. With fetch=true the pass must fail instead of admitting
  // a Ticket from the stale ref.
  await git("update-ref", "refs/remotes/origin/main", base);
  await git("remote", "add", "origin", join(root, "does-not-exist"));

  const fixtures = join(root, "fixtures.json");
  await writeFile(fixtures, JSON.stringify({
    tickets: [{ number: 7, state: "OPEN", milestone: "M1", url: "https://example.test/issues/7", blockers: [], blockerStates: {} }],
    claims: [],
    completions: [],
  }, null, 2));
  const worktrees = join(root, "worktrees");
  await mkdir(worktrees, { recursive: true });

  const created = [];
  const dsh = {
    isLive: () => false,
    isProgressing: () => false,
    async createAgent(binding) { created.push(binding.number); },
    async resumeAgent() {},
    async disposeAgent() {},
  };
  const dispatcher = createDispatcher({
    github: createFixtureGithubAdapter(fixtures),
    git: createGitAdapter(repo, worktrees),
    dsh,
    stateStore: createStateStore(join(root, "state.json")),
    repoRoot: repo,
    worktreeRoot: worktrees,
    baseSha: "",
    baseRef: "origin/main",
    fetch: true,
    maxActive: 3,
    sessionProbe: async () => ({ status: "missing" }),
  });

  const report = await dispatcher.reconcile();
  assert.ok(report.resolutionError, "resolutionError must be set on fetch failure");
  assert.match(report.resolutionError, /fetch/i);
  assert.deepEqual(report.running, [], "no Ticket may be admitted from the stale ref");
  assert.deepEqual(report.ready, [7], "the Ticket stays on the ready frontier");
  assert.deepEqual(created, [], "no agent/worktree may be created");
  assert.equal((await readFile(fixtures, "utf8")).includes("dispatcher-claim:"), false, "no durable claim may be written");
  assert.equal((await readFile(join(root, "state.json"), "utf8")).includes("claimed"), false, "local state must hold no claimed binding");
});
