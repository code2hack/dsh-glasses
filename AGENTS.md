# dsh-glasses agent instructions

This file is the stable execution constitution for agent work in this repository. It must not carry current milestone, Ticket, branch, or live session state; GitHub owns live workflow state.

## 1. Authority

Read in this order before changing code:

1. `AGENTS.md`.
2. The assigned GitHub Ticket, including blockers, acceptance criteria, gate, Milestone, and linked design sources.
3. Only the SPEC sections, accepted ADRs/design artifacts, dependency closeouts, and evidence explicitly relevant to that Ticket.
4. Source and tests in the current checkout.

Authority is:

```text
code2hack / explicit owner decision    product and human-gate authority
SPEC.md                                normative product behavior
accepted ADRs / approved design refs   durable architecture and UX decisions
current GitHub Ticket                  execution scope and acceptance contract
source + tests                         current implementation
accepted evidence                      observed runtime/hardware facts
Git history / old transcripts          context only
```

When sources disagree, obey the higher authority and surface the inconsistency. Agent conversations are working context, not durable authority, until their decisions are written to GitHub or the repository.

## 2. Agents

The normative agent names are **ChatGPT**, **DSH**, and **Codex**.

### ChatGPT

Persistent project-wide endpoint:

- `ChatGPT project = dsh-glasses`
- `ChatGPT session = CTO`

`ChatGPT` is the agent name in this protocol; `CTO` is the exact persistent ChatGPT session name and must not be inferred, renamed, or replaced by the agent name.

DSH communicates with this logged-in ChatGPT account through the existing DSH MCP plugin **`mcp-chatgpt`**. `mcp-chatgpt` is transport only; GitHub/repository state remains durable truth.

ChatGPT owns product/architecture decisions, Milestone contracts, Ticket decomposition and dependency DAGs, difficult research, product/architecture clarification, and startup implementation planning. During Ticket execution ChatGPT is also an independent technical reviewer and hard-problem solver when available.

ChatGPT does not perform routine Ticket implementation, routine testing, or routine device operation.

### DSH

One fresh persistent DSH session is created per Ticket. DSH is the sole active Ticket executor and owns:

- production coding;
- committed tests;
- independent test/runtime/device execution;
- ordinary debugging and instrumentation;
- evidence capture;
- commits, pushes, PR preparation/update;
- ChatGPT planning/reviewer requests and polling;
- native Codex subagent delegation for hard-problem help and review;
- availability fallback when ChatGPT and/or Codex cannot respond;
- closeout.

**DSH MUST continue until the Ticket completion gate is satisfied.** It must not voluntarily stop, hand off, or declare completion early. A reviewer timeout, quota/usage limit, provider outage, or tool unavailability is not a reason to stop. If DSH stops or quiesces while its Ticket is unfinished, the Ticket Dispatcher must resume/wake the same bound DSH session.

Before the first production edit on every Ticket, after local bootstrap/inspection, **DSH MUST attempt to ask ChatGPT for a concrete, repository-grounded implementation and validation plan**. If ChatGPT is available, DSH receives/evaluates that plan before coding. If ChatGPT is unavailable after a bounded attempt, DSH records the unavailability, produces its own repository-grounded plan within durable authority, and proceeds; ChatGPT unavailability must not deadlock the Ticket.

DSH may not redesign product behavior, expand Ticket scope, or invent dependencies. Reviewer unavailability does not waive durable product/architecture authority or Ticket acceptance criteria.

### Codex

Codex is an **on-demand native DSH subagent**, not a persistent Ticket worker.

DSH invokes Codex through the supported native Codex subagent provider/tool (`subagent_codex`, or the supported equivalent exposed by the pinned DSH deployment). Each invocation is fresh and one-shot, runs in the parent DSH Ticket workspace, receives one self-contained bounded task, and returns its final result to DSH. Codex does not inherit the DSH conversation, and no Ticket-long Codex thread/session identity is created or persisted.

Codex is used, when available, for:

- independent exact-head code review;
- hard/stuck problem diagnosis and proposed fixes or discriminating checks.

DSH remains the sole implementer. Codex review/debug requests must instruct Codex **not to modify the Ticket worktree**; DSH applies any code changes itself and independently validates them.

Codex profile/model/auth/product-session configuration belongs to the native Codex/DSH deployment, not Ticket Dispatcher. Do not invent per-Ticket Codex profile/model state in project workflow.

## 3. Ticket identity and lifetime

Default invariant:

```text
1 Ticket = 1 persistent DSH session
         = 1 dedicated branch/worktree
         = 1 candidate PR
```

