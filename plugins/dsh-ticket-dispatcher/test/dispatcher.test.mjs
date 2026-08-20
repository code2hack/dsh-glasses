import assert from "node:assert/strict";
import test from "node:test";
import { createDispatcher } from "../lib/dispatcher.js";
import { claimBody, parseClaim } from "../lib/core.js";

const BASE = "71059429be3d6f95ef9625adf5dea52db2cd51d2";
const tickets = () => [1, 2, 3, 4].map((number) => ({ number, state: "OPEN", blockers: number === 4 ? [3] : [], url: `https://example.test/issues/${number}` }));

function harness({ fail, initialState, durableClaims = [], maxActive = 3 } = {}) {
  let state = structuredClone(initialState ?? { schemaVersion: 1, tickets: {} });
  let saves = 0;
  const worktrees = new Set();
  const sessions = new Set();
  const calls = [];
  const github = {
    async listTickets() { return tickets(); },
    async listClaims() { return durableClaims.map(parseClaim); },
    async writeClaim(binding) {
      calls.push(`claim:${binding.number}`);
      if (fail === "claim") throw new Error("claim fault");
      durableClaims.push(claimBody(binding));
    },
  };
  const git = {
    async createWorktree(binding) {
      calls.push(`worktree:${binding.number}`);
      if (fail === "worktree") throw new Error("worktree fault");
      worktrees.add(binding.worktree);
    },
    async removeWorktree(binding) { calls.push(`remove:${binding.number}`); worktrees.delete(binding.worktree); },
    async worktreeExists(binding) { return worktrees.has(binding.worktree); },
  };
  const dsh = {
    async createAgent(binding) {
      calls.push(`agent:${binding.number}`);
      if (fail === "agent") throw new Error("agent fault");
      sessions.add(binding.sessionId);
    },
    async disposeAgent(binding) { calls.push(`dispose:${binding.number}`); sessions.delete(binding.sessionId); },
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
  const dispatcher = createDispatcher({ github, git, dsh, stateStore, repoRoot: "/repo", worktreeRoot: "/tickets", baseSha: BASE, maxActive, uuid: () => `uuid-${++id}` });
  return { dispatcher, calls, durableClaims, sessions, state: () => structuredClone(state), worktrees };
}

test("one pass admits up to capacity and repeated reconcile is a strict spawn no-op", async () => {
  const h = harness({ maxActive: 2 });
  const first = await h.dispatcher.reconcile();
  assert.deepEqual(first.running.map((x) => x.number), [1, 2]);
  assert.deepEqual(first.capacityLimited, [3]);
  assert.deepEqual(first.blocked, [{ number: 4, blocking: [3] }]);
  assert.equal(h.sessions.size, 2);
  const creates = h.calls.filter((x) => x.startsWith("agent:")).length;
  await h.dispatcher.reconcile();
  assert.equal(h.calls.filter((x) => x.startsWith("agent:")).length, creates);
  assert.equal(h.durableClaims.length, 2);
});

for (const fault of ["worktree", "agent", "state", "claim"]) {
  test(`publication rollback at ${fault} is unclaimed and retryable`, async () => {
    const h = harness({ fail: fault, maxActive: 1 });
    await h.dispatcher.reconcile();
    assert.equal(h.durableClaims.length, 0);
    assert.equal(h.sessions.size, 0);
    assert.equal(h.worktrees.size, 0);
    assert.equal(h.state().tickets["1"].status, "failed");
  });
}

test("lost state reconstructs a durable claim and never duplicates its session", async () => {
  const claims = [];
  const first = harness({ durableClaims: claims, maxActive: 1 });
  await first.dispatcher.reconcile();
  const original = first.state().tickets["1"];

  const restarted = harness({ durableClaims: claims, maxActive: 1 });
  restarted.worktrees.add(original.worktree);
  const report = await restarted.dispatcher.reconcile();
  assert.equal(report.running[0].sessionId, original.sessionId);
  assert.equal(report.running[0].validWorktree, true);
  assert.equal(restarted.calls.some((x) => x === "agent:1"), false);
});

test("a pre-marker publishing crash retries instead of becoming a false claim", async () => {
  const initialState = {
    schemaVersion: 1,
    tickets: {
      1: {
        number: 1,
        status: "publishing",
        sessionId: "session-crashed",
        branch: "workflow/ticket-1",
        worktree: `/tickets/ticket-1-${BASE.slice(0, 12)}`,
        baseSha: BASE,
      },
    },
  };
  const h = harness({ initialState, maxActive: 1 });
  h.worktrees.add(initialState.tickets[1].worktree);
  const report = await h.dispatcher.reconcile();
  assert.equal(report.running[0].number, 1);
  assert.notEqual(report.running[0].sessionId, "session-crashed");
  assert.equal(h.durableClaims.length, 1);
});

test("closing a blocker makes its successor ready on a later pass", async () => {
  const h = harness({ maxActive: 4 });
  const before = await h.dispatcher.status();
  assert.deepEqual(before.blocked, [{ number: 4, blocking: [3] }]);
  const records = tickets();
  records.find((x) => x.number === 3).state = "CLOSED";
  h.dispatcher;
  const viewModule = await import("../lib/core.js");
  assert.deepEqual(viewModule.classify(records, {}, 4).ready.map((x) => x.number), [1, 2, 4]);
});
