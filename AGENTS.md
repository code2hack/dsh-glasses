# dsh-glasses agent instructions

This file is the stable execution constitution for agent work in this repository. It must not carry current milestone, Ticket, branch, or live session state; GitHub owns live workflow state.

## 1. Authority

Read in this order before changing code:

1. `AGENTS.md`.
2. The assigned GitHub Ticket, including blockers, acceptance criteria, gate, Milestone, and linked design sources.
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

When sources disagree, obey the higher authority and surface the inconsistency. Agent conversations are working context, not durable authority, until their decisions are written to GitHub or the repository.

## 2. Agents

The normative agent names are **ChatGPT**, **DSH**, and **Codex**.

### ChatGPT

Persistent project-wide endpoint:

- `ChatGPT project = dsh-glasses`
- `ChatGPT session = ChatGPT`

DSH communicates with this logged-in ChatGPT account through the existing DSH MCP plugin **`mcp-chatgpt`**. `mcp-chatgpt` is transport only; GitHub/repository state remains durable truth.

ChatGPT owns product/architecture decisions, Milestone contracts, Ticket decomposition and dependency DAGs, difficult research, and product/architecture clarification. During Ticket execution, ChatGPT is also one of two independent technical reviewers and hard-bug solvers.

ChatGPT does not perform routine Ticket implementation, routine testing, or routine device operation.

### DSH

One fresh DSH session is created per Ticket. DSH is the sole active Ticket executor and owns:

- production coding;
- committed tests;
- independent test/runtime/device execution;
- ordinary debugging and instrumentation;
- evidence capture;
- commits, pushes, PR preparation/update;
- reviewer requests and polling;
- closeout.

**DSH MUST continue until the Ticket completion gate is satisfied.** It must not voluntarily stop, hand off, or declare completion early. Waiting for required reviewer replies or an explicit human gate is not completion. If DSH stops or quiesces while its Ticket is unfinished, the Ticket Dispatcher must resume/wake the same bound DSH session.

DSH may not redesign product behavior, expand Ticket scope, or invent dependencies. Product/architecture ambiguity goes to ChatGPT.

### Codex

One fresh normal persistent Codex thread is created per Ticket by the Ticket Dispatcher. It is not created through an `exec`-style one-shot coding invocation.

Codex is an independent technical reviewer and hard-bug solver. It does not own routine implementation, routine testing, Ticket scope, product decisions, or merge authority. DSH remains the code author/executor.

At bootstrap, Codex remains idle after thread creation until DSH sends a review or hard-debug request.

## 3. Ticket pair and naming

Default invariant:

```text
1 Ticket = 1 DSH session + 1 Codex thread
         = 1 dedicated branch/worktree
         = 1 candidate PR
```

The exact agent names are:

```text
<project>-<milestone>-#<ticket>-DSH
<project>-<milestone>-#<ticket>-Codex
```

Example:

```text
dsh-glasses-M1-#17-DSH
dsh-glasses-M1-#17-Codex
```

The Ticket Dispatcher must derive these names mechanically from the repository/project name, the Ticket's declared Milestone, and Ticket number.

For Codex, the **first prompt must be exactly the assigned Codex name and nothing else**. The thread then remains idle until DSH sends the first review/debug request.

The dispatcher must retain/reconstruct at minimum:

```text
Ticket <-> DSH session id/name <-> Codex thread id/name
       <-> branch/worktree <-> exact admitted base SHA
```

## 4. Bootstrap

Before implementation begins, the dispatcher must establish the Ticket claim, exact base SHA, dedicated branch/worktree, DSH session, and paired Codex thread.

DSH then must:

1. fetch `origin` and verify every declared blocker is complete;
2. verify the exact base SHA, branch, worktree, DSH name, and paired Codex name/thread;
3. read the Ticket and every linked authority/evidence source required by the Ticket;
4. inspect the relevant current source and tests;
5. begin implementation itself.

Codex does not implement during bootstrap. Its first prompt is only its exact assigned name, then it waits.

Bootstrap is complete only when DSH can state the Ticket, Milestone, base SHA, blockers, gate, acceptance criteria, worktree/branch, DSH identity, and paired Codex identity without guessing.

## 5. Execution and dual-review loop

DSH owns the implementation loop:

```text
DSH codes
  -> DSH tests / operates / debugs
  -> ordinary defect: DSH fixes it itself
  -> hard bug: send one identical git-only request to ChatGPT + Codex
  -> DSH polls both reviewers periodically and applies useful findings
  -> DSH continues coding/testing until acceptance-ready
  -> DSH commits/pushes exact candidate and prepares/updates PR
  -> send one identical git-only review request to ChatGPT + Codex
  -> DSH polls both periodically
       -> either reviewer UNPASSED / REQUEST_CHANGES: DSH loops implementation + validation
       -> both reviewers PASS the same exact head: evaluate Ticket completion gate
```

ChatGPT and Codex are peer technical review gates for the exact candidate head. A PASS from only one reviewer is insufficient.

Any production-code change after either reviewer passes invalidates both prior review results for completion purposes; DSH must revalidate and request dual review again on the new exact head.

For a hard bug, ChatGPT/Codex may diagnose, propose fixes, or identify the next discriminating check, but DSH remains responsible for modifying code, running the checks, and proving the result.

## 6. Git-only reviewer request protocol

For **review** or **hard-debug** requests, DSH must send the same prompt body to both reviewers:

- ChatGPT through `mcp-chatgpt` targeting `ChatGPT project = dsh-glasses`, `ChatGPT session = ChatGPT`;
- the paired persistent Codex thread.

The request contains **git/project references only**, not full logs, transcript dumps, or pasted agent chat. Use this shape:

```text
request-id: <unique id>
kind: review | debug
repo: code2hack/dsh-glasses
milestone: <milestone>
ticket: #<number>
base: <exact base SHA or ref+resolved SHA>
branch: <branch>
head: <exact current SHA>
pr: <PR number/url if present>
paths: <relevant repository/evidence paths if needed>
question: <smallest concrete review/debug question>
```

If raw diagnostic material is needed for a hard bug, DSH first reduces it into durable bounded repository evidence where appropriate, then sends only the git/path references. Do not send full logs or prior chats as reviewer prompts.

DSH must poll both reviewers periodically after a blocking request. Polling/waiting does not terminate the DSH Ticket session. DSH acts on any UNPASSED / REQUEST_CHANGES result and continues the Ticket.

Product/architecture decisions are sent to ChatGPT; Codex has no product-authority vote.

## 7. Ticket completion gate

A Ticket is complete only when all are true:

- every Ticket acceptance criterion is demonstrably PASS;
- every required automated, runtime, hardware, and human gate is satisfied;
- the final candidate is committed and pushed;
- required evidence is durable and tied to the tested implementation;
- **ChatGPT PASSes the exact current head**;
- **Codex PASSes the exact same current head**;
- no unresolved reviewer failure, blocker, or requested change remains;
- the worktree is clean except for explicitly documented external/runtime artifacts;
- DSH has written the durable closeout.

Until all conditions are true, DSH is unfinished and must continue or remain waiting/polling for the required gate. Do not merge by default; merge only when explicitly authorized by the Ticket, ChatGPT/product authority, or owner under the current workflow.

## 8. Ticket Dispatcher

The Ticket Dispatcher is deterministic non-LLM runtime glue. It owns no product reasoning.

For each ready unclaimed Ticket within configured capacity it must:

1. resolve the current admitted base deterministically;
2. create/verify one dedicated branch/worktree;
3. create one fresh DSH session and name it `<project>-<milestone>-#<ticket>-DSH`;
4. create one normal persistent Codex thread and name it `<project>-<milestone>-#<ticket>-Codex`;
5. send the Codex thread's first prompt as exactly that name, with no extra text;
6. bootstrap/wake DSH to begin work while Codex stays idle;
7. persist/reconstruct the paired binding;
8. periodically reconcile Ticket state and DSH liveness;
9. if DSH is stopped/quiescent while the Ticket completion gate is unsatisfied, resume/wake the **same** DSH session to continue;
10. after closeout, retire/reconcile the pair and recompute the ready frontier.

The dispatcher does not create Tickets, choose priority, invent dependencies, reinterpret gates, review code, or perform Ticket work. Shared-resource scheduling remains separate from logical DAG readiness.

Repeated reconcile/restart must not duplicate either the DSH session or Codex thread for a live Ticket pair.

## 9. Closeout and successor bootstrap

DSH records a durable closeout containing at minimum:

- final candidate SHA and PR;
- acceptance results;
- required evidence refs;
- ChatGPT review request/verdict + reviewed SHA;
- Codex review request/verdict + reviewed SHA;
- residual uncertainty or explicit deferrals.

The outgoing DSH session does not choose or launch successors. The dispatcher recomputes the Milestone frontier from durable state.

A successor gets a fresh DSH session and fresh Codex thread, with the exact naming convention above. It reads its own Ticket and linked durable authorities; it does not replay predecessor chat transcripts.

## 10. Git, hosts, and hard guardrails

- GitHub `origin` is shared truth across hosts. Transfer source through Git; do not hand-copy source trees between Spark and u4090.
- One active Ticket owns one mutable Ticket branch/worktree. Never rewrite another Ticket's branch and never force-push `main`.
- **spark** is the DSH/plugin/server host. **u4090** is the first-priority Android/Rokid build, USB-ADB, screenshot, logcat, UIAutomator, and input-tracing host.
- Use debug builds for development Tickets unless the Ticket explicitly requires release qualification.
- Never commit real credentials or real disposable session IDs.
- Never expose an unauthenticated unrestricted DSH interface publicly.
- Never wipe/reset the Rokid, Tailscale identity, DSH home/session history, or another durable environment without explicit owner authority.
- Never claim hardware/runtime behavior that was not observed on the stated build/device/environment.
- For DSH integration, follow `SPEC.md` section 5: keep DSH internals behind the project adapter, pin the supported DSH revision, and extend through documented services/events rather than patching the agent loop for convenience.

For a Ticket that touches TB0 runtime/Rokid debug infrastructure, read the relevant `docs/TRACER_BULLET_TB0_*.md`, `docs/dev/*`, and `docs/evidence/*` files named by the Ticket before operating that path. Historical TB0 documents are conditional references, not default startup reading for unrelated work.

## 11. Protocol-v2 transition guard

The dispatcher implementation merged before this protocol created DSH workers only. It does **not** yet satisfy the paired DSH+Codex creation and DSH-liveness-watchdog requirements above. Do not deploy automatic Ticket execution under protocol v2 until the follow-up dispatcher implementation Ticket is accepted.