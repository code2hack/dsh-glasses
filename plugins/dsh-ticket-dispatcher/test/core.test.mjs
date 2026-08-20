import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAIM_PREFIX,
  CLOSEOUT_PREFIX,
  DEFAULT_CODEX_THINKING,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MAX_ACTIVE,
  bindingNames,
  bootstrapPrompt,
  claimBody,
  classify,
  closeoutMarkerBody,
  collapseClaimMarkers,
  collapseCloseoutMarkers,
  derivePairNames,
  parseBlockers,
  parseClaim,
  parseCloseoutMarker,
  parseMilestone,
  stableReport,
  voidClaimBody,
} from "../lib/core.js";

test("blocker parser accepts issue and PR references only inside Blocked by", () => {
  assert.deepEqual(parseBlockers("## What to build\nSee #99\n\n## Blocked by\n- #4\n- https://github.com/x/y/pull/2\n- #4\n\n## Gate\nautonomous"), [2, 4]);
  assert.deepEqual(parseBlockers("## Blocked by\nNone"), []);
  assert.deepEqual(parseBlockers("no contract"), []);
});

test("milestone tokens are derived deterministically from the declared Milestone section", () => {
  assert.equal(parseMilestone("## Milestone\nM1\n\n## What to build\nx"), "M1");
  assert.equal(parseMilestone("## Milestone\nBootstrap / protocol-v2 transition"), "Bootstrap");
  assert.equal(parseMilestone("## Milestone\nWorkflow bootstrap — must complete here."), "Workflow");
  assert.equal(parseMilestone("## Milestone\nprotocol-v2_x.3"), "protocol-v2_x.3");
});

test("malformed or ambiguous Milestone sections are rejected rather than guessed", () => {
  assert.throws(() => parseMilestone("# no milestone section"), /missing or empty/);
  assert.throws(() => parseMilestone("## Milestone\n\n## What to build\nx"), /missing or empty/);
  assert.throws(() => parseMilestone("## Milestone\n---"), /no valid naming token/);
  assert.throws(() => parseMilestone(`## Milestone\n${"x".repeat(80)}`), /too long/);
});

test("pair names derive mechanically and reject bad tokens", () => {
  assert.deepEqual(derivePairNames({ project: "dsh-glasses", milestone: "M1", number: 17 }), {
    dshName: "dsh-glasses-M1-#17-DSH",
    codexName: "dsh-glasses-M1-#17-Codex",
  });
  assert.deepEqual(derivePairNames({ project: "dsh-glasses", milestone: "Bootstrap", number: 19 }), {
    dshName: "dsh-glasses-Bootstrap-#19-DSH",
    codexName: "dsh-glasses-Bootstrap-#19-Codex",
  });
  assert.throws(() => derivePairNames({ project: "dsh-glasses", milestone: "", number: 1 }), /invalid milestone/);
  assert.throws(() => derivePairNames({ project: "dsh-glasses", milestone: "M1", number: "x" }), /invalid ticket number/);
});

