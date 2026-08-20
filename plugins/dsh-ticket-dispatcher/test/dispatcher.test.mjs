import assert from "node:assert/strict";
import test from "node:test";
import { createDispatcher } from "../lib/dispatcher.js";
import { claimBody, collapseClaimMarkers, voidClaimBody } from "../lib/core.js";

const BASE = "71059429be3d6f95ef9625adf5dea52db2cd51d2";
const NEXT = "e3f6cdbfe49cc295753859e3c7b600785885aa45";
const defaultTickets = () => [1, 2, 3, 4].map((number) => ({ number, state: "OPEN", blockers: number === 4 ? [3] : [], url: `https://example.test/issues/${number}` }));

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
  } = options;
  let state = structuredClone(initialState ?? { schemaVersion: 1, tickets: {} });
  let saves = 0;
  let refSha = options.refSha ?? BASE;
  const live = new Set();
  const calls = [];
  const github = {
    async listTickets() { return structuredClone(records); },
    async listClaims() { return collapseClaimMarkers(durableClaims); },
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
    async worktreeExists(binding) { return sharedWorktrees.has(binding.worktree); },
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
    ...(options.wakeAgents ? { async wakeAgent(binding) { calls.push(`wake:${binding.number}`); } } : {}),
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
  const dispatcher = createDispatcher({
    github, git, dsh, stateStore, repoRoot: "/repo", worktreeRoot: "/tickets",
    baseSha, baseRef: "moving", fetch: false, maxActive,
    sessionProbe: async (binding) => sharedSessions.has(binding.sessionId),
    uuid: () => `uuid-${++id}`,
  });
  return {
    dispatcher, calls, durableClaims, live, records, sharedBranches, sharedSessions, sharedWorktrees,
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
  const records = [{ number: 1, state: "OPEN", blockers: [], url: "u1" }];
  const h = harness({ records, baseSha: "", refSha: BASE, maxActive: 2 });
  await h.dispatcher.reconcile();
  h.setRef(NEXT);
  records.push({ number: 2, state: "OPEN", blockers: [], url: "u2" });
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

test("missing worktree is recreated before the claimed session resumes", async () => {
  const binding = { number: 1, sessionId: "session-old", branch: "workflow/ticket-1", worktree: "/tickets/old", baseSha: BASE };
  const claims = [claimBody(binding)];
  const sessions = new Set([binding.sessionId]);
  const h = harness({ durableClaims: claims, sharedSessions: sessions, maxActive: 1 });
  const report = await h.dispatcher.reconcile();
  assert.equal(report.running[0].sessionId, binding.sessionId);
  assert.equal(report.running[0].recovered, "worktree");
  assert.equal(report.running[0].live, true);
  assert.deepEqual(h.calls.slice(0, 2), ["worktree:1", "resume:1"]);
});

test("missing persisted session is voided and becomes ready for a later pass", async () => {
  const binding = { number: 1, sessionId: "session-missing", branch: "workflow/ticket-1", worktree: "/tickets/old", baseSha: BASE };
  const claims = [claimBody(binding)];
  const h = harness({ durableClaims: claims, maxActive: 1 });
  const first = await h.dispatcher.reconcile();
  assert.deepEqual(first.running, []);
  assert.deepEqual(first.invalid, [{ number: 1, reason: "stale-session" }]);
  assert.equal(first.ready[0], 1);
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
