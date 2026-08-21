# dsh-glasses engineering workflow

This document defines the operational workflow around the stable rules in `AGENTS.md`. GitHub and the repository are durable workflow state; agent conversations are replaceable working contexts.

## 1. Lifetimes and topology

```text
ChatGPT project = dsh-glasses
└── ChatGPT session = CTO                   persistent across project

Milestone N
├── Ticket #A
│   └── dsh-glasses-MN-#A-DSH               persistent Ticket executor
│       └── fresh Codex subagent             escalation only
├── Ticket #B
│   └── dsh-glasses-MN-#B-DSH
└── Ticket Dispatcher                        deterministic DSH lifecycle glue
```

Lifetime rule:

```text
ChatGPT = project-long persistent first-line helper
DSH     = Ticket-long persistent executor
Codex   = request-long ephemeral escalation helper
```

DSH reaches ChatGPT through `mcp-chatgpt` at exactly:

```text
ChatGPT project = dsh-glasses
ChatGPT session = CTO
```

Codex is never pre-created. Every `subagent_codex` invocation is fresh, uses the parent DSH Ticket worktree, receives a self-contained task, and returns its result to DSH.

## 2. Responsibilities

### ChatGPT

ChatGPT is the default implementation planner, progress supervisor, hard-problem helper, and exact-head reviewer. It is always tried first for those interactions.

### DSH

DSH is the sole implementer. It codes, tests, debugs, operates runtime/device paths, captures evidence, manages git/PR state, reports to the active helper, and continues until TicketComplete.

DSH must not create its own implementation plan/to-do list while either ChatGPT or Codex is available to provide one.

### Codex

Codex performs the same Ticket-level helper functions as ChatGPT when escalated, but is **never called in parallel with ChatGPT**. It is summoned only when ChatGPT is unavailable or when the same problem/review chain remains unresolved after three complete ChatGPT loops.

Codex must not modify the Ticket worktree; DSH remains the sole code author.

### Ticket Dispatcher

The dispatcher computes the declared ready frontier and materializes/maintains DSH runtime state only. It does not plan work, review code, or own Codex lifecycle.

## 3. Sequential helper routing

The canonical helper chain is:

```text
ChatGPT first
    ↓ unavailable OR same chain unresolved after 3 complete loops
fresh Codex subagent
    ↓ unavailable
DSH continues alone
```

DSH **never sends the same workflow request to ChatGPT and Codex concurrently**.

`UNAVAILABLE` means an objective execution failure such as timeout, quota/rate/usage-limit exhaustion, provider outage, or transport/tool failure. A technical disagreement, `UNPASSED`, `REQUEST_CHANGES`, or blocking finding is not unavailability.

One complete ChatGPT loop is:

```text
DSH request
→ ChatGPT guidance/blocking verdict
→ DSH implements/fixes + validates
→ same problem/review chain still unresolved/non-passing
```

After the third unsuccessful loop, DSH does not start a fourth ChatGPT loop for that same chain. It escalates the next request to a fresh Codex subagent.

Codex escalation is scoped to that unresolved chain. Once resolved, ordinary workflow interactions return to ChatGPT-first.

## 4. Ticket-start planning

Every Ticket begins with a helper-produced detailed implementation/validation plan and ordered to-do list.

After reading durable authority and inspecting relevant source/tests, but before production edits:

```text
DSH → ChatGPT: detailed plan/to-do request
        ↓
      available → use plan
        ↓ unavailable
DSH → fresh Codex: same planning role
        ↓
      available → use Codex plan
        ↓ unavailable
DSH → self-plan as last resort
```

DSH must never self-plan while ChatGPT or Codex is available.

The plan should contain numbered/checkable items with implementation outcome, validation, and evidence/acceptance mapping where useful.

If a helper plan conflicts with durable authority, DSH requests correction. If the same planning problem survives three ChatGPT loops, DSH escalates it to Codex under the standard rule.

## 5. Per-to-do completion checkpoints

After **every completed to-do item**, DSH must report completion before silently proceeding through additional items.

Recommended progress payload:

```text
request-id: <unique>
kind: progress
repo: code2hack/dsh-glasses
milestone: <milestone>
ticket: #<number>
todo-item: <id + description>
status: completed
base: <exact base>
branch: <branch>
head: <current SHA or working-tree state>
result: <what changed / what was proved>
validation: <checks performed>
evidence: <paths/refs>
next: <next to-do item>
```

Routing is sequential:

- ChatGPT first for normal checkpoints;
- Codex only if ChatGPT is unavailable for that checkpoint or the checkpoint belongs to an already Codex-escalated unresolved chain;
- if both are unavailable, record the checkpoint durably where appropriate and continue.

