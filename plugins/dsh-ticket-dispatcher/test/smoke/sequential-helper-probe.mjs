// Deterministic sequential-helper protocol engine for the #19 integration smoke.
//
// This probe is DISPOSABLE smoke-only code (never production dispatcher code).
// It implements exactly the helper-routing a compliant Ticket Lead must follow
// under AGENTS §§4–10 (fe547f22): a STRICT priority chain — ChatGPT FIRST,
// fresh native Codex subagent as escalation ONLY (objective UNAVAILABLE or the
// same chain surviving three unsuccessful ChatGPT loops), DSH alone only as
// last resort — with an observable helper event ledger so order, count, and
// non-overlap are asserted. ChatGPT is a scripted smoke-only stand-in
// (deterministic availability/verdicts); Codex is the REAL pinned native
// `subagent_codex` seam where a scenario escalates (unless the no-codex
// variant composes it away). The agent under test is the REAL conversational
// Ticket DSH session resolved through the production adapter.
//
// Completion is a byte-observable side effect (DONE file), written only when
// the protocol's gate is satisfied. Each scenario self-asserts its ledger
// invariants and prints `SQP PASS` (or fails loudly).

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const name = "sequential-helper-probe";
export const inject = ["tools"];

// apply() is deliberately NOT async (same pattern as the shipped dispatcher and
// the other probes) so loader.await() inside the body cannot self-deadlock.
export function apply(ctx, config) {
  probe(ctx, config).catch((error) => {
    console.error(
      "SQP ERROR " + (error instanceof Error ? error.stack || error.message : String(error))
    );
    ctx.get("appExit")?.(1);
  });
}

function textOf(result) {
  if (!result) return "";
  if (result.kind !== "foreground") return JSON.stringify(result);
  const blocks = Array.isArray(result.output) ? result.output : [];
  return blocks
    .map((block) => (block && block.type === "text" ? block.text : JSON.stringify(block)))
    .join("\n");
}

function verdictOf(raw) {
  // Blocking verdicts first: a real reviewer may legitimately write
  // "REQUEST_CHANGES: validation does not PASS" -- that is a REQUEST_CHANGES,
  // not a PASS, and must never be swallowed by a naive PASS-first match.
  if (/\bREQUEST_CHANGES\b/i.test(raw)) return "REQUEST_CHANGES";
  if (/\bPASS\b|APPROVED/i.test(raw)) return "PASS";
  return "OTHER";
}

const REQUIRE = "SQ-GATE-PASSED";

// Shared final-review carve-out: after the probe commits the candidate per the
// exact-head protocol, the ONLY legitimate working-tree delta is the DONE file.
const carve = " and that the ONLY possible uncommitted delta is an empty DONE file (its absence until the gate is written is perfectly fine; release-note.txt is committed with the candidate head and must contain EXACTLY the gate string). There must be no other uncommitted or staged-but-uncommitted candidate edits. Start with a verdict line: PASS or REQUEST_CHANGES, then one sentence.";

// Production fidelity: a final exact-head review reviews the COMMITTED/PUSHED
// candidate, not the dirty working tree. The probe therefore commits the
// acceptance-ready release-note.txt before any real final-head Codex review.
function commitCandidate(worktree, number) {
  // Only commit when the candidate file actually changed since the last
  // commit; repeated scenario runs on a shared worktree must not fail with
  // "nothing to commit" nor spam empty commits.
  const changed = execFileSync("git", ["status", "--porcelain", "--", "release-note.txt"], { cwd: worktree, encoding: "utf8" }).trim();
  if (changed) {
    execFileSync("git", ["add", "release-note.txt"], { cwd: worktree, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "Ticket #" + number + ": sequential-helper acceptance candidate"], { cwd: worktree, stdio: "pipe" });
  }
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
}

