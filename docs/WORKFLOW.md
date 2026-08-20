# dsh-glasses engineering workflow

This document defines the operational workflow around the stable rules in `AGENTS.md`. GitHub and the repository are durable workflow state; agent conversations are replaceable working contexts.

## 1. Lifetimes and topology

```text
ChatGPT project = dsh-glasses
└── ChatGPT session = CTO                   persistent across project

Milestone N
├── Ticket #A
│   └── dsh-glasses-MN-#A-DSH               persistent Ticket executor
│       ├── Codex subagent invocation        fresh hard-debug specialist
│       ├── Codex subagent invocation        fresh exact-head reviewer
│       └── ...                              fresh per request
├── Ticket #B
│   └── dsh-glasses-MN-#B-DSH
└── Ticket Dispatcher                        deterministic DSH lifecycle glue
```

Lifetime rule:

```text
ChatGPT = project-long persistent intelligence
DSH     = Ticket-long persistent executor
Codex   = request-long ephemeral specialist
```

`ChatGPT` is the protocol agent name; `CTO` is the exact concrete persistent ChatGPT session name. DSH reaches ChatGPT through the existing DSH MCP plugin `mcp-chatgpt`.

Codex is not pre-created and has no Ticket-long conversation. DSH invokes the native Codex subagent on demand. Each invocation is fresh, operates in the parent DSH Ticket workspace, receives a self-contained task, and returns a result to DSH.

## 2. Responsibilities

### ChatGPT

ChatGPT owns product/architecture decisions, Milestone design, Ticket decomposition and DAGs, hard research, product/architecture clarification, startup implementation planning, exact-head review, and hard-problem assistance.

### DSH

DSH owns implementation: coding, committed tests, runtime/device checks, ordinary debugging, evidence, git/PR work, ChatGPT planning/reviewer requests/polling, native Codex delegation, and closeout. DSH must keep working until the Ticket completion gate is satisfied.

Before first production edits, DSH must ask ChatGPT for a concrete repository-grounded implementation/validation plan and receive it.

When DSH becomes stuck on a hard problem, it must ask **both ChatGPT and a fresh native Codex subagent** for help using the same bounded git-only debug task. It may not keep making speculative changes instead of escalating.

### Codex

Codex is an on-demand independent reviewer and hard-problem specialist reached through DSH's native Codex subagent capability. It is not the routine code author and not a persistent workflow worker.

Every Codex invocation is fresh. It sees the Ticket worktree and the self-contained task DSH delegates, not DSH's conversation history. Review/debug tasks must instruct Codex not to modify the Ticket worktree; DSH applies changes itself.

### Ticket Dispatcher

The dispatcher computes the declared ready frontier and materializes/maintains **DSH runtime state only**. It does not plan work, review code, or own Codex lifecycle.

## 3. Milestone lifecycle

At Milestone start, ChatGPT refreshes from durable state:

1. current `origin/main`;
2. current `SPEC.md` and relevant accepted ADR/design artifacts;
3. previous Milestone closeout/deferrals;
4. current source where needed.

ChatGPT then defines the Milestone goal, non-goals, tracer-bullet Tickets, `Blocked by` DAG, human gates, and Milestone acceptance.

Tickets remain narrow vertical slices. Logical dependencies belong in `Blocked by`; shared hardware contention does not.

## 4. Ticket contract

Each implementation Ticket should contain:

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
- <specific SPEC sections / accepted ADR / approved design ref>

## Validation
- <required automated/runtime/device checks>

## Evidence
- <durable evidence paths needed for ChatGPT + Codex exact-head review>

