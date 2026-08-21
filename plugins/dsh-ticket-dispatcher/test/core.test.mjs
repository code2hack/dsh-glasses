import assert from "node:assert/strict";
import test from "node:test";
import { CLAIM_PREFIX, COMPLETE_PREFIX, DEFAULT_INTERVAL_MS, DEFAULT_MAX_ACTIVE, bindingNames, bootstrapPrompt, claimBody, classify, collapseClaimMarkers, collapseCompleteMarkers, completeBody, continuationPrompt, dshName, parseBlockers, parseClaim, parseCompleteMarker, parseMilestone, stableReport, voidClaimBody } from "../lib/core.js";

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
  const bindings = { 1: { number: 1, status: "claimed", sessionId: "dsh-glasses-M1-#1-DSH", name: "dsh-glasses-M1-#1-DSH", branch: "b", worktree: "w", baseSha: "a" } };
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

test("closed claimed Tickets release active capacity for successors; completed bindings are never re-admitted", () => {
  const tickets = [
    { number: 1, state: "CLOSED", blockers: [] },
    { number: 2, state: "OPEN", blockers: [1] },
    { number: 5, state: "OPEN", blockers: [] },
  ];
  const bindings = {
    1: { number: 1, status: "claimed", sessionId: "s1" },
    5: { number: 5, status: "complete", sessionId: "dsh-glasses-M1-#5-DSH" },
  };
  const view = classify(tickets, bindings, 1);
  assert.deepEqual(view.running, []);
  assert.deepEqual(view.completed.map((x) => x.number), [5]);
  assert.deepEqual(view.admitted, [{ number: 2 }]);
});

test("Milestone parsing is deterministic and strictly validated", () => {
  assert.equal(parseMilestone("## Milestone\n\nM1\n\n## What to build\nx"), "M1");
  assert.equal(parseMilestone("## Milestone\nBootstrap\n## What to build\nx"), "Bootstrap");
  assert.equal(parseMilestone("## Milestone\n\n<!-- anything -->\nM-2026-Q3\n\n## Gate\n"), "M-2026-Q3");
  assert.equal(parseMilestone("## Milestone\n\n<!--\nM-Commented\n-->\nM-2026-Q3\n\n## Gate\n"), "M-2026-Q3", "a multi-line HTML comment must not supply the milestone");
  assert.equal(parseMilestone("## Milestone\n\n<!--\nBootstrap\n-->\n\n## What to build\nx"), undefined, "commented-out metadata alone must not trigger admission");
  assert.equal(parseMilestone("## Milestone\n\n## What to build\nx"), undefined);
  assert.equal(parseMilestone("## Milestone\nmilestone with spaces\n"), undefined);
  assert.equal(parseMilestone("no milestone section"), undefined);
});

test("DSH identity is exactly <project>-<milestone>-#<ticket>-DSH and invalid parts are rejected", () => {
  assert.equal(dshName({ project: "dsh-glasses", milestone: "Bootstrap", number: 19 }), "dsh-glasses-Bootstrap-#19-DSH");
  assert.equal(dshName({ project: "dsh-glasses", milestone: "M1", number: 2 }), "dsh-glasses-M1-#2-DSH");
  assert.throws(() => dshName({ milestone: "M 1", number: 1 }), /invalid milestone/);
  assert.throws(() => dshName({ milestone: "M1", number: 0 }), /invalid ticket number/);
});

test("binding, claim, and completion identities are deterministic and reconstructable", () => {
  const names = bindingNames({ number: 15, baseSha: "71059429be3d6f95ef9625adf5dea52db2cd51d2", repoRoot: "/repo" });
  assert.deepEqual(names, { branch: "workflow/ticket-15", worktree: "/dsh-glasses-tickets/ticket-15-71059429be3d" });
  const binding = { number: 15, name: "dsh-glasses-M1-#15-DSH", sessionId: "dsh-glasses-M1-#15-DSH", ...names, baseSha: "71059429be3d6f95ef9625adf5dea52db2cd51d2" };
  const body = claimBody(binding);
  assert.ok(body.startsWith(`${CLAIM_PREFIX} `));
  const parsed = parseClaim(body);
  assert.equal(parsed.sessionId, "dsh-glasses-M1-#15-DSH");
  assert.equal(parsed.name, "dsh-glasses-M1-#15-DSH");
  assert.equal(parsed.number, 15);

  const done = completeBody(binding, { head: "abcd".repeat(10), pr: "https://example.test/pr/1" });
  assert.ok(done.startsWith(`${COMPLETE_PREFIX} `));
  const marker = parseCompleteMarker(done);
  assert.equal(marker.number, 15);
  assert.equal(marker.sessionId, binding.sessionId);
  assert.equal(marker.head, "abcd".repeat(10));
});

