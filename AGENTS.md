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

ChatGPT is the **first-line** implementation planner, progress supervisor, technical reviewer, and hard-problem helper for every Ticket. ChatGPT also owns product/architecture clarification under the durable authority model above.

ChatGPT does not perform routine Ticket implementation, routine testing, or routine device operation.

### DSH

One fresh persistent DSH session is created per Ticket. DSH is the sole active Ticket executor and code author. DSH owns:

- production coding;
- committed tests;
- independent test/runtime/device execution;
- ordinary debugging and instrumentation;
- evidence capture;
- commits, pushes, PR preparation/update;
- helper planning/review/progress requests and bounded waiting;
- native Codex escalation when the ChatGPT-first rules below require it;
- closeout.

**DSH MUST continue until the Ticket completion gate is satisfied.** It must not voluntarily stop, hand off, or declare completion early. Helper timeout, quota/usage limit, provider outage, or tool unavailability is not a reason to stop. If DSH stops or quiesces while its Ticket is unfinished, the Ticket Dispatcher must resume/wake the same bound DSH session.

DSH **MUST NOT make its own implementation plan/to-do list while either ChatGPT or Codex is available to provide one**. Self-planning is permitted only after bounded attempts establish that both helpers are unavailable for planning.

DSH may not redesign product behavior, expand Ticket scope, or invent dependencies. Helper unavailability never waives durable product/architecture authority or Ticket acceptance criteria.

### Codex

Codex is an **on-demand native DSH subagent**, not a persistent Ticket worker. DSH invokes it through the supported native Codex subagent provider/tool (`subagent_codex`, or the supported equivalent exposed by the pinned DSH deployment).

Codex has the same Ticket-level helper role as ChatGPT when invoked: implementation planning, progress supervision, technical review, and hard-problem assistance. However, Codex is **second-line escalation**, never a parallel peer request. DSH must not summon Codex while a ChatGPT request for the same workflow step is still active or before the escalation rules below are met.

Each Codex invocation is fresh and one-shot, runs in the parent DSH Ticket workspace, receives one self-contained bounded task, and returns its final result to DSH. Codex does not inherit the DSH conversation, and no Ticket-long Codex thread/session identity is created or persisted.

DSH remains the sole implementer. Codex planning/review/debug/progress requests must instruct Codex **not to modify the Ticket worktree**; DSH applies all code changes itself and independently validates them.

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

## 4. Sequential helper and escalation semantics

ChatGPT and Codex are not parallel reviewers. They occupy the same helper role in a strict priority chain:

```text
first line:  ChatGPT
escalation:  fresh native Codex subagent
last resort: DSH alone, only when the required helper path is unavailable/exhausted
```

**DSH MUST NEVER request ChatGPT and Codex at the same time for the same planning, progress, debug, or review step.**

A helper may be classified `UNAVAILABLE` for the current request after a bounded attempt when there is objective execution failure such as:

- request timeout;
- explicit rate/quota/usage-limit exhaustion;
- provider/service outage;
- transport/tool failure that prevents obtaining a result.

A technical verdict, disagreement, or requested change is not unavailability.

Codex escalation is allowed only when either:

1. ChatGPT is `UNAVAILABLE` for the required interaction; or
2. ChatGPT has failed to resolve/pass the **same problem or review chain for three complete loops**.

A ChatGPT loop means:

```text
DSH sends one bounded request
-> ChatGPT returns guidance or a blocking/non-pass result
-> DSH applies the guidance/fix and validates it
-> the same problem/review chain remains unresolved or non-passing
```

After the **third unsuccessful ChatGPT loop**, DSH does not start a fourth ChatGPT loop for that same unresolved problem/review chain. The next helper request for that chain goes to a fresh Codex subagent.

Codex escalation is scoped to the unresolved problem/review chain. Once that chain is resolved, the next ordinary planning/progress/review interaction returns to ChatGPT-first behavior.

If ChatGPT is unavailable and Codex is also unavailable, DSH may continue independently. If ChatGPT has exhausted three loops and Codex is unavailable, DSH may continue independently, but it may not silently ignore a known valid blocking finding; it must resolve or disprove it with durable evidence/validation before completion.

