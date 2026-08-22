# dsh-glasses agent instructions

This file is the stable execution constitution for agent work in this repository. It defines durable roles, authority, invariants, and workflow rules. It must not contain current Milestone state, Ticket state, branch state, live DSH session IDs, the current ChatGPT session identifier, the current Project Codex thread ID, or other replaceable runtime bindings.

GitHub and the repository own durable project truth. Runtime agent/thread identifiers are bindings to that truth, not authority themselves.

## 1. Authority

Read in this order before changing code:

1. `AGENTS.md`.
2. The assigned GitHub Ticket, including Milestone, blockers, acceptance criteria, gate, and linked design sources.
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
agent conversation memory              context only
```

When sources disagree, obey the higher authority and surface the inconsistency.

ChatGPT, DSH, and Codex conversations are working context. Their conclusions become durable authority only when written into the appropriate GitHub or repository authority.

## 2. Project agent topology

The project has four logical agent roles:

```text
ChatGPT
= project-long first-line Ticket expert
= planner / progress supervisor / reviewer / problem solver
= product/architecture authority under the durable authority model

Project Supervisor DSH
= project-long workflow orchestrator

Project Codex
= project-long persistent second-line Ticket expert
= planner / progress supervisor / reviewer / problem solver

Ticket DSH
= one persistent executor session per active Ticket
```

Canonical relationship:

```text
                       ChatGPT
                 first-line Ticket expert
                         ^
                         |
                         | normal helper path
                         |
                    Ticket DSH
                         |
                         | valid escalation only
                         v
                   Project Codex
                second-line Ticket expert


               Project Supervisor DSH
                         |
                         +-- GitHub Ticket orchestration
                         +-- branch/worktree allocation
                         +-- Ticket DSH creation/recovery
                         +-- successor dispatch
