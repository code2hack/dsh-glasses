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
        baseSha: <exact-40-character-sha>
```

The package must resolve its DSH peers from the running deployment. For a linked source checkout, link the deployment's `node_modules/@deepseek-ai` scope into this package's `node_modules`, as the smoke script does.

```bash
dsh --profile dispatcher --patch overlay.yml status
dsh --profile dispatcher --patch overlay.yml reconcile
dsh --profile dispatcher --patch overlay.yml reconcile --max-active 2
```

The command prints stable JSON followed by a stable human summary. `reconcile` is one-shot unless `stayAlive: true` is configured. Agent creation and session flush do not invoke an LLM. Set `wakeAgents: true` only when the admitted agents should immediately receive their recorded bootstrap prompts and start model turns.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `repo` | `code2hack/dsh-glasses` | GitHub repository read through `gh api` |
| `repoRoot` | process cwd | source repository used for git worktrees |
| `worktreeRoot` | sibling `dsh-glasses-tickets` | dedicated Ticket worktree parent |
| `baseSha` / `DISPATCHER_BASE_SHA` | required | exact base for every admission pass |
| `statePath` / `DISPATCHER_STATE_PATH` | `$XDG_STATE_HOME/dsh-glasses/ticket-dispatcher/state.json` | private local binding state |
| `maxActive` / `DISPATCHER_MAX_ACTIVE` / `--max-active` | `3` | active Ticket ceiling |
| `wakeAgents` | `false` | send the bootstrap followup after durable claim publication |
| `fixturesPath` | empty | offline test/smoke Ticket and marker store |

`gh` must already be authenticated for the target host; no token is read from configuration or committed. The adapter recognizes issue bodies containing the Ticket contract's `## What to build` heading and parses references only from `## Blocked by`. Pull requests may satisfy blockers but are not dispatched as Tickets.

The active Ticket limit is independent of vLLM `max_seqs`: the former limits admitted workers, while the latter limits simultaneous inference. Scarce resources such as the Rokid are reported in a separate `resources.awaitsResource` bucket and never become fake DAG blocker edges.

## Claims, restart, and rollback

Branch `workflow/ticket-<n>` and worktree `ticket-<n>-<shortbase>` names are reconstructable. Each admission gets a unique `session-<uuid>`. Publication order is worktree, flushed DSH session, atomic state file, then one GitHub `dispatcher-claim:` comment. A process lock serializes local reconcile calls. Existing state or a durable claim marker suppresses duplicate creation; a lost state file is reconstructed from markers and validated against the worktree and persisted DSH session directory.

Failure before the marker rolls back the agent, worktree, and branch, records local `failed` state when possible, and leaves the Ticket retryable. A crash after local `publishing` state reuses the exact deterministic worktree and retries with a fresh session; a published marker always wins reconstruction. Resource leasing, Ticket retirement, CTO wake bridges, and model-driven scheduling are intentionally absent.

## Checks

```bash
npm test
npm run typecheck
npm run smoke
```

The smoke uses a disposable Git repository, DSH home, profile, state directory, and fixture marker store under the operating system's temporary directory; it never calls GitHub, invokes a model, or touches product code or the Rokid.
