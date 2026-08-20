import assert from "node:assert/strict";
import test from "node:test";
import { CLAIM_PREFIX, DEFAULT_MAX_ACTIVE, bindingNames, bootstrapPrompt, claimBody, classify, collapseClaimMarkers, parseBlockers, parseClaim, stableReport, voidClaimBody } from "../lib/core.js";

test("blocker parser accepts issue and PR references only inside Blocked by", () => {
  assert.deepEqual(parseBlockers("## What to build\nSee #99\n\n## Blocked by\n- #4\n- https://github.com/x/y/pull/2\n- #4\n\n## Gate\nautonomous"), [2, 4]);
  assert.deepEqual(parseBlockers("## Blocked by\nNone"), []);
  assert.deepEqual(parseBlockers("no contract"), []);
});

test("frontier is numeric, blocked transitions are mechanical, and capacity defaults to three", () => {
  const tickets = [
    { number: 9, state: "OPEN", blockers: [2] },
    { number: 4, state: "OPEN", blockers: [] },
    { number: 7, state: "OPEN", blockers: [] },
    { number: 2, state: "OPEN", blockers: [] },
    { number: 1, state: "CLOSED", blockers: [] },
  ];
  const initial = classify(tickets, {}, DEFAULT_MAX_ACTIVE);
  assert.deepEqual(initial.admitted.map((x) => x.number), [2, 4, 7]);
  assert.deepEqual(initial.capacityLimited.map((x) => x.number), []);
  assert.deepEqual(initial.blocked, [{ number: 9, blocking: [2] }]);

  tickets[3].state = "CLOSED";
  const transitioned = classify(tickets, {}, 2);
  assert.deepEqual(transitioned.admitted.map((x) => x.number), [4, 7]);
  assert.deepEqual(transitioned.capacityLimited.map((x) => x.number), [9]);
});

test("claimed Tickets consume capacity and scarce resources remain a separate view", () => {
  const tickets = [1, 2, 3].map((number) => ({ number, state: "OPEN", blockers: [] }));
  const bindings = { 1: { number: 1, status: "claimed", sessionId: "session-a", branch: "b", worktree: "w", baseSha: "a" } };
  const view = classify(tickets, bindings, 2);
  const report = stableReport(view, { awaitsResource: [{ number: 2, resource: "rokid" }] });
  assert.deepEqual(view.admitted, [{ number: 2 }]);
  assert.deepEqual(view.capacityLimited, [{ number: 3 }]);
  assert.deepEqual(report.resources.awaitsResource, [{ number: 2, resource: "rokid" }]);
  assert.deepEqual(view.blocked, []);
});

test("external issue or PR blocker state participates without becoming a dispatch candidate", () => {
  const ticket = { number: 15, state: "OPEN", blockers: [14], blockerStates: { 14: "OPEN" } };
  assert.deepEqual(classify([ticket], {}, 3).blocked, [{ number: 15, blocking: [14] }]);
  ticket.blockerStates[14] = "CLOSED";
  assert.deepEqual(classify([ticket], {}, 3).ready, [{ number: 15 }]);
});

test("closed claimed Tickets release active capacity for successors", () => {
  const tickets = [
    { number: 1, state: "CLOSED", blockers: [] },
    { number: 2, state: "OPEN", blockers: [1] },
  ];
  const bindings = { 1: { number: 1, status: "claimed", sessionId: "session-1" } };
  const view = classify(tickets, bindings, 1);
  assert.deepEqual(view.running, []);
  assert.deepEqual(view.admitted, [{ number: 2 }]);
});

test("binding, claim, and bootstrap identities are deterministic except session UUID", () => {
  const names = bindingNames({ number: 15, baseSha: "71059429be3d6f95ef9625adf5dea52db2cd51d2", repoRoot: "/repo" });
  assert.deepEqual(names, { branch: "workflow/ticket-15", worktree: "/dsh-glasses-tickets/ticket-15-71059429be3d" });
  const binding = { number: 15, sessionId: "session-one", ...names, baseSha: "71059429be3d6f95ef9625adf5dea52db2cd51d2" };
  const body = claimBody(binding);
  assert.ok(body.startsWith(`${CLAIM_PREFIX} `));
  assert.deepEqual(parseClaim(body), { schemaVersion: 1, ticket: 15, number: 15, sessionId: "session-one", ...names, baseSha: binding.baseSha, status: "claimed" });
  const prompt = bootstrapPrompt({ number: 15, url: "https://github.com/code2hack/dsh-glasses/issues/15", ...binding });
  assert.match(prompt, /AGENTS\.md section 3/);
  assert.match(prompt, /issues\/15/);
  assert.match(prompt, new RegExp(binding.baseSha));
});

test("claim tombstones suppress only their matching durable session", () => {
  const first = { number: 15, sessionId: "session-one", branch: "b", worktree: "w", baseSha: "a".repeat(40) };
  const second = { ...first, sessionId: "session-two" };
  assert.deepEqual(collapseClaimMarkers([claimBody(first), voidClaimBody(first, "stale-session")]), [
    { number: 15, sessionId: "session-one", status: "void", reason: "stale-session" },
  ]);
  assert.equal(collapseClaimMarkers([claimBody(first), claimBody(second), voidClaimBody(first, "stale-session")])[0].sessionId, "session-two");
});