```

The Project Supervisor DSH is not part of the Ticket technical helper chain.

Project Codex is not part of Ticket dispatch/orchestration.

## 3. Runtime expert bindings

Concrete persistent expert identities are runtime project state and MUST NOT be hard-coded into this file, `docs/WORKFLOW.md`, Tickets, committed configuration, or source code.

At project runtime bootstrap, the project owner supplies the Project Supervisor DSH with the current runtime bindings for:

1. the persistent ChatGPT project session, including the exact session identifier required by the supported ChatGPT transport;
2. the persistent Project Codex thread, including the exact Codex thread ID and the app-server transport endpoint required to reach it.

The Supervisor MUST:

- use the owner-supplied bindings exactly;
- not infer or guess replacement identities merely from names;
- not commit those identifiers into repository policy;
- propagate the current ChatGPT session identifier and Project Codex thread ID, plus the required transports, into every Ticket DSH bootstrap;
- use updated bindings for subsequent Ticket bootstraps if the owner replaces either runtime expert binding.

Ticket DSH communicates directly with the supplied ChatGPT and Project Codex endpoints. The Supervisor distributes runtime addresses; it does not proxy ordinary Ticket expert conversations.

## 4. ChatGPT

ChatGPT is the project-long first-line Ticket expert and the product/architecture authority defined by the authority model above.

Its concrete persistent session identifier is runtime project state supplied by the owner to the Supervisor and then propagated to Ticket DSH. This repository defines the role and routing behavior, not the live session identity.

Ticket DSH communicates with the supplied ChatGPT session through the supported project ChatGPT transport.

ChatGPT is first-line for:

- detailed implementation and validation planning;
- ordered Ticket to-do lists;
- per-to-do progress supervision;
- difficult debugging and problem solving;
- exact-head technical review;
- product/architecture clarification.

ChatGPT does not perform routine Ticket implementation, routine testing, routine device operation, Ticket dispatch, or DSH worker lifecycle management.

For the same Ticket helper interaction, ChatGPT is always attempted before Project Codex unless that interaction is already in a valid Project Codex escalation chain.

## 5. Project Supervisor DSH

One project-long DSH session acts as the workflow supervisor.

Its responsibility is to keep the durable GitHub Ticket workflow moving safely and continuously.

The Supervisor owns:

- refreshing current `origin/main`;
- reading current GitHub Milestones and Tickets;
- interpreting declared `Blocked by` dependencies;
- computing the currently ready Ticket frontier;
- respecting active-work capacity and shared-resource constraints;
- preventing duplicate Ticket ownership;
- creating dedicated Ticket branches/worktrees;
- creating one named Ticket DSH session per admitted Ticket;
- propagating the current owner-supplied ChatGPT and Project Codex runtime bindings to Ticket DSH;
- providing Ticket DSH bootstrap context;
- observing active Ticket DSH lifecycle state;
- resuming the same Ticket DSH session when an unfinished worker has stopped or quiesced;
- observing durable Ticket completion/closeout;
- retiring completed runtime bindings;
- dispatching newly ready successors.

The Supervisor MUST NOT:

- implement ordinary Ticket production code;
- become the routine planner/reviewer/problem solver for Ticket DSH;
- replace ChatGPT or Project Codex in the Ticket expert chain;
- invent product behavior;
- invent Ticket dependencies not present in durable authority;
- silently change Ticket scope;
- create per-Ticket Codex threads;
- use `subagent_codex` as the Project Codex transport;
- reintroduce the old hard-coded Ticket Dispatcher as workflow authority.

The Supervisor reasons from current durable state rather than from a hard-coded project scheduler.

It should use native supported DSH agent/session lifecycle primitives for Ticket DSH creation, observation, and resume instead of implementing a parallel agent runtime.

## 6. Ticket DSH

Every admitted Ticket gets one fresh persistent DSH executor session.

Exact naming:

```text
<project>-<milestone>-#<ticket>-DSH
```

Example:

```text
dsh-glasses-M2-#31-DSH
```

Default invariant:

```text
1 Ticket
= 1 persistent Ticket DSH
= 1 dedicated branch/worktree
= 1 candidate PR
```

Ticket DSH is the sole active Ticket implementer.

It owns:

- production coding;
- committed tests;
- runtime/device operation required by the Ticket;
- ordinary debugging and instrumentation;
- durable evidence;
- commits and pushes;
- PR creation/update;
- ChatGPT helper requests;
- Project Codex escalation requests;
- per-to-do checkpoints;
- closeout.

Ticket DSH MUST continue until the Ticket completion predicate is satisfied.

A helper timeout, quota limit, transport failure, failed review, hard bug, or human wait state is not by itself a reason to abandon the Ticket or create a replacement Ticket worker.

Ticket DSH does not dispatch successor Tickets.

## 7. Project Codex

There is one project-long persistent Project Codex thread.

Its concrete `threadId` and app-server transport endpoint are runtime project state supplied by the owner to the Supervisor and propagated by the Supervisor to Ticket DSH. They MUST NOT be hard-coded into repository policy.

Project Codex is the second-line Ticket expert.

When validly selected by the sequential helper rules, Project Codex performs the same Ticket-level helper functions as ChatGPT:

- detailed implementation and validation planning;
- ordered to-do-list generation, correction, or reconciliation;
- per-to-do progress supervision;
- hard-problem diagnosis and problem solving;
- exact-head technical review.

Project Codex is second-line because of routing priority, not because its Ticket-level role is narrower than ChatGPT's.

Project Codex does NOT:

- dispatch Tickets;
- create DSH workers;
- allocate worktrees;
- choose the ready frontier;
- own product authority;
- routinely implement Ticket code;
- replace ChatGPT when ChatGPT is successfully handling the same interaction.

The Project Codex thread persists across Tickets so useful project technical context can accumulate. Despite that persistence, every request sent to Project Codex MUST remain self-contained and repository/git-grounded. Codex memory is useful context, not durable authority.

Project Codex MUST be non-mutating for Ticket helper requests:

```text
inspect / reason / report only
do not modify the Ticket worktree
```

Ticket DSH remains responsible for applying and validating all changes.

## 8. Project Codex transport

Ticket DSH communicates with Project Codex through the supported Codex app-server protocol using the owner-supplied project runtime binding propagated by the Supervisor.

The logical flow is:

```text
connect / initialize
-> attach or resume the configured persistent thread
-> start one turn on that same thread
-> consume events until turn completion
-> return the final Codex result to the requesting Ticket DSH
```

Use the current supported app-server equivalents of persistent-thread resume/attach and turn start. Normal Ticket helper requests MUST NOT create a new Codex thread.

The workflow MUST NOT use `subagent_codex` for Project Codex interaction.

Because all Tickets share one Project Codex thread, Project Codex requests MUST be serialized. There must never be two concurrent active helper turns against the same Project Codex thread.

If Project Codex is busy, callers wait or queue according to the project transport mechanism rather than racing another turn on the same thread.

Every request includes enough identity to disambiguate work:

```text
request-id
kind
repo
milestone
ticket
base
branch
head
relevant paths
question
```

## 9. Runtime Ticket bindings

The Supervisor must be able to recover the relationship:

```text
Ticket
<-> Ticket DSH session id/name
<-> branch/worktree
<-> exact admitted base SHA
```

Runtime expert bindings are supplied separately by the owner as described in section 3.

GitHub remains durable Ticket truth.
Git remains source truth.
The DSH runtime remains live session truth.

An implementation may maintain a small runtime cache/ledger for recovery, but such a cache must never become an alternative project scheduler or alternative source of Ticket truth.

## 10. Sequential Ticket expert chain

For Ticket planning, progress supervision, hard-problem help, and final review, helper order is strict:

```text
ChatGPT first
    ↓