test("claim tombstones suppress only their matching durable session", () => {
  const first = { number: 15, name: "dsh-glasses-M1-#15-DSH", sessionId: "dsh-glasses-M1-#15-DSH", branch: "b", worktree: "w", baseSha: "a".repeat(40) };
  const second = { ...first, sessionId: "revision-session" };
  assert.deepEqual(collapseClaimMarkers([claimBody(first), voidClaimBody(first, "stale-session")]), [
    { number: 15, sessionId: first.sessionId, name: first.name, status: "void", reason: "stale-session" },
  ]);
  assert.equal(collapseClaimMarkers([claimBody(first), claimBody(second), voidClaimBody(first, "stale-session")])[0].sessionId, "revision-session");
  assert.deepEqual(collapseCompleteMarkers([completeBody(first, {}), "irrelevant", completeBody(first, { head: "c".repeat(40) })]), [
    { number: 15, sessionId: first.sessionId, head: "c".repeat(40), pr: "", status: "complete" },
  ]);
});

test("generated bootstrap names the exact DSH identity and required protocol", () => {
  const binding = {
    number: 19,
    milestone: "Bootstrap",
    name: "dsh-glasses-Bootstrap-#19-DSH",
    url: "https://github.com/code2hack/dsh-glasses/issues/19",
    baseSha: "71059429be3d6f95ef9625adf5dea52db2cd51d2",
    branch: "workflow/ticket-19",
    worktree: "/tickets/ticket-19-71059429be3d",
  };
  const prompt = bootstrapPrompt(binding);
  assert.match(prompt, /dsh-glasses-Bootstrap-#19-DSH/);
  assert.match(prompt, /issues\/19/);
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, new RegExp(binding.baseSha));
  assert.match(prompt, /subagent_codex/);
});

test("generated bootstrap requires the exact ChatGPT endpoint, plan-before-edit, strict sequential helper chain (escalation-only Codex), and availability fallback", () => {
  const prompt = bootstrapPrompt({ number: 3, milestone: "M1", name: "dsh-glasses-M1-#3-DSH", url: "https://github.com/code2hack/dsh-glasses/issues/3", baseSha: "a".repeat(40), branch: "workflow/ticket-3", worktree: "/w/ticket-3" });
  assert.match(prompt, /mcp-chatgpt/);
  assert.match(prompt, /ChatGPT project = dsh-glasses/);
  assert.match(prompt, /ChatGPT session = CTO/);
  assert.match(prompt, /one bounded attempt to ask ChatGPT/i);
  assert.match(prompt, /before the first production edit|Before the first production edit/);
  assert.match(prompt, /UNAVAILABLE/);
  assert.match(prompt, /UNPASSED|REQUEST_CHANGES/);
  assert.match(prompt, /inspect\/reason\/report only/);
  assert.match(prompt, /do not modify the Ticket worktree/);
  assert.match(prompt, /fresh one-shot/);
});

test("generated bootstrap distinguishes UNAVAILABLE from blocking technical verdicts and forbids deadlock", () => {
  const prompt = bootstrapPrompt({ number: 4, milestone: "M1", name: "dsh-glasses-M1-#4-DSH", url: "https://github.com/code2hack/dsh-glasses/issues/4", baseSha: "a".repeat(40), branch: "workflow/ticket-4", worktree: "/w/ticket-4" });
  assert.match(prompt, /is NOT unavailability and must be addressed/);
  assert.match(prompt, /must not deadlock the Ticket/);
  assert.match(prompt, /must not wait indefinitely/);
  assert.match(prompt, /DSH MUST continue until/);
});