## 5. Mandatory Ticket-start plan and to-do list

At the start of every Ticket, after local bootstrap/inspection and before the first production edit, DSH **MUST obtain a detailed implementation and validation plan/to-do list from a helper**.

The order is mandatory:

```text
1. ask ChatGPT
2. only if ChatGPT is UNAVAILABLE, ask fresh Codex
3. only if BOTH are UNAVAILABLE, DSH may self-plan
```

DSH must never skip directly to Codex while ChatGPT is available, and must never self-plan while either helper is available.

The plan must be repository/Ticket-grounded and contain an ordered, checkable to-do list. Each item should identify the intended implementation/validation outcome and, where useful, the relevant paths, tests, evidence, or acceptance criteria.

If ChatGPT returns a plan that conflicts with durable authority, DSH reports that conflict and requests correction. Such correction loops count toward the three-loop escalation rule if the same planning problem remains unresolved. If ChatGPT reaches three unsuccessful loops, DSH escalates the planning problem to a fresh Codex subagent. DSH self-plans only if the helper path ultimately has no available helper.

Production implementation begins only after DSH has a plan source:

- `ChatGPT`;
- `Codex` after valid escalation/unavailability; or
- `DSH SELF-PLAN` only when both helpers are unavailable.

## 6. Mandatory per-to-do progress reporting

For every item in the active helper-provided to-do list, **DSH MUST report completion immediately after that item is finished** before silently advancing through further items.

A completion report should contain at least:

```text
ticket: #<number>
todo-item: <id/number + short description>
status: completed
head: <exact current SHA or working-tree state if not yet committed>
result: <what changed / what was proved>
validation: <tests/runtime checks performed>
evidence: <durable paths/refs if any>
next: <next planned item>
```

Helper routing for each progress checkpoint follows the same sequential chain:

1. ChatGPT first;
2. Codex only if ChatGPT is unavailable for that checkpoint, or if that checkpoint belongs to a problem/review chain already escalated to Codex after three unsuccessful ChatGPT loops;
3. if both are unavailable, DSH records the checkpoint durably where appropriate and continues independently.

If the helper responds with bounded corrections or an updated remaining to-do list that is consistent with durable authority, DSH incorporates it before continuing. DSH does not need to invoke Codex merely because ChatGPT accepted a checkpoint; Codex remains escalation-only.

## 7. Bootstrap

Before implementation begins, the dispatcher establishes the Ticket claim, exact base SHA, dedicated branch/worktree, and named DSH session.

DSH then must:

1. fetch `origin` and verify every declared blocker is complete;
2. verify the exact base SHA, branch, worktree, and DSH name;
3. read the Ticket and every linked authority/evidence source required by the Ticket;
4. inspect the relevant current source and tests;
5. verify that the supported native Codex subagent capability is available for possible escalation, or record genuine provider/tool unavailability without treating a missing required composition as acceptable;
6. request the detailed plan/to-do list using the mandatory ChatGPT -> Codex -> self-plan order in section 5;
7. receive/evaluate the helper plan, or self-plan only if both helpers are unavailable;
8. begin production implementation.

Bootstrap is complete when DSH can state the Ticket, Milestone, base SHA, blockers, gate, acceptance criteria, worktree/branch, DSH identity, native Codex capability/availability, plan source, and ordered to-do list without guessing.

## 8. Execution and hard-problem loop

DSH owns the implementation loop:

```text
Dispatcher starts persistent DSH
  -> DSH inspects Ticket/source/tests
  -> DSH obtains detailed plan/to-do list:
       ChatGPT first
       -> if unavailable: fresh Codex
       -> if both unavailable: DSH self-plan
  -> for each to-do item:
       DSH implements/tests
       -> reports completed item to ChatGPT first
       -> Codex only on valid escalation/unavailability
       -> both unavailable: record + continue
  -> ordinary defect: DSH fixes it itself within the current plan
  -> hard problem / stuck:
       request ChatGPT first
       -> if unavailable: fresh Codex
       -> if unresolved after 3 complete ChatGPT loops: fresh Codex
       -> if required helper path unavailable: DSH continues debugging itself
  -> continue until acceptance-ready
  -> final review uses section 10 sequential review semantics
```

