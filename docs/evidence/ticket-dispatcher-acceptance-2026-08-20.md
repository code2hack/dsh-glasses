# Ticket #15 — deterministic Ticket Dispatcher — independent DSH acceptance evidence

- Ticket: https://github.com/code2hack/dsh-glasses/issues/15
- DSH Ticket Lead session: `session-e264b58f-a673-447d-90e2-31d45ddc690c` (host `spark`, aarch64; user `code2hack`)
- Tested implementation head: `488b4c4b2b7fecd1cf743d6969b1d4e7f9fe3f8c` (branch `workflow/ticket-dispatcher`)
- Stacked base: accepted PR #14 head `ad6700b44c4fdd712a517b7a32002324c3a19af2` (branch `workflow/cto-dsh-codex`)
- Original bootstrap base recorded before implementation: `71059429be3d6f95ef9625adf5dea52db2cd51d2`
- Evidence date: 2026-08-20
- Codex Coder thread: ONE fresh `Codex-Thread-ID: 01a01f12-aac0-77c0-a3a7-6921db898642`

Independence: production code and committed tests were produced by the Codex Coder; every result below was re-executed independently by the DSH Ticket Lead on `spark` against the exact tested head `488b4c4b2b7fecd1cf743d6969b1d4e7f9fe3f8c`.

## Scope confirmation

