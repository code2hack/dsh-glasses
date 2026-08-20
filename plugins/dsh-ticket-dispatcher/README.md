# DSH Ticket Dispatcher

`dsh-ticket-dispatcher` is deterministic runtime glue for the workflow in `AGENTS.md` and `docs/WORKFLOW.md`. It sorts open contract Tickets by numeric id, admits the ready unclaimed frontier, and materializes one dedicated pair per Ticket: one named persistent DSH session, one named persistent Codex thread, one branch/worktree, and one exact admitted base SHA. Per the current protocol the **dispatcher** creates the paired Codex thread (its first prompt is exactly the thread name and nothing else) and keeps it idle; the DSH bootstrap explicitly requires ChatGPT startup planning before the first production edit and mandatory dual ChatGPT+Codex escalation on hard/stuck problems. The dispatcher does not plan Milestones, infer dependencies, schedule devices, or patch the agent loop.

## Install and run

Install or link this package into a DSH profile that mounts `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-headless`, and `@deepseek-ai/dsh-llm`. Disable the stock headless rows and insert this plugin:

```yaml
- id: headless-startup
  disabled: true
- id: headless-runner
  disabled: true
- insert:
    - id: ticket-dispatcher
      name: 'dsh-ticket-dispatcher'
      config:
        repoRoot: /absolute/path/to/dsh-glasses
        baseRef: origin/main
        stayAlive: true
        # Required for automatic Ticket execution: deliver the bootstrap prompt
        # to each admitted/resumed Ticket Lead and start its model turns, and
        # allow the same-session watchdog to continue quiesced workers.
        wakeAgents: true
```

The package must resolve its DSH peers from the running deployment. For a linked source checkout, link the deployment's `node_modules/@deepseek-ai` scope into this package's `node_modules`, as the smoke script does.

```bash
dsh --profile dispatcher --patch overlay.yml status
dsh --profile dispatcher --patch overlay.yml reconcile
dsh --profile dispatcher --patch overlay.yml reconcile --stay-alive --heartbeat-interval-ms 120000 --max-active 2
dsh --profile dispatcher --patch overlay.yml reconcile --max-passes 3 --base-ref origin/main
```

The command prints stable JSON followed by a stable human summary for every pass. `status` and ordinary `reconcile` are one-shot. `stayAlive: true` loops sequentially without overlapping passes; `maxPasses: N` provides the same loop with a deterministic cap. Agent creation, resume, and session flush do not invoke an LLM. `wakeAgents` defaults to `false` (create/claim/report only, no model turn). **Automatic Ticket execution requires `wakeAgents: true`:** each newly admitted or resumed Ticket Lead then receives its recorded bootstrap prompt and starts model turns, and the watchdog may send minimal same-session continuations. The production workflow profile above therefore slips it explicitly; keep the safe default only for manual, LLM-free admission inspect.

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
| `heartbeatIntervalMs` / `DISPATCHER_HEARTBEAT_INTERVAL_MS` / `--heartbeat-interval-ms` | `120000` | polling/heartbeat cadence, in ms; also the watchdog cooldown before a quiesced unfinished session may be continued. `intervalMs` / `--interval-ms` remains a backwards-compatible alias |
| `maxPasses` / `DISPATCHER_MAX_PASSES` / `--max-passes` | `0` | live-pass cap; zero is unlimited with `stayAlive` |
| `stayAlive` / `--stay-alive` | `false` | continuously reconcile rather than run one pass |
| `wakeAgents` | `false` | send the bootstrap followup after durable claim publication and enable same-session watchdog continuations; **`true` is required for automatic Ticket execution** |
| `codexThinking` / `DISPATCHER_CODEX_THINKING` / `--codex-thinking` | `max` | Codex reasoning effort. Applied to the REAL persistent thread through `config.model_reasoning_effort` / `turn effort`; never a Codex profile or per-thread model selection |
| `codexBin` / `CODEX_BIN` | `codex` | codex CLI used only for `app-server daemon start/version` |
| `codexControlSocket` / `DISPATCHER_CODEX_CONTROL_SOCKET` | empty | optional explicit app-server control socket (skips daemon resolution) |
| `fixturesPath` | empty | offline test/smoke Ticket and marker store |