## Out of scope
- <important nearby behavior intentionally excluded>
```

The Ticket gives DSH enough durable context to execute without replaying prior conversations. Codex invocations remain self-contained and git-grounded.

## 5. Ticket Dispatcher

For each ready unclaimed Ticket within active capacity:

```text
GitHub Ticket + Milestone
    -> resolve exact current base
    -> create dedicated branch/worktree
    -> create named persistent DSH session
       name = <project>-<milestone>-#<ticket>-DSH
    -> persist Ticket <-> DSH <-> worktree <-> base binding
    -> wake/bootstrap DSH
       require ChatGPT plan before first production edit
       require native Codex availability for later debug/review
       require dual ChatGPT + fresh-Codex help when hard-stuck
    -> watchdog the same DSH until TicketComplete
```

Required properties:

- deterministic ready-frontier admission;
- default active Ticket capacity 3, configurable;
- exactly one persistent DSH session per admitted Ticket, no duplicate across reconcile/restart;
- exact admitted base SHA recorded per Ticket;
- GitHub remains durable project truth;
- DSH id/name + worktree/base are reconstructable runtime bindings;
- shared-resource scheduling remains separate from DAG readiness;
- **no Codex thread/session lifecycle in dispatcher state**.

The dispatcher must never create/name/seed/persist/resume/reconstruct/poll/retire Codex threads. DSH owns native Codex invocation on demand.

### DSH liveness watchdog

The dispatcher periodically checks every unfinished admitted Ticket's DSH state. Default polling/heartbeat interval is **120 seconds**, configurable through the normal dispatcher configuration surface.

If the bound DSH session is stopped/quiescent while Ticket completion is false, the dispatcher resumes/wakes the **same DSH session** with a minimal continuation instruction. It must not create a replacement session merely because the existing one became idle.

A completed Ticket is never re-woken. A Ticket waiting on ChatGPT/reviewer/human gates remains unfinished but recoverable; DSH continues its required polling/orchestration after resume.

Prefer supported DSH lifecycle/turn state over a fragile inactivity heuristic when deciding whether a session has stopped/quiesced.

## 6. Ticket execution loop

```text
Dispatcher starts DSH
        ↓
DSH inspects Ticket/source/tests
        ↓
DSH asks ChatGPT for concrete implementation plan
        ↓
ChatGPT plan received
        ↓
DSH implements
        ↓
DSH tests / operates / ordinary-debug fixes
        ↓
Hard/stuck problem?
  yes → same bounded git-only debug task
          ├─→ ChatGPT via mcp-chatgpt
          └─→ fresh native Codex subagent
        DSH collects both results
        DSH fixes/tests itself
        ↓
Acceptance-ready candidate
        ↓
DSH commits/pushes exact head + updates PR/evidence
        ↓
same bounded git-only review task
  ├─→ ChatGPT via mcp-chatgpt
  └─→ fresh native Codex subagent
        ↓
ChatGPT PASS + Codex PASS on same exact head?
  no  → DSH fixes/tests → fresh dual review
  yes → Ticket completion gate
