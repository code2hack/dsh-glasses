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

ChatGPT owns product/architecture decisions, Milestone contracts, Ticket decomposition and dependency DAGs, difficult research, product/architecture clarification, and startup implementation planning for every Ticket. During Ticket execution ChatGPT is also an independent technical reviewer and hard-problem solver.

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
- closeout.

**DSH MUST continue until the Ticket completion gate is satisfied.** It must not voluntarily stop, hand off, or declare completion early. Waiting for required planning/reviewer replies or an explicit human gate is not completion. If DSH stops or quiesces while its Ticket is unfinished, the Ticket Dispatcher must resume/wake the same bound DSH session.

Before the first production edit on every Ticket, after local bootstrap/inspection, **DSH MUST ask ChatGPT for a concrete, repository-grounded implementation and validation plan and receive the reply before coding begins**. The plan is execution guidance inside the current durable authorities. If it introduces or changes product/architecture behavior, that change must be durably recorded in the appropriate Ticket/SPEC/ADR/design authority before DSH relies on it.

DSH may not redesign product behavior, expand Ticket scope, or invent dependencies. Product/architecture ambiguity goes to ChatGPT.

### Codex

Codex is an **on-demand native DSH subagent**, not a persistent Ticket worker.

DSH invokes Codex through the supported native Codex subagent provider/tool (`subagent_codex`, or the supported equivalent exposed by the pinned DSH deployment). Each invocation is fresh and one-shot, runs in the parent DSH Ticket workspace, receives one self-contained bounded task, and returns its final result to DSH. Codex does not inherit the DSH conversation, and no Ticket-long Codex thread/session identity is created or persisted.

Codex is used for:

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

## 4. Bootstrap

Before implementation begins, the dispatcher establishes the Ticket claim, exact base SHA, dedicated branch/worktree, and named DSH session.

DSH then must:

1. fetch `origin` and verify every declared blocker is complete;
2. verify the exact base SHA, branch, worktree, and DSH name;
3. read the Ticket and every linked authority/evidence source required by the Ticket;
4. inspect the relevant current source and tests;
5. verify that the supported native Codex subagent capability is available for later review/debug use;
6. send a git/project-reference-only `plan` request to ChatGPT through `mcp-chatgpt` at `ChatGPT project = dsh-glasses`, `ChatGPT session = CTO`;
7. receive and evaluate ChatGPT's concrete implementation/validation plan against durable authority;
8. only then begin production implementation itself.

Bootstrap is complete only when DSH can state the Ticket, Milestone, base SHA, blockers, gate, acceptance criteria, worktree/branch, DSH identity, native Codex capability, and received ChatGPT implementation plan without guessing.

## 5. Execution and dual-review loop

DSH owns the implementation loop:

```text
Dispatcher starts persistent DSH
  -> DSH inspects Ticket/source/tests
  -> DSH asks ChatGPT for concrete implementation plan
  -> ChatGPT plan received
  -> DSH codes
  -> DSH tests / operates / debugs
  -> ordinary defect: DSH fixes it itself
  -> hard problem / stuck:
       same git-only debug task
         -> ChatGPT through mcp-chatgpt
         -> fresh native Codex subagent invocation
       DSH collects both results and fixes/tests itself
  -> DSH continues until acceptance-ready
  -> DSH commits/pushes exact candidate and prepares/updates PR
  -> same git-only exact-head review task
       -> ChatGPT through mcp-chatgpt
       -> fresh native Codex subagent invocation
  -> ChatGPT PASS + Codex PASS on the same exact head?
       no: DSH loops implementation + validation + fresh dual review
       yes: evaluate Ticket completion gate
```

ChatGPT and Codex are independent technical review gates for the exact candidate head. A PASS from only one is insufficient.

Any production-code change after either reviewer passes invalidates both prior PASS results for completion purposes; DSH must revalidate and request a fresh ChatGPT review and a fresh Codex subagent review on the new exact head.

**When DSH is stuck on a hard problem, asking both ChatGPT and Codex for help is mandatory.** “Stuck/hard” includes a failure unresolved after a bounded local debugging attempt, ambiguous behavior where further edits would be speculative, uncertainty about a critical supported API/runtime invariant, or another blocker preventing reliable forward progress. DSH must not keep speculative thrashing instead of escalating.

## 6. Planning, debug, and review request protocol

