# dsh-glasses engineering workflow

This document defines the project workflow around the stable rules in `AGENTS.md`. GitHub and the repository are durable workflow state; agent conversations are replaceable working contexts.

## 1. Lifetimes and ownership

```text
Project
└── one persistent ChatGPT CTO session: `CTO`
    ├── Milestone N
    │   ├── Ticket A -> fresh DSH Ticket Lead + fresh Codex Coder
    │   ├── Ticket B -> fresh DSH Ticket Lead + fresh Codex Coder
    │   └── Ticket C -> fresh DSH Ticket Lead + fresh Codex Coder
    └── Milestone N+1
        └── fresh Ticket workers again
```

The CTO gets continuity. Ticket workers get freshness. Durable truth lives in SPEC/ADRs, GitHub Milestones/Tickets/PRs, source/tests, and accepted evidence.

## 2. Milestone lifecycle

The project-long `CTO` session owns milestone design and ticket decomposition.

### Start a milestone

The CTO rebases its working understanding from current durable state before planning:

1. current `origin/main`;
2. current `SPEC.md` and accepted ADR/design artifacts relevant to the milestone;
3. previous milestone closeout and unresolved/deferred work;
4. current architecture/source where inspection is needed.

Historical chat context is advisory when it conflicts with these sources.

The CTO then defines:

- milestone destination and success criteria;
- explicit non-goals/boundaries;
- tracer-bullet Tickets;
- logical `Blocked by` edges and ready frontier;
- any required human gates;
- milestone-level acceptance.

Tickets should be narrow vertical slices, independently verifiable, and sized for one fresh DSH/Codex pair.

### Close a milestone

A milestone closes only after its required Tickets are complete and milestone acceptance passes against the integrated current state. The closeout records the accepted main SHA, delivered behavior, durable decisions, evidence, and explicit deferrals. Any discovered gap becomes a new Ticket rather than an undocumented continuation.

The same CTO session continues to the next milestone; milestone boundaries are state-rebase checkpoints, not mandatory new conversations.

## 3. Ticket contract

Each implementation Ticket should contain:

```markdown
## Milestone
<parent milestone>

## What to build
<one observable end-to-end behavior>

## Acceptance criteria
- [ ] checkable criterion
- [ ] checkable criterion

## Blocked by
- <logical blockers, or None>

## Gate
`autonomous` or the exact human-required action/decision

## Design sources
- <specific SPEC sections / ADRs / approved design artifact>

## Validation
- <required automated/runtime/device checks>

## Evidence
- <what must be preserved for CTO review>

## Out of scope
- <important nearby behavior intentionally excluded>
```

Avoid implementation recipes unless a prototype/schema/state-machine fragment is itself an approved design decision. The Ticket specifies behavior and proof; Codex retains implementation freedom inside accepted architecture.

## 4. Ticket execution lifecycle

```text
READY Ticket
    -> fresh DSH Ticket Lead bootstraps
    -> fresh Codex Coder implements + committed tests
    -> DSH independently validates exact candidate
       -> ordinary implementation failure: bounded feedback to Codex
       -> hard/ambiguous failure: evidence packet -> CTO debug request
       -> product/architecture ambiguity: CTO decision request
    -> all Ticket acceptance passes
    -> DSH commits/pushes and prepares/updates PR
    -> CTO reviews exact PR head
       -> REQUEST_CHANGES: Codex -> DSH validation -> new exact-head review
       -> APPROVE current head: Ticket closeout gate
    -> durable closeout / authorized merge
```

Codex may run tests while developing, but DSH must independently rerun the Ticket acceptance surface. A worker-reported success is not independent acceptance evidence.

## 5. CTO request protocol

GitHub is the durable mailbox. Browser/CDP communication may wake the `CTO` session, but request content, evidence, and verdicts belong on the Ticket or PR.

Only three blocking request kinds are expected:

### Review request

Use the candidate PR. Include:

```text
request-id: <unique id>
kind: review
ticket: <number>
head: <exact SHA>
acceptance: <PASS/FAIL matrix>
evidence: <durable refs>
question: review this exact candidate
```

The CTO verdict is `APPROVE` or `REQUEST_CHANGES` and identifies the reviewed head. Any later code change invalidates the approval.

### Debug request

Use the Ticket unless the failure is specifically about the PR diff. Include only a tight packet:

```text
request-id
exact head/build/environment
minimal reproduction
expected vs observed
bounded trace/log/screenshot references
hypotheses already falsified/tested
smallest concrete question
```

The CTO diagnoses or requests the next discriminating observation. DSH remains responsible for collecting/rerunning the evidence.

### Decision request

Use when execution cannot proceed without changing/clarifying product, architecture, UX, or a human-owned gate. The durable answer must update the Ticket and, when appropriate, SPEC/ADR/design authority before implementation continues.

## 6. Parallelism and scarce resources

The Ticket DAG expresses causal/logical dependencies only. Do not add a dependency merely because two independent Tickets need the same physical device or host.

Shared mutable resources are scheduled separately. In particular, real-Rokid qualification is an exclusive lease: only one worker may perform a conflicting device test/install/debug sequence at a time. Other ready Tickets may continue host-side coding/testing while waiting for that lease.

Worker concurrency should follow the deployment's actual model/runtime capacity and evidence bottlenecks; capacity is a ceiling, not a requirement to keep every slot occupied.

## 7. Evidence and exact-head discipline

Evidence must identify what was actually tested: commit/head, relevant build variant, environment/device when material, reproduction/action, observed result, and limitations. Keep raw bulky artifacts out of ChatGPT context when a durable bounded reference is sufficient.

The review unit is an exact Git commit, not "the branch approximately as reviewed". After an approved head changes, revalidate affected acceptance and obtain a new CTO review.

## 8. Closeout, successor bootstrap, and archival

The outgoing DSH Ticket Lead records a compact durable closeout on the Ticket/PR containing:

- final SHA/PR;
- acceptance results;
- evidence references;
- CTO verdict + reviewed SHA;
- remaining uncertainty/deferrals.

The milestone DAG determines the next ready frontier. The outgoing worker may launch a prescribed successor, but does not invent new scope or reorder the DAG.

A successor is a fresh DSH session with a fresh Codex thread. It reads `AGENTS.md`, its own Ticket, required linked authority, and dependency closeouts; it does not need the predecessor transcript. Archive/retire the predecessor once its closeout is durable and any required successor bootstrap has confirmed the needed context.

## 9. TB0 transition

TB0 established the ADB-only one-session text-loop MVP and its reproducible host/device-debug foundations. Its tracer and evidence documents remain historical/conditional references. New work should be planned as Milestones and GitHub Tickets rather than by editing a "current slice" section in `AGENTS.md`.
