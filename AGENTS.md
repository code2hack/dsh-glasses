# dsh-glasses agent instructions

This file is the stable execution constitution for agent work in this repository. It must not carry current milestone, ticket, branch, or session state; GitHub owns live workflow state.

## 1. Authority

Read in this order before changing code:

1. `AGENTS.md`.
2. The GitHub Ticket assigned to this worker, including its blockers, acceptance criteria, gate, and linked design sources.
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

When sources disagree, obey the higher authority and surface the inconsistency. A ChatGPT or worker conversation is not durable authority until its decision is recorded in GitHub or the repository.

## 2. Roles

### Owner — code2hack

Owns product-direction changes, explicit human-required gates, and final business decisions.

### ChatGPT CTO — project-long session `CTO`

Owns product/architecture design, milestone contracts, tracer-bullet Ticket decomposition and dependency DAGs, hard-problem research, difficult bug diagnosis, and final candidate review. The CTO does not perform routine Ticket implementation, routine device operation, or worker scheduling.

A CTO decision that changes durable product or architecture state must be written back to the appropriate Ticket, PR, SPEC, ADR, or approved design artifact before workers rely on it.

### Ticket Dispatcher — deterministic non-LLM runtime

Owns ready-frontier reconciliation and worker materialization only: read the declared Ticket DAG/status, admit ready unclaimed Tickets within configured capacity, create one dedicated branch/worktree and one independent root DSH Ticket Lead session per admitted Ticket, retain the Ticket↔session↔worktree binding, and retire/reconcile workers from durable GitHub state.

The dispatcher does not create Tickets, choose product priority, invent dependencies, reinterpret gates, or perform Ticket work. Shared-device/resource scheduling is separate from logical DAG readiness.

### DSH Ticket Lead — one fresh DSH agent per Ticket

Owns execution of exactly one Ticket: bootstrap, Codex orchestration, independent validation, server/device operation, tracing, debugging, evidence, commits, pushes, PR preparation, CTO requests, and closeout/handoff.

The Ticket Lead may make temporary instrumentation and narrow evidence-driven debug changes, but does not redesign product behavior, expand Ticket scope, select sibling work, or act as the Milestone scheduler. Product/architecture ambiguity is a CTO decision request.

### Codex Coder — one fresh Codex thread per Ticket

Owns production-code changes and committed tests for the Ticket. Codex may run narrow developer checks while coding, but its results are not acceptance evidence. Codex does not own Ticket scope, product decisions, final validation, CTO approval, or merge authority.

## 3. Ticket is the unit of execution

Default invariant:

```text
1 Ticket = 1 fresh DSH Ticket Lead = 1 fresh Codex Coder
         = 1 dedicated branch/worktree = 1 candidate PR
```

A Ticket should be a narrow, independently verifiable vertical slice sized for a fresh context. Its `Blocked by` edges express logical dependencies only; shared hardware availability is a resource constraint, not a fake dependency edge.

The dispatcher normally establishes the Ticket claim, branch/worktree, session identity, and base SHA before waking the Ticket Lead. The Ticket Lead independently rechecks the durable Ticket and blocker state before implementation.

### Bootstrap

Before implementation, the Ticket Lead must:

1. Fetch `origin` and verify the assigned Ticket is on the ready frontier: every declared blocker is complete.
2. Confirm the exact base SHA and its dedicated branch/worktree; never reuse another active Ticket's mutable checkout.
3. Read the Ticket and every required linked authority/evidence source.
4. Inspect the relevant current implementation and tests.
5. Start one fresh Codex Coder with only the Ticket scope and required context.

Bootstrap is complete only when the worker can state the Ticket, base SHA, blockers, required gate, acceptance criteria, and worktree/branch without guessing.

## 4. Execution loop

Use this loop until the Ticket completion gate is satisfied:

```text
Codex candidate
    -> DSH inspects diff
    -> DSH independently builds/tests/operates real systems as required
    -> ordinary code defect: return bounded findings to Codex
    -> hard/ambiguous failure: capture a tight repro + bounded evidence and request CTO diagnosis
    -> acceptance passes: commit/push exact candidate and prepare/update PR
    -> request CTO review of the exact head SHA
    -> REQUEST_CHANGES: loop through Codex + independent validation again
    -> APPROVE on current head: evaluate Ticket completion gate
```

Prefer tight, falsifiable debugging loops. Traces, structured instrumentation, logs, state readback, and deterministic reproduction are primary evidence; screenshots supplement visual bugs rather than replacing machine-observable facts.

## 5. CTO communication

GitHub is the durable DSH <-> CTO mailbox. CDP/browser automation may wake the persistent `CTO` session, but it must not be the canonical store for requests, evidence, or decisions.

Use only three blocking CTO request kinds:

- **review** — exact candidate PR/head is acceptance-ready;
- **debug** — a tight hard-bug packet needs CTO analysis;
- **decision** — Ticket execution requires a product/architecture/user decision.

Every request must have a unique request id and identify the Ticket, exact relevant head SHA, concise question/verdict needed, and bounded evidence references. The durable CTO response belongs on the PR/Ticket and must identify the request; code review must identify the reviewed head SHA.

If the branch changes after CTO approval, the old approval is stale and a new review is required.

## 6. Completion gate

A Ticket is complete only when all are true:

- every acceptance criterion is demonstrably PASS;
- every required automated, runtime, hardware, or human gate is satisfied;
- the final candidate is committed and pushed;
- required evidence is durable and references the exact tested implementation;
- ChatGPT CTO has approved the exact current head SHA;
- no unresolved blocker or requested change remains;
- the worktree is clean except for explicitly documented external/runtime artifacts.

Do not merge by default. Merge only when the Ticket/CTO/owner explicitly authorizes it under the current workflow.

## 7. Closeout and handoff

Closeout is a durable GitHub artifact, not a transcript summary. Record at minimum:

- final candidate SHA and PR;
- acceptance results;
- required evidence locations;
- CTO review request/verdict and reviewed SHA;
- any residual uncertainty or deliberately deferred behavior.

The milestone DAG determines the next ready frontier. The outgoing worker does not invent, reorder, or spawn sibling/successor work. After durable closeout, the dispatcher recomputes the frontier and materializes newly ready Tickets.

A successor uses a fresh DSH session and fresh Codex thread, bootstraps from current `origin/main` (or the explicitly specified base), its own Ticket, linked authorities, and completed dependency closeouts. Do not require it to replay the predecessor transcript. Archive/retire the predecessor after its closeout is durable; successor creation is dispatcher-owned rather than predecessor-owned.

## 8. Git, hosts, and hard guardrails

- GitHub `origin` is shared truth across hosts. Transfer source through Git; do not hand-copy source trees between Spark and u4090.
- One worker owns one active Ticket branch/worktree. Never rewrite another worker's branch and never force-push `main`.
- **spark** is the DSH/plugin/server host. **u4090** is the first-priority Android/Rokid build, USB-ADB, screenshot, logcat, UIAutomator, and input-tracing host.
- Use debug builds for development Tickets unless the Ticket explicitly requires release qualification.
- Never commit real credentials or real disposable session IDs.
- Never expose an unauthenticated unrestricted DSH interface publicly.
- Never wipe/reset the Rokid, Tailscale identity, DSH home/session history, or another durable environment without explicit owner authority.
- Never claim hardware/runtime behavior that was not observed on the stated build/device/environment.
- For DSH integration, follow `SPEC.md` section 5: keep DSH internals behind the project adapter, pin the supported DSH revision, and extend through documented services/events rather than patching the agent loop for convenience.

For a Ticket that touches TB0 runtime/Rokid debug infrastructure, read the relevant `docs/TRACER_BULLET_TB0_*.md`, `docs/dev/*`, and `docs/evidence/*` files named by the Ticket before operating that path. Historical TB0 documents are references, not default startup reading for unrelated work.