There is **no Codex profile setting and no dispatcher model setting**: every Codex thread inherits the running daemon's profile/model (owner protocol-v2 directive). Only the polling/heartbeat interval and the Codex thinking effort are exposed and configurable.

`gh` must already be authenticated for the target host; no token is read from configuration or committed. The adapter recognizes issue bodies containing the Ticket contract's `## What to build` heading and parses references only from `## Blocked by`. Pull requests may satisfy blockers but are not dispatched as Tickets.

Each pass resolves the current base ref only for new admissions and records the resulting exact SHA in their bindings; existing bindings retain their historical SHA. Resolution failure admits nothing and appears as `resolutionError`. The active Ticket limit is independent of vLLM `max_seqs`: the former limits admitted workers, while the latter limits simultaneous inference. Scarce resources such as the Rokid are reported in a separate `resources.awaitsResource` bucket and never become fake DAG blocker edges.

## Milestone naming and paired admission

Every admitted Ticket must declare a `## Milestone` section; the first valid naming token of its first line is parsed mechanically and is required for identity. The naming contract is deterministic:

```text
DSH session :  <project>-<milestone>-#<n>-DSH
Codex thread:  <project>-<milestone>-#<n>-Codex
branch      :  workflow/ticket-<n>
worktree    :  <worktreeRoot>/ticket-<n>-<baseSha[0:12]>
base SHA    :  the exact 40-character SHA admitted against
```

A malformed or ambiguous Milestone places the Ticket in `invalid` (`milestone-malformed`) rather than guessing a name, and nothing is claimed. On admission the dispatcher creates the branch/worktree, the named flushed DSH session, exactly one named persistent Codex thread (never `exec`), seeds that thread with **exactly one** `turn/start` whose input is byte-for-byte the Codex name (no second prompt; thread then sits idle), and finally publishes the GitHub `dispatcher-claim:` marker carrying the full reconstructable pair. Any failure rolls the whole pair back — Codex thread deleted, agent disposed, worktree/branch removed — so no false half-claim is ever durable.

## Claims, restart, watchdog, and rollback

Branch, worktree, Milestone, pair names, session id, and Codex thread id are all reconstructable from the claimed binding. Each admission keeps its own `session-<uuid>`. Publication order is worktree, DSH session, Codex thread + one-name seed, atomic state file, then GitHub claim comment. A process lock serializes local reconcile calls. Existing state or a durable claim marker suppresses duplicate creation; repeated reconcile never duplicates either member of the pair.

On restart, the dispatcher reconstructs the SAME pair — it reuses the recorded session id (resumed, not recreated), verifies/rebuilds the SAME Codex thread by id/name through the real app-server seam (`thread/read`; `thread/start` only when the thread is genuinely gone), reuses a usable branch/worktree even when the Lead advanced its HEAD, and never fabricates a new identity. A missing or wrong-branch dispatcher-owned path is removed and recreated.

The watchdog is lifecycle-grounded, not wall-clock: it reads the real agent handle `status`. A **live and progressing** pair is never woken. A **quiesced (idle), unfinished** pair receives a minimal continuation in the SAME DSH session only after the heartbeat cooldown has elapsed. **Completed** Tickets (durable `dispatcher-closeout:` GitHub marker — set during AGENTS.md closeout — or a closed Ticket) are retired, their agents disposed, and never re-woken, even across restarts.

A session is marked `stale-session` only when persistence is definitively absent. An indeterminate probe attempts resume; only a failed resume becomes `invalid-claim`. Missing sessions and resume failures are removed from capacity, reported in `invalid`, and durably superseded by a session-specific `dispatcher-claim:void` tombstone so a later pass can admit a fresh worker. Failure before the claim marker rolls back the Codex thread, agent, worktree, and branch. A crash after local `publishing` state reuses the exact deterministic worktree and retries with a fresh pair.

## Checks

```bash
npm test
npm run typecheck
npm run smoke
```

The smoke runs against a disposable Git repository, DSH home/profile, state directory, and fixture marker store under the operating system's temporary directory; it never calls GitHub or touches product code or the Rokid. It mounts the REAL `@deepseek-ai/dsh` seam and the REAL local Codex app-server control socket, so passing smoke proves the full admission/restart/watchdog pair lifecycle against the exact revisions the deployment uses.
