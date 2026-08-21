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

ChatGPT owns product/architecture decisions, Milestone design, Ticket decomposition and DAGs, hard research, product/architecture clarification, startup implementation planning, exact-head review, and hard-problem assistance when available.

### DSH

DSH owns implementation: coding, committed tests, runtime/device checks, ordinary debugging, evidence, git/PR work, ChatGPT planning/reviewer requests/polling, native Codex delegation, availability fallback, and closeout. DSH must keep working until the Ticket completion gate is satisfied.

Before first production edits, DSH must make a bounded attempt to ask ChatGPT for a concrete repository-grounded implementation/validation plan. If ChatGPT is unavailable, DSH records that fact, makes its own plan within durable authority, and continues.

When DSH becomes stuck on a hard problem, it should attempt **both ChatGPT and a fresh native Codex subagent** using the same bounded git-only debug task. Receiving both answers is preferred but not required. One helper may be used if the other is unavailable; if both are unavailable, DSH continues debugging independently.

### Codex

Codex is an on-demand independent reviewer and hard-problem specialist reached through DSH's native Codex subagent capability. It is not the routine code author and not a persistent workflow worker.

Every Codex invocation is fresh. It sees the Ticket worktree and the self-contained task DSH delegates, not DSH's conversation history. Review/debug tasks must instruct Codex not to modify the Ticket worktree; DSH applies changes itself.

### Ticket Dispatcher

The dispatcher computes the declared ready frontier and materializes/maintains **DSH runtime state only**. It does not plan work, review code, or own Codex lifecycle.

## 3. Availability fallback

ChatGPT and Codex provide redundant assistance, not hard availability dependencies.

A bounded request may be marked `UNAVAILABLE` when it fails objectively because of timeout, quota/rate/usage limit, provider outage, or transport/tool failure. A technical `REQUEST_CHANGES`, `UNPASSED`, or blocking finding is **not** unavailability and must be addressed.

Fallback behavior:

```text
both available       -> use both
ChatGPT unavailable  -> use Codex + DSH judgment
Codex unavailable    -> use ChatGPT + DSH judgment
both unavailable     -> DSH continues independently
```

This applies to startup planning, hard-problem assistance, and final review. Unavailability never waives Ticket acceptance criteria, product authority, required tests, runtime/device/human gates, evidence, or cleanliness.

For final review, these reviewer states are acceptable when all non-review completion requirements pass:

```text
ChatGPT PASS + Codex PASS
ChatGPT PASS + Codex UNAVAILABLE
ChatGPT UNAVAILABLE + Codex PASS
ChatGPT UNAVAILABLE + Codex UNAVAILABLE
```

If either available reviewer returns a blocking verdict, completion is blocked until the finding is resolved. Any new production-code head invalidates prior PASS/UNAVAILABLE review evidence and requires fresh bounded attempts.

## 4. Milestone lifecycle

At Milestone start, ChatGPT refreshes from durable state:

1. current `origin/main`;
2. current `SPEC.md` and relevant accepted ADR/design artifacts;
3. previous Milestone closeout/deferrals;
4. current source where needed.

ChatGPT then defines the Milestone goal, non-goals, tracer-bullet Tickets, `Blocked by` DAG, human gates, and Milestone acceptance.

Tickets remain narrow vertical slices. Logical dependencies belong in `Blocked by`; shared hardware contention does not.

## 5. Ticket contract

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
- <durable evidence paths needed for review/availability records>

## Out of scope
- <important nearby behavior intentionally excluded>
```

The Ticket gives DSH enough durable context to execute without replaying prior conversations. Codex invocations remain self-contained and git-grounded.

## 6. Ticket Dispatcher

For each ready unclaimed Ticket within active capacity:

```text
GitHub Ticket + Milestone
    -> resolve exact current base
    -> create dedicated branch/worktree
    -> create named persistent DSH session
       name = <project>-<milestone>-#<ticket>-DSH
    -> persist Ticket <-> DSH <-> worktree <-> base binding
    -> wake/bootstrap DSH
       require bounded ChatGPT-plan attempt before first production edit
       require native Codex availability check for later debug/review
       require best-effort ChatGPT + fresh-Codex help/review
       require reviewer availability fallback without deadlock
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

A completed Ticket is never re-woken. A Ticket must not be left permanently waiting only because ChatGPT or Codex timed out, hit a usage limit, or is otherwise unavailable; resumed DSH applies the fallback semantics and continues.

Prefer supported DSH lifecycle/turn state over a fragile inactivity heuristic when deciding whether a session has stopped/quiesced.

## 7. Ticket execution loop

```text
Dispatcher starts DSH
        ↓
DSH inspects Ticket/source/tests
        ↓
DSH attempts ChatGPT implementation plan
  available   → use plan
  unavailable → record + DSH self-plan
        ↓
DSH implements
        ↓
DSH tests / operates / ordinary-debug fixes
        ↓
Hard/stuck problem?
  yes → same bounded git-only debug task
          ├─→ ChatGPT via mcp-chatgpt
          └─→ fresh native Codex subagent
        use both / either / neither according to availability
        DSH fixes/tests itself and continues
        ↓
Acceptance-ready candidate
        ↓
DSH commits/pushes exact head + updates PR/evidence
        ↓
same bounded git-only review task
  ├─→ ChatGPT via mcp-chatgpt
  └─→ fresh native Codex subagent
        ↓
Any available reviewer has blocking finding?
  yes → DSH fixes/tests → fresh bounded review attempts
  no  → record PASS/UNAVAILABLE states → Ticket completion gate
```