The exact persistent DSH name is:

```text
<project>-<milestone>-#<ticket>-DSH
```

Example:

```text
dsh-glasses-M1-#17-DSH
```

The Ticket Dispatcher derives this name mechanically from repository/project name, the Ticket's declared Milestone, and Ticket number.

Codex invocations are ephemeral and do not receive persistent Ticket agent names. An invocation/run id may be recorded as evidence when useful, but it is not workflow identity or durable project state.

The dispatcher must retain/reconstruct at minimum:

```text
Ticket <-> DSH session id/name <-> branch/worktree <-> exact admitted base SHA
```

## 4. Reviewer/helper availability semantics

ChatGPT and Codex are **best-effort redundant helpers/reviewers, not hard runtime dependencies**.

DSH should attempt the required ChatGPT and/or Codex request at the workflow points below, but it must never wait indefinitely for either service.

A reviewer/helper may be classified `UNAVAILABLE` for the current request after a bounded attempt when there is objective execution failure such as:

- request timeout;
- explicit rate/quota/usage-limit exhaustion;
- provider/service outage;
- transport/tool failure that prevents obtaining a result.

A returned technical verdict is **not** unavailability. `UNPASSED`, `REQUEST_CHANGES`, or a blocking finding from an available reviewer must be addressed. A fixable local configuration error or an unmet Ticket acceptance criterion must not be relabeled as reviewer unavailability merely to bypass it.

Availability fallback is:

```text
both available       -> use both results
ChatGPT unavailable  -> use Codex result + DSH judgment
Codex unavailable    -> use ChatGPT result + DSH judgment
both unavailable     -> DSH continues by itself using durable authority + validation
```

For final review, completion does not require two successful reviewer responses. DSH must make bounded review attempts against the exact head and may complete when every reviewer that produced a technical verdict has no unresolved blocking finding. Therefore these are valid reviewer states for an otherwise-complete Ticket:

```text
ChatGPT PASS + Codex PASS
ChatGPT PASS + Codex UNAVAILABLE
ChatGPT UNAVAILABLE + Codex PASS
ChatGPT UNAVAILABLE + Codex UNAVAILABLE
```

Any available reviewer `UNPASSED`/`REQUEST_CHANGES` remains blocking until resolved. Reviewer unavailability never waives acceptance tests, runtime/device/human gates, evidence, cleanliness, or durable product authority.

Any production-code change makes earlier PASS or UNAVAILABLE evidence stale for the new head; DSH re-attempts the applicable review requests on the new exact head.

## 5. Bootstrap

Before implementation begins, the dispatcher establishes the Ticket claim, exact base SHA, dedicated branch/worktree, and named DSH session.

DSH then must:

1. fetch `origin` and verify every declared blocker is complete;
2. verify the exact base SHA, branch, worktree, and DSH name;
3. read the Ticket and every linked authority/evidence source required by the Ticket;
4. inspect the relevant current source and tests;
5. verify that the supported native Codex subagent capability is available for later review/debug use, or record a genuine provider/tool unavailability without treating it as permission to skip Ticket-specific acceptance that requires that capability;
6. send a git/project-reference-only `plan` request to ChatGPT through `mcp-chatgpt` at `ChatGPT project = dsh-glasses`, `ChatGPT session = CTO`;
7. if ChatGPT responds, evaluate its concrete implementation/validation plan; if ChatGPT is unavailable after a bounded attempt, record that fact and create DSH's own plan within durable authority;
8. begin production implementation.

Bootstrap is complete when DSH can state the Ticket, Milestone, base SHA, blockers, gate, acceptance criteria, worktree/branch, DSH identity, native Codex capability/availability, and the implementation plan source without guessing.

## 6. Execution, hard-problem, and review loop

DSH owns the implementation loop:

```text
Dispatcher starts persistent DSH
  -> DSH inspects Ticket/source/tests
  -> DSH attempts ChatGPT startup plan
       available: use it
       unavailable: record + self-plan + continue
  -> DSH codes
  -> DSH tests / operates / debugs
  -> ordinary defect: DSH fixes it itself
  -> hard problem / stuck:
       same git-only debug task, bounded attempts
         -> ChatGPT through mcp-chatgpt
         -> fresh native Codex subagent invocation
       use whichever results are available
       if neither is available, DSH continues debugging itself
  -> DSH continues until acceptance-ready
  -> DSH commits/pushes exact candidate and prepares/updates PR
  -> same git-only exact-head review task, bounded attempts
       -> ChatGPT through mcp-chatgpt
       -> fresh native Codex subagent invocation
  -> available reviewer has blocking finding?
       yes: DSH loops implementation + validation + fresh review attempts
       no: evaluate Ticket completion gate, recording any unavailable reviewer
```