- New package only: `plugins/dsh-ticket-dispatcher/` (README, lib, tests, integration smoke). No product code, no Android/app changes, no Rokid/device state, no `SPEC.md`/`AGENTS.md`/`docs/WORKFLOW.md` (beyond the PR #14 stacked base), no TB0 runtime.
- Deterministic non-LLM dispatcher: no LoopX, no DSH Agent Teams, no LLM scheduling, no CTO/CDP wake bridge, no Rokid lease engine (modeled only as a separate status bucket).

## Acceptance matrix — all PASS

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| 1 | one reconcile admits up to configured concurrency and creates one independent root DSH agent/session per admitted Ticket | PASS | integration smoke admitted dummy Tickets #21 and #22 concurrently; root agents created through the documented `ctx.agents.create` seam on the real `@deepseek-ai/dsh@0.1.0-rc.8` runtime |
| 2 | unique session id, dedicated branch/worktree, exact base SHA, AGENTS.md + Ticket bootstrap prompt per admitted Ticket | PASS | smoke report shows distinct `sessionId`, distinct `worktree`, `baseSha == scratch base`, branches `workflow/ticket-21` / `workflow/ticket-22`; state files store `bootstrapPrompt` matching `AGENTS.md section 3` and `issues/<n>` |
| 3 | claimed/running Ticket never spawned twice across repeated reconcile or restart/re-entry | PASS | repeated `reconcile` with same state → identical session ids; fresh state dir + durable markers → identical session ids (`first.json` vs `restarted.json` compared below); no new agents or claim markers |
| 4 | blocked Tickets never admitted; closing blockers makes successors eligible later without LLM | PASS | unit tests `blocked transitions are mechanical` and `closing a blocker makes its successor ready on a later pass`; live read-only GitHub check classifies Ticket #15 as OPEN blocked by PR #14 (open) → not admitted |
| 5 | DAG readiness independent of scarce resources; no fake blocker edge | PASS | unit `claimed Tickets consume capacity and scarce resources remain a separate view`; `resources.awaitsResource` is a separate status bucket in the report |
| 6 | default active concurrency 3, configurable | PASS | `DEFAULT_MAX_ACTIVE = 3`; `--max-active`, config `maxActive`, `DISPATCHER_MAX_ACTIVE`; unit `capacity defaults to three` plus admission-limit tests |
| 7 | documented DSH/Cordis lifecycle seam; agent loop untouched | PASS | implementation uses `ctx.agents.create`/`AgentHandle`, `ctx.sessions.flush`, `agent.followup` (the stock headless-runner pattern); no agent-loop patch |
| 8 | deterministic status/reconcile surface showing ready, running/claimed, blocked, capacity-limited + bindings | PASS | `status`/`reconcile` print stable JSON + human summary; smoke transcript shows two simultaneous claim bindings with sessionId/branch/worktree/baseSha |
| 9 | publication failure leaves no false claim; retry/reconcile safe | PASS | unit tests fault-inject failure at worktree / agent / state / claim steps → local `failed` state, durable marker not written; `a pre-marker publishing crash retries instead of becoming a false claim` |
| 10 | no new credential committed; host auth reused | PASS | only local `gh` CLI auth is used; no token/config committed; probe comment round-trip done against live GitHub |
| 11 | automated tests cover frontier, idempotent admission, concurrency, blocker transitions, rollback, restart/reconcile | PASS | `npm test` → 18/18 (suite includes `adapters.test`, `core.test`, `dispatcher.test`, `state.test`) |
| 12 | integration smoke ≥2 dummy Tickets concurrently, distinct roots/worktrees, no duplicate spawn, no product/Rokid | PASS | `npm run smoke` PASS; retained artifact `/home/code2hack/tmp/dsh-ticket-dispatcher-smoke-0CbUhD` |

## Exact commands and results (re-executed by DSH at tested head `488b4c4`)

```
$ git rev-parse HEAD
488b4c4b2b7fecd1cf743d6969b1d4e7f9fe3f8c

$ git diff --check                                     -> PASS (no whitespace errors)

$ cd plugins/dsh-ticket-dispatcher && npm test
tests 18, pass 18, fail 0                              -> PASS

$ npm run typecheck (node --check lib/*.js)            -> PASS

$ KEEP_SMOKE=1 npm run smoke
dsh-ticket-dispatcher smoke: PASS
smoke retained: /home/code2hack/tmp/dsh-ticket-dispatcher-smoke-0CbUhD

$ node /tmp/real-gh-check.mjs                          -> live read-only GitHub adapter check
agent tickets found: #15[OPEN]
durable claims found: 0
live classify: blocked [ { number: 15, blocking: [14] } ]
```

Deterministic status output from the smoke (two simultaneous Ticket bindings):

```json
{
  "schemaVersion": 1,
  "activeLimit": 3,
  "ready": [],
  "running": [
    {
      "number": 21,
      "status": "claimed",
      "sessionId": "session-b784bb89-1f60-4d2f-b20a-90f1f1b0aabc",
      "branch": "workflow/ticket-21",
      "worktree": "/home/code2hack/tmp/dsh-ticket-dispatcher-smoke-0CbUhD/worktrees/ticket-21-29d19e70ffbb",
      "baseSha": "29d19e70ffbb527a1e7d2ea426de1bfb295dedad",
      "validWorktree": true,
      "sessionPersisted": true
    },
    {
      "number": 22,
      "status": "claimed",
      "sessionId": "session-e2b7cd57-bfae-4dd8-8414-8d26b1ff3163",
      "branch": "workflow/ticket-22",
      "worktree": "/home/code2hack/tmp/dsh-ticket-dispatcher-smoke-0CbUhD/worktrees/ticket-22-29d19e70ffbb",
      "baseSha": "29d19e70ffbb527a1e7d2ea426de1bfb295dedad",
      "validWorktree": true,
      "sessionPersisted": true
    }
  ],
  "blocked": [],
  "capacityLimited": [],
  "resources": { "awaitsResource": [] }
}
```

Distinct DSH root sessions and worktrees (persisted under the disposable `DSH_HOME`):

```
.../sessions/--…-worktrees-ticket-21-29d19e70ffbb--/session-b784bb89-1f60-4d2f-b20a-90f1f1b0aabc
.../sessions/--…-worktrees-ticket-22-29d19e70ffbb--/session-e2b7cd57-bfae-4dd8-8414-8d26b1ff3163
```

Restart / repeated-reconcile idempotency (local binding state `first.json` vs `restarted.json`):

```
first:    21 -> (session-b784bb89-…, claimed) | 22 -> (session-e2b7cd57-…, claimed)
restarted:21 -> (session-b784bb89-…, claimed) | 22 -> (session-e2b7cd57-…, claimed)
NO DUPLICATE SPAWN ACROSS RESTART: True   (distinct sessions in first: 2)
```

Durable claim markers written exactly once per Ticket (reconstructable on restart):

```
dispatcher-claim: {"schemaVersion":1,"ticket":21,"sessionId":"session-b784bb89-…","branch":"workflow/ticket-21",…}
dispatcher-claim: {"schemaVersion":1,"ticket":22,"sessionId":"session-e2b7cd57-…","branch":"workflow/ticket-22",…}
```

Worktree verification: `git -C <worktree> branch --show-current` = `workflow/ticket-21`; `git -C <worktree> rev-parse HEAD` = exact base SHA.

## Live GitHub adapter verification (read-only, real remote)

- `createGithubAdapter({ repo: "code2hack/dsh-glasses" }).listTickets()` returned issue #15 as the only OPEN agent Ticket with `blockers: [14]`; `listClaims([15])` returned `[]` (the validation probe was deleted).
- `gh api --paginate --jq '.[]' …` is the pinned read path because the installed `gh` 2.45.0 (Ubuntu) does not support `--slurp`; the adapter’s `parseJqLines` and its contract tests cover that path.
- Real `gh` comment write/read/delete round-trip verified on live GitHub (probe `dispatcher-claim:` comment created with id `5355846879`, listed back, deleted).

## Assumptions

- GitHub authentication: the local, already-authenticated `gh` CLI (token scopes `repo` etc.) is the only GitHub surface; no repository-committed credential exists. Verified against `gh` 2.45.0.
- DSH host composition: `spark` runs `@deepseek-ai/dsh@0.1.0-rc.8` at `/home/code2hack/.npm-global/lib/node_modules/@deepseek-ai/dsh`; the dispatcher resolves its DSH peers from the running deployment (smoke/README document the link step). DSH/vLLM `max_seqs` is an inference ceiling, not the active-Ticket limit.
- Agent creation does not require an LLM; the `wakeAgents: true` bootstrap-followup path (which starts model turns) is an operator-enabled option and was not an acceptance surface of this bootstrap Ticket.
- Temporary dispatcher smoke profile under the real `DSH_HOME` is created only when operated manually; the committed smoke is fully disposable (`/tmp` home, scratch repo, scratch worktrees, no product or Rokid interaction).

## Review request

See the stacked draft PR opened from `workflow/ticket-dispatcher`. Request id: `req-ticket-15-acceptance`.
