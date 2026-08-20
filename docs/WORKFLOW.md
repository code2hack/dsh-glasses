# dsh-glasses engineering workflow

This document defines the project workflow around the stable rules in `AGENTS.md`. GitHub and the repository are durable workflow state; agent conversations are replaceable working contexts.

## 1. Lifetimes and ownership

```text
ChatGPT project: `dsh-glasses`
└── one persistent CTO session: `CTO`
    ├── Milestone N
    │   ├── Ticket Dispatcher materializes the ready frontier
    │   ├── Ticket A -> fresh DSH Ticket Lead + fresh Codex Coder
    │   ├── Ticket B -> fresh DSH Ticket Lead + fresh Codex Coder
    │   └── Ticket C -> fresh DSH Ticket Lead + fresh Codex Coder
    └── Milestone N+1
        └── fresh Ticket workers again
```

The CTO gets continuity. Ticket workers get freshness. The Ticket Dispatcher is deterministic runtime glue, not another planning agent. Durable truth lives in SPEC/ADRs, GitHub Milestones/Tickets/PRs, source/tests, and accepted evidence.

The stable logical CTO identity is ChatGPT project `dsh-glasses`, session `CTO`. Browser/CDP automation must not resolve that target by fuzzy title/sidebar search. The machine-local `cto-bridge` configuration pins the opaque ChatGPT project/conversation identifiers and exact conversation URL used for routing, while GitHub remains the durable request/response surface.

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

The first post-TB0 product Milestone must not start until the bootstrap Ticket Dispatcher is accepted. Once available, the dispatcher—not a Ticket Lead—materializes the CTO-declared ready frontier into independent DSH root sessions/worktrees.

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

## 4. Ticket Dispatcher

The dispatcher owns no product reasoning. It repeatedly reconciles durable Ticket/DAG state into runtime worker state:

```text
GitHub Tickets + Blocked-by edges
    -> compute ready + unclaimed frontier
    -> apply configured active-Ticket capacity
    -> create/verify dedicated branch + worktree
    -> create one independent root DSH session/agent
    -> send Ticket bootstrap
    -> retain Ticket <-> session <-> branch/worktree binding
    -> later reconcile closeout/failure/restart
```

Required properties:

- **Deterministic frontier:** readiness comes only from declared Ticket state and blocker completion; no LLM prioritization or inferred dependency.
- **Idempotent admission:** repeated reconcile or dispatcher restart must not create duplicate Ticket Leads for an already claimed/running Ticket.
- **Independent roots:** parallel Tickets use separate root DSH sessions and mutable worktrees; they are not DSH Agent-Team members and do not share conversation state.
- **Capacity is separate from existence:** the active-Ticket limit controls admitted workers; vLLM `max_seqs` is an inference ceiling rather than a session-count definition. Initial project default is 3 active Tickets unless deliberately reconfigured.
- **Rollback:** failed worktree/session publication must not leave durable state falsely claiming that a worker exists.
- **No successor authority in workers:** after Ticket closeout the dispatcher recomputes the whole frontier and starts newly ready work.

The dispatcher may expose deterministic reconcile/status controls and local operational bindings. GitHub remains durable workflow truth; runtime binding state must be reconstructable/reconcilable rather than becoming a second project-management database.

## 5. Ticket execution lifecycle

```text
Dispatcher admits READY Ticket
    -> fresh DSH Ticket Lead independently verifies bootstrap
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
    -> dispatcher reconciles frontier
```

Codex may run tests while developing, but DSH must independently rerun the Ticket acceptance surface. A worker-reported success is not independent acceptance evidence.

## 6. CTO request protocol

GitHub is the durable mailbox. Browser/CDP communication may wake the canonical ChatGPT endpoint `dsh-glasses` / `CTO`, but request content, evidence, and verdicts belong on the Ticket or PR.

The `cto-bridge` owns browser routing. Its target configuration should pin, once the CTO session exists, the exact ChatGPT project ID, conversation/session ID, and canonical conversation URL, with the expected names `dsh-glasses` / `CTO` retained as verification metadata. DSH workers address the logical CTO endpoint through the bridge and must not discover or guess these opaque identifiers themselves.

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

## 7. Parallelism and scarce resources

The Ticket DAG expresses causal/logical dependencies only. Do not add a dependency merely because two independent Tickets need the same physical device or host.

The dispatcher may admit multiple logically ready Tickets concurrently. Shared mutable resources are scheduled separately. In particular, real-Rokid qualification is an exclusive lease: only one worker may perform a conflicting device test/install/debug sequence at a time. Other ready Tickets may continue host-side coding/testing while waiting for that lease.

Worker concurrency should follow the deployment's actual model/runtime capacity and evidence bottlenecks; capacity is a ceiling, not a requirement to keep every slot occupied.

## 8. Evidence and exact-head discipline

Evidence must identify what was actually tested: commit/head, relevant build variant, environment/device when material, reproduction/action, observed result, and limitations. Keep raw bulky artifacts out of ChatGPT context when a durable bounded reference is sufficient.

The review unit is an exact Git commit, not "the branch approximately as reviewed". After an approved head changes, revalidate affected acceptance and obtain a new CTO review.

## 9. Closeout, successor bootstrap, and archival

The outgoing DSH Ticket Lead records a compact durable closeout on the Ticket/PR containing:

- final SHA/PR;
- acceptance results;
- evidence references;
- CTO verdict + reviewed SHA;
- remaining uncertainty/deferrals.

The outgoing worker does not choose or launch sibling/successor Tickets. The dispatcher reads the durable closeout/state, recomputes the Milestone frontier, and creates any newly admissible fresh Ticket Leads within capacity.

A successor is a fresh DSH session with a fresh Codex thread. It reads `AGENTS.md`, its own Ticket, required linked authority, and dependency closeouts; it does not need the predecessor transcript. The predecessor may be archived/retired once its closeout is durable; successor creation is independent of predecessor liveness.

## 10. TB0 transition

TB0 established the ADB-only one-session text-loop MVP and its reproducible host/device-debug foundations. Its tracer and evidence documents remain historical/conditional references. New work should be planned as Milestones and GitHub Tickets rather than by editing a "current slice" section in `AGENTS.md`.
