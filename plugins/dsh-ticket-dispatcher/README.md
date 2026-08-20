# DSH Ticket Dispatcher

`dsh-ticket-dispatcher` is deterministic runtime glue for the workflow in `AGENTS.md` and `docs/WORKFLOW.md`. It sorts open contract Tickets by numeric id, admits the ready unclaimed frontier, and creates one root DSH agent plus one branch/worktree per Ticket. It does not plan Milestones, infer dependencies, schedule devices, or patch the agent loop.

## Install and run

Install or link this package into a DSH profile that mounts `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-headless`. Disable the stock headless rows and insert this plugin:

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
        # to each admitted/resumed Ticket Lead and start its model turns.
        wakeAgents: true
```

The package must resolve its DSH peers from the running deployment. For a linked source checkout, link the deployment's `node_modules/@deepseek-ai` scope into this package's `node_modules`, as the smoke script does.

```bash
dsh --profile dispatcher --patch overlay.yml status
dsh --profile dispatcher --patch overlay.yml reconcile
dsh --profile dispatcher --patch overlay.yml reconcile --stay-alive --interval-ms 60000 --max-active 2
dsh --profile dispatcher --patch overlay.yml reconcile --max-passes 3 --base-ref origin/main
```

The command prints stable JSON followed by a stable human summary for every pass. `status` and ordinary `reconcile` are one-shot. `stayAlive: true` loops sequentially without overlapping passes; `maxPasses: N` provides the same loop with a deterministic cap. Agent creation, resume, and session flush do not invoke an LLM. `wakeAgents` defaults to `false` (create/claim/report only, no model turn). **Automatic Ticket execution requires `wakeAgents: true`:** each newly admitted or resumed Ticket Lead then receives its recorded bootstrap prompt and starts model turns. The production workflow profile above therefore slips it explicitly; keep the safe default only for manual, LLM-free admission inspect.

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
| `intervalMs` / `DISPATCHER_INTERVAL_MS` / `--interval-ms` | `60000` | delay between sequential live passes |
| `maxPasses` / `DISPATCHER_MAX_PASSES` / `--max-passes` | `0` | live-pass cap; zero is unlimited with `stayAlive` |
| `stayAlive` / `--stay-alive` | `false` | continuously reconcile rather than run one pass |
| `wakeAgents` | `false` | send the bootstrap followup after durable claim publication; **`true` is required for automatic Ticket execution** |
| `fixturesPath` | empty | offline test/smoke Ticket and marker store |

`gh` must already be authenticated for the target host; no token is read from configuration or committed. The adapter recognizes issue bodies containing the Ticket contract's `## What to build` heading and parses references only from `## Blocked by`. Pull requests may satisfy blockers but are not dispatched as Tickets.

Each pass resolves the current base ref only for new admissions and records the resulting exact SHA in their bindings; existing bindings retain their historical SHA. Resolution failure admits nothing and appears as `resolutionError`. The active Ticket limit is independent of vLLM `max_seqs`: the former limits admitted workers, while the latter limits simultaneous inference. Scarce resources such as the Rokid are reported in a separate `resources.awaitsResource` bucket and never become fake DAG blocker edges.

## Claims, restart, and rollback

Branch `workflow/ticket-<n>` and worktree `ticket-<n>-<shortbase>` names are reconstructable. Each admission gets a unique `session-<uuid>`. Publication order is worktree, flushed DSH session, atomic state file, then one GitHub `dispatcher-claim:` comment. A process lock serializes local reconcile calls. Existing state or a durable claim marker suppresses duplicate creation. On restart, a checkout on the recorded branch is usable even when the Ticket Lead has advanced its HEAD beyond the historical binding SHA, so its persisted session resumes in place under the same id. A missing or wrong-branch dispatcher-owned path is removed and recreated; an existing Ticket branch is reused at its current head instead of re-pinned to the new binding SHA. Reports expose `live` and optional `recovered` on bindings.

A session is marked `stale-session` only when persistence is definitively absent. An indeterminate probe attempts resume; only a failed resume becomes `invalid-claim`. Missing sessions and resume failures are removed from capacity, reported in `invalid`, and durably superseded by a session-specific `dispatcher-claim:void` tombstone so a later pass can admit a fresh worker. Failure before the claim marker rolls back the agent, worktree, and branch. A crash after local `publishing` state reuses the exact deterministic worktree and retries with a fresh session. Resource leasing, Ticket retirement, CTO wake bridges, and model-driven scheduling are intentionally absent.

## Checks

```bash
npm test
npm run typecheck
npm run smoke
```

The smoke uses a disposable Git repository, DSH home, profile, state directory, and fixture marker store under the operating system's temporary directory; it never calls GitHub, invokes a model, or touches product code or the Rokid.