DSH must not keep speculative thrashing merely to avoid escalation, and it must not deadlock merely because a helper is unavailable.

## 9. Planning, progress, debug, and review request protocol

### ChatGPT transport

```text
mcp-chatgpt
-> ChatGPT project = dsh-glasses
-> ChatGPT session = CTO
```

### Codex transport

```text
native DSH Codex subagent (`subagent_codex` or pinned supported equivalent)
-> fresh invocation for this request
-> parent DSH Ticket worktree
-> self-contained task only
-> returns final result to DSH
```

Codex must never be invoked in parallel with the corresponding ChatGPT request.

Use repository/Ticket references rather than transcript dumps or bulky logs. Standard request shape:

```text
request-id: <unique id>
kind: plan | progress | review | debug
repo: code2hack/dsh-glasses
milestone: <milestone>
ticket: #<number>
base: <exact base SHA or ref+resolved SHA>
branch: <branch>
head: <exact current SHA>
pr: <PR number/url if present>
paths: <relevant repository/evidence paths if needed>
question: <smallest concrete request>
```

For `plan`, request a detailed ordered implementation/validation to-do list.

For `progress`, identify the completed to-do item, result, validation/evidence, and next planned item.

For Codex `plan`, `progress`, `debug`, or `review`, make the non-mutation rule explicit: inspect/reason/report only; do not edit the Ticket worktree.

If raw diagnostic material is needed, DSH first reduces it into bounded durable repository evidence where appropriate, then sends only git/path references. Do not send full logs or prior chats as helper prompts.

DSH waits/polls only for a bounded period. Once the current primary helper is objectively unavailable, it records `UNAVAILABLE` and follows the escalation chain. There is no persistent Codex polling/reconstruction lifecycle.

## 10. Sequential final-review semantics

Final exact-head review is also ChatGPT-first and sequential.

For an acceptance-ready candidate:

1. DSH commits/pushes the exact candidate and completes required validation/evidence.
2. DSH asks ChatGPT to review the exact head.
3. If ChatGPT returns `PASS`, the reviewer gate is satisfied. **Do not summon Codex.**
4. If ChatGPT is `UNAVAILABLE`, DSH asks a fresh Codex subagent to review the exact same head.
5. If ChatGPT returns a blocking/non-pass verdict, DSH fixes/validates and re-requests ChatGPT review. Each still-unresolved cycle counts as one ChatGPT loop.
6. If the third complete ChatGPT review loop is still non-passing for the same review chain, the next review goes to a fresh Codex subagent instead of a fourth ChatGPT loop.
7. If Codex returns `PASS`, the reviewer gate is satisfied, subject to all non-review completion requirements.
8. If Codex returns a blocking finding, DSH fixes/validates and continues the Codex escalation chain for that unresolved review problem.
9. If the required helper path becomes unavailable and no helper can review, DSH may continue/complete only when all non-review requirements pass and DSH has independently resolved or disproved every known blocking finding.

Any production-code change makes prior PASS/UNAVAILABLE review evidence stale for the new head.

A helper's technical blocking finding is never relabeled `UNAVAILABLE` merely to bypass it.

## 11. Ticket completion gate

A Ticket is complete only when all are true:

- every Ticket acceptance criterion is demonstrably PASS;
- every required automated, runtime, hardware, and human gate is satisfied;
- the final candidate is committed and pushed;
- required evidence is durable and tied to the tested implementation;
- a detailed Ticket plan/to-do list was obtained from ChatGPT first, Codex after valid escalation/unavailability, or DSH only when both were unavailable;
- completion of every executed to-do item was reported through the mandatory progress-checkpoint chain unless both helpers were unavailable for that checkpoint;
- final review followed the sequential ChatGPT-first escalation rule;
- no known unresolved blocking helper finding remains;
- no unresolved blocker remains;
- the worktree is clean except for explicitly documented external/runtime artifacts;
- DSH has written the durable closeout.

