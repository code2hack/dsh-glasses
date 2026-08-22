# dsh-glasses engineering workflow

This document defines the operational workflow implementing the stable rules in `AGENTS.md`.

GitHub and Git are durable project state. DSH and Codex session/thread identifiers are runtime bindings supplied at runtime, not repository policy.

## 1. Topology and lifetimes

```text
ChatGPT
└── project-long persistent first-line Ticket expert

Project Supervisor DSH
└── project-long workflow orchestrator
    │
    ├── Ticket #A
    │   └── <project>-<milestone>-#A-DSH
    ├── Ticket #B
    │   └── <project>-<milestone>-#B-DSH
    └── Ticket #C
        └── <project>-<milestone>-#C-DSH

Project Codex
└── project-long persistent second-line Ticket expert
```

Lifetime rule:

```text
ChatGPT        = project-long
Supervisor DSH = project-long
Project Codex  = project-long
Ticket DSH     = Ticket-long
```

The UI/process location used to display or host Project Codex is an operational detail and is not part of the workflow protocol.

## 2. Responsibility split

### ChatGPT

ChatGPT is the first-line Ticket expert for:

- detailed implementation/validation planning;
- ordered Ticket to-do lists;
- per-to-do progress supervision;
- hard-problem help;
- exact-head technical review;
- product/architecture clarification.

The repository does not contain the current persistent ChatGPT session identifier. The project owner supplies that runtime identifier to the Supervisor DSH.

### Project Supervisor DSH

The Supervisor owns project orchestration only:

- read GitHub workflow state;
- compute the ready frontier from declared dependencies;
- enforce active capacity/resource constraints;
- create dedicated branch/worktree state;
- create named Ticket DSH workers;
- propagate runtime expert bindings to Ticket DSH;
- observe/recover Ticket DSH workers;
- observe durable completion;
- dispatch successors.

It does not implement Ticket production code and does not act as the normal Ticket technical expert.

### Ticket DSH

Ticket DSH owns Ticket execution only:

- implementation;
- tests;
- runtime/device operation;
- ordinary debugging;
- evidence;
- git/PR;
- helper interactions;
- closeout.

It does not dispatch successors.

### Project Codex

Project Codex is the project-long persistent second-line Ticket expert.

When validly selected by the sequential helper rules, it performs the same Ticket-level expert functions as ChatGPT:

- detailed implementation/validation planning;
- ordered to-do-list generation/correction;
- progress supervision;
- hard-problem diagnosis;
- exact-head technical review.

It does not dispatch Tickets, manage DSH workers, own product authority, or routinely modify Ticket code.

The repository does not contain the current Project Codex thread ID. The project owner supplies that runtime identifier and the required app-server endpoint to the Supervisor DSH.

## 3. Runtime expert bootstrap

Before the Supervisor can bootstrap normal Ticket workers, the project owner provides the live project expert bindings:

```text
ChatGPT runtime binding
- supported transport
- exact persistent ChatGPT session identifier

Project Codex runtime binding
- Codex app-server endpoint
- exact persistent Project Codex thread ID
```

These values are runtime state.

They MUST NOT be committed into `AGENTS.md`, `docs/WORKFLOW.md`, Tickets, source code, or committed configuration.

The Supervisor uses the owner-supplied values exactly and propagates both expert identities and their required transports into every Ticket DSH bootstrap.

If the owner replaces either project expert binding, subsequent Ticket DSH bootstraps use the new binding.

The Supervisor should not guess a replacement session/thread identity from names or history.

## 4. Direct Ticket-to-expert communication

The normal communication topology is:

```text
Owner
  |
  | supplies runtime expert bindings
  v
Project Supervisor DSH
  |
  | propagates bindings at Ticket bootstrap
  v
Ticket DSH
  |\
  | \----> ChatGPT
  |
  \------> Project Codex through Codex app-server
```

The Supervisor is not a routine message relay between Ticket DSH and the project experts.

## 5. Project Codex app-server transport

Project Codex communication uses the existing persistent Codex thread through Codex app-server.

Logical client sequence:

```text
connect to configured app-server
-> initialize
-> resume/attach configured Project Codex thread
-> wait until that thread is available for a turn
-> start one helper turn
-> consume app-server events
-> obtain the completed response
```

Use the current supported app-server persistent-thread resume/attach and turn-start APIs.

