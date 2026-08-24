# dsh-glasses agent instructions

This file is the stable execution constitution for agent work in this repository. It defines durable logical roles, authority, invariants, and workflow rules. It does not assign those roles to a product, process, conversation, model, thread, or agent implementation.

GitHub and the repository own durable project truth. Runtime identities and transports are bindings to that truth, not authority themselves.

## 1. Authority

Read in this order before changing code:

1. AGENTS.md.
2. The assigned GitHub Ticket, including Milestone, blockers, acceptance criteria, gate, and linked design sources.
3. Only the SPEC sections, accepted ADRs/design artifacts, dependency closeouts, and evidence explicitly relevant to that Ticket.
4. Source and tests in the current checkout.

Authority is:

    code2hack / explicit owner decision    product and human-gate authority
    SPEC.md                                normative product behavior
    accepted ADRs / approved design refs   durable architecture and UX decisions
    current GitHub Ticket                  execution scope and acceptance contract
    source + tests                         current implementation
    accepted evidence                      observed runtime/hardware facts
    Git history / old transcripts          context only
    agent conversation memory              context only

When sources disagree, obey the higher authority and surface the inconsistency.

Agent and expert conversations are working context. Their conclusions become durable authority only when written into the appropriate GitHub or repository authority.

## 2. Logical roles and runtime bindings

The workflow has four logical roles:

- Ticket Manager: project-long workflow orchestrator.
- Ticket Worker: one Ticket-long implementation executor per active Ticket.
- First-line Project Expert: project-long planner, progress reviewer, problem solver, exact-head reviewer, and product/architecture expert under the authority model.
- Second-line Project Expert: project-long escalation expert with the same Ticket-level helper functions.

These are responsibilities, not product assignments. At runtime the owner supplies, replaces, or confirms:

- which agent/process is the Ticket Manager;
- which worker mechanism the manager uses;
- worker naming and active-capacity policy;
- each expert's provider, transport, project/conversation or session identity, model, reasoning effort, and any endpoint/thread binding;
- any shared-resource constraints.

The owner may bind one runtime agent to more than one logical role. The duties and routing rules remain distinct.

Runtime bindings MUST NOT be hard-coded into this file, docs/WORKFLOW.md, Tickets, committed configuration, or source code. The Ticket Manager uses owner-supplied bindings exactly and does not infer replacements from names or history.

Canonical relationship:

                       First-line Expert
                              ^
                              |
                         Ticket Worker
                              |
                       valid escalation
                              v
                       Second-line Expert

                         Ticket Manager
                              |
                    GitHub/worktree/worker
                         orchestration

The Ticket Manager is not the routine Ticket implementer or ordinary first-line technical helper. Ticket Workers do not dispatch successors.

## 3. Ticket Manager

The Ticket Manager keeps the durable GitHub Ticket workflow moving.

It owns:

- refreshing current origin/main and GitHub state;
- interpreting declared Blocked by dependencies;
- computing the ready Ticket frontier;
- enforcing active capacity and shared-resource constraints;
- preventing duplicate Ticket ownership;
- creating dedicated Ticket branches/worktrees;
- creating one runtime Ticket Worker per admitted Ticket;
- propagating current runtime expert bindings and workflow rules;
- recording or reconstructing Ticket-to-worker/base/branch/worktree bindings;
- observing and recovering unfinished workers;
- observing durable Ticket completion;
- retiring completed runtime bindings;
- dispatching newly ready successors.

The Ticket Manager MUST NOT:

- implement ordinary Ticket production code;
- invent product behavior or undeclared dependencies;
- silently change Ticket scope;
- replace a successfully handling first-line expert;
- create duplicate workers for one Ticket;
- wake a durably completed Ticket;
- use a hard-coded project scheduler as workflow authority.

The manager reasons from current durable state and uses the selected runtime's native worker lifecycle rather than building a parallel agent runtime.

## 4. Ticket Worker

Default invariant:

    1 Ticket
    = 1 persistent runtime Ticket Worker
    = 1 dedicated branch/worktree
    = 1 candidate PR

