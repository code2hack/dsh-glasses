# dsh-glasses engineering workflow

This document operationalizes AGENTS.md without assigning manager, worker, or expert roles to a product, process, conversation, model, or agent implementation.

GitHub and Git are durable project state. Runtime identities, models, transports, and capacity are live bindings supplied by the owner.

## 1. Runtime bootstrap

Before normal Ticket work, obtain the current runtime configuration:

    Ticket Manager
    - runtime identity and control channel

    Ticket Workers
    - worker mechanism
    - naming convention
    - maximum active count
    - resume/recovery mechanism

    First-line Project Expert
    - provider and transport
    - project/conversation/session identity
    - model and reasoning effort
    - concurrency constraints

    Second-line Project Expert
    - provider and transport
    - project/conversation/session/thread identity
    - model and reasoning effort
    - concurrency constraints

    Shared resources
    - host/device constraints
    - scarce hardware allocation
    - current Rokid ADB host, route, and device selector

These values remain runtime state. Do not commit them into AGENTS.md, this file, Tickets, source, or committed configuration. Use owner-supplied values exactly; never infer a replacement from a similar name.

One runtime agent may fill multiple logical roles when the owner says so. Keep role duties and routing distinct.

## 2. Responsibility split

Ticket Manager:

- reconcile GitHub and origin/main;
- compute the ready frontier from declared dependencies;
- enforce capacity and resource constraints;
- create and recover dedicated branches/worktrees/workers;
- propagate runtime bindings and workflow rules;
- observe durable completion and dispatch successors.

Ticket Worker:

- implement;
- test;
- operate required runtime/devices;
- debug;
- collect durable evidence;
- commit/push/update PR;
- perform expert interactions and checkpoints;
- write closeout.

First-line Project Expert:

- produce implementation/validation plans and ordered to-do lists;
- review per-item progress;
- solve hard problems;
- review exact candidate heads;
- clarify product/architecture under durable authority.

Second-line Project Expert:

- perform the same Ticket-level helper functions after valid escalation or first-line unavailability.

The manager does not routinely implement Ticket code. Workers do not dispatch successors. Experts inspect/reason/report unless the current owner binding explicitly assigns separate implementation authority.

## 3. Manager reconcile loop

Reconcile at bootstrap and whenever a worker report, completion, owner instruction, or runtime event changes project state:

    refresh origin/main and GitHub
    -> inspect active Ticket bindings
    -> recover unfinished stopped workers
    -> observe durable closeouts
    -> recompute ready frontier
    -> apply capacity/resource constraints
    -> admit ready Tickets
    -> verify admitted workers are active/progressing
    -> end the manager turn and wait for worker reports

Durable dependency declarations decide logical readiness. Scarce hardware may delay execution without inventing a Blocked by edge.

Do not poll active workers. Once every admitted worker is confirmed working and no immediate manager action remains, yield control; worker reports wake the manager for the next reconciliation.

If readiness depends on product meaning, ask the first-line expert rather than inventing policy.

## 4. Ticket readiness and admission

A Ticket is eligible when:

- execution state permits work;
- every declared blocker is complete;
- no active owner exists;
- its contract is executable;
- capacity and shared resources permit admission;
- no conflicting branch/worktree exists;
- it has no durable completed closeout.

Admission:

    resolve exact current base
    -> create dedicated branch/worktree
    -> create one runtime Ticket Worker
    -> supply bootstrap
    -> record runtime binding

Record:

    Ticket
    <-> worker runtime identity
    <-> branch/worktree
    <-> exact admitted base SHA

Do not create duplicate ownership.

## 5. Worker bootstrap

Supply each worker:

- Ticket and Milestone;
- exact admitted base;
- branch and worktree;
- worker runtime identity;
- current authority-reading order;
- current first-line and second-line expert bindings;
- sequential routing and shared-expert serialization rules;
- mandatory expert-produced plan;
- self-plan prohibition while an expert is available;
- mandatory per-to-do checkpoints;
- three-loop escalation;
- exact-head final review;
- TicketComplete predicate;
- disposable DSH test-isolation rule.

The worker reads current AGENTS.md, the Ticket, linked durable authorities, and relevant source/tests before requesting its plan.

## 6. Sequential expert routing

For every planning, progress, hard-problem, and review interaction:

    First-line Expert
        ↓
    objectively unavailable
    OR same unresolved chain survives 3 complete first-line loops
        ↓
    Second-line Expert
        ↓
    objectively unavailable
        ↓
    Worker continues independently where permitted

Never contact both experts concurrently for one interaction. Serialize turns against any shared persistent conversation/thread.

UNAVAILABLE means a bounded attempt failed objectively: timeout, quota/rate exhaustion, provider outage, or unusable transport. REQUEST_CHANGES, disagreement, and technical failure are usable results, not unavailability.

One loop is request -> expert result -> worker fix/application -> worker validation -> same chain still unresolved. After three unsuccessful first-line loops, route that chain second-line instead of starting loop 4. New independent interactions remain first-line.

## 7. Ticket-start planning