### Startup plan request — ChatGPT only

Before first production edits, DSH sends a planning request through `mcp-chatgpt` to exactly:

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

DSH must receive this plan before production coding starts. A plan does not override higher durable authority.

### Hard-debug or review request — same task to ChatGPT and Codex

For `debug` and `review`, DSH constructs one bounded git/project-grounded task body and uses that same body for both reviewers.

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

For a hard/stuck problem, dual escalation is mandatory. DSH sends/wakes ChatGPT and invokes a fresh Codex subagent; it polls ChatGPT as needed and awaits/collects the Codex result. There is no persistent Codex polling/reconstruction lifecycle.

Product/architecture decisions are sent to ChatGPT; Codex has no product-authority vote.

## 7. Ticket completion gate

A Ticket is complete only when all are true:

- every Ticket acceptance criterion is demonstrably PASS;
- every required automated, runtime, hardware, and human gate is satisfied;
- the final candidate is committed and pushed;
- required evidence is durable and tied to the tested implementation;
- **ChatGPT PASSes the exact current head**;
- **a fresh native Codex subagent review PASSes the exact same current head**;
- no unresolved reviewer failure, blocker, or requested change remains;
- the worktree is clean except for explicitly documented external/runtime artifacts;
- DSH has written the durable closeout.

Until all conditions are true, DSH is unfinished and must continue or remain waiting/polling for the required gate. Do not merge by default; merge only when explicitly authorized by the Ticket, ChatGPT/product authority, or owner under the current workflow.

## 8. Ticket Dispatcher

The Ticket Dispatcher is deterministic non-LLM runtime glue. It owns no product reasoning and **does not own Codex lifecycle**.

For each ready unclaimed Ticket within configured capacity it must:

1. resolve the current admitted base deterministically;
2. create/verify one dedicated branch/worktree;
3. create one fresh named DSH session `<project>-<milestone>-#<ticket>-DSH`;
4. bootstrap/wake DSH with Ticket/worktree/base identity, exact ChatGPT endpoint, mandatory ChatGPT startup-plan rule, mandatory hard-problem dual-help rule, and instruction to use the native Codex subagent for Codex help/review;
5. persist/reconstruct the Ticket↔DSH↔worktree↔base binding;
6. periodically reconcile Ticket completion state and DSH liveness;
7. if DSH is stopped/quiescent while the Ticket completion gate is unsatisfied, resume/wake the **same** DSH session to continue;
8. after durable closeout, retire/reconcile DSH and recompute the ready frontier.

The dispatcher must not create, name, seed, persist, resume, reconstruct, poll, or retire Codex threads. Codex is entirely on-demand from DSH through the native subagent capability.

The dispatcher does not create Tickets, choose priority, invent dependencies, reinterpret gates, review code, or perform Ticket work. Shared-resource scheduling remains separate from logical DAG readiness.

Repeated reconcile/restart must not duplicate the DSH session for a live Ticket.

## 9. Closeout and successor bootstrap

DSH records a durable closeout containing at minimum:

- final candidate SHA and PR;
- acceptance results;
- required evidence refs;
- ChatGPT final review request/verdict + reviewed SHA;
- Codex final native-subagent review result + reviewed SHA and invocation reference when available;
- residual uncertainty or explicit deferrals.

The outgoing DSH session does not choose or launch successors. The dispatcher recomputes the Milestone frontier from durable state.

A successor gets a fresh named DSH session in its own branch/worktree. It reads its own Ticket and linked durable authorities; it does not replay predecessor chat transcripts. Its Codex calls are fresh on-demand subagent invocations.

## 10. Git, hosts, and hard guardrails

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

## 11. Native-Codex transition guard

The dispatcher implementation currently on `main` predates the final protocol in this file. Automatic Ticket execution must remain disabled until the bootstrap dispatcher Ticket verifies all of the following against the pinned DSH deployment:

- named persistent DSH admission/restart/watchdog behavior;
- generated DSH bootstrap contains ChatGPT-plan-before-code and mandatory dual hard-problem escalation rules;
- native Codex subagent capability is available to admitted DSH agents;
- hard-debug and final review use fresh native Codex subagent invocations rather than dispatcher-managed persistent Codex threads;
- existing deterministic frontier, moving-base, rollback, failed-fetch, and resource-separation guarantees remain intact.