The Ticket Worker is the sole active implementer for its Ticket. It owns:

- production coding;
- committed tests;
- runtime/device operation required by the Ticket;
- ordinary debugging and instrumentation;
- durable evidence;
- commits and pushes;
- PR creation/update;
- expert requests and checkpoints;
- closeout.

A helper timeout, quota limit, transport failure, failed review, hard bug, or wait state does not by itself authorize abandoning the Ticket or replacing its worker.

The worker continues until the Ticket completion predicate is satisfied. It does not choose or launch successor Tickets.

## 5. Sequential expert chain

For planning, progress checkpoints, hard-problem help, and final review:

    First-line Expert
        ↓
    objectively unavailable
    OR same unresolved chain survives 3 complete first-line loops
        ↓
    Second-line Expert
        ↓
    objectively unavailable
        ↓
    Ticket Worker continues independently where allowed

Never ask both experts concurrently for the same workflow interaction. Access to any shared persistent expert conversation/thread is serialized.

A helper is UNAVAILABLE only after a bounded attempt fails objectively, such as:

- network/request timeout;
- explicit quota/rate/usage exhaustion;
- provider outage;
- transport failure preventing a usable result.

A technical disagreement, UNPASSED, REQUEST_CHANGES, or blocking finding is not unavailability.

One complete first-line loop is:

    bounded request
    -> guidance or blocking/non-pass result
    -> worker applies/fixes
    -> worker validates
    -> same chain remains unresolved

After three unsuccessful loops, do not start loop 4; route that chain to the second-line expert. After it is resolved, new interactions return to first-line routing.

## 6. Mandatory Ticket-start plan

Before the first production edit, the Ticket Worker obtains a detailed, repository-grounded implementation and validation plan with an ordered, checkable to-do list:

1. First-line Project Expert.
2. Second-line Project Expert only after valid escalation or first-line unavailability.
3. Worker self-plan only when both experts are unavailable.

The plan maps acceptance criteria to implementation paths, tests, runtime/device checks, evidence, PR work, and closeout. A conflict with higher authority must be reported and corrected.

Record one plan source:

    PLAN_SOURCE = FIRST_LINE
    PLAN_SOURCE = SECOND_LINE
    PLAN_SOURCE = WORKER_SELF only when both experts are unavailable

## 7. Mandatory progress checkpoints

After every completed active to-do item, the Ticket Worker reports the completed item before advancing, unless both experts are unavailable.

Minimum checkpoint:

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
    evidence: <durable refs>
    next-item: <next planned item>
    question: Identify any blocking correction before continuation; otherwise confirm continuation.

Routing starts first-line. A chain already escalated stays second-line until resolved, then ordinary routing resumes first-line. Both-unavailable checkpoints are recorded durably before independent continuation.

## 8. Hard problems and final review

The Ticket Worker solves ordinary defects inside the active plan. A problem is hard/stuck when bounded local debugging fails, the next edit would be speculative, or a critical supported invariant is uncertain. Route it through the sequential expert chain.

For an acceptance-ready exact candidate head:

1. Complete required validation/evidence.
2. Commit and push the exact candidate.
3. Request first-line exact-head review.
4. PASS satisfies the reviewer gate; do not invoke the second-line expert.
5. UNAVAILABLE routes the exact same head second-line.
6. A blocking result starts a fix/validate/re-review loop.
7. After the third unsuccessful first-line loop for the same review chain, route the next review second-line.
8. A second-line blocking finding remains on that escalation chain until resolved.
9. If both experts become unavailable, completion is allowed only when every non-review requirement passes and every known blocking finding is resolved or disproved.

Any production-code change makes prior review evidence stale for the new head.

## 9. Ticket admission, completion, and closeout

Before admission the Ticket Manager verifies:

- Ticket exists and is executable;
- declared blockers are complete;
- no active owner already exists;
- capacity/resource policy permits admission;
- branch/worktree does not conflict;
- no durable completed closeout exists.