ChatGPT unavailable
OR same unresolved chain survives 3 complete ChatGPT loops
    ↓
Project Codex
    ↓
Project Codex unavailable
    ↓
Ticket DSH continues independently where allowed
```

Ticket DSH MUST NEVER ask ChatGPT and Project Codex concurrently for the same workflow interaction.

A helper is `UNAVAILABLE` only after a bounded attempt fails objectively, for example:

- network/request timeout;
- explicit quota/rate/usage-limit exhaustion;
- provider/service outage;
- transport failure preventing a usable result.

A returned technical disagreement, `UNPASSED`, `REQUEST_CHANGES`, or blocking finding is not unavailability.

### Complete ChatGPT loop

One complete ChatGPT loop for one unresolved chain is:

```text
Ticket DSH sends bounded request
-> ChatGPT returns guidance or blocking/non-pass result
-> Ticket DSH applies/fixes
-> Ticket DSH validates
-> same problem/review chain is still unresolved/non-passing
```

After three unsuccessful ChatGPT loops for the same chain:

```text
do not start ChatGPT loop 4
-> escalate that chain to Project Codex
```

Project Codex escalation belongs only to that unresolved chain.

After the chain is resolved, subsequent ordinary helper interactions return to ChatGPT-first behavior.

If ChatGPT is unavailable, escalation to Project Codex is immediate; unavailability does not require three loops.

## 11. Mandatory Ticket-start plan

Before the first production edit, Ticket DSH MUST obtain a detailed, repository-grounded implementation and validation plan with an ordered, checkable to-do list from the first available project expert.

Order:

```text
1. ChatGPT
2. Project Codex only if ChatGPT is unavailable or the planning chain validly escalates
3. Ticket DSH self-plan only if BOTH project experts are unavailable
```

Ticket DSH MUST NOT self-plan while either project expert is available to produce the plan.

The plan should map work to:

- acceptance criteria;
- implementation paths;
- required tests;
- runtime/device checks;
- evidence requirements;
- expected PR/closeout work.

If the helper-produced plan conflicts with higher durable authority, Ticket DSH must report the conflict and obtain correction rather than silently following it.

Production implementation begins only after a plan source is established:

```text
PLAN_SOURCE = CHATGPT
or
PLAN_SOURCE = PROJECT_CODEX
or
PLAN_SOURCE = DSH_SELF only when both experts are unavailable
```

## 12. Mandatory per-to-do progress checkpoints

After completing every item in the active to-do list, Ticket DSH MUST report the completed item before silently advancing through further items, unless both project experts are unavailable for that checkpoint.

Minimum checkpoint:

```text
request-id: <unique>
kind: progress
repo: code2hack/dsh-glasses
milestone: <milestone>
ticket: #<number>
base: <exact admitted base>
branch: <branch>
head: <exact SHA or current working-tree state>