test("default protocol-v2 runtime settings are heartbeat 120s and Codex thinking MAX", () => {
  assert.equal(DEFAULT_HEARTBEAT_INTERVAL_MS, 120_000);
  assert.equal(DEFAULT_CODEX_THINKING, "max");
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
  const binding = {
    number: 15,
    milestone: "M1",
    dshName: "dsh-glasses-M1-#15-DSH",
    codexName: "dsh-glasses-M1-#15-Codex",
    codex: { threadId: "thread-x", thinkingEffort: "max", firstPrompt: "dsh-glasses-M1-#15-Codex" },
    sessionId: "session-one",
    ...names,
    baseSha: "71059429be3d6f95ef9625adf5dea52db2cd51d2",
  };
  const body = claimBody(binding);
  assert.ok(body.startsWith(`${CLAIM_PREFIX} `));
  const claim = parseClaim(body);
  assert.equal(claim.number, 15);
  assert.equal(claim.sessionId, "session-one");
  assert.equal(claim.milestone, "M1");
  assert.equal(claim.dshName, "dsh-glasses-M1-#15-DSH");
  assert.equal(claim.codexName, "dsh-glasses-M1-#15-Codex");
  assert.deepEqual(claim.codex, { threadId: "thread-x", thinkingEffort: "max" });
  const prompt = bootstrapPrompt({ number: 15, milestone: "M1", url: "https://github.com/code2hack/dsh-glasses/issues/15", ...binding });
  assert.match(prompt, /Read AGENTS\.md/);
  assert.match(prompt, /issues\/15/);
  assert.match(prompt, new RegExp(binding.baseSha));
  assert.match(prompt, /dsh-glasses-M1-#15-Codex/);
  assert.match(prompt, /ChatGPT session = CTO/);
  assert.match(prompt, /mcp-chatgpt/);
  // Current-protocol mandates the dispatcher bootstrap must carry (AGENTS.md):
  // startup planning to ChatGPT before first production edit + mandatory dual
  // ChatGPT/Codex escalation on hard problems.
  assert.match(prompt, /before your FIRST production edit/);
  assert.match(prompt, /plan` request to ChatGPT/);
  assert.match(prompt, /MANDATORY hard-problem escalation/);
  assert.match(prompt, /BOTH ChatGPT and Codex/);
  assert.match(prompt, /dispatcher-closeout/);
});

test("claim tombstones suppress only their matching durable session", () => {
  const first = { number: 15, sessionId: "session-one", branch: "b", worktree: "w", baseSha: "a".repeat(40) };
  const second = { ...first, sessionId: "session-two" };
  assert.deepEqual(collapseClaimMarkers([claimBody(first), voidClaimBody(first, "stale-session")]), [
    { number: 15, sessionId: "session-one", status: "void", reason: "stale-session" },
  ]);
  assert.equal(collapseClaimMarkers([claimBody(first), claimBody(second), voidClaimBody(first, "stale-session")])[0].sessionId, "session-two");
});

test("closeout markers are the durable completion signal and suppress re-admission", () => {
  const binding = { number: 19, milestone: "Bootstrap", dshName: "dsh-glasses-Bootstrap-#19-DSH", codexName: "dsh-glasses-Bootstrap-#19-Codex", codex: { threadId: "thread-c" } };
  const body = closeoutMarkerBody(binding, { headSha: "a".repeat(40), pr: 21, dshName: binding.dshName, codexName: binding.codexName });
  assert.ok(body.startsWith(`${CLOSEOUT_PREFIX} `));
  const marker = parseCloseoutMarker(body);
  assert.equal(marker.number, 19);
  assert.equal(marker.status, "completed");
  assert.equal(marker.headSha, "a".repeat(40));
  assert.equal(marker.codexThreadId, "thread-c");
  assert.deepEqual(collapseCloseoutMarkers([body, closeoutMarkerBody(binding)]).map((m) => m.number), [19]);

  const tickets = [{ number: 19, state: "OPEN", blockers: [] }];
  const bindings = { 19: { number: 19, status: "completed", sessionId: "session-19" } };
  const view = classify(tickets, bindings, 3);
  assert.deepEqual(view.completed, [bindings[19]]);
  assert.deepEqual(view.ready, []);
  assert.deepEqual(view.running, []);
  assert.deepEqual(view.admitted, []);
});

test("completed bindings never re-enter the ready frontier or consume capacity", () => {
  const tickets = [
    { number: 1, state: "OPEN", blockers: [] },
    { number: 2, state: "OPEN", blockers: [] },
  ];
  const bindings = { 1: { number: 1, status: "completed", sessionId: "s1" } };
  const view = classify(tickets, bindings, 1);
  assert.deepEqual(view.running, []);
  assert.deepEqual(view.admitted, [{ number: 2 }]);
  assert.deepEqual(view.completed.map((b) => b.number), [1]);
});
