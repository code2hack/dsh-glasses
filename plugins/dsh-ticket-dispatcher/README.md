# DSH Ticket Dispatcher

`dsh-ticket-dispatcher` is deterministic runtime glue for the workflow in `AGENTS.md` and `docs/WORKFLOW.md`. It reads the declared Ticket DAG/status, admits the ready unclaimed frontier within capacity, and materializes one dedicated branch/worktree and one independent root DSH Ticket Lead session per admitted Ticket. It does not plan Milestones, infer dependencies, schedule devices, patch the agent loop, or maintain any Codex lifecycle. Native Codex runs are request-scoped ephemeral specialists started by each Ticket Lead on demand; the dispatcher itself never sees Codex.

## Protocol (v2, nativized)

The dispatcher implements named, deterministic DSH admission and a DSH watchdog, and leaves the full protocol to the generated bootstrap text.

- **Identity is exact and durable.** A first claim binds `name = sessionId = dsh-glasses-<milestone>-#<n>-DSH`, derived from the Ticket's declared `## Milestone`. Only Ticket↔DSH identity (number, name, sessionId, branch, worktree, base SHA, bootstrap prompt) is persisted; no Codex fields are stored.
- **Bootstrap.** Every admitted/resumed Ticket Lead receives a self-contained bootstrap prompt that names its exact identity, worktree, base SHA, blocker set, and required gate; tells it to fetch `origin`, re-verify its ready frontier, and confirm the base SHA; requires a **helper-produced DETAILED ORDERED implementation+validation plan with a checkable to-do list before the first production edit**, then a **progress checkpoint after every completed to-do item**; connects the project-long intelligence endpoint exactly as `ChatGPT project = dsh-glasses` / `ChatGPT session = CTO` through `mcp-chatgpt`; and instructs it to use **one fresh one-shot native Codex escalation via `subagent_codex` in its own Ticket worktree** only when the strict helper chain authorizes it (see below).
- **Sequential helper chain, never deadlock.** The workflow is a STRICT priority chain, never parallel redundancy: **ChatGPT FIRST** for every planning, progress, debug, and review step; a **fresh native Codex subagent only on objective `UNAVAILABLE` or after the same unresolved problem/review chain survives exactly three unsuccessful ChatGPT loops**; **DSH alone only as last resort** when every required helper path is unavailable or exhausted. ChatGPT and Codex are **never requested in parallel** for the same step. `UNAVAILABLE` is recorded only on objective execution failure (timeout, rate/quota/usage limit, provider outage, transport/tool failure); a returned technical verdict (`UNPASSED` / `REQUEST_CHANGES` / a blocking finding) is the opposite of `UNAVAILABLE` and must be addressed. The bootstrap explicitly forbids waiting indefinitely on a helper.
- **Watchdog.** Live + progressing ⇒ no-op. Loaded but quiescent while its Ticket is unfinished ⇒ the **same** bound session is woken with a minimal continuation. Completed (Ticket closed or matching `ticket-complete:` marker) ⇒ disposed and never re-woken. Restart reconstructs the same named session and worktree from durable state and markers.
- **No duplicate admission.** Repeated or restarted reconciles reuse the exact deterministic binding and persisted session; no second agent, worktree, or claim is created. Completion is durable and idempotent.

## Install and run

Install or link this package into a DSH profile that mounts `@deepseek-ai/dsh-base` and the native-Codex provider bundle `@deepseek-ai/dsh-subagent-codex`. The agent-presets service and the composed preset are loaded separately. Disable the stock headless rows and insert the plugin together with `@deepseek-ai/dsh-agent-presets`:

```yaml
- id: headless-startup
  disabled: true
- id: headless-runner
  disabled: true
- insert:
    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: ticket-lead
    - id: ticket-dispatcher
      name: 'dsh-ticket-dispatcher'
      config:
        repoRoot: /absolute/path/to/dsh-glasses
        baseRef: origin/main
        stayAlive: true
```

`wakeAgents` defaults to `true`: every admitted or resumed Ticket Lead is woken with its recorded bootstrap prompt. The composed Ticket-Lead preset must expose the native Codex tool so the generated bootstrap's capability statement is real. Host availability alone grants no tool — the `subagent_codex` tool is mounted by a preset row such as:

```yaml
- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: codex
    toolName: subagent_codex
    backgroundMode: one-shot
    maxDepth: provider-managed
```

The package must resolve its DSH peers from the running deployment. For a linked source checkout, link the deployment's `node_modules/@deepseek-ai` scope into this package's `node_modules`, as the smoke script does.

```bash
dsh --profile dispatcher --patch overlay.yml status
dsh --profile dispatcher --patch overlay.yml reconcile
dsh --profile dispatcher --patch overlay.yml reconcile --stay-alive --interval-ms 120000 --max-active 2
dsh --profile dispatcher --patch overlay.yml reconcile --max-passes 3 --base-ref origin/main
```

The command prints stable JSON followed by a stable human summary for every pass. `status` and ordinary `reconcile` are one-shot. `stayAlive: true` loops sequentially without overlapping passes; `maxPasses: N` provides the same loop with a deterministic cap. Agent creation, resume, and session flush do not invoke an LLM. `wakeAgents` may be set to `false` only for manual, LLM-free admission inspect.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `repo` | `code2hack/dsh-glasses` | GitHub repository read through `gh api` |
| `repoRoot` | process cwd | source repository used for git worktrees |
| `worktreeRoot` | sibling `dsh-glasses-tickets` | dedicated Ticket worktree parent |
| `baseRef` / `DISPATCHER_BASE_REF` / `--base-ref` | `origin/main` | ref resolved once when a pass has new admissions |
| `baseSha` / `DISPATCHER_BASE_SHA` / `--base-sha` | empty | exact 40-character override for deterministic CI/smoke runs |
| `fetch` / `DISPATCHER_FETCH` / `--fetch`, `--no-fetch` | `true` | fetch `origin` before ref resolution when `origin` is configured; a failed fetch fails that admission pass (`resolutionError`, no admission) instead of falling back to a stale local `origin/main`. Only explicit `fetch: false` permits resolving an intentionally local/stale ref |
| `statePath` / `DISPATCHER_STATE_PATH` | `$XDG_STATE_HOME/dsh-glasses/ticket-dispatcher/state.json` | private local binding state |
| `maxActive` / `DISPATCHER_MAX_ACTIVE` / `--max-active` | `3` | active Ticket ceiling |
| `intervalMs` / `DISPATCHER_INTERVAL_MS` / `--interval-ms` | `120000` | default delay between sequential live passes; every report carries `heartbeatMs` equal to this value |
| `maxPasses` / `DISPATCHER_MAX_PASSES` / `--max-passes` | `0` | live-pass cap; zero is unlimited with `stayAlive` |
| `stayAlive` / `--stay-alive` | `false` | continuously reconcile rather than run one pass |
| `wakeAgents` / `--no-wake` | `true` | send the bootstrap (or minimal continuation) followup after durable claim publication |
| `fixturesPath` | empty | offline test/smoke Ticket and marker store |
| `completionAuthors` | empty | non-empty allowlist of GitHub logins trusted to POST `ticket-complete:` markers; a marker is only authoritative when it is both posted on the Ticket's own issue (`ticket` === source issue) and authored by an allowlisted writer. Keep it set to the DSH closeout identity on shared/public repositories so untrusted commenters cannot retire Tickets |

`gh` must already be authenticated for the target host; no token is read from configuration or committed. The adapter recognizes issue bodies containing the Ticket contract's `## What to build` heading, requires a valid `## Milestone` for admission, and parses references only from `## Blocked by`. Open Tickets without a valid milestone are never admitted and are reported under `invalidMilestone`. Pull requests may satisfy blockers but are not dispatched as Tickets.

Each pass resolves the current base ref only for new admissions and records the resulting exact SHA in their bindings; existing bindings retain their historical SHA (moving-base safe). Resolution failure admits nothing and appears as `resolutionError`. The active Ticket limit is independent of vLLM `max_seqs`: the former limits admitted workers, while the latter limits simultaneous inference. Scarce resources such as the Rokid are reported in a separate `resources.awaitsResource` bucket and never become fake DAG blocker edges.

## Claims, restart, rollback, and completion