Before production edits, request a detailed implementation/validation plan and ordered to-do list from:

1. First-line expert.
2. Second-line expert only after valid escalation/unavailability.
3. Worker itself only if both experts are unavailable.

Record PLAN_SOURCE as FIRST_LINE, SECOND_LINE, or WORKER_SELF.

The plan covers acceptance criteria, implementation paths, tests, runtime/device checks, evidence, PR work, and closeout. Resolve conflicts with higher authority before implementation.

## 8. Execution and progress checkpoints

Execute and validate one to-do item, checkpoint it, then continue.

Minimum checkpoint:

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
    question: Identify any blocking correction before continuation; otherwise confirm continuation.

Route first-line unless this exact chain is already second-line. If both experts are unavailable, record the checkpoint durably and continue where permitted.

## 9. Hard-problem workflow

Workers solve ordinary defects inside the plan.

A problem is hard/stuck when bounded local debugging fails, the next edit would be speculative, or a critical supported invariant is uncertain. Route it through the sequential chain. Known valid blocking findings remain binding until resolved or disproved even if an expert later becomes unavailable.

## 10. Final review

For an acceptance-ready Ticket:

    complete validation/evidence
    -> commit and push exact head
    -> update PR/evidence
    -> first-line exact-head review

PASS satisfies the reviewer gate without second-line review.

UNAVAILABLE routes the same head second-line.

A blocking verdict starts fix -> validate -> push -> re-review. After the third unsuccessful first-line review loop for the same chain, the next review is second-line.

Any production-code change invalidates review evidence for the prior head. Independent completion after both experts become unavailable is permitted only when every non-review gate passes and no known blocking finding remains.

## 11. Ticket completion and closeout

TicketComplete requires:

- all acceptance criteria PASS;
- required automated/runtime/device/human gates satisfied;
- exact final candidate committed and pushed;
- durable evidence tied to that implementation;
- valid plan source;
- required checkpoints;
- sequential final review;
- no unresolved expert finding or Ticket blocker;
- clean worktree except documented external/runtime artifacts;
- durable closeout.

Closeout records final SHA/PR, acceptance matrix, evidence, plan source, checkpoint summary, final review route/result, and residual uncertainty/deferral.

Do not merge by default. Merge only with current explicit authority. Workers do not dispatch successors; the manager observes closeout and recomputes readiness.

## 12. Worker and expert recovery

For unfinished work:

    active/progressing worker -> leave it alone
    stopped/quiescent worker -> resume the same worker when possible

Never create a replacement merely because a worker stopped. If runtime resume is impossible, preserve its branch/worktree and recover deliberately without duplicate ownership.

Recover experts through their configured runtime transports. Never guess a replacement identity. A binding that cannot be recovered is unavailable until the owner supplies another.

## 13. Rokid ADB binding and escalation

The Rokid ADB location is owner-supplied runtime state.

When a Ticket requires Rokid and its configured ADB target is absent or unreachable:

    worker records attempted host/route/device and observed ADB result
    -> worker reports to and wakes Ticket Manager
    -> worker pauses the device-dependent step
    -> manager asks owner for the current Rokid ADB binding
    -> manager supplies it to the same worker
    -> same worker resumes

Workers do not probe or guess alternate hosts, addresses, serials, transports, or devices. Independent non-device work may continue when it cannot invalidate the paused step.

## 14. Parallel work and shared resources

The manager controls active Ticket count and hardware allocation from current runtime configuration.

Logical readiness and physical resource availability are separate. A Ticket may be ready while waiting for hardware.

Serialize requests to a shared expert conversation/thread. Parallel Ticket workers must not race turns against it.

## 15. Disposable DSH test workflow

Every DSH or dsh-glasses-plugin test starts with an explicit disposable profile:

    create unique Ticket-specific temporary root outside ~/.dsh
    -> set DSH_HOME to that root for the test and every child
    -> verify the resolved path is neither ~/.dsh nor beneath it
    -> allocate disposable ports/process names
    -> run the test
    -> preserve required evidence
    -> remove only the validated disposable root

Fail before starting DSH when DSH_HOME is unset, empty, shared, or not demonstrably disposable.

All experimental presets, plugins, settings, credentials, sessions, and logs stay inside the disposable DSH_HOME. Workers never use ~/.dsh as a fixture, baseline, source, cache, fallback, restore target, or cleanup target.

If a runtime check truly requires the owner's shared DSH profile, it is not a worker test. Stop and obtain explicit owner authorization for that separately scoped operation.

## 16. Durable versus runtime configuration

Durable policy:

- logical role responsibilities;
- GitHub/Git authority;
- sequential expert routing;
- plan/checkpoint/review/completion rules;
- DSH test isolation;
- git/host hard guardrails.

Runtime configuration:

- manager identity;
- worker implementation, naming, recovery, and capacity;
- expert provider, project/conversation/session/thread, model, effort, transport, and endpoint;
- active host/device allocation, including the current Rokid ADB binding.

Changing runtime bindings requires an owner instruction, not a repository-policy edit.