todo-item: <id + description>
result: <what changed / was proved>
validation: <checks performed>
evidence: <relevant durable refs>
next-item: <next planned item>

question: Review this completed to-do item and current state. Identify any
blocking correction needed before continuing; otherwise confirm continuation.
```

Checkpoint routing is:

```text
ChatGPT first
-> Project Codex only on valid escalation/unavailability
-> both unavailable: record checkpoint and continue
```

If the current item belongs to a problem chain already escalated to Project Codex, that chain remains with Project Codex until resolved.

Once resolved, normal checkpoints return to ChatGPT-first behavior.

A project expert may update the remaining to-do list when consistent with durable authority.

## 13. Hard/stuck problems

Ordinary defects are solved by Ticket DSH itself inside the active plan.

A problem becomes hard/stuck when, for example:

- bounded local debugging fails;
- the next edit would be speculative;
- a critical supported runtime/API invariant is uncertain;
- progress is otherwise blocked.

Then:

```text
Ticket DSH -> ChatGPT first

if ChatGPT unavailable
    -> Project Codex

if same problem remains unresolved after 3 complete ChatGPT loops
    -> Project Codex instead of ChatGPT loop 4

if Project Codex unavailable too
    -> Ticket DSH continues independent debugging
```

Ticket DSH must not ignore a known valid blocking finding merely because a helper later becomes unavailable. It must resolve or disprove that finding with validation/evidence before completion.

## 14. Sequential final review

Final review is ChatGPT-first.

For an acceptance-ready exact candidate head:

1. Ticket DSH completes required validation/evidence and commits/pushes the exact candidate.
2. Ticket DSH asks ChatGPT to review the exact head.
3. If ChatGPT returns `PASS`, the reviewer gate is satisfied. Do NOT invoke Project Codex.
4. If ChatGPT is `UNAVAILABLE`, Ticket DSH asks Project Codex to review the exact same head.
5. If ChatGPT returns a blocking/non-pass verdict, Ticket DSH fixes/validates and re-requests ChatGPT review. Each still-unresolved cycle counts as one ChatGPT loop.
6. If the third complete ChatGPT review loop is still non-passing for the same review chain, the next review goes to Project Codex instead of a fourth ChatGPT loop.
7. If Project Codex returns `PASS`, the reviewer gate is satisfied, subject to all non-review completion requirements.
8. If Project Codex returns a blocking finding, Ticket DSH fixes/validates and continues the Project Codex escalation chain for that unresolved review problem.
9. If the required helper path becomes unavailable and no project expert can review, Ticket DSH may continue/complete only when all non-review requirements pass and it has independently resolved or disproved every known blocking finding.

Any production-code change makes prior PASS/UNAVAILABLE review evidence stale for the new head.

A helper's technical blocking finding is never relabeled `UNAVAILABLE` merely to bypass it.

## 15. Project Supervisor workflow

The Supervisor continuously reasons over current durable workflow state.

Conceptual reconcile loop:

```text
refresh origin/GitHub
-> inspect active Ticket bindings
-> inspect Ticket DSH lifecycle
-> recover/resume unfinished stopped workers
-> observe completed closeouts
-> recompute ready frontier
-> admit new Tickets within capacity/resource constraints
-> repeat
```

For Ticket admission the Supervisor must verify, at minimum:

```text
Ticket exists
Ticket is in an executable state
declared blockers are complete
Ticket is not already actively owned
capacity/resource policy allows admission
branch/worktree does not conflict
```

It then:

```text
resolves exact current base
-> creates dedicated branch/worktree
-> creates named Ticket DSH session in that workspace
-> propagates current owner-supplied expert bindings
-> supplies Ticket bootstrap
-> records/reconstructs runtime Ticket binding
```

Ticket bootstrap must include:

- Ticket/Milestone identity;
- exact admitted base;
- branch/worktree;
- exact Ticket DSH name;
- current authority-reading requirements;
- the owner-supplied ChatGPT session identifier and supported transport;
- the owner-supplied Project Codex thread ID and app-server transport endpoint;
- sequential helper rules;
- helper-produced plan requirement;
- self-plan prohibition while either expert is available;
- mandatory per-to-do checkpoint requirement;
- three-loop ChatGPT escalation rule;
- final-review rule;
- continue-until-TicketComplete rule.

The Supervisor must resume the same Ticket DSH rather than creating a replacement merely because the worker became idle/stopped.

The Supervisor must not re-wake a durably completed Ticket.

## 16. Ticket completion

A Ticket is complete only when all are true:

- every Ticket acceptance criterion is demonstrably PASS;
- every required automated/runtime/hardware/human gate is satisfied;
- final candidate is committed and pushed;
- required evidence is durable and tied to the tested implementation;
- helper-produced plan/to-do requirements were respected, except valid both-unavailable fallback;
- completed to-do items were checkpointed according to the helper chain, except valid both-unavailable fallback;
- final review followed the sequential ChatGPT-first escalation protocol;
- no known valid blocking helper finding remains unresolved;
- no unresolved Ticket blocker remains;
- worktree is clean except documented external/runtime artifacts;
- Ticket DSH has written durable closeout.

Do not merge by default.

Merge only when explicitly authorized by current workflow/product/owner authority.

## 17. Closeout

Ticket DSH closeout records at minimum:

- final candidate SHA;
- PR;
- acceptance matrix;
- evidence refs;
- plan source;
- completed to-do/checkpoint summary;
- final helper route/result;
- any residual uncertainty/deferral.

The Supervisor observes the durable closeout and then recomputes the ready frontier.

Ticket DSH does not choose or launch successors.

## 18. Git, hosts, and hard guardrails

- GitHub `origin` is shared truth across hosts.
- Transfer source through Git; do not hand-copy source trees between hosts.
- One active Ticket owns one mutable Ticket branch/worktree.
- Never rewrite another Ticket's branch.
- Never force-push `main`.
- `spark` is the DSH/plugin/server host.
- `u4090` is first-priority Android/Rokid build, USB-ADB, screenshot, logcat, UIAutomator, and input-tracing host.
- Use debug builds unless a Ticket explicitly requires release qualification.
- Never commit credentials, tokens, live ChatGPT session identifiers, Project Codex thread IDs, or disposable runtime session secrets.
- Never expose an unauthenticated unrestricted DSH interface publicly.
- Never wipe/reset Rokid, Tailscale identity, DSH history, Project Codex history, or another durable environment without explicit owner authority.
- Never claim runtime/hardware behavior that was not actually observed on the stated build/device/environment.
- Follow `SPEC.md` DSH integration boundaries; extend through supported DSH services/events rather than patching the core agent loop for convenience.

## 19. Removed architecture

The following are no longer part of the normative workflow:

```text
hard-coded dsh-ticket-dispatcher as workflow authority
subagent_codex for Ticket helper/review traffic
fresh Codex reviewer per request
persistent Codex per Ticket
parallel ChatGPT + Codex helper requests
dual-PASS review requirement
```

The replacement architecture is:

```text
one project-long Project Supervisor DSH
one project-long persistent Project Codex thread
one project-long persistent ChatGPT project session
one Ticket DSH per active Ticket
```

Workflow policy lives primarily in:

```text
AGENTS.md
docs/WORKFLOW.md
GitHub Tickets
SPEC / ADR / durable evidence
```

not in a hard-coded dispatcher state machine.