Branch `workflow/ticket-<n>` and worktree `ticket-<n>-<shortbase>` names are reconstructable. A first claim binds the exact identity `dsh-glasses-<milestone>-#<n>-DSH` as both name and session id. Publication order is worktree, flushed DSH session, atomic state file, then one GitHub `dispatcher-claim:` marker. A process lock serializes local reconcile calls. Existing state or a durable claim marker suppresses duplicate creation and duplicate re-claims. On restart, a checkout on the recorded branch is usable even when the Ticket Lead has advanced its HEAD beyond the historical binding SHA, so its persisted session resumes under the same deterministic id. A missing or wrong-branch dispatcher-owned path is removed and recreated; an existing Ticket branch is reused at its current head instead of re-pinned.

`refreshState` keeps the durable projection free of runtime liveness signals (worktree usability, session probe, live/progressing flags) so reports never corrupt state. A session probe fails closed: an identity collision becomes `identity-collision`, definitive absence becomes `stale-session`, and an indeterminate probe attempts resume — only a failed resume becomes `invalid-claim`. Failures are removed from capacity, reported in `invalid`, and durably superseded by a session-specific `dispatcher-claim:void` tombstone so a later pass can re-admit. Failure before the claim marker rolls back the agent, worktree, and branch. A crash between session flush and claim publication uses the exact deterministic worktree and reuses the persisted session.

A binding is complete only when its Ticket is CLOSED or a `ticket-complete:` marker matches its session id. Completed bindings are disposed, never woken, and permanently excluded from capacity and admission; the bootstrap instructs the Ticket Lead to write that marker with `{ schemaVersion: 1, ticket, sessionId, head: <exact head SHA>, pr }` at closeout. Resource leasing, Ticket retirement, CTO wake bridges, and model-driven scheduling are intentionally absent — Codex included.

## Checks

```bash
npm test
npm run typecheck
npm run smoke
```

The smoke uses a disposable Git repository, DSH home, profile, state directory, and fixture marker store under the operating system's temporary directory; it never calls GitHub and never touches product code or the Rokid. It does run the **real pinned DSH deployment and real native Codex**: two dummy ready Tickets are admitted as exactly named persistent DSH sessions, restarted into the same sessions with no duplicates, a moving base and a durable completion marker are honored, and two **fresh one-shot self-contained read-only `subagent_codex` invocations** are driven on the bound Ticket DSH session (asserting the worktree stays byte-identical and that no persistent Codex session or thread is created). The smoke asserts the EXACT pinned deployment versions it ran against.

The smoke also exercises the **reviewer-availability contract on a real conversational DSH agent** through the REAL pinned native-Codex reviewer seam (`dsh-tool-subagent` → `dsh-subagent-codex` app-server, Codex 0.148.0): an available reviewer's technical `REQUEST_CHANGES` stays blocking until addressed, the same verdict keeps the Ticket OPEN while the gate stays unmet, and both-helpers-unavailable completes only on the agent's own independent gate.

The smoke additionally runs a **deterministic sequential-helper protocol matrix** (disposable scripted ChatGPT stand-in + REAL pinned native-Codex escalation + observable helper event ledger) and asserts the strict priority chain end-to-end on the real DSH agent: ChatGPT-first planning with ZERO Codex calls while ChatGPT is available; objective ChatGPT `UNAVAILABLE` escalates planning to a REAL fresh Codex plan; progress checkpoints are routed ChatGPT-first with Codex fallback only on unavailability; a hard-problem chain runs EXACTLY three ChatGPT loops and then a fresh Codex escalation (no fourth ChatGPT request), returning to ChatGPT-first afterward (scoped escalation); the final review is ChatGPT-first and a ChatGPT **PASS produces ZERO Codex review calls**; ChatGPT `UNAVAILABLE` at the final review escalates to a REAL Codex exact-head review of the **committed candidate**; three non-pass final-review loops escalate to fresh Codex; both-helpers-unavailable legs complete through DSH's own plan/independent acceptance; and an available reviewer's `REQUEST_CHANGES` stays blocking until the finding is applied. Real Codex invocations are asserted fresh, one-shot, self-contained, and byte-non-mutating, with exact deployment pins (DSH rc.8, Codex 0.148.0) asserted.

Completion authorship is **fail-closed**: with the production GitHub adapter, only authors in the configured `completionAuthors` allowlist may write the durable `ticket-complete:` marker — an empty allowlist authorizes NO marker, and only a CLOSED issue retires a binding.