DSH never uses a reviewer failure, timeout, quota limit, or hard problem as a reason to stop. A returned blocking review is another implementation loop; helper unavailability causes fallback, not deadlock.

## 8. Planning, debug, and review protocol

### Startup planning — ChatGPT preferred

Before first production edits, DSH attempts:

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

If ChatGPT responds, DSH uses/evaluates that plan before production coding. If ChatGPT is unavailable after the bounded attempt, DSH records the reason and proceeds with its own repository-grounded plan. Durable authority is unchanged either way.

### Hard-debug and exact-head review — same task to ChatGPT and Codex

DSH constructs one task body and makes bounded attempts to both reviewers.

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

DSH polls/waits only for a bounded period. A timed-out/limited/unavailable reviewer is recorded `UNAVAILABLE`, then DSH proceeds with the other reviewer or alone. Codex is never treated as a persistent thread.

## 9. Review semantics

For an exact candidate head, DSH records each reviewer as one of:

```text
PASS
UNAVAILABLE <reason>
BLOCKING <finding>
```

Completion review succeeds when no available reviewer has an unresolved blocking finding. Two PASSes are preferred, not mandatory.

Examples:

```text
PASS / PASS            -> reviewer gate satisfied
PASS / UNAVAILABLE     -> reviewer gate satisfied
UNAVAILABLE / PASS     -> reviewer gate satisfied
UNAVAILABLE / UNAVAILABLE -> reviewer gate satisfied by fallback
BLOCKING / PASS        -> not satisfied
PASS / BLOCKING        -> not satisfied
```

Any production-code change makes prior review/availability records stale. DSH revalidates and makes fresh review attempts for the new exact head.

For product/architecture decisions, durable authority remains binding. ChatGPT unavailability does not grant DSH authority to invent product behavior, and Codex review never grants product authority.

## 10. Completion gate

```text
TicketComplete =
  every acceptance criterion == PASS
  AND required automated/runtime/device/human gates == satisfied
  AND final candidate == committed + pushed
  AND durable evidence == tied to tested implementation
  AND bounded exact-head ChatGPT review attempt == PASS or UNAVAILABLE
  AND bounded exact-head Codex review attempt == PASS or UNAVAILABLE
  AND no available reviewer has unresolved blocking finding
  AND no unresolved blocker
  AND worktree == clean (except documented external/runtime artifacts)
  AND DSH closeout == durable
```

Reviewer `UNAVAILABLE` is a documented fallback state, not a failed Ticket. It does not excuse any non-review acceptance requirement.

## 11. Closeout and successors

DSH closeout records:

- final SHA/PR;
- acceptance matrix;
- evidence refs;
- ChatGPT final review result or `UNAVAILABLE` reason tied to the final SHA;
- Codex final subagent result or `UNAVAILABLE` reason tied to the final SHA, with invocation reference when available;
- residual uncertainty/deferrals.

The dispatcher then retires/reconciles DSH and recomputes the ready frontier. A successor gets a fresh named DSH session in its own branch/worktree. It does not replay predecessor chat history. Its Codex help/review calls are fresh native subagent invocations.

## 12. Parallelism and scarce resources

Multiple logically ready Tickets may run concurrently up to configured active capacity. Shared mutable resources such as the real Rokid remain separately leased/scheduled; resource contention never becomes a fake `Blocked by` edge.

Codex subagent concurrency is an execution/resource concern of DSH/native provider, not a Ticket-DAG dependency and not persistent Ticket worker count.

## 13. Native-Codex deployment transition

VALIDATED by Bootstrap Ticket #19 against the pinned DSH deployment; automatic Ticket execution is now enabled (dispatcher `wakeAgents` defaults to `true`, watchdog heartbeat defaults to 120s). Evidence: `docs/evidence/ticket-19-native-codex-dispatcher-2026-08-21.md` and the PR that raises the dispatcher and pinned workflow composition to the current native-Codex protocol. Verified and under test:

- deterministic named DSH admission/restart (exact identity `dsh-glasses-<milestone>-#<n>-DSH`, same session reconstructed on restart, no duplicates);
- 120-second-default configurable DSH watchdog with no duplicate admission across repeated reconciles;
- generated DSH bootstrap includes the bounded ChatGPT-plan attempt before code;
- generated DSH bootstrap includes best-effort ChatGPT + fresh-Codex hard-help/review with explicit availability fallback (`UNAVAILABLE` never blocks; technical `UNPASSED`/`REQUEST_CHANGES` findings do);
- native Codex subagent tool/provider is exposed to admitted DSH agents and verified with two real fresh one-shot self-contained non-mutating `subagent_codex` invocations in the Ticket worktree;
- hard-debug and final review use fresh native Codex invocations in the Ticket worktree;
- the dispatcher contains no persistent Codex lifecycle state (asserted: no Codex session/thread persisted);
- existing frontier, moving-base, failed-fetch, rollback, credential, identity-collision, and resource-separation guarantees remain intact.
