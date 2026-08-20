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
import { claimBody, closeoutMarkerBody, collapseClaimMarkers, collapseCloseoutMarkers, parseClaim, voidClaimBody } from "../lib/core.js";

const run = promisify(execFile);

const BASE = "71059429be3d6f95ef9625adf5dea52db2cd51d2";
const NEXT = "e3f6cdbfe49cc295753859e3c7b600785885aa45";
const ticketRecord = (number, overrides = {}) => ({
  number,
  state: "OPEN",
  blockers: [],
  url: `https://example.test/issues/${number}`,
  milestone: "M1",
  body: "## Milestone\nM1\n\n## What to build\nwork\n",
  ...overrides,
});
const defaultTickets = () => [1, 2, 3, 4].map((number) => ticketRecord(number, { blockers: number === 4 ? [3] : [] }));

function harness(options = {}) {
  const {
    fail,
    initialState,
    durableClaims = [],
    maxActive = 3,
    records = defaultTickets(),
    baseSha = BASE,
    sharedWorktrees = new Set(),
    sharedBranches = new Set(),
    sharedSessions = new Set(),
    sharedThreads,
    codexFaults = new Set(),
  } = options;
  const codexThreads = sharedThreads ?? [];
  let state = structuredClone(initialState ?? { schemaVersion: 1, tickets: {} });
  let saves = 0;
  let refSha = options.refSha ?? BASE;
  const live = new Set();
  const calls = [];
  const github = {
    async listTickets() { return structuredClone(records); },
    async listClaims() { return collapseClaimMarkers(durableClaims); },
    async listCloseouts() { return collapseCloseoutMarkers(durableClaims); },
    async writeClaim(binding) {
      calls.push(`claim:${binding.number}`);
      if (fail === "claim") throw new Error("claim fault");
      durableClaims.push(claimBody(binding));
    },
    async writeCloseout(binding, info = {}) {
      durableClaims.push(closeoutMarkerBody(binding, info));
    },
    async voidClaim(binding, reason) {
      calls.push(`void:${binding.number}:${reason}`);
      if (fail === "void") throw new Error("void fault");
      durableClaims.push(voidClaimBody(binding, reason));
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
    async createAgent(binding) {
      calls.push(`agent:${binding.number}`);
      if (fail === "agent") throw new Error("agent fault");
      live.add(binding.sessionId);
      sharedSessions.add(binding.sessionId);
    },
    async resumeAgent(binding) {
      calls.push(`resume:${binding.number}`);
      if (fail === "resume") throw new Error("cannot resume");
      live.add(binding.sessionId);
    },
    async disposeAgent(binding) { calls.push(`dispose:${binding.number}`); live.delete(binding.sessionId); },
    ...(options.statusFor ? { agentStatus(binding) { return options.statusFor(binding.sessionId); } } : {}),
    ...(options.wakeAgents ? {
      async wakeAgent(binding) { calls.push(`wake:${binding.number}`); },
      async continueAgent(binding) {
        calls.push(`continue:${binding.number}`);
        if (fail === "continue") throw new Error("continue fault");
      },
    } : {}),
  };
  const codex = {
    async createThread({ name }) {
      calls.push(`codex-create:${name}`);
      if (fail === "codex" || codexFaults.has("create")) throw new Error("codex create fault");
      const thread = {
        threadId: `thread-${name}-${codexThreads.length}`,
        threadName: name,
        firstPrompt: name,
        status: "idle",
        turns: [{ items: [{ type: "userMessage", content: [{ type: "text", text: name }] }] }],
      };
      codexThreads.push(thread);
      return thread;
    },
    async readThread({ threadId, name }) {
      calls.push(`codex-read:${name ?? threadId}`);
      if (fail === "codex-read" || codexFaults.has("read")) throw new Error("codex read fault");
      const byId = codexThreads.find((thread) => thread.threadId === threadId);
      if (byId) return byId;
      if (name) {
        const byName = codexThreads.filter((thread) => thread.threadName === name);
        if (byName.length) return byName[0];
        throw new Error(`codex thread not found by name: ${name}`);
      }
      throw new Error("codex read requires identity");
    },
    async deleteThread(threadId) {
      calls.push(`codex-delete:${threadId}`);
      const index = codexThreads.findIndex((thread) => thread.threadId === threadId);
      if (index >= 0) codexThreads.splice(index, 1);
    },
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
  let id = 0;
  const dispatcherOptions = {
    github, git, dsh, codex, stateStore, repoRoot: "/repo", worktreeRoot: "/tickets",
    baseSha, baseRef: "moving", fetch: false, maxActive,
    uuid: () => `uuid-${++id}`,
    ...(options.wakeAgents ? { wakeAgents: true } : {}),
    ...(options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
    ...(options.codexThinking !== undefined ? { codexThinking: options.codexThinking } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  if (!options.omitSessionProbe) dispatcherOptions.sessionProbe = options.sessionProbe ?? (async (binding) => sharedSessions.has(binding.sessionId));
  if (options.sessionLogReader) dispatcherOptions.sessionLogReader = options.sessionLogReader;
  if (options.bootstrapMarker) dispatcherOptions.bootstrapMarker = options.bootstrapMarker;
  const dispatcher = createDispatcher(dispatcherOptions);
  return {
    dispatcher, calls, durableClaims, live, records, sharedBranches, sharedSessions, sharedWorktrees, codexThreads,
    setRef(value) { refSha = value; },
    state: () => structuredClone(state),
  };
}

test("one pass admits to capacity and repeated reconcile neither creates nor resumes live agents", async () => {
  const h = harness({ maxActive: 2 });
  const first = await h.dispatcher.reconcile();
  assert.deepEqual(first.running.map((x) => x.number), [1, 2]);
  assert.ok(first.running.every((x) => x.live));
  assert.deepEqual(first.capacityLimited, [3]);
  const creates = h.calls.filter((x) => x.startsWith("agent:")).length;
  await h.dispatcher.reconcile();
  assert.equal(h.calls.filter((x) => x.startsWith("agent:")).length, creates);
  assert.equal(h.calls.filter((x) => x.startsWith("resume:")).length, 0);
  assert.equal(h.durableClaims.length, 2);
});

for (const fault of ["worktree", "agent", "codex", "state", "claim"]) {
  test(`publication rollback at ${fault} is unclaimed and retryable`, async () => {
    const h = harness({ fail: fault, maxActive: 1 });
    await h.dispatcher.reconcile();
    assert.equal(h.durableClaims.length, 0);
    assert.equal(h.live.size, 0);
    assert.equal(h.sharedWorktrees.size, 0);
    assert.equal(h.codexThreads.length, 0);
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
  const records = [ticketRecord(1, { url: "u1" })];
  const h = harness({ records, baseSha: "", refSha: BASE, maxActive: 2 });
  await h.dispatcher.reconcile();
  h.setRef(NEXT);
  records.push(ticketRecord(2, { url: "u2" }));
  const report = await h.dispatcher.reconcile();
  assert.deepEqual(report.running.map(({ number, baseSha }) => ({ number, baseSha })), [
    { number: 1, baseSha: BASE },
    { number: 2, baseSha: NEXT },
  ]);
});

test("restart resumes a valid durable claim under the same session id", async () => {
  const claims = [];
  const worktrees = new Set();
  const sessions = new Set();
  const first = harness({ durableClaims: claims, sharedWorktrees: worktrees, sharedSessions: sessions, maxActive: 1 });
  const admitted = (await first.dispatcher.reconcile()).running[0];
  const restarted = harness({ durableClaims: claims, sharedWorktrees: worktrees, sharedSessions: sessions, maxActive: 1, wakeAgents: true });
  const report = await restarted.dispatcher.reconcile();
  assert.equal(report.running[0].sessionId, admitted.sessionId);
  assert.equal(report.running[0].live, true);
  assert.equal(restarted.calls.includes("resume:1"), true);
  assert.equal(restarted.calls.includes("wake:1"), true);
  assert.equal(restarted.calls.includes("agent:1"), false);
});

test("restart resumes a progressed worktree without recreating or voiding it", async () => {
  const binding = { number: 1, sessionId: "session-progressed", branch: "workflow/ticket-1", worktree: "/tickets/progressed", baseSha: BASE };
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
  // The legacy claim is completed into a full pair: its missing Codex thread is
  // rebuilt (the contract requires one persistent paired thread per Ticket).
  assert.equal(report.running[0].recovered, "codex");
  assert.equal(h.calls.includes("worktree:1"), false);
  assert.ok(h.calls.some((call) => call.startsWith("codex-create:dsh-glasses-M1-#1-Codex")));
  assert.equal(h.calls.some((call) => call.startsWith("void:1:")), false);
});

test("default indeterminate session probe attempts and succeeds at resume", async () => {
  const binding = { number: 1, sessionId: "session-unknown", branch: "workflow/ticket-1", worktree: "/tickets/unknown", baseSha: BASE };
  const h = harness({
    durableClaims: [claimBody(binding)],
    sharedWorktrees: new Set([binding.worktree]),
    omitSessionProbe: true,
    maxActive: 1,
  });
  const report = await h.dispatcher.reconcile();
  assert.equal(report.running[0].sessionId, binding.sessionId);
  assert.equal(report.running[0].sessionPersisted, undefined);
  assert.equal(report.running[0].live, true);
  assert.equal(h.calls.includes("resume:1"), true);
  assert.equal(h.calls.some((call) => call.startsWith("void:1:")), false);
});

test("indeterminate session probe voids once only after resume fails", async () => {
  const binding = { number: 1, sessionId: "session-unknown-bad", branch: "workflow/ticket-1", worktree: "/tickets/unknown-bad", baseSha: BASE };
  const claims = [claimBody(binding)];
  const h = harness({
    fail: "resume",
    durableClaims: claims,
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
  const binding = { number: 1, sessionId: "session-old", branch: "workflow/ticket-1", worktree: "/tickets/old", baseSha: BASE };
  const claims = [claimBody(binding)];
  const sessions = new Set([binding.sessionId]);
  const h = harness({ durableClaims: claims, sharedSessions: sessions, maxActive: 1 });
  const report = await h.dispatcher.reconcile();
  assert.equal(report.running[0].sessionId, binding.sessionId);
  assert.equal(report.running[0].recovered, "worktree+codex");
  assert.equal(report.running[0].live, true);
  assert.deepEqual(h.calls.slice(0, 4), ["worktree:1", "codex-read:dsh-glasses-M1-#1-Codex", "codex-create:dsh-glasses-M1-#1-Codex", "resume:1"]);
});

test("definitively missing persisted session is voided stale without attempting resume", async () => {
  const binding = { number: 1, sessionId: "session-missing", branch: "workflow/ticket-1", worktree: "/tickets/old", baseSha: BASE };
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
  assert.notEqual(second.running[0].sessionId, binding.sessionId);
});

test("resume failure voids the claim instead of reporting false-running", async () => {
  const binding = { number: 1, sessionId: "session-bad", branch: "workflow/ticket-1", worktree: "/tickets/old", baseSha: BASE };
  const claims = [claimBody(binding)];
  const h = harness({ fail: "resume", durableClaims: claims, sharedWorktrees: new Set([binding.worktree]), sharedSessions: new Set([binding.sessionId]), maxActive: 1 });
  const report = await h.dispatcher.reconcile();
  assert.deepEqual(report.running, []);
  assert.deepEqual(report.invalid, [{ number: 1, reason: "invalid-claim" }]);
  assert.equal(h.calls.includes("void:1:invalid-claim"), true);
});

test("failed tombstone publication stays invalid without consuming capacity or becoming eligible", async () => {
  const binding = { number: 1, sessionId: "session-missing", branch: "workflow/ticket-1", worktree: "/tickets/old", baseSha: BASE };
  const claims = [claimBody(binding)];
  const h = harness({ fail: "void", durableClaims: claims, maxActive: 1 });
  const report = await h.dispatcher.reconcile();
  assert.deepEqual(report.running, []);
  assert.deepEqual(report.ready, [2, 3]);
  assert.deepEqual(report.invalid, [{ number: 1, reason: "void-failed" }]);
  assert.equal(h.state().tickets[1].status, "voiding");
});

test("resume cleanup removes a recreated worktree but preserves its pre-existing branch", async () => {
  const binding = { number: 1, sessionId: "session-bad", branch: "workflow/ticket-1", worktree: "/tickets/old", baseSha: BASE };
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
  const initialState = { schemaVersion: 1, tickets: { 1: { number: 1, status: "publishing", sessionId: "session-crashed", branch: "workflow/ticket-1", worktree: `/tickets/ticket-1-${BASE.slice(0, 12)}`, baseSha: BASE } } };
  const h = harness({ initialState, sharedWorktrees: new Set([initialState.tickets[1].worktree]), maxActive: 1 });
  const report = await h.dispatcher.reconcile();
  assert.equal(report.running[0].number, 1);
  assert.notEqual(report.running[0].sessionId, "session-crashed");
});

test("paired admission creates exactly one DSH session and one Codex thread with exact names", async () => {
  const h = harness({ maxActive: 2 });
  const report = await h.dispatcher.reconcile();
  assert.deepEqual(report.running.map((x) => x.number), [1, 2]);
  for (const binding of report.running) {
    assert.equal(binding.dshName, `dsh-glasses-M1-#${binding.number}-DSH`);
    assert.equal(binding.codexName, `dsh-glasses-M1-#${binding.number}-Codex`);
    // The DSH session IS the deterministic name (DSH has no separate display name).
    assert.equal(binding.sessionId, binding.dshName);
    assert.ok(binding.codexThreadId);
    assert.equal(binding.codex.thinkingEffort, "max");
    assert.equal(binding.codex.firstPrompt, binding.codexName);
    assert.equal(binding.milestone, "M1");
  }
  // Each admission created exactly one agent and one codex thread.
  assert.equal(h.calls.filter((x) => x.startsWith("agent:")).length, 2);
  assert.equal(h.calls.filter((x) => x.startsWith("codex-create:")).length, 2);
  // The durable claim carries the full pair binding.
  assert.equal(h.durableClaims.length, 2);
  const claim = parseClaim(h.durableClaims[0].startsWith("dispatcher-claim:") ? h.durableClaims[0] : `dispatcher-claim: ${h.durableClaims[0]}`);
  assert.equal(claim.dshName, "dsh-glasses-M1-#1-DSH");
  assert.equal(claim.codexName, "dsh-glasses-M1-#1-Codex");
  assert.ok(claim.codex?.threadId);
});

test("repeated reconcile never duplicates either member of the pair", async () => {
  const h = harness({ maxActive: 2 });
  await h.dispatcher.reconcile();
  const agents = h.calls.filter((x) => x.startsWith("agent:")).length;
  const threads = h.calls.filter((x) => x.startsWith("codex-create:")).length;
  const sessions = [...h.sharedSessions];
  await h.dispatcher.reconcile();
  await h.dispatcher.reconcile();
  assert.equal(h.calls.filter((x) => x.startsWith("agent:")).length, agents);
  assert.equal(h.calls.filter((x) => x.startsWith("codex-create:")).length, threads);
  assert.deepEqual([...h.sharedSessions], sessions);
  assert.equal(h.durableClaims.length, 2);
});

test("restart reconstructs the SAME DSH session and Codex thread without recreating either", async () => {
  const claims = [];
  const worktrees = new Set();
  const sessions = new Set();
  const threadStore = [];
  const restartOpts = (extra = {}) => ({ durableClaims: claims, sharedWorktrees: worktrees, sharedSessions: sessions, sharedThreads: threadStore, maxActive: 1, wakeAgents: true, ...extra });
  const first = harness(restartOpts());
  const admitted = (await first.dispatcher.reconcile()).running[0];
  assert.equal(threadStore.length, 1, "admission created exactly one thread in the shared store");
  const restarted = harness(restartOpts());
  const report = await restarted.dispatcher.reconcile();
  assert.equal(report.running[0].sessionId, admitted.sessionId);
  assert.equal(report.running[0].codexThreadId, admitted.codexThreadId);
  assert.equal(report.running[0].dshName, admitted.dshName);
  assert.equal(report.running[0].codexName, admitted.codexName);
  assert.equal(restarted.calls.includes("resume:1"), true);
  assert.equal(restarted.calls.includes("wake:1"), true);
  assert.equal(restarted.calls.includes("agent:1"), false);
  // Codex thread was reconstructed by read, never recreated.
  assert.equal(restarted.calls.filter((x) => x.startsWith("codex-create:")).length, 0);
  assert.ok(restarted.calls.some((x) => x.startsWith("codex-read:")));
});

test("restart does NOT re-wake a session that already durably received its bootstrap", async () => {
  const claims = [];
  const worktrees = new Set();
  const sessions = new Set();
  const threadStore = [];
  const first = harness({ durableClaims: claims, sharedWorktrees: worktrees, sharedSessions: sessions, sharedThreads: threadStore, maxActive: 1, wakeAgents: true });
  const admitted = (await first.dispatcher.reconcile()).running[0];
  const log = `{"type":"session/start"}\n{"type":"userMessage","content":[{"type":"text","text":"You are DSH session ${admitted.sessionId} for Ticket #1"}]}\nworktree=${admitted.worktree}`;
  const restarted = harness({
    durableClaims: claims,
    sharedWorktrees: worktrees,
    sharedSessions: sessions,
    maxActive: 1,
    wakeAgents: true,
    sharedThreads: threadStore,
    sessionLogReader: async () => log,
  });
  const report = await restarted.dispatcher.reconcile();
  assert.equal(report.running[0].sessionId, admitted.sessionId);
  assert.equal(restarted.calls.includes("resume:1"), true);
  assert.equal(restarted.calls.includes("wake:1"), false, "bootstrap already delivered: no duplicate wake/followup");
});

test("a foreign orphan session (log from another worktree) is invalidated stale, never quietly resumed", async () => {
  const claims = [];
  const worktrees = new Set();
  const sessions = new Set();
  const threadStore = [];
  const first = harness({ durableClaims: claims, sharedWorktrees: worktrees, sharedSessions: sessions, sharedThreads: threadStore, maxActive: 1, wakeAgents: true });
  const admitted = (await first.dispatcher.reconcile()).running[0];
  // The persisted log exists but belongs to a DIFFERENT worktree; resume must not happen.
  const restarted = harness({
    durableClaims: claims,
    sharedWorktrees: worktrees,
    sharedSessions: sessions,
    maxActive: 1,
    wakeAgents: true,
    sharedThreads: threadStore,
    sessionLogReader: async () => `{"type":"userMessage","text":"You are DSH session dsh-glasses-M1-#1-DSH"}\ncwd=/somewhere/else`,
  });
  const report = await restarted.dispatcher.reconcile();
  assert.deepEqual(report.invalid, [{ number: 1, reason: "stale-session" }]);
  assert.equal(restarted.calls.includes("resume:1"), false);
});

test("reconstruct wakes when the bootstrap was NOT durably delivered before the crash", async () => {
  const claims = [];
  const worktrees = new Set();
  const sessions = new Set();
  const threadStore = [];
  const first = harness({ durableClaims: claims, sharedWorktrees: worktrees, sharedSessions: sessions, sharedThreads: threadStore, maxActive: 1, wakeAgents: true });
  const admitted = (await first.dispatcher.reconcile()).running[0];
  // Persisted log contains the worktree (identity-compatible) but NO bootstrap sentinel.
  const restarted = harness({
    durableClaims: claims,
    sharedWorktrees: worktrees,
    sharedSessions: sessions,
    maxActive: 1,
    wakeAgents: true,
    sharedThreads: threadStore,
    sessionLogReader: async () => `{"type":"session/start"}\ncwd=${admitted.worktree}`,
  });
  const report = await restarted.dispatcher.reconcile();
  assert.equal(report.running[0].sessionId, admitted.sessionId);
  assert.equal(restarted.calls.includes("resume:1"), true);
  assert.equal(restarted.calls.includes("wake:1"), true, "undelivered bootstrap must be re-sent once after restart");
});

test("readmission REUSES the same name-bound thread instead of creating a duplicate", async () => {
  // Simulates the Codex-flagged stale/readmission gap: a same-name persistent
  // thread already exists on the (shared) daemon; admission must reuse it.
  const threadStore = [{
    threadId: "thread-existing-#1",
    threadName: "dsh-glasses-M1-#1-Codex",
    firstPrompt: "dsh-glasses-M1-#1-Codex",
    status: "idle",
    turns: [{ items: [{ type: "userMessage", content: [{ type: "text", text: "dsh-glasses-M1-#1-Codex" }] }] }],
  }];
  const h = harness({ maxActive: 1, sharedThreads: threadStore });
  const report = await h.dispatcher.reconcile();
  const binding = report.running[0];
  assert.equal(binding.codexThreadId, "thread-existing-#1");
  assert.equal(h.state().tickets["1"].reusedThread, true, "binding must record the reuse");
  assert.equal(h.calls.filter((x) => x.startsWith("codex-create:")).length, 0, "no duplicate thread may be created");
  assert.ok(h.calls.some((x) => x.startsWith("codex-read:dsh-glasses-M1-#1-Codex")));
});

test("milestone-malformed Tickets are rejected rather than silently named", async () => {
  const records = [{ number: 8, state: "OPEN", blockers: [], url: "u8", milestone: "", body: "# No milestone" }];
  const h = harness({ records, maxActive: 1 });
  const report = await h.dispatcher.reconcile();
  assert.deepEqual(report.running, []);
  assert.deepEqual(report.ready, [8]);
  assert.equal(h.state().tickets["8"].status, "failed");
  assert.equal(h.state().tickets["8"].reason, "milestone-malformed");
  assert.equal(h.durableClaims.length, 0);
  assert.equal(h.calls.filter((x) => x.startsWith("codex-create:")).length, 0);
});

test("watchdog wakes the SAME quiesced unfinished DSH session with a minimal continuation", async () => {
  let clock = 1_000_000;
  const h = harness({ maxActive: 1, wakeAgents: true, heartbeatIntervalMs: 120_000, now: () => clock, statusFor: () => "idle" });
  await h.dispatcher.reconcile();
  const admitted = (await h.dispatcher.status()).running[0];
  assert.equal(h.calls.includes("wake:1"), true);
  // Immediately after the admission wake the cooldown has not elapsed: no continuation.
  await h.dispatcher.reconcile();
  assert.equal(h.calls.includes("continue:1"), false);
  // Advance past one heartbeat: the quiesced idle session receives a minimal continuation.
  clock += 120_001;
  await h.dispatcher.reconcile();
  const report = await h.dispatcher.status();
  assert.equal(h.calls.includes("continue:1"), true);
  assert.equal(report.running[0].sessionId, admitted.sessionId);
  assert.equal(report.running[0].watchdog, true);
  // The same session was continued, never replaced.
  assert.equal(report.running[0].sessionId, admitted.sessionId);
});

test("watchdog never wakes a live/progressing DSH session", async () => {
  let clock = 1_000_000;
  const h = harness({ maxActive: 1, wakeAgents: true, heartbeatIntervalMs: 120_000, now: () => clock, statusFor: () => "running" });
  await h.dispatcher.reconcile();
  clock += 120_001;
  const before = h.calls.filter((x) => x.startsWith("continue:")).length;
  const report = await h.dispatcher.reconcile();
  assert.equal(h.calls.filter((x) => x.startsWith("continue:")).length, before);
  assert.equal(report.running[0].progress, true);
  assert.equal(report.running[0].watchdog, false);
});

test("watchdog never wakes a completed Ticket (durable closeout marker)", async () => {
  const h = harness({ maxActive: 2, wakeAgents: true, heartbeatIntervalMs: 120_000, statusFor: () => "idle" });
  await h.dispatcher.reconcile();
  const binding = h.state().tickets["1"];
  h.durableClaims.push(closeoutMarkerBody(binding, { headSha: NEXT, pr: 99 }));
  let clock = 2_000_000;
  const h2 = harness({ durableClaims: h.durableClaims, sharedWorktrees: h.sharedWorktrees, sharedSessions: h.sharedSessions, maxActive: 2, wakeAgents: true, heartbeatIntervalMs: 120_000, now: () => clock, statusFor: () => "idle" });
  const report = await h2.dispatcher.reconcile();
  assert.deepEqual(report.running.map((x) => x.number), [2]);
  assert.deepEqual(report.completed.map((x) => x.number), [1]);
  assert.equal(h2.calls.includes("dispose:1"), true);
  assert.equal(h2.calls.includes("continue:1"), false);
  assert.equal(h2.calls.includes("wake:1"), false);
});

test("protocol-v2 runtime settings default and override reach the report", async () => {
  const defaults = createDispatcher({
    github: { async listTickets() { return []; }, async listClaims() { return []; } },
    git: { async worktreeUsable() { return true; } },
    dsh: { isLive: () => false },
    stateStore: { async load() { return { schemaVersion: 1, tickets: {} }; }, async save() {}, async lock(fn) { return fn(); } },
    repoRoot: "/repo",
    worktreeRoot: "/tickets",
    baseSha: BASE,
    maxActive: 1,
  });
  const defaultReport = await defaults.status();
  assert.equal(defaultReport.runtime.heartbeatIntervalMs, 120_000);
  assert.equal(defaultReport.runtime.codexThinking, "max");

  const overridden = createDispatcher({
    github: { async listTickets() { return []; }, async listClaims() { return []; } },
    git: { async worktreeUsable() { return true; } },
    dsh: { isLive: () => false },
    stateStore: { async load() { return { schemaVersion: 1, tickets: {} }; }, async save() {}, async lock(fn) { return fn(); } },
    repoRoot: "/repo",
    worktreeRoot: "/tickets",
    baseSha: BASE,
    maxActive: 1,
    heartbeatIntervalMs: 7_500,
    codexThinking: "low",
  });
  const overrideReport = await overridden.status();
  assert.equal(overrideReport.runtime.heartbeatIntervalMs, 7_500);
  assert.equal(overrideReport.runtime.codexThinking, "low");
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
    tickets: [{ number: 7, state: "OPEN", url: "https://example.test/issues/7", milestone: "M1", body: "## Milestone\nM1\n\n## What to build\nwork\n", blockers: [], blockerStates: {} }],
    claims: [],
  }, null, 2));
  const worktrees = join(root, "worktrees");
  await mkdir(worktrees, { recursive: true });

  const created = [];
  const dsh = {
    isLive: () => false,
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
    sessionProbe: async () => true,
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