async function codex(ctx, agent, label, task) {
  // Bounded, protocol-plausible robustness: an objective execution failure of
  // the native Codex seam (transport/tool/app-server error — notably
  // `collab spawn failed`) is UNAVAILABLE, not a verdict. Retry as a fresh
  // one-shot invocation up to 3 times with backoff (fresh threads each time)
  // before recording UNAVAILABLE.
  const attempts = 4;
  const capMs = 100_000;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const tool = ctx.tools.get("subagent_codex", agent);
    if (!tool) { console.log("SQP event codex kind=" + label + " attempt=" + attempt + " tool=absent verdict=UNAVAILABLE"); return { verdict: "UNAVAILABLE", raw: "", kind: label }; }
    const started = Date.now();
    let guard;
    try {
      const result = await Promise.race([
        tool.execute(
          { description: "SQ " + label, prompt: task },
          { agent, signal: new AbortController().signal }
        ),
        new Promise((_, reject) => {
          guard = setTimeout(() => reject(new Error("SQ codex timeout")), capMs);
        }),
      ]);
      clearTimeout(guard);
      const raw = textOf(result);
      const verdict = verdictOf(raw);
      console.log(
        "SQP event codex kind=" + label +
        " attempt=" + attempt +
        " ms=" + (Date.now() - started) +
        " verdict=" + verdict +
        " head=" + String(raw).slice(0, 180).replace(/[\r\n]+/g, " ")
      );
      return { verdict, raw, kind: label };
    } catch (error) {
      clearTimeout(guard);
      console.error("SQP codex error kind=" + label + " attempt=" + attempt + " error=" + String(error));
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
  console.log("SQP event codex kind=" + label + " verdict=UNAVAILABLE after " + attempts + " attempts");
  return { verdict: "UNAVAILABLE", raw: "codex unavailable after bounded retries", kind: label };
}

// ── Scripted ChatGPT stand-in (disposable, deterministic) ────────────────────
const CHECKPOINT_FIELDS = ["ticket:", "todo-item:", "status:", "head:", "result:", "validation:", "evidence:", "next:"];
const REVIEW_HEAD_RE = /candidate committed head [0-9a-f]{40}/;
const REVIEW_TOKEN_RE = /preparation-token \d+/;
function verifyReviewTask(task) {
  if (typeof task !== "string" || !REVIEW_HEAD_RE.test(task) || !REVIEW_TOKEN_RE.test(task))
    throw new Error("a final-review request must name an EXACTLY-once-prepared committed candidate head and its per-request preparation token");
}

function chatScript(ctx, agent, label, profile, loop, gateMet, task) {
  const kind = profile.chat[label];
  if (kind === "unavailable") {
    console.log("SQP event chatgpt kind=" + label + " verdict=UNAVAILABLE loop=" + loop);
    return { verdict: "UNAVAILABLE", raw: "" };
  }
  if (kind === "pass") {
    if (label === "review-final") verifyReviewTask(task);
    console.log("SQP event chatgpt kind=" + label + " verdict=PASS loop=" + loop);
    return { verdict: "PASS", raw: "PASS" };
  }
  if (kind === "plan") {
    console.log("SQP event chatgpt kind=" + label + " verdict=ok loop=0");
    return { verdict: "ok", plan: ["item A (implementation)", "item B (validation)"] };
  }
  if (kind === "nonpass-n") {
    if (label === "review-final") verifyReviewTask(task);
    const non = Number(profile.chat[label + "-count"] || 1);
    const rc = loop < non;
    console.log(
      "SQP event chatgpt kind=" + label +
      " verdict=" + (rc ? "REQUEST_CHANGES" : "PASS") + " loop=" + loop
    );
    return rc
      ? { verdict: "REQUEST_CHANGES", raw: "REQUEST_CHANGES " + REQUIRE }
      : { verdict: "PASS", raw: "PASS" };
  }
  if (kind === "gate") {
    if (label === "review-final") verifyReviewTask(task);
    const verdict = gateMet ? "PASS" : "REQUEST_CHANGES";
    console.log("SQP event chatgpt kind=" + label + " verdict=" + verdict + " loop=" + loop);
    return verdict === "PASS"
      ? { verdict: "PASS", raw: "PASS" }
      : { verdict: "REQUEST_CHANGES", raw: "REQUEST_CHANGES " + REQUIRE };
  }
  if (label === "checkpoint" && typeof task === "string") {
    // Protocol: a progress checkpoint MUST carry the full field set (ticket,
    // todo-item, status, head, result, validation, evidence, next). The
    // scripted ChatGPT stands in as the first-line helper and verifies receipt.
    const missing = CHECKPOINT_FIELDS.filter((f) => !task.includes(f));
    if (missing.length)
      throw new Error("progress checkpoint to first-line helper missing fields: " + missing.join(", ") + " (task=" + JSON.stringify(task).slice(0, 240) + ")");
  }
  console.log("SQP event chatgpt kind=" + label + " verdict=ok loop=" + loop);
  return { verdict: "ok", raw: "ok" };
}

async function probe(ctx, config) {
  await ctx.get("loader")?.await();

  // Resolve through the PRODUCTION dispatcher dsh adapter exactly like the
  // other smoke probes: deterministic named session, composed default preset.
  const { createDshAdapter } = await import(process.env.SQ_DSH_LIB);
  const dsh = createDshAdapter(ctx);
  const binding = {
    number: config.number,
    name: config.sessionId,
    sessionId: config.sessionId,
    branch: config.branch,
    worktree: config.worktree,
    baseSha: config.baseSha,
  };
  if (!dsh.isLive(binding)) await dsh.resumeAgent(binding);
  const agents = ctx.get("agents");
  const entry = agents.get(binding.sessionId);
  if (!entry) throw new Error("live Ticket DSH session unavailable: " + binding.sessionId);
  const agent = entry.followup ? entry : entry.agent;
  if (!agent || typeof agent.followup !== "function")
    throw new Error("agent object has no followup() — composition broken");

  const scenario = process.env.SQ_SCENARIO || "unknown";
  const noCodex = process.env.SQ_NO_CODEX === "1";
  const worktree = binding.worktree;
  const donePath = join(worktree, "DONE");
  const notePath = join(worktree, "release-note.txt");
  const events = [];
  const codexCalls = [];
  const chatCalls = [];
  let escalationOutcome = "none";
  let planEscalationUnavailable = false;
  const record = (kind, helper, item) => events.push(kind + ":" + helper + (item ? ":" + item : ""));
  const note = () => {
    try { return readFileSync(notePath, "utf8"); } catch { return null; }
  };
  // Protocol: ChatGPT and Codex are NEVER requested in parallel for the same
  // step. Mechanical assertion: every helper interaction goes through
  // guarded(), which fails the scenario if a second helper call starts while
  // another is still in flight (the probe structurally awaits each call, so
  // this trips only on a regression that introduces concurrency).
  let busy = null;
  const overlap = [];
  const guarded = async (label, fn) => {
    if (busy !== null) overlap.push(label + "-while-" + busy);
    busy = label;
    try { return await fn(); } finally { busy = null; }
  };
  const headShaOf = (w) => {
    try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: w, encoding: "utf8" }).trim(); }
    catch { return "(no git head)"; }
  };
  // Model of the DSH apply/fix+validate step of a COMPLETE helper loop: after a
  // technical non-PASS verdict the DSH applies the finding, records it durably
  // (out-of-worktree so the committed exact-head candidate stays pristine), and
  // validates; only then may the next loop/request proceed.
  let applies = 0;
  const applyFinding = (chain, loop) => {
    applies += 1;
    const marker = join(worktree, "..", ".sq-applied-" + chain + ".log");
    try {
      const prev = existsSync(marker) ? readFileSync(marker, "utf8") : "";
      writeFileSync(marker, prev + "applied chain=" + chain + " loop=" + loop + "\n");
    } catch {}
    record("apply", "dsh", chain + "-" + String(loop));
    console.log("SQP event apply chain=" + chain + " loop=" + loop + " count=" + applies);
  };
  // Completed-item checkpoint: authority requires status = completed and an
  // exact head (SHA + working-tree state), not a placeholder/in_progress row.
  const checkpointTask = (item) => [
    "PROGRESS CHECKPOINT for Ticket #" + config.number,
    "ticket: #" + config.number,
    "todo-item: " + JSON.stringify(item),
    "status: completed",
    "head: " + headShaOf(worktree) + " (worktree state: candidate release-note.txt + DONE, permitted)",
    "result: completed " + JSON.stringify(item),
    "validation: scenario gate + probe ledger",
    "evidence: release-note.txt candidate",
    "next: continue remaining items, then final review",
    "The ONLY permitted uncommitted paths are release-note.txt and DONE; ignore those. " +
      "Inspect/reason/report only; do not modify the Ticket worktree.",
  ].join(" ");
  const setAcceptanceReady = () => writeFileSync(notePath, REQUIRE);
  const gateMet = () => note() !== null && String(note()).trim() === REQUIRE;

  // Scenario profiles. profile.chat.<label> is "plan" | "pass" | "ok" |
  // "unavailable" | "nonpass-n" | "gate"; "<label>-count" tunes loops.
  const profiles = {
    "plan-chatgpt-ok": {
      chat: { plan: "plan", checkpoint: "ok", "review-final": "pass" },
      expectFinal: "chatgpt-pass", codexZero: true,
    },
    "plan-codex-escalation": {
      chat: { plan: "unavailable", checkpoint: "ok", "review-final": "pass" },
      planSource: "codex", expectFinal: "chatgpt-pass",
    },
    "checkpoint-unavail-codex": {
      chat: { plan: "plan", checkpoint: "unavailable", "review-final": "pass" },
      planSource: "chatgpt", expectFinal: "chatgpt-pass",
      checkpointEscalationCodex: true, singlePlan: true,
    },
    "three-loops-chain": {
      chat: { plan: "plan", checkpoint: "ok", debug: "nonpass-n", "debug-count": "3", "review-final": "pass" },
      hardChain: true, expectFinal: "chatgpt-pass",
    },
    "final-chatgpt-pass": {
      chat: { plan: "plan", checkpoint: "ok", "review-final": "pass" },
      expectFinal: "chatgpt-pass", codexZero: true,
    },
    "final-chatgpt-unavail-codex": {
      chat: { plan: "plan", checkpoint: "ok", "review-final": "unavailable" },
      expectFinal: "codex", gateIndependent: true,
    },
    "final-three-loops-codex": {
      chat: { plan: "plan", checkpoint: "ok", "review-final": "nonpass-n", "review-final-count": "3" },
      expectFinal: "codex", gateIndependent: true,
    },
    "blocking-request-changes": {
      chat: { plan: "plan", checkpoint: "ok", "review-final": "gate" },
      gateBlock: true, expectFinal: "fix-gate",
    },
    "plan-both-down": {
      chat: { plan: "unavailable", checkpoint: "unavailable", "review-final": "unavailable" },
      planSource: "self", noCodex: true, gateIndependent: true, expectFinal: "independent",
    },
    "final-both-down": {
      chat: { plan: "plan", checkpoint: "ok", "review-final": "unavailable" },
      noCodex: true, gateIndependent: true, expectFinal: "independent",
    },
  };
  const profile = profiles[scenario];
  if (!profile) throw new Error("unknown SQ scenario: " + scenario);
  if (noCodex && !profile.noCodex)
    throw new Error("SQ_NO_CODEX=1 given for a codex-present scenario");

  // Deterministic baseline: the shared Ticket worktree must present ONLY the
  // probe-managed files. Discard any uncommitted edits or untracked strays a
  // prior phase left behind so each scenario reviews a pristine candidate.
  rmSync(donePath, { force: true });
  try { execFileSync("git", ["checkout", "--", "."], { cwd: worktree, stdio: "pipe" }); } catch {}
  // FULL deterministic baseline: discard every tracked modification AND remove
  // ALL untracked strays (e.g. the real agent's uncommitted evidence file from
  // the availability phase, which would otherwise look like a forbidden delta
  // to an exact-head native-Codex review). The probe owns release-note.txt and
  // DONE outright and rewrites them below, so nothing needed survives the clean.
  try { execFileSync("git", ["clean", "-fdq", "--", "."], { cwd: worktree, stdio: "pipe" }); } catch {}
  writeFileSync(notePath, "PLACEHOLDER-NOT-APPROVED");

  // ── PLAN (mandatory helper-produced ordered plan before edits) ───────────
  let plan = null;
  let planSource = "unknown";
  const planChat = await guarded("chatgpt-plan", async () => chatScript(ctx, agent, "plan", profile, 0, false));
  chatCalls.push(planChat);
  if (planChat.verdict === "ok" && planChat.plan) {
    plan = profile.singlePlan ? [planChat.plan[0]] : planChat.plan;
    planSource = "chatgpt";
  } else {
    record("plan", "unavailable", "-");
    if (!noCodex) {
      const planCodex = await guarded("codex-plan", () => codex(
        ctx, agent, "plan",
        "PLANNING: produce a concise ordered two-item implementation+validation to-do list that satisfies the gate string " + JSON.stringify(REQUIRE) + " in release-note.txt in worktree " + JSON.stringify(worktree) + " The ONLY permitted uncommitted paths are release-note.txt and DONE; ignore those. Inspect/reason/report only; do not modify the Ticket worktree. End your answer with the word PLANNED."
      ));
      codexCalls.push(planCodex);
      if (planCodex.verdict !== "UNAVAILABLE") {
        plan = ["item A (codex plan)", "item B (codex validate)"];
        planSource = "codex";
      } else {
        planEscalationUnavailable = true;
      }
    }
    if (!plan) {
      record("plan", "self", "-");
      plan = ["item A (self plan)", "item B (self validate)"];
      planSource = "self";
    }
  }
  record("plan", planSource, "-");
  console.log("SQP scenario=" + scenario + " plan_source=" + planSource + " no_codex=" + noCodex + " agent=" + agent.id);

  // ── EXECUTE each plan item; MANDATORY progress checkpoint after each ─────
  for (const item of plan) {
    const state = note() || "";
    writeFileSync(notePath, state + "\n-- done: " + item);
    const task = checkpointTask(item);
    const cp = await guarded("chatgpt-checkpoint", async () => chatScript(ctx, agent, "checkpoint", profile, 0, false, task));
    chatCalls.push(cp);
    if (cp.verdict === "UNAVAILABLE") {
      if (!noCodex) {
        // Same-chain escalation: the checkpoint helper call objectively
        // unavailable -> the SAME progress-checkpoint is routed to fresh Codex.
        // The REAL verdict is kept (never a synthetic success): a blocking
        // REQUEST_CHANGES fails the leg; both-helpers-unavailable is recorded
        // durably per protocol and the DSH continues.
        const cpx = await guarded("codex-checkpoint", () => codex(
          ctx, agent, "checkpoint:" + item, task
        ));
        codexCalls.push({ kind: "checkpoint", verdict: cpx.verdict });
        if (cpx.verdict === "REQUEST_CHANGES")
          throw new Error("escalated checkpoint returned REQUEST_CHANGES but the finding was not applied: " + JSON.stringify(item));
        if (cpx.verdict === "UNAVAILABLE") {
          record("checkpoint", "self", item); // both helpers unavailable: record durably, continue
        } else {
          record("checkpoint", "codex", item);
        }
      } else {
        record("checkpoint", "self", item); // both unavailable: record durably, continue
      }
    } else {
      record("checkpoint", "chatgpt", item);
    }
  }

  // ── HARD-PROBLEM CHAIN (three-loop escalation, scoped, then return) ──────
  if (profile.hardChain) {
    let loop = 0;
    let resolved = false;
    while (loop < 3 && !resolved) {
      const dbg = await guarded("chatgpt-debug", async () => chatScript(ctx, agent, "debug", profile, loop, false));
      chatCalls.push(dbg);
      record("debug-loop", "chatgpt", String(loop + 1));
      if (dbg.verdict === "PASS") { resolved = true; break; }
      // A COMPLETE loop ends only when the DSH has applied the finding and
      // validated it; only a still-non-passing result may start the next loop.
      applyFinding("hard-chain", loop);
      loop += 1;
    }
    if (!resolved) {
      // NO fourth ChatGPT loop: escalate the SAME chain to REAL fresh Codex.
      const dbgCodex = await guarded("codex-debug-escalate", () => codex(
        ctx, agent, "debug-escalate",
        "DEBUG/RESOLVE for Ticket #" + config.number + " worktree " + JSON.stringify(worktree) + ": inspect the current state and resolve the previously-unresolved hard problem (gate string " + JSON.stringify(REQUIRE) + ") The ONLY permitted uncommitted paths are release-note.txt and DONE; ignore those. Inspect/reason/report only; do not modify the Ticket worktree. End with PASS only if the gate is satisfiable, else REQUEST_CHANGES."
      ));
      codexCalls.push(dbgCodex);
      if (dbgCodex.verdict === "PASS") record("debug-resolved", "codex", "-");
      else if (dbgCodex.verdict === "UNAVAILABLE") record("debug-escalated-unavailable", "codex", "-");
      else {
        // A KNOWN blocking finding remains after escalation: the chain is NOT
        // resolved, so DONE must not be claimed.
        record("debug-escalated-blocking", "codex", "-");
        throw new Error("escalated Codex left the hard chain unresolved (REQUEST_CHANGES): a known blocking finding remains and DONE must not be claimed");
      }
    }
    // After the escalated chain resolves, ordinary interactions return to
    // ChatGPT-first (escalation is scoped to the unresolved chain only).
    const after = await guarded("chatgpt-checkpoint", async () => chatScript(ctx, agent, "checkpoint", profile, 0, true, checkpointTask("post-escalation resume")));
    chatCalls.push(after);
    if (after.verdict === "UNAVAILABLE") record("checkpoint", "self", "after-chain");
    else record("checkpoint", "chatgpt", "after-chain");
  }

  // ── FINAL REVIEW (sequential ChatGPT-first; exact-head protocol) ─────────
  let finalVerdict = "PENDING";
  // Exact-head semantics apply to EACH final-review request regardless of which
  // helper receives it: the acceptance-ready candidate is committed and its HEAD
  // identified BEFORE the request, and the request names that committed head.
  let lastReviewHead = null;
  let prepareCount = 0;
  let reviewRequests = 0;
  // ONE preparation immediately before EACH review request: commit the
  // candidate (no-op when unchanged), identify its HEAD, and mint a strictly
  // increasing per-request preparation token. The request that follows carries
  // both; the scripted receiver and the completion invariant prove exactly one
  // preparation per review request.
  const prepareFinalHead = () => {
    prepareCount += 1;
    const h = commitCandidate(worktree, config.number);
    lastReviewHead = h;
    console.log("SQP event commit head=" + h + " kind=final-review-candidate token=" + prepareCount);
    return { head: h, token: prepareCount };
  };
  const reviewTaskFor = (info, directive) =>
    "FINAL EXACT-HEAD REVIEW for Ticket #" + config.number +
    " candidate committed head " + info.head + " preparation-token " + info.token +
    " worktree " + JSON.stringify(worktree) + " " + directive;
  const bindRequest = () => { reviewRequests += 1; };
  if (profile.expectFinal === "fix-gate") {
    // Available reviewer's technical REQUEST_CHANGES is BLOCKING: candidate NOT
    // yet acceptance-ready -> REQUEST_CHANGES, NO DONE while it stands; then
    // DSH applies the finding (sets the exact gate), re-reviews, and completes.
    // The reviewer's technical verdict is requested against the committed HEAD
    // of the not-yet-approved candidate (exact-head semantics for every review).
    bindRequest();
    const g1 = prepareFinalHead();
    const rev1 = await guarded("chatgpt-review", async () => chatScript(ctx, agent, "review-final", profile, 0, gateMet(), reviewTaskFor(g1, "Verify release-note.txt at that committed head.")));
    chatCalls.push(rev1);
    if (rev1.verdict !== "REQUEST_CHANGES")
      throw new Error("blocking scenario: reviewer must first return REQUEST_CHANGES against the non-ready candidate");
    record("review-blocked", "chatgpt", "-");
    if (existsSync(donePath))
      throw new Error("blocking scenario: DONE must NOT exist while REQUEST_CHANGES stands");
    applyFinding("review-final", 0); // DSH applies the finding (writes the gate)
    setAcceptanceReady();
    // validate: the finding is applied and the gate now reads exactly REQUIRE
    if (!gateMet()) throw new Error("blocking scenario: apply step must bring the candidate to the required gate");
    // Re-commit the acceptance-ready candidate and identify its new HEAD before
    // the re-review (the earlier head was the not-yet-approved candidate).
    bindRequest();
    const g2 = prepareFinalHead();
    const rev2 = await guarded("chatgpt-review", async () => chatScript(ctx, agent, "review-final", profile, 1, true, reviewTaskFor(g2, "Verify release-note.txt at that committed head.")));
    chatCalls.push(rev2);
    if (rev2.verdict !== "PASS")
      throw new Error("blocking scenario: after applying the finding the reviewer must PASS");
    finalVerdict = "PASS";
  } else {
    // Acceptance-ready exact candidate pushed BEFORE any review request.
    setAcceptanceReady();
    if (profile.expectFinal === "chatgpt-pass" || profile.expectFinal === "independent") {
      // Exact-head protocol applies to the ChatGPT-first request too: one
      // preparation immediately before this request, token minted and carried.
      bindRequest();
      const head1 = prepareFinalHead();
      const rev = await guarded("chatgpt-review", async () => chatScript(ctx, agent, "review-final", profile, 0, true, reviewTaskFor(head1, "Verify release-note.txt at that committed head contains EXACTLY the gate string " + JSON.stringify(REQUIRE) + ".")));
      chatCalls.push(rev);
      if (rev.verdict === "PASS") finalVerdict = "PASS";
      else if (rev.verdict === "UNAVAILABLE" && !noCodex) {
        bindRequest();
        const head2 = prepareFinalHead();
        const revCodex = await guarded("codex-review", () => codex(
          ctx, agent, "review-final",
          reviewTaskFor(head2, "Verify release-note.txt at that committed head contains EXACTLY the gate string " + JSON.stringify(REQUIRE)) + carve + " Inspect/reason/report only; do not modify the Ticket worktree."
        ));
        codexCalls.push(revCodex);
        escalationOutcome = revCodex.verdict === "UNAVAILABLE" ? "unavailable" : "pass";
        finalVerdict = revCodex.verdict === "PASS" ? "PASS" : (revCodex.verdict === "UNAVAILABLE" && profile.gateIndependent ? "UNAVAILABLE" : "BLOCKED");
      } else {
        finalVerdict = rev.verdict === "UNAVAILABLE" ? "UNAVAILABLE" : "BLOCKED";
      }
    } else if (profile.expectFinal === "codex") {
      // Every ChatGPT loop request here is ALSO an exact-head review: one
      // preparation immediately before EACH request (fresh per-request token).
      const loopCount = Number(profile.chat["review-final-count"] || 3);
      let loop = 0;
      let nonPass = 0;
      while (loop < loopCount && nonPass < loopCount) {
        bindRequest();
        const hi = prepareFinalHead();
        const rev = await guarded("chatgpt-review", async () => chatScript(ctx, agent, "review-final", profile, loop, true, reviewTaskFor(hi, "Verify release-note.txt at that committed head contains EXACTLY the gate string " + JSON.stringify(REQUIRE) + ".")));
        chatCalls.push(rev);
        if (rev.verdict === "PASS") { finalVerdict = "PASS"; break; }
        if (rev.verdict === "UNAVAILABLE") break; // objective unavailability escalates NOW to fresh Codex
        // COMPLETE loop: apply the finding, validate, then (still non-passing)
        // request the next ChatGPT loop.
        applyFinding("review-final", loop);
        nonPass += 1;
        loop += 1;
      }
      if (finalVerdict !== "PASS") {
        // applies write only out-of-worktree markers, so the committed release-note
        // still reads exactly REQUIRE; one more preparation immediately before the
        // escalated exact-head review (no-op commit, fresh token).
        bindRequest();
        const headN = prepareFinalHead();
        const revCodex = await guarded("codex-review", () => codex(
          ctx, agent, "review-final",
          reviewTaskFor(headN, "Verify release-note.txt at that committed head contains EXACTLY " + JSON.stringify(REQUIRE)) + carve + " Inspect/reason/report only; do not modify the Ticket worktree."
        ));
        codexCalls.push(revCodex);
        escalationOutcome = revCodex.verdict === "UNAVAILABLE" ? "unavailable" : "pass";
        finalVerdict = revCodex.verdict === "PASS" ? "PASS" : (revCodex.verdict === "UNAVAILABLE" && profile.gateIndependent ? "UNAVAILABLE" : "BLOCKED");
      }
    }
  }
  record("review-final", finalVerdict, "-");

  // Never-parallel assertion: any helper call overlapping another fails the
  // scenario (ChatGPT and Codex are never requested in parallel for the same
  // planning/progress/debug/review step).
  if (overlap.length)
    throw new Error("helper calls overlapped concurrently: " + overlap.join("; ") + " -> ChatGPT and Codex must never be in flight at once");
  console.log("SQP event concurrency non_overlap=true max_concurrent=1");

  const independentComplete =
    profile.gateIndependent && finalVerdict === "UNAVAILABLE" && gateMet();
  if ((finalVerdict === "PASS" || independentComplete) && !lastReviewHead)
    throw new Error("exact-head final-review protocol violated: no committed candidate head was identified before the final review");
  if (finalVerdict === "PASS" || independentComplete) {
    if (reviewRequests < 1)
      throw new Error("exact-head final-review protocol: at least one review request must have been made");
    if (prepareCount !== reviewRequests)
      throw new Error("exact-head final-review protocol: every review request must be immediately preceded by exactly one candidate-head preparation; prepareCount=" + prepareCount + " reviewRequests=" + reviewRequests);
  }
  const done = finalVerdict === "PASS" || independentComplete;
  if (done) writeFileSync(donePath, "");
  console.log(
    "SQP scenario=" + scenario + " done=" + done + " final=" + finalVerdict +
    " plan=" + planSource + " codex_calls=" + codexCalls.length +
    " chat_calls=" + chatCalls.length +
    " escalation_outcome=" + escalationOutcome +
    " independent=" + (independentComplete ? "complete" : "no")
  );

  // ── Scenario invariants (self-asserted before SQP PASS) ──────────────────
  if (profile.expectFinal === "chatgpt-pass" && profile.codexZero && codexCalls.length !== 0)
    throw new Error("ChatGPT-first scenario with ChatGPT available must make ZERO Codex calls; saw " + codexCalls.length);
  if (scenario === "plan-codex-escalation") {
    if (planSource === "codex") { /* ideal: real Codex supplied the plan */ }
    else if (planSource === "self" && planEscalationUnavailable) { /* Codex objectively unavailable: self-plan fallback is protocol-correct */ }
    else throw new Error("plan must come from fresh Codex after ChatGPT planning UNAVAILABLE; planSource=" + planSource + " unavail=" + planEscalationUnavailable);
  }
  if (scenario === "plan-both-down" && planSource !== "self")
    throw new Error("both helpers unavailable -> DSH self-plan required");
  if (scenario === "checkpoint-unavail-codex") {
    const cpEsc = codexCalls.filter((c) => c && c.kind === "checkpoint").length;
    if (cpEsc !== 1)
      throw new Error("a progress checkpoint whose first-line helper call is objectively UNAVAILABLE must escalate that SAME checkpoint to fresh Codex exactly once (attempt recorded); saw " + cpEsc);
    if (codexCalls.length !== cpEsc)
      throw new Error("checkpoint escalation scenario: ONLY the checkpoint escalates (final review stays ChatGPT-first on PASS); codex_calls=" + codexCalls.length);
    const cpV = (codexCalls.find((c) => c && c.kind === "checkpoint") || {}).verdict;
    if (cpV === "REQUEST_CHANGES")
      throw new Error("escalated checkpoint's blocking finding must not be discarded/claimed as ok");
    if (!events.some((e) => e.startsWith("checkpoint:codex:") || e.startsWith("checkpoint:self:")))
      throw new Error("checkpoint->Codex escalation must be recorded in the ledger (codex verdict or both-unavailable durable record)");
  }
  if (scenario === "three-loops-chain") {
    const debugLoops = events.filter((e) => e.startsWith("debug-loop:chatgpt:")).length;
    if (debugLoops !== 3)
      throw new Error("hard chain must run EXACTLY 3 ChatGPT loops; saw " + debugLoops);
    if (applies !== 3)
      throw new Error("each of the 3 hard-chain loops must be COMPLETE (apply/fix+validate between loops); applies=" + applies);
    if (!events.some((e) => e.startsWith("apply:dsh:hard-chain-")))
      throw new Error("apply/fix steps after hard-chain REQUEST_CHANGES must be ledgered");
    if (events.filter((e) => e === "checkpoint:chatgpt:after-chain").length !== 1)
      throw new Error("after the escalated chain resolves, ordinary interactions must return to ChatGPT-first");
    if (!events.some((e) => e.startsWith("debug-resolved:codex") || e.startsWith("debug-escalated-unavailable:codex")))
      throw new Error("after 3 unsuccessful ChatGPT loops the SAME chain must escalate to fresh Codex and either resolve or record both-helper-unavailable");
  }
  if (scenario === "final-three-loops-codex") {
    const codexReviews = codexCalls.filter((c) => c && c.kind === "review-final").length;
    if (codexReviews !== 1)
      throw new Error("after 3 non-pass ChatGPT loops the final review must go to fresh Codex exactly once; saw " + codexReviews);
    if (applies !== 3)
      throw new Error("each of the 3 final-review loops must be COMPLETE (apply/fix+validate between loops); applies=" + applies);
  }
  if (scenario === "blocking-request-changes" && applies !== 1)
    throw new Error("the blocking fix must be modeled as one apply/fix+validate step; applies=" + applies);
  if (scenario === "blocking-request-changes") {
    if (!events.some((e) => e === "review-blocked:chatgpt:-"))
      throw new Error("the blocking REQUEST_CHANGES must have been observed (and DONE withheld) before completion");
  }
  if (scenario === "final-both-down" && (!independentComplete || finalVerdict !== "UNAVAILABLE"))
    throw new Error("both helpers unavailable at final review: independent completion only with the gate met; final=" + finalVerdict + " gate=" + gateMet());
  if (!done) throw new Error("scenario " + scenario + " did not reach DONE");

  console.log("SQP ledger=" + events.join("|"));
  console.log("SQP PASS scenario=" + scenario);
  // Deterministic process termination: the DSH app stays alive until the
  // composed probe asks it to stop (same pattern as the shipped probes).
  ctx.get("appExit")?.(0);
}