Valid final helper outcomes include:

```text
ChatGPT PASS                         -> complete reviewer gate; Codex not called
ChatGPT UNAVAILABLE -> Codex PASS   -> complete reviewer gate
ChatGPT 3-loop unresolved -> Codex PASS -> complete reviewer gate
required helper path unavailable    -> fallback allowed only with independent validation and no unresolved known blocking finding
```

Helper unavailability never waives acceptance tests, runtime/device/human gates, evidence, cleanliness, or durable product authority.

Until the remaining completion conditions are true, DSH is unfinished and must continue. Do not merge by default; merge only when explicitly authorized by the Ticket, ChatGPT/product authority, or owner under the current workflow.

## 12. Ticket Dispatcher

The Ticket Dispatcher is deterministic non-LLM runtime glue. It owns no product reasoning and **does not own Codex lifecycle**.

For each ready unclaimed Ticket within configured capacity it must:

1. resolve the current admitted base deterministically;
2. create/verify one dedicated branch/worktree;
3. create one fresh named DSH session `<project>-<milestone>-#<ticket>-DSH`;
4. bootstrap/wake DSH with Ticket/worktree/base identity, exact ChatGPT endpoint, mandatory helper-produced plan/to-do rule, mandatory per-to-do progress reporting, sequential ChatGPT-first/Codex-escalation semantics, three-loop escalation rule, helper availability fallback, and native Codex subagent address;
5. persist/reconstruct the Ticket↔DSH↔worktree↔base binding;
6. periodically reconcile Ticket completion state and DSH liveness;
7. if DSH is stopped/quiescent while the Ticket completion gate is unsatisfied, resume/wake the **same** DSH session to continue;
8. after durable closeout, retire/reconcile DSH and recompute the ready frontier.

The dispatcher must not create, name, seed, persist, resume, reconstruct, poll, or retire Codex threads. Codex is entirely on-demand from DSH through the native subagent capability.

The dispatcher does not create Tickets, choose priority, invent dependencies, reinterpret gates, review code, or perform Ticket work. Shared-resource scheduling remains separate from logical DAG readiness.

Repeated reconcile/restart must not duplicate the DSH session for a live Ticket.

## 13. Closeout and successor bootstrap

DSH records a durable closeout containing at minimum:

- final candidate SHA and PR;
- acceptance results;
- required evidence refs;
- plan source (`ChatGPT`, escalated `Codex`, or `DSH SELF-PLAN` with both-unavailable reasons);
- ordered to-do list and completion/progress-checkpoint record;
- final helper/review path and verdict, including any ChatGPT loop count and Codex escalation reason;
- helper `UNAVAILABLE` reasons where applicable;
- residual uncertainty or explicit deferrals.

The outgoing DSH session does not choose or launch successors. The dispatcher recomputes the Milestone frontier from durable state.

A successor gets a fresh named DSH session in its own branch/worktree. It reads its own Ticket and linked durable authorities; it does not replay predecessor chat transcripts. Its Codex calls are fresh on-demand escalation invocations.

## 14. Git, hosts, and hard guardrails

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

## 15. Native-Codex transition guard

Automatic Ticket execution must remain disabled until the bootstrap dispatcher Ticket verifies the final protocol against the pinned DSH deployment, including:

- named persistent DSH admission/restart/watchdog behavior;
- generated DSH bootstrap requires a helper-produced detailed plan/to-do list before code, using ChatGPT -> Codex -> self-plan fallback;
- generated DSH bootstrap requires progress reporting after every completed to-do item;
- ChatGPT and Codex are never requested in parallel;
- Codex is used only when ChatGPT is unavailable or the same problem/review chain survives three complete ChatGPT loops;
- native Codex subagent capability is available to admitted DSH agents;
- final review is sequential ChatGPT-first with Codex escalation rather than dual review;
- existing deterministic frontier, moving-base, rollback, failed-fetch, and resource-separation guarantees remain intact.