If the helper returns a bounded correction or updates the remaining to-do list consistently with durable authority, DSH incorporates it before continuing.

## 6. Milestone lifecycle

At Milestone start, ChatGPT refreshes from durable state:

1. current `origin/main`;
2. current `SPEC.md` and relevant accepted ADR/design artifacts;
3. previous Milestone closeout/deferrals;
4. current source where needed.

ChatGPT then defines the Milestone goal, non-goals, tracer-bullet Tickets, `Blocked by` DAG, human gates, and Milestone acceptance.

Tickets remain narrow vertical slices. Logical dependencies belong in `Blocked by`; shared hardware contention does not.

## 7. Ticket contract

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
- <durable evidence paths needed for planning/progress/review records>

## Out of scope
- <important nearby behavior intentionally excluded>
```

The Ticket gives DSH enough durable context to execute without replaying prior conversations. Codex invocations remain self-contained and git-grounded.

## 8. Ticket Dispatcher

For each ready unclaimed Ticket within active capacity:

```text
GitHub Ticket + Milestone
    -> resolve exact current base
    -> create dedicated branch/worktree
    -> create named persistent DSH session
       name = <project>-<milestone>-#<ticket>-DSH
    -> persist Ticket <-> DSH <-> worktree <-> base binding
    -> wake/bootstrap DSH
       require helper-produced detailed plan/to-do before code
       require ChatGPT-first / Codex-escalation routing
       require no parallel ChatGPT+Codex requests
       require 3-loop escalation rule
       require progress report after every completed to-do item
       require sequential final review
       require both-unavailable fallback without deadlock
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
- no Codex thread/session lifecycle in dispatcher state.

The dispatcher must never create/name/seed/persist/resume/reconstruct/poll/retire Codex threads. DSH owns native Codex invocation on demand.

### DSH liveness watchdog

The dispatcher periodically checks every unfinished admitted Ticket's DSH state. Default polling/heartbeat interval is **120 seconds**, configurable through the normal dispatcher configuration surface.

If the bound DSH session is stopped/quiescent while Ticket completion is false, the dispatcher resumes/wakes the **same DSH session** with a minimal continuation instruction. It must not create a replacement session merely because the existing one became idle.

A completed Ticket is never re-woken. A Ticket must not remain permanently waiting only because ChatGPT/Codex is unavailable; resumed DSH applies the sequential fallback and continues.

Prefer supported DSH lifecycle/turn state over a fragile inactivity heuristic.

## 9. Ticket execution loop

```text
Dispatcher starts DSH
        ↓
DSH inspects Ticket/source/tests
        ↓
obtain detailed plan/to-do list
  ChatGPT first
  unavailable → fresh Codex
  both unavailable → DSH self-plan
        ↓
for each to-do item
  implement + validate
        ↓
  report completion
    ChatGPT first
    unavailable / already-escalated chain → Codex
    both unavailable → record + continue
        ↓
hard/stuck problem?
  yes → ChatGPT first
        ├─ unavailable → fresh Codex
        ├─ 3 unsuccessful ChatGPT loops → fresh Codex
        └─ helper path unavailable → DSH continues itself
        ↓
acceptance-ready candidate
        ↓
sequential exact-head review
  ChatGPT PASS → done; do NOT call Codex
  ChatGPT unavailable → Codex review
  ChatGPT still non-pass after 3 loops → Codex review
        ↓
Ticket completion gate
```

## 10. Planning/progress/debug/review protocol

### ChatGPT transport

```text
mcp-chatgpt
-> ChatGPT project = dsh-glasses
-> ChatGPT session = CTO
```

### Codex transport

```text
native DSH Codex subagent (`subagent_codex` or pinned supported equivalent)
-> fresh request-long invocation
-> parent DSH Ticket worktree
-> self-contained prompt
-> final result returned to DSH
```

Standard request body:

```text
request-id: <unique id>
kind: plan | progress | review | debug
repo: code2hack/dsh-glasses
milestone: <milestone>
ticket: #<number>
base: <base ref + exact resolved SHA>
branch: <branch>
head: <current exact SHA>
pr: <PR number/url if present>
paths: <relevant repository/evidence paths>
question: <smallest concrete request>
```

For planning, request a detailed ordered implementation/validation to-do list.

For progress, identify the completed to-do item, result, validation/evidence, and next item.

For Codex, always add: inspect/reason/report only; do not modify the Ticket worktree.

Do not paste complete logs or old conversations. Reduce diagnostics into bounded durable evidence and pass repository/path references.

## 11. Hard-problem escalation

Ordinary defects remain DSH's responsibility.