Admission resolves an exact base, creates the dedicated branch/worktree, creates the runtime worker, supplies the bootstrap, and records:

    Ticket
    <-> runtime worker identity
    <-> branch/worktree
    <-> exact admitted base SHA

Ticket bootstrap includes:

- Ticket/Milestone identity;
- exact admitted base, branch, and worktree;
- runtime worker identity;
- authority-reading requirements;
- owner-supplied expert bindings and transports;
- sequential expert rules;
- mandatory plan and checkpoint rules;
- three-loop escalation;
- final review;
- continue-until-complete.

TicketComplete requires:

- every acceptance criterion demonstrably PASS;
- every required automated/runtime/hardware/human gate satisfied;
- final candidate committed and pushed;
- durable evidence tied to the tested implementation;
- valid plan source;
- required checkpoints;
- sequential final review;
- no known valid blocking finding;
- no unresolved Ticket blocker;
- clean worktree except documented external/runtime artifacts;
- durable worker closeout.

Do not merge by default. Merge only when explicitly authorized by current workflow/product/owner authority.

Closeout records final SHA/PR, acceptance matrix, evidence, plan source, checkpoint summary, final review route/result, and residual uncertainty/deferral.

## 10. Worker and expert recovery

For an unfinished Ticket, resume the same runtime worker when possible. Do not create a replacement merely because it stopped or quiesced. If the runtime cannot resume it, preserve its branch/worktree and recover deliberately without creating duplicate ownership.

Persistent expert bindings are recovered through their configured transports. Never guess a replacement identity. If one cannot be recovered, it is unavailable until the owner supplies a replacement.

## 11. Disposable DSH test isolation

Every Ticket Worker testing DSH itself or dsh-glasses-plugin MUST isolate the experiment from the shared user profile.

Before starting any test/runtime process:

- create a unique disposable DSH home outside ~/.dsh, preferably under a Ticket-specific mktemp directory;
- set DSH_HOME explicitly for the process and every child process;
- reject execution when DSH_HOME is unset, empty, equal to ~/.dsh, or resolves anywhere beneath ~/.dsh;
- use dedicated disposable ports and process names when the test starts servers;
- keep experimental presets, plugins, settings, credentials, sessions, and logs inside that disposable home;
- clean up only the validated disposable root after preserving required evidence.

Ticket Workers MUST NOT read, write, copy from, restore, rename, delete, or otherwise use ~/.dsh during DSH or plugin tests. The shared profile is not a fixture, baseline, cache, fallback, or cleanup target.

A test that cannot prove its DSH_HOME is explicitly disposable must fail before starting DSH.

## 12. Git, hosts, and hard guardrails

- GitHub origin is shared truth across hosts.
- Transfer source through Git; do not hand-copy source trees between hosts.
- One active Ticket owns one mutable Ticket branch/worktree.
- Never rewrite another Ticket's branch.
- Never force-push main.
- spark is the DSH/plugin/server host.
- u4090 is first-priority Android/Rokid build, USB-ADB, screenshot, logcat, UIAutomator, and input-tracing host.
- Use debug builds unless a Ticket explicitly requires release qualification.
- Never commit credentials, tokens, runtime conversation/session/thread identifiers, or disposable runtime secrets.
- Never expose an unauthenticated unrestricted DSH interface publicly.
- Never wipe/reset Rokid, Tailscale identity, DSH history, an expert conversation, or another durable environment without explicit owner authority.
- Never claim runtime/hardware behavior not observed on the stated build/device/environment.
- Follow SPEC.md DSH integration boundaries; extend supported services/events rather than patching the core agent loop for convenience.

## 13. Removed architecture

Repository policy does not assign logical roles to DSH, Codex, ChatGPT, native subagents, or any other implementation. It does not hard-code worker names, expert conversations, models, reasoning effort, transport endpoints, thread IDs, or active capacity.

Runtime owner instructions bind those choices. Workflow authority remains GitHub Tickets, Git, SPEC/ADRs, accepted evidence, and this policy—not a hard-coded dispatcher state machine.