```

DSH never uses a reviewer failure or hard problem as a reason to stop. A failed review is another implementation loop; a hard/stuck problem is mandatory dual-help escalation.

## 7. Planning, debug, and review protocol

### Startup planning — ChatGPT only

Before first production edits, DSH sends:

```text
mcp-chatgpt
-> ChatGPT project = dsh-glasses
-> ChatGPT session = CTO
```

Planning task:

```text
request-id: <unique id>
kind: plan
repo: code2hack/dsh-glasses
milestone: <milestone>
ticket: #<number>
base: <base ref + exact resolved SHA where useful>
branch: <branch>
head: <exact current SHA>
paths: <relevant Ticket/SPEC/ADR/source/test paths>
question: Produce a concrete implementation and validation plan for this Ticket within the current durable authorities.
```

DSH must receive the plan before production coding begins. If the plan changes product/architecture authority, durable authority must be updated before DSH relies on that change.

### Hard-debug and exact-head review — same task to ChatGPT and Codex

DSH constructs one task body and uses it for both reviewers.

ChatGPT transport:

```text
mcp-chatgpt
-> ChatGPT project = dsh-glasses
-> ChatGPT session = CTO
```

Codex transport:

```text
native DSH Codex subagent (`subagent_codex` or pinned supported equivalent)
-> fresh invocation for this request
-> parent DSH Ticket worktree
-> self-contained task only
-> returns final result to DSH
```

Task body:

```text
request-id: <unique id>
kind: review | debug
repo: code2hack/dsh-glasses
milestone: <milestone>
ticket: #<number>
base: <base ref + exact resolved SHA where useful>
branch: <branch>
head: <exact current SHA>
pr: <PR number/url if present>
paths: <relevant repository/evidence paths if needed>
question: <smallest concrete question>
```

For Codex, append/integrate the requirement: **inspect/reason/report only; do not modify the Ticket worktree**.

Do not paste complete logs, conversation transcripts, or previous reviewer chats. If debug evidence is needed, DSH reduces it into bounded durable repository evidence and sends references.

For a hard/stuck problem, dual escalation is mandatory: ChatGPT and a fresh Codex invocation must both be consulted.

DSH polls ChatGPT periodically as needed. Codex is not polled as a persistent thread; DSH invokes a fresh subagent and awaits/collects its result.

## 8. Review semantics

Accepted terminal review result:

```text
ChatGPT = PASS on SHA X
fresh Codex subagent = PASS on SHA X
```

Anything else is not completion. If either reviewer returns `UNPASSED`, `REQUEST_CHANGES`, or equivalent failure, DSH resumes implementation/testing/debugging.

Any production-code change after a PASS makes both previous PASSes stale for completion. DSH must revalidate and request ChatGPT review plus a **new fresh Codex subagent review** on the new exact head.

For product/architecture decisions, ChatGPT remains authoritative; Codex review does not grant product authority.

## 9. Completion gate

```text
TicketComplete =
  every acceptance criterion == PASS
  AND required automated/runtime/device/human gates == satisfied
  AND final candidate == committed + pushed
  AND durable evidence == tied to tested implementation
  AND ChatGPT review(finalHeadSHA) == PASS
  AND fresh Codex subagent review(finalHeadSHA) == PASS
  AND no unresolved blocker/reviewer failure
  AND worktree == clean (except documented external/runtime artifacts)
  AND DSH closeout == durable
```

Until this predicate is true, DSH remains responsible for continuing the Ticket.

## 10. Closeout and successors

DSH closeout records:

- final SHA/PR;
- acceptance matrix;
- evidence refs;
- ChatGPT request/verdict/reviewed SHA;
- final Codex subagent result/reviewed SHA and invocation reference when available;
- residual uncertainty/deferrals.

The dispatcher then retires/reconciles DSH and recomputes the ready frontier. A successor gets a fresh named DSH session in its own branch/worktree. It does not replay predecessor chat history. Its Codex help/review calls are fresh native subagent invocations.

## 11. Parallelism and scarce resources

Multiple logically ready Tickets may run concurrently up to configured active capacity. Shared mutable resources such as the real Rokid remain separately leased/scheduled; resource contention never becomes a fake `Blocked by` edge.

Codex subagent concurrency is an execution/resource concern of DSH/native provider, not a Ticket-DAG dependency and not persistent Ticket worker count.

## 12. Native-Codex deployment transition

The dispatcher implementation merged before this final protocol already centers on DSH admission, but automatic Ticket execution remains disabled until the bootstrap dispatcher Ticket validates the remaining required behavior against the pinned DSH deployment:

- deterministic named DSH admission/restart;
- 120-second-default configurable DSH watchdog;
- generated DSH bootstrap includes ChatGPT-plan-before-code;
- generated DSH bootstrap includes mandatory ChatGPT + fresh-Codex escalation for hard/stuck problems;
- native Codex subagent tool/provider is exposed to admitted DSH agents;
- hard-debug and final review use fresh native Codex invocations in the Ticket worktree;
- dispatcher contains no persistent Codex lifecycle state;
- existing frontier, moving-base, failed-fetch, rollback, credential, and resource-separation guarantees remain intact.