A hard/stuck problem is one where bounded local debugging has not resolved the failure, the next edit would be speculative, a critical supported API/runtime invariant is uncertain, or another blocker prevents reliable progress.

DSH asks ChatGPT first. If ChatGPT is unavailable, invoke Codex. If the same problem remains unresolved after three complete ChatGPT loops, invoke Codex instead of a fourth loop.

If Codex is unavailable too, DSH continues independently. Known valid blocking findings still must be resolved or disproved with validation/evidence.

## 12. Sequential final review

For the final exact head:

```text
ChatGPT review
  PASS
    -> reviewer gate satisfied; Codex NOT called
  UNAVAILABLE
    -> fresh Codex review
  BLOCKING / UNPASSED
    -> DSH fixes + validates + asks ChatGPT again
    -> after third unsuccessful loop: fresh Codex review
```

If escalated Codex returns `PASS`, the reviewer gate is satisfied. If Codex returns blocking findings, DSH fixes/validates and continues that Codex escalation chain.

If the required helper path is unavailable, DSH may fall back to independent validation, but it may not silently ignore any known unresolved valid blocking finding.

Any production-code change invalidates prior PASS/UNAVAILABLE review evidence for the new head.

## 13. Completion gate

```text
TicketComplete =
  every acceptance criterion == PASS
  AND required automated/runtime/device/human gates == satisfied
  AND final candidate == committed + pushed
  AND durable evidence == tied to tested implementation
  AND plan/to-do source follows ChatGPT -> Codex -> self-plan order
  AND every completed to-do item has required progress checkpoint or both-unavailable record
  AND final review follows sequential ChatGPT-first escalation
  AND no known unresolved blocking helper finding
  AND no unresolved blocker
  AND worktree == clean (except documented external/runtime artifacts)
  AND DSH closeout == durable
```

Helper unavailability never excuses non-review acceptance requirements.

## 14. Closeout and successors

DSH closeout records:

- final SHA/PR;
- acceptance matrix;
- evidence refs;
- plan source and ordered to-do list;
- per-to-do progress checkpoint record;
- final helper/review route and verdict;
- ChatGPT loop count and Codex escalation reason when escalation occurred;
- helper unavailability reasons;
- residual uncertainty/deferrals.

The dispatcher then retires/reconciles DSH and recomputes the ready frontier. A successor gets a fresh named DSH session in its own branch/worktree and starts a new ChatGPT-first helper chain.

## 15. Parallelism and scarce resources

Multiple logically ready Tickets may run concurrently up to configured active capacity. Shared mutable resources such as the real Rokid remain separately leased/scheduled; resource contention never becomes a fake `Blocked by` edge.

Codex subagent use is an execution/resource concern of DSH/native provider, not a Ticket-DAG dependency and not persistent Ticket worker count.

## 16. Native-Codex deployment transition

VALIDATED by Bootstrap Ticket #19 against the pinned DSH deployment; automatic Ticket execution is now enabled (dispatcher `wakeAgents` defaults to `true`, watchdog heartbeat defaults to 120s). Evidence: `docs/evidence/ticket-19-native-codex-dispatcher-2026-08-21.md` and the PR that raises the dispatcher and pinned workflow composition to the current native-Codex sequential protocol. Verified and under test:

- deterministic named DSH admission/restart (exact identity `dsh-glasses-<milestone>-#<n>-DSH`, same session reconstructed on restart, no duplicates);
- 120-second-default configurable DSH watchdog with no duplicate admission across repeated reconciles;
- generated bootstrap REQUIRES a helper-produced detailed plan/ordered to-do list before code: ChatGPT first, fresh Codex only if ChatGPT is unavailable, DSH self-plan only if both helpers are unavailable;
- generated bootstrap REQUIRES progress reporting after every completed to-do item (ChatGPT first; Codex only on escalation/unavailability; both unavailable -> record durably and continue);
- ChatGPT and Codex are NEVER requested in parallel for the same planning/progress/debug/review step;
- Codex is used only when ChatGPT is unavailable or the same problem/review chain survives three complete ChatGPT loops;
- final review is sequential ChatGPT-first: ChatGPT PASS -> no Codex; ChatGPT unavailable or three-loop unresolved -> fresh Codex; both unavailable -> independent completion only with every non-review gate passing and no unresolved known blocking finding;
- native Codex subagent tool/provider is exposed to admitted DSH agents and verified with two real fresh one-shot self-contained non-mutating `subagent_codex` invocations in the Ticket worktree;
- the dispatcher contains no persistent Codex lifecycle state (asserted: no Codex session/thread persisted);
- existing frontier, moving-base, failed-fetch, rollback, credential, identity-collision, and resource-separation guarantees remain intact.

