# dsh-glasses engineering workflow

This document defines the operational workflow around the stable rules in `AGENTS.md`. GitHub and the repository are durable workflow state; agent conversations are replaceable working contexts.

## 1. Lifetimes and topology

```text
ChatGPT project = dsh-glasses
└── ChatGPT session = CTO                persistent across the project

Milestone N
├── Ticket #A
│   ├── dsh-glasses-MN-#A-DSH            fresh, active executor
│   └── dsh-glasses-MN-#A-Codex          fresh, persistent reviewer; idle initially
├── Ticket #B
│   ├── dsh-glasses-MN-#B-DSH
│   └── dsh-glasses-MN-#B-Codex
└── Ticket Dispatcher                     deterministic runtime glue
```

`ChatGPT` is the protocol agent name; `CTO` is the exact concrete persistent ChatGPT session name. ChatGPT retains project continuity. Every Ticket gets a fresh DSH/Codex pair. DSH works continuously until completion; Codex is pre-created but idle until DSH requests review or hard-debug help.

DSH reaches ChatGPT through the existing DSH MCP plugin `mcp-chatgpt`, which operates the logged-in ChatGPT web account. GitHub/repository state remains canonical.

## 2. Responsibilities

### ChatGPT

ChatGPT owns product/architecture decisions, Milestone design, Ticket decomposition and DAGs, hard research, and product/architecture clarification. During Ticket execution it is also one of the two independent technical reviewers and hard-bug solvers.

### DSH

DSH owns implementation: coding, committed tests, runtime/device checks, ordinary debugging, evidence, git/PR work, reviewer requests/polling, and closeout. DSH must keep working until the Ticket completion gate is satisfied. A reviewer wait or external human gate is a wait state, not a terminal state.

### Codex

Codex is the second independent technical reviewer and hard-bug solver. It is not the routine code author. The dispatcher creates a normal persistent Codex thread for the Ticket; its first prompt is exactly its assigned name and nothing else, then the thread remains idle until DSH contacts it.

### Ticket Dispatcher

The dispatcher computes the declared ready frontier and materializes/maintains paired DSH+Codex runtime state. It does not plan work or review code.

## 3. Milestone lifecycle

At the start of a Milestone, ChatGPT refreshes its understanding from current durable state:

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
- <durable evidence paths needed for dual review>

## Out of scope
- <important nearby behavior intentionally excluded>
```

The Ticket should give DSH enough durable context to execute without replaying prior conversations.

## 5. Ticket Dispatcher

For each ready unclaimed Ticket within active capacity:

```text
GitHub Ticket + Milestone
    -> resolve exact current base
    -> create dedicated branch/worktree
    -> create DSH session
       name = <project>-<milestone>-#<ticket>-DSH
    -> create normal persistent Codex thread
       name = <project>-<milestone>-#<ticket>-Codex
       first prompt = exact Codex name only
    -> persist pair binding
    -> wake/bootstrap DSH
    -> keep Codex idle
```

Required properties:

- deterministic ready-frontier admission;
- default active Ticket capacity 3, configurable;
- one DSH session + one Codex thread per Ticket, no duplicates across reconcile/restart;
- exact admitted base SHA recorded per Ticket;
- GitHub remains durable project truth;
- DSH/Codex IDs and names are reconstructable runtime bindings;
- shared-resource scheduling remains separate from DAG readiness.

### DSH liveness watchdog

The dispatcher periodically checks every unfinished admitted Ticket's DSH state. If the bound DSH session is stopped, quiescent, or otherwise no longer progressing while the Ticket completion gate is false, the dispatcher resumes/wakes the **same DSH session** with a minimal continuation instruction. It must not create a replacement session merely because the existing one became idle.

A completed Ticket is never re-woken. A Ticket waiting on a reviewer/human gate may remain waiting but its DSH session must remain recoverable and continue polling as required by the workflow.

## 6. Ticket execution loop

```text
Dispatcher bootstraps DSH + idle Codex
        ↓
DSH implements
        ↓
DSH tests / operates / ordinary-debug fixes
        ↓
Hard bug?
  yes → identical git-only request → ChatGPT + Codex
        DSH polls both → DSH applies findings → continue
        ↓
Acceptance-ready candidate
        ↓
DSH commits/pushes exact head + updates PR/evidence
        ↓
identical git-only review request → ChatGPT + Codex
        ↓
DSH polls both periodically
        ├── ChatGPT UNPASSED → DSH fixes/tests → new dual review
        ├── Codex UNPASSED   → DSH fixes/tests → new dual review
        └── both PASS same exact head
                     ↓
             Ticket completion gate
```

DSH never uses a reviewer failure as a reason to stop. A failed review is another implementation loop.

## 7. Reviewer request protocol

DSH sends exactly the same request body to ChatGPT and Codex for `review` and `debug` requests.

ChatGPT transport:

```text
mcp-chatgpt
→ ChatGPT project = dsh-glasses
→ ChatGPT session = CTO
```

Codex transport:

```text
paired persistent Codex thread
→ no exec / no fresh one-shot invocation
```

Request body:

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

Do not paste complete logs, conversation transcripts, or previous reviewer chats into these prompts. Reviewers inspect the referenced git state themselves. If debug evidence must be preserved, DSH reduces it into bounded durable repository evidence and sends only the references.

DSH polls both reviewer channels periodically after a blocking request. Polling cadence is operational configuration, not product logic.

## 8. Review semantics

For code completion, ChatGPT and Codex are independent peer review gates.

Accepted terminal review result:

```text
ChatGPT = PASS on SHA X
Codex   = PASS on SHA X
```

Anything else is not completion. If either reviewer returns `UNPASSED`, `REQUEST_CHANGES`, or an equivalent failure, DSH resumes implementation/testing/debugging.

Any production-code change after a PASS makes both previous reviewer PASSes stale for completion purposes. DSH must revalidate and request both reviews again on the new exact head.

For product/architecture decisions, ChatGPT remains authoritative; Codex's reviewer role does not grant product authority.

## 9. Completion gate

```text
TicketComplete =
  every acceptance criterion == PASS
  AND required automated/runtime/device/human gates == satisfied
  AND final candidate == committed + pushed
  AND durable evidence == tied to tested implementation
  AND ChatGPT review(finalHeadSHA) == PASS
  AND Codex review(finalHeadSHA) == PASS
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
- Codex request/verdict/reviewed SHA;
- residual uncertainty/deferrals.

The dispatcher then retires/reconciles the pair and recomputes the ready frontier. A successor gets a fresh DSH/Codex pair with new names derived from its own Milestone/Ticket. It does not replay predecessor chat history.

## 11. Parallelism and scarce resources

Multiple logically ready Tickets may run concurrently up to the configured active limit. Shared mutable resources such as the real Rokid remain separately leased/scheduled; resource contention never becomes a fake `Blocked by` edge.

## 12. Protocol-v2 deployment transition

The dispatcher implementation merged before this protocol creates DSH sessions only. It does not yet create paired persistent Codex threads or perform the required DSH liveness watchdog. Therefore automatic Ticket execution under protocol v2 must remain disabled until the follow-up dispatcher implementation Ticket passes acceptance.