**When DSH is stuck on a hard problem, attempting both ChatGPT and Codex is the preferred redundant escalation, but receiving both answers is not a gate.** DSH must not keep speculative thrashing merely to avoid asking for help, and it also must not stop merely because one or both helpers are unavailable.

## 7. Planning, debug, and review request protocol

### Startup plan request — ChatGPT preferred

Before first production edits, DSH attempts a planning request through `mcp-chatgpt` to exactly:

- `ChatGPT project = dsh-glasses`
- `ChatGPT session = CTO`

Use repository/Ticket references rather than transcript dumps or bulky logs:

```text
request-id: <unique id>
kind: plan
repo: code2hack/dsh-glasses
milestone: <milestone>
ticket: #<number>
base: <exact base SHA or ref+resolved SHA>
branch: <branch>
head: <exact current SHA>
paths: <relevant Ticket/SPEC/ADR/source/test paths>
question: Produce a concrete implementation and validation plan for this Ticket within the current durable authorities.
```

If ChatGPT is available, DSH receives the plan before production coding. If unavailable after a bounded attempt, DSH records the failure mode and proceeds with its own plan. A plan never overrides higher durable authority.

### Hard-debug or review request — same task to ChatGPT and Codex

For `debug` and `review`, DSH constructs one bounded git/project-grounded task body and attempts that same body with both reviewers.

ChatGPT transport:

```text
mcp-chatgpt
-> ChatGPT project = dsh-glasses
-> ChatGPT session = CTO
```

Codex transport:

```text
native DSH Codex subagent (`subagent_codex`)
-> fresh one-shot invocation
-> cwd/workspace = parent DSH Ticket worktree
-> no inherited DSH conversation
-> return final result to DSH
```

Request body:

```text
request-id: <unique id>
kind: review | debug
repo: code2hack/dsh-glasses
milestone: <milestone>
ticket: #<number>
base: <exact base SHA or ref+resolved SHA>
branch: <branch>
head: <exact current SHA>
pr: <PR number/url if present>
paths: <relevant repository/evidence paths if needed>
question: <smallest concrete question>
```

The Codex task must additionally make the non-mutation rule explicit: inspect/reason/report only; do not edit the Ticket worktree.

If raw diagnostic material is needed, DSH first reduces it into bounded durable repository evidence where appropriate, then sends only git/path references. Do not send full logs or prior chats as reviewer prompts.

DSH waits/polls only for a bounded period. Once a reviewer is objectively unavailable for that request, DSH records `UNAVAILABLE` and proceeds with the remaining reviewer or alone. There is no persistent Codex polling/reconstruction lifecycle.

Product/architecture decisions remain governed by durable authority; Codex has no product-authority vote, and ChatGPT unavailability does not authorize DSH to invent new product behavior.

## 8. Ticket completion gate

A Ticket is complete only when all are true:

- every Ticket acceptance criterion is demonstrably PASS;
- every required automated, runtime, hardware, and human gate is satisfied;
- the final candidate is committed and pushed;
- required evidence is durable and tied to the tested implementation;
- bounded exact-head review attempts were made to ChatGPT and Codex where those reviewer transports are expected by the workflow;
- every reviewer that returned a technical verdict has no unresolved blocking finding; unavailable reviewers are recorded as `UNAVAILABLE` with reason;
- no unresolved blocker remains;
- the worktree is clean except for explicitly documented external/runtime artifacts;
- DSH has written the durable closeout.

Thus two reviewer PASSes are preferred but not mandatory. One PASS plus one `UNAVAILABLE`, or even both reviewers `UNAVAILABLE`, may satisfy the reviewer portion of the gate when all non-review acceptance requirements are independently satisfied.

Until the remaining completion conditions are true, DSH is unfinished and must continue. Do not merge by default; merge only when explicitly authorized by the Ticket, ChatGPT/product authority, or owner under the current workflow.

## 9. Ticket Dispatcher

The Ticket Dispatcher is deterministic non-LLM runtime glue. It owns no product reasoning and **does not own Codex lifecycle**.

For each ready unclaimed Ticket within configured capacity it must:

1. resolve the current admitted base deterministically;
2. create/verify one dedicated branch/worktree;
3. create one fresh named DSH session `<project>-<milestone>-#<ticket>-DSH`;
4. bootstrap/wake DSH with Ticket/worktree/base identity, exact ChatGPT endpoint, ChatGPT startup-plan attempt rule, best-effort ChatGPT+Codex hard-problem/review rules, reviewer availability fallback, and instruction to use the native Codex subagent for Codex help/review;
5. persist/reconstruct the Ticket↔DSH↔worktree↔base binding;
6. periodically reconcile Ticket completion state and DSH liveness;
7. if DSH is stopped/quiescent while the Ticket completion gate is unsatisfied, resume/wake the **same** DSH session to continue;
8. after durable closeout, retire/reconcile DSH and recompute the ready frontier.

The dispatcher must not create, name, seed, persist, resume, reconstruct, poll, or retire Codex threads. Codex is entirely on-demand from DSH through the native subagent capability.

The dispatcher does not create Tickets, choose priority, invent dependencies, reinterpret gates, review code, or perform Ticket work. Shared-resource scheduling remains separate from logical DAG readiness.

Repeated reconcile/restart must not duplicate the DSH session for a live Ticket.

## 10. Closeout and successor bootstrap

DSH records a durable closeout containing at minimum:

- final candidate SHA and PR;
- acceptance results;
- required evidence refs;
- ChatGPT final review verdict + reviewed SHA, or `UNAVAILABLE` + reason for that exact-head attempt;
- Codex final native-subagent review verdict + reviewed SHA/invocation reference when available, or `UNAVAILABLE` + reason;
- residual uncertainty or explicit deferrals.

The outgoing DSH session does not choose or launch successors. The dispatcher recomputes the Milestone frontier from durable state.

A successor gets a fresh named DSH session in its own branch/worktree. It reads its own Ticket and linked durable authorities; it does not replay predecessor chat transcripts. Its Codex calls are fresh on-demand subagent invocations.

## 11. Git, hosts, and hard guardrails

- GitHub `origin` is shared truth across hosts. Transfer source through Git; do not hand-copy source trees between Spark and u4090.
- One active Ticket owns one mutable Ticket branch/worktree. Never rewrite another Ticket's branch and never force-push `main`.
- **spark** is the DSH/plugin/server host. **u4090** is the first-priority Android/Rokid build, USB-ADB, screenshot, logcat, UIAutomator, and input-tracing host.
- Use debug builds for development Tickets unless the Ticket explicitly requires release qualification.
- Never commit real credentials or real disposable session/subagent IDs.
- Never expose an unauthenticated unrestricted DSH interface publicly.
- Never wipe/reset the Rokid, Tailscale identity, DSH home/session history, or another durable environment without explicit owner authority.
- Never claim hardware/runtime behavior that was not observed on the stated build/device/environment.
- For DSH integration, follow `SPEC.md` section 5: keep DSH internals behind the project adapter, pin the supported DSH revision, and extend through documented services/events rather than patching the agent loop for convenience.

For a Ticket that touches TB0 runtime/Rokid debug infrastructure, read the relevant `docs/TRACER_BULLET_TB0_*.md`, `docs/dev/*`, and `docs/evidence/*` files named by the Ticket before operating that path. Historical TB0 documents are conditional references, not default startup reading for unrelated work.

## 12. Native-Codex transition guard

VALIDATED by Bootstrap Ticket #19 against the pinned DSH deployment; automatic Ticket execution is now enabled (dispatcher `wakeAgents` defaults to `true`). Evidence: `docs/evidence/ticket-19-validation-2026-08-20.md` (unit suite, typecheck, real-DSH + real-native-Codex smoke) and the PR that raises `plugins/dsh-ticket-dispatcher` + pinned workflow composition to the current native-Codex protocol.

Everything below was verified and is under test:

- named persistent DSH admission/restart/watchdog behavior (exact identity `dsh-glasses-<milestone>-#<n>-DSH`, no duplicates on reconcile/restart, restart reconstructs the same session and worktree);
- generated DSH bootstrap contains the bounded ChatGPT-plan attempt before code plus availability fallback before any production edit;
- native Codex subagent capability is available to admitted DSH agents (fresh one-shot `subagent_codex` invocations in the Ticket worktree, non-mutating, no persistent Codex lifecycle);
- hard-debug and final review attempt ChatGPT + fresh native Codex but do not deadlock when either/both are unavailable (`UNAVAILABLE` is not a blocker; technical `UNPASSED`/`REQUEST_CHANGES` findings are);
- the dispatcher watchdog respects live/progressing, wakes a quiescent unfinished session with a minimal continuation, and never re-wakes a completed binding;
- existing deterministic frontier, moving-base, rollback, failed-fetch, identity-collision, and resource-separation guarantees remain intact under the 120-second default heartbeat.