Normal Ticket helper requests MUST NOT create a new Codex thread.

Normal Ticket helper requests MUST NOT use `subagent_codex`.

All Ticket workers share the same Project Codex thread. Therefore Project Codex access is serialized:

```text
one active Project Codex helper turn at a time
```

If the thread is busy, callers queue/wait through the project transport mechanism rather than racing concurrent turns.

A Codex escalation request remains self-contained even though the thread persists across Tickets.

## 6. Milestone and Ticket authority

At Milestone start, ChatGPT may refresh from durable state as needed:

- current `origin/main`;
- current SPEC;
- relevant accepted ADR/design sources;
- previous Milestone closeout/deferrals;
- current source/runtime evidence.

ChatGPT defines or clarifies product/architecture Milestone contracts under owner authority.

The Supervisor DSH does not invent Milestone product scope.

Implementation Tickets should contain enough durable information for a fresh Ticket DSH to execute without replaying old conversations.

Recommended Ticket contract:

```markdown
## Milestone
M1

## What to build
<one observable end-to-end behavior>

## Acceptance criteria
- [ ] checkable criterion

## Blocked by
- None

## Gate
`autonomous`

## Design sources
- <SPEC / ADR / approved design refs>

## Validation
- <required automated/runtime/device checks>

## Evidence
- <required durable evidence>

## Out of scope
- <nearby behavior intentionally excluded>
```

## 7. Supervisor reconcile loop

The project-long Supervisor DSH repeatedly reconciles the project from current state.

Conceptually:

```text
refresh origin/main
refresh GitHub Tickets/Milestones
        ↓
inspect active Ticket DSH bindings
        ↓
recover unfinished stopped workers
        ↓
observe durable completed closeouts
        ↓
compute ready frontier
        ↓
apply capacity/resource constraints
        ↓
admit new ready Tickets
        ↓
repeat
```

This is agent reasoning over durable authority, not the old hard-coded Ticket Dispatcher state machine.

The Supervisor should use supported native DSH agent/session lifecycle primitives for Ticket DSH creation, observation, and resume.

## 8. Ready Ticket determination

A Ticket is eligible for admission when, at minimum:

- its execution state permits work;
- every declared `Blocked by` dependency is complete;
- it is not already actively owned;
- its Milestone/Ticket contract is executable;
- active capacity permits admission;
- shared-resource policy permits admission or safe deferred resource use.

Shared hardware contention does not automatically become a logical `Blocked by` edge.

If readiness is ambiguous because of product/architecture meaning, Supervisor DSH asks ChatGPT rather than inventing policy.

## 9. Ticket admission

For each admitted Ticket:

```text
Supervisor DSH
    ↓
fetch/resolve exact current base
    ↓
create dedicated Ticket branch/worktree
    ↓
create one persistent named Ticket DSH
    ↓
propagate owner-supplied expert bindings
    ↓
bootstrap worker
    ↓
record/recover runtime Ticket binding
```

Exact Ticket DSH name:

```text
<project>-<milestone>-#<ticket>-DSH
```

Runtime Ticket binding:

```text
Ticket
<-> DSH session id/name
<-> branch/worktree
<-> exact admitted base SHA
```

Before creating a worker, Supervisor DSH checks for existing:

- active Ticket binding;
- matching Ticket DSH;
- Ticket branch/worktree;
- durable completed closeout.

Do not create duplicates.

## 10. Ticket DSH bootstrap

Supervisor DSH gives Ticket DSH enough context to establish itself, including:

```text
Ticket number
Milestone
exact admitted base
branch
worktree
Ticket DSH identity
owner-supplied ChatGPT runtime binding
owner-supplied Project Codex runtime binding
```

The concrete ChatGPT session identifier and Project Codex thread ID exist only in this live runtime bootstrap/context, not in repository policy.

The bootstrap also requires Ticket DSH to read current:

```text
AGENTS.md
Ticket
linked durable authorities
relevant source/tests
```

Then Ticket DSH starts the mandatory helper-produced planning workflow.

## 11. Sequential expert routing

For every Ticket expert interaction, routing is:

```text
ChatGPT first
    ↓
ChatGPT objectively unavailable
OR same unresolved chain survives 3 complete ChatGPT loops
    ↓
Project Codex
    ↓
Project Codex unavailable
    ↓
Ticket DSH continues independently where allowed
```