test("continuation prompt is minimal and names the same DSH identity", () => {
  const prompt = continuationPrompt({ number: 19, name: "dsh-glasses-Bootstrap-#19-DSH" });
  assert.match(prompt, /Continue Ticket #19/);
  assert.match(prompt, /dsh-glasses-Bootstrap-#19-DSH/);
  assert.match(prompt, /TicketComplete/);
  assert.equal(prompt.includes("Bootstrap exactly"), false);
});

test("report exposes DSH identity, heartbeat, and no Codex lifecycle fields", () => {
  const ticket = { number: 2, state: "OPEN", blockers: [] };
  const bindings = { 2: { number: 2, status: "claimed", name: "dsh-glasses-M1-#2-DSH", sessionId: "dsh-glasses-M1-#2-DSH", branch: "b", worktree: "w", baseSha: "a".repeat(40) } };
  const view = classify([ticket], bindings, 3);
  const report = stableReport(view, {}, { heartbeatMs: 120000 });
  assert.equal(report.heartbeatMs, 120000);
  assert.equal(report.running[0].name, "dsh-glasses-M1-#2-DSH");
  assert.deepEqual(Object.keys(report).sort(), [
    "activeLimit", "blocked", "capacityLimited", "completed", "heartbeatMs", "invalid", "invalidMilestone", "ready", "resolutionError", "resources", "running", "schemaVersion",
  ]);
});

test("the configured heartbeat default is exactly 120 seconds", () => {
  assert.equal(DEFAULT_INTERVAL_MS, 120_000);
});


test("a completion marker is authoritative only with an exact 40-hex head SHA and must not retire a session with a malformed head", () => {
  const binding = { number: 15, name: "dsh-glasses-M1-#15-DSH", sessionId: "dsh-glasses-M1-#15-DSH", branch: "b", worktree: "w", baseSha: "a".repeat(40) };
  const valid = completeBody(binding, { head: "a".repeat(40), pr: "https://example.test/pr/15" });
  assert.equal(parseCompleteMarker(valid)?.head, "a".repeat(40));
  // missing head, non-hex head, and short heads are all rejected: the marker
  // parse returns undefined so the dispatcher never retires the binding on it.
  for (const bad of [
    `${COMPLETE_PREFIX} ${JSON.stringify({ schemaVersion: 1, ticket: 15, sessionId: binding.sessionId })}`,
    `${COMPLETE_PREFIX} ${JSON.stringify({ schemaVersion: 1, ticket: 15, sessionId: binding.sessionId, head: "h".repeat(40) })}`,
    `${COMPLETE_PREFIX} ${JSON.stringify({ schemaVersion: 1, ticket: 15, sessionId: binding.sessionId, head: "abc123" })}`,
    `${COMPLETE_PREFIX} ${JSON.stringify({ schemaVersion: 1, ticket: 15, sessionId: binding.sessionId, head: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEF" })}`,
  ]) {
    assert.equal(parseCompleteMarker(bad), undefined, `malformed marker must be ignored: ${bad}`);
  }
  assert.deepEqual(collapseCompleteMarkers([valid, `${COMPLETE_PREFIX} not-json-at-all`]), [
    { number: 15, sessionId: binding.sessionId, head: "a".repeat(40), pr: "https://example.test/pr/15", status: "complete" },
  ]);
});

// ── Sequential-helper protocol (fe547f22 workflow delta) ─────────────────────

test("generated bootstrap encodes the strict sequential helper contract (ChatGPT first, Codex escalation only, no parallel, per-item checkpoints, final-review routing)", () => {
  const prompt = bootstrapPrompt({ number: 21, milestone: "M1", name: "dsh-glasses-M1-#21-DSH", url: "https://github.com/code2hack/dsh-glasses/issues/21", baseSha: "c".repeat(40), branch: "workflow/ticket-21", worktree: "/w/ticket-21" });
  // First-line / no-parallel
  assert.match(prompt, /ChatGPT FIRST/);
  assert.match(prompt, /NEVER requested in parallel/);
  assert.match(prompt, /fresh native Codex subagent as escalation/);
  // Helper-produced detailed ordered plan + to-do before first edit
  assert.match(prompt, /DETAILED ORDERED implementation\+validation plan with a checkable to-do list/);
  assert.match(prompt, /before the first production edit/);
  assert.match(prompt, /make ONE bounded attempt to ask ChatGPT/);
  // Codex only if ChatGPT unavailable; self-plan only if both unavailable
  assert.match(prompt, /If ChatGPT is objectively UNAVAILABLE, ask a fresh native Codex subagent/);
  assert.match(prompt, /DSH may produce its own plan ONLY if BOTH helpers are unavailable/);
  // Mandatory per-item progress checkpoints (with fields) routed ChatGPT-first
  assert.match(prompt, /after EVERY completed to-do item, send a progress checkpoint/);
  assert.match(prompt, /identifying the ticket, todo-item, status, head, result, validation, evidence, and the next item/);
  assert.match(prompt, /Route every checkpoint ChatGPT-first/);
  // One complete loop definition + three-loop escalation + return to ChatGPT-first
  assert.match(prompt, /One complete ChatGPT loop is:/);
  assert.match(prompt, /After exactly THREE unsuccessful ChatGPT loops on the same chain/);
  assert.match(prompt, /instead of starting a fourth ChatGPT loop for that chain/);
  assert.match(prompt, /once the escalated chain resolves, ordinary interactions return to ChatGPT-first/);
  // Hard-problem ChatGPT-first
  assert.match(prompt, /Hard problems: ask ChatGPT FIRST/);
  // Final review: ChatGPT-first, PASS suppresses Codex, unavailability escalates, third loop escalates
  assert.match(prompt, /ask ChatGPT to review the exact head/);
  assert.match(prompt, /the reviewer gate is satisfied — do NOT invoke Codex/);
  assert.match(prompt, /If ChatGPT is unavailable, ask a fresh Codex subagent for the exact-head review/);
  assert.match(prompt, /after the third unsuccessful ChatGPT review loop, escalate the exact candidate to fresh Codex/);
  assert.match(prompt, /both helpers are unavailable, you may complete only when every non-review acceptance requirement passes and no unresolved known blocking finding remains/);
  // Blocking is not UNAVAILABLE
  assert.match(prompt, /is NOT unavailability and must be addressed/);
  // Codex fresh/self-contained/non-mutating
  assert.match(prompt, /fresh one-shot native DSH subagent/);
  assert.match(prompt, /never this DSH conversation history/);
  assert.match(prompt, /inspect\/reason\/report only; do not modify the Ticket worktree/);
  assert.match(prompt, /the dispatcher stores no Codex lifecycle state/);
});

test("generated bootstrap no longer contains any dual-helper instruction", () => {
  const prompt = bootstrapPrompt({ number: 22, milestone: "Bootstrap", name: "dsh-glasses-Bootstrap-#22-DSH", url: "u22", baseSha: "d".repeat(40), branch: "b", worktree: "w" });
  for (const stale of ["attempt it against BOTH", "Two PASSes are preferred", "PASS + UNAVAILABLE, UNAVAILABLE + PASS", "best-effort redundant helpers", "redundant helpers", "use both results if both respond"]) {
    assert.equal(prompt.includes(stale), false, `stale dual-helper wording must be gone: ${stale}`);
  }
});

test("continuation prompt instructs re-checking current durable authority + active plan/checkpoint state and the strict chain", () => {
  const c = continuationPrompt({ number: 19, name: "dsh-glasses-Bootstrap-#19-DSH" });
  assert.match(c, /Continue Ticket #19/);
  assert.match(c, /dsh-glasses-Bootstrap-#19-DSH/);
  assert.match(c, /Re-check the CURRENT durable AGENTS\.md and docs\/WORKFLOW\.md/);
  assert.match(c, /active helper-produced plan and your completed\/remaining to-do and checkpoint state/);
  assert.match(c, /STRICT sequential helper chain: ChatGPT FIRST/);
  assert.match(c, /Never request ChatGPT and Codex in parallel/);
  assert.match(c, /ChatGPT PASS -> no Codex/);
  assert.match(c, /TicketComplete/);
});
