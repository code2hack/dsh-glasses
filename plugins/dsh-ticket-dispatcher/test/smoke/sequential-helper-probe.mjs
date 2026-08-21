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
  if (/\bPASS\b|APPROVED/i.test(raw)) return "PASS";
  if (/\bREQUEST_CHANGES\b/i.test(raw)) return "REQUEST_CHANGES";
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
const CHECKPOINT_FIELDS = ["todo-item:", "status:", "head:", "result:", "validation:", "evidence:", "next:"];

function chatScript(ctx, agent, label, profile, loop, gateMet, task) {
  const kind = profile.chat[label];
  if (kind === "unavailable") {
    console.log("SQP event chatgpt kind=" + label + " verdict=UNAVAILABLE loop=" + loop);
    return { verdict: "UNAVAILABLE", raw: "" };
  }
  if (kind === "pass") {
    console.log("SQP event chatgpt kind=" + label + " verdict=PASS loop=" + loop);
    return { verdict: "PASS", raw: "PASS" };
  }
  if (kind === "plan") {
    console.log("SQP event chatgpt kind=" + label + " verdict=ok loop=0");
    return { verdict: "ok", plan: ["item A (implementation)", "item B (validation)"] };
  }
  if (kind === "nonpass-n") {
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
  const checkpointTask = (item) => [
    "PROGRESS CHECKPOINT for Ticket #" + config.number,
    "todo-item: " + JSON.stringify(item),
    "status: in_progress",
    "head: " + worktree,
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
        // Same-chain escalation: the checkpooint helper call objectively
        // unavailable -> the SAME progress-checkpoint is routed to fresh Codex.
        await guarded("codex-checkpoint", () => codex(
          ctx, agent, "checkpoint:" + item, task
        ));
        codexCalls.push({ kind: "checkpoint", verdict: "ok" });
        record("checkpoint", "codex", item);
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
      else record("debug-escalated-blocking", "codex", "-");
    }
    // After the escalated chain resolves, ordinary interactions return to
    // ChatGPT-first (escalation is scoped to the unresolved chain only).
    const after = await guarded("chatgpt-checkpoint", async () => chatScript(ctx, agent, "checkpoint", profile, 0, true, checkpointTask("post-escalation resume")));
    chatCalls.push(after);
    if (after.verdict === "UNAVAILABLE") record("checkpoint", "self", "after-chain");
    else record("checkpoint", "chatgpt", "after-chain");
  }

  // ── FINAL REVIEW (sequential ChatGPT-first) ──────────────────────────────
  let finalVerdict = "PENDING";
  if (profile.expectFinal === "fix-gate") {
    // Available reviewer's technical REQUEST_CHANGES is BLOCKING: candidate NOT
    // yet acceptance-ready -> REQUEST_CHANGES, NO DONE while it stands; then
    // DSH applies the finding (sets the exact gate), re-reviews, and completes.
    const rev1 = await guarded("chatgpt-review", async () => chatScript(ctx, agent, "review-final", profile, 0, gateMet()));
    chatCalls.push(rev1);
    if (rev1.verdict !== "REQUEST_CHANGES")
      throw new Error("blocking scenario: reviewer must first return REQUEST_CHANGES against the non-ready candidate");
    record("review-blocked", "chatgpt", "-");
    if (existsSync(donePath))
      throw new Error("blocking scenario: DONE must NOT exist while REQUEST_CHANGES stands");
    setAcceptanceReady();
    const rev2 = await guarded("chatgpt-review", async () => chatScript(ctx, agent, "review-final", profile, 1, true));
    chatCalls.push(rev2);
    if (rev2.verdict !== "PASS")
      throw new Error("blocking scenario: after applying the finding the reviewer must PASS");
    finalVerdict = "PASS";
  } else {
    // Acceptance-ready exact candidate pushed BEFORE any review request.
    setAcceptanceReady();
    if (profile.expectFinal === "chatgpt-pass" || profile.expectFinal === "independent") {
      const rev = await guarded("chatgpt-review", async () => chatScript(ctx, agent, "review-final", profile, 0, true));
      chatCalls.push(rev);
      if (rev.verdict === "PASS") finalVerdict = "PASS";
      else if (rev.verdict === "UNAVAILABLE" && !noCodex) {
        commitCandidate(worktree, config.number);
        const revCodex = await guarded("codex-review", () => codex(
          ctx, agent, "review-final",
          "FINAL EXACT-HEAD REVIEW for Ticket #" + config.number + " worktree " + JSON.stringify(worktree) + ". Verify release-note.txt contains EXACTLY the gate string " + JSON.stringify(REQUIRE) + carve + " Inspect/reason/report only; do not modify the Ticket worktree."
        ));
        codexCalls.push(revCodex);
        escalationOutcome = revCodex.verdict === "UNAVAILABLE" ? "unavailable" : "pass";
        finalVerdict = revCodex.verdict === "PASS" ? "PASS" : (revCodex.verdict === "UNAVAILABLE" && profile.gateIndependent ? "UNAVAILABLE" : "BLOCKED");
      } else {
        finalVerdict = rev.verdict === "UNAVAILABLE" ? "UNAVAILABLE" : "BLOCKED";
      }
    } else if (profile.expectFinal === "codex") {
      const loopCount = Number(profile.chat["review-final-count"] || 3);
      let loop = 0;
      let nonPass = 0;
      while (loop < loopCount && nonPass < loopCount) {
        const rev = await guarded("chatgpt-review", async () => chatScript(ctx, agent, "review-final", profile, loop, true));
        chatCalls.push(rev);
        if (rev.verdict === "PASS") { finalVerdict = "PASS"; break; }
        if (rev.verdict === "UNAVAILABLE") break; // objective unavailability escalates NOW to fresh Codex
        nonPass += 1;
        loop += 1;
      }
      if (finalVerdict !== "PASS") {
        commitCandidate(worktree, config.number);
        const revCodex = await guarded("codex-review", () => codex(
          ctx, agent, "review-final",
          "FINAL EXACT-HEAD REVIEW for Ticket #" + config.number + " worktree " + JSON.stringify(worktree) + ". Verify release-note.txt contains EXACTLY " + JSON.stringify(REQUIRE) + carve + " Inspect/reason/report only; do not modify the Ticket worktree."
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
    const cpCodex = codexCalls.filter((c) => c && c.kind === "checkpoint").length;
    if (cpCodex !== 1)
      throw new Error("a progress checkpoint whose first-line helper call is objectively UNAVAILABLE must escalate that SAME checkpoint to fresh Codex exactly once; saw " + cpCodex);
    if (codexCalls.length !== cpCodex)
      throw new Error("checkpoint escalation scenario: ONLY the checkpoint escalates (final review stays ChatGPT-first on PASS); codex_calls=" + codexCalls.length);
    if (!events.some((e) => e.startsWith("checkpoint:codex:")))
      throw new Error("checkpoint->Codex escalation must be recorded in the ledger");
  }
  if (scenario === "three-loops-chain") {
    const debugLoops = events.filter((e) => e.startsWith("debug-loop:chatgpt:")).length;
    if (debugLoops !== 3)
      throw new Error("hard chain must run EXACTLY 3 ChatGPT loops; saw " + debugLoops);
    if (events.filter((e) => e === "checkpoint:chatgpt:after-chain").length !== 1)
      throw new Error("after the escalated chain resolves, ordinary interactions must return to ChatGPT-first");
    if (!events.some((e) => e.startsWith("debug-resolved:codex") || e.startsWith("debug-escalated-blocking:codex")))
      throw new Error("after 3 unsuccessful ChatGPT loops the SAME chain must escalate to fresh Codex");
  }
  if (scenario === "final-three-loops-codex") {
    const codexReviews = codexCalls.filter((c) => c && c.kind === "review-final").length;
    if (codexReviews !== 1)
      throw new Error("after 3 non-pass ChatGPT loops the final review must go to fresh Codex exactly once; saw " + codexReviews);
  }
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