Ticket DSH MUST NEVER ask ChatGPT and Project Codex concurrently for the same planning, progress, debug, or review step.

`UNAVAILABLE` means an objective inability to obtain a usable response after a bounded attempt, such as:

- timeout;
- explicit rate/quota/usage exhaustion;
- provider outage;
- transport failure.

A technical `UNPASSED`, `REQUEST_CHANGES`, disagreement, or blocking finding is not unavailability.

## 12. Ticket-start planning

Before first production edits:

```text
Ticket DSH
    ↓
ChatGPT detailed implementation + validation plan
and ordered to-do list
```

If ChatGPT responds successfully:

```text
PLAN_SOURCE = CHATGPT
```

Do not call Project Codex for the same planning interaction.

If ChatGPT is objectively unavailable:

```text
Ticket DSH
    ↓
Project Codex persistent thread
```

If Project Codex responds:

```text
PLAN_SOURCE = PROJECT_CODEX
```

Only if both project experts are unavailable:

```text
PLAN_SOURCE = DSH_SELF
```

Ticket DSH is forbidden from self-planning merely for convenience while either project expert remains available.

The active to-do list should cover all required implementation, tests, runtime/device gates, evidence, and closeout work.

If a planning disagreement with ChatGPT remains unresolved through three complete ChatGPT correction loops, that planning chain escalates to Project Codex instead of starting ChatGPT loop 4.

## 13. Ticket execution loop

```text
obtain project-expert-produced plan/to-do list
        ↓
execute TODO #1
        ↓
validate TODO #1
        ↓
mandatory progress checkpoint
        ↓
execute TODO #2
        ↓
validate TODO #2
        ↓
mandatory progress checkpoint
        ↓
...
        ↓
acceptance-ready candidate
        ↓
sequential final review
        ↓
TicketComplete
```

Ticket DSH does not silently execute the whole plan and report only at the end.

## 14. Progress checkpoint protocol

After every completed to-do item, send a checkpoint containing at least:

```text
request-id: <unique>
kind: progress
repo: code2hack/dsh-glasses
milestone: <milestone>
ticket: #<number>
base: <exact base>
branch: <branch>
head: <exact SHA/current state>
todo-item: <id + description>
result: <what changed/proved>
validation: <checks performed>
evidence: <refs>
next-item: <next item>
question: Review this completed item. Identify any blocking correction needed
before continuing; otherwise confirm the next planned item.
```

Routing starts with ChatGPT.

If ChatGPT accepts or has no blocking correction, continue to the next to-do item and do not call Project Codex.

If ChatGPT is unavailable, route the checkpoint to Project Codex.

If the checkpoint belongs to a chain already escalated to Project Codex after three unsuccessful ChatGPT loops, continue that chain with Project Codex until resolved.

If both experts are unavailable, record the checkpoint durably where appropriate and continue independently.

When the escalated chain resolves, normal routing returns to ChatGPT-first.

## 15. Three-loop escalation

For one specific unresolved helper chain:

```text
ChatGPT loop 1
-> DSH fix/validate
-> unresolved

ChatGPT loop 2
-> DSH fix/validate
-> unresolved

ChatGPT loop 3
-> DSH fix/validate
-> unresolved

Project Codex next
```

Do not run ChatGPT loop 4 for that same unresolved chain.

ChatGPT unavailability escalates directly to Project Codex and does not require three loops.

Project Codex escalation is scoped to that chain. Other independent helper interactions still begin with ChatGPT.

## 16. Hard-problem workflow

For an ordinary bug, Ticket DSH diagnoses/fixes it itself inside the active plan.

For a hard/stuck problem:

```text
ChatGPT first
```

Then either:

```text
resolved
-> continue
```

or:

```text
ChatGPT unavailable
-> Project Codex
```

or:

```text
same problem unresolved through 3 complete ChatGPT loops
-> Project Codex
```

If Project Codex is unavailable too:

```text
Ticket DSH continues independent debugging
```

Known valid blocking findings remain real findings even if helper availability later changes.

## 17. Project Codex request protocol

A Project Codex escalation is sent to the existing persistent project thread through app-server.

Example request:

```text
request-id: <unique>
kind: plan-escalation | progress-escalation | debug-escalation | review-escalation
repo: code2hack/dsh-glasses
milestone: <milestone>
ticket: #<number>
base: <exact base>
branch: <branch>
head: <exact head>
worktree: <Ticket worktree path if needed for inspection>
pr: <PR if applicable>
paths:
- <relevant source/evidence paths>
question: <smallest concrete request>

constraints:
- inspect/reason/report only
- do not modify the Ticket worktree
```

Do not dump entire DSH transcripts into Project Codex.

Persistent Codex memory may help, but current git/Ticket state remains authoritative.

## 18. Final review

Acceptance-ready Ticket:

```text
Ticket DSH
-> complete full required validation
-> commit/push exact head
-> update PR/evidence
-> ChatGPT exact-head review
```

If ChatGPT returns `PASS`:

```text
reviewer gate satisfied
NO Project Codex review
```

If ChatGPT is `UNAVAILABLE`:

```text
Project Codex exact-head review
```

If ChatGPT returns blocking/non-pass:

```text
DSH fixes
-> validates
-> pushes new head
-> ChatGPT reviews again
```

After the third unsuccessful ChatGPT review loop:

```text
Project Codex reviews next
```

If Project Codex passes after valid escalation, the reviewer gate is satisfied.

If Project Codex blocks, Ticket DSH fixes/validates and continues the Project Codex review chain.

If the required expert path becomes unavailable, independent fallback is allowed only when all non-review gates pass and no known blocking finding remains unresolved.

Any production-code change invalidates prior PASS/UNAVAILABLE review evidence for the new head.

## 19. Ticket completion predicate

```text
TicketComplete =
  every acceptance criterion == PASS
  AND required automated/runtime/device/human gates == satisfied
  AND final candidate == committed + pushed
  AND durable evidence == tied to tested implementation
  AND valid plan source exists
  AND every completed TODO was checkpointed unless both experts unavailable
  AND final review followed sequential expert protocol
  AND no known unresolved expert finding
  AND no unresolved blocker
  AND worktree clean except documented runtime artifacts
  AND durable Ticket DSH closeout exists
```

## 20. Ticket closeout

Ticket DSH closeout records:

- final SHA/PR;
- acceptance matrix;
- validation/evidence refs;
- plan source;
- to-do/checkpoint completion summary;
- final review route/result;
- residual uncertainty/deferrals.

Ticket DSH does not dispatch a successor.

Supervisor DSH sees the closeout during reconciliation and recomputes the ready frontier.

## 21. Worker recovery

Supervisor DSH observes supported native DSH session state.

For an unfinished Ticket:

```text
worker active/progressing
-> leave it alone

worker stopped/quiescent
-> resume same DSH session
```

Do not create a replacement worker merely because the original worker stopped.

For a durably completed Ticket:

```text
do not wake it
```

Recovery should use supported DSH session/agent identity and resume primitives rather than heuristic reconstruction of conversation state.

## 22. Project Codex recovery

The Project Codex helper identity is the owner-supplied persistent thread ID.

After app-server/client restart:

```text
reconnect
-> resume/attach the same owner-supplied persistent thread
-> continue using the same Project Codex thread
```

Do not create a new Codex thread merely because the transport process/client was recreated.

If the configured thread genuinely cannot be recovered, Project Codex is unavailable until the owner deliberately supplies a replacement runtime binding.

## 23. Parallel Tickets and shared resources

Multiple Tickets may execute concurrently.

Supervisor DSH controls active Ticket count and shared-resource allocation according to current durable policy.

Logical Ticket readiness and physical resource availability are separate concepts.

A Ticket can be logically ready while waiting for scarce hardware.

The single Project Codex thread is also a shared resource:

```text
one active Project Codex helper turn at a time
```

Project Codex requests are serialized.

## 24. Removed legacy workflow

The following are retired:

```text
hard-coded dsh-ticket-dispatcher orchestration
subagent_codex as Ticket helper
fresh Codex per helper request
persistent Codex per Ticket
parallel ChatGPT + Codex helper requests
dual-review / dual-PASS completion
```

The replacement is:

```text
ChatGPT
    = project-long first-line Ticket expert

Project Supervisor DSH
    = project-long Ticket orchestrator

Project Codex thread
    = project-long second-line Ticket expert

Ticket DSH
    = one executor per active Ticket
```

Workflow policy lives primarily in:

```text
AGENTS.md
docs/WORKFLOW.md
GitHub Tickets
SPEC / ADR / durable evidence
```

not in a hard-coded dispatcher state machine.
