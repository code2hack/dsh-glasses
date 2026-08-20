# Ticket #15 — deterministic Ticket Dispatcher — independent DSH acceptance evidence (rev 2)

- Ticket: https://github.com/code2hack/dsh-glasses/issues/15
- DSH Ticket Lead session: `session-e264b58f-a673-447d-90e2-31d45ddc690c` (host `spark`, aarch64; user `code2hack`)
- Tested implementation head: `e09a3d72de48a0733fe9f3aa0ed1e4e5b91f6b86` (branch `workflow/ticket-dispatcher`)
- Stacked base: current `origin/main` `0673f8c5c30c20caf25532c132b6a27122428578` — the Ticket Dispatcher PR #16 was retargeted to `main` because PR #14 (`workflow/cto-dsh-codex`) MERGED during this Ticket (merged 2026-08-20T13:12:24Z at head `e3f6cdbf`); the review packet required retargeting/integrating to current `main` in that case.
- Evidence date: 2026-08-20
- Codex Coder thread: single fresh `Codex-Thread-ID: 01a01f12-aac0-77c0-a3a7-6921db898642` used for all three rounds. The Harness bootstrap review packet (`REQUEST_CHANGES`, PR #16 comment, 2026-08-20T13:02:32Z) was the complete blocking review and was fully resolved.

SHA semantics (per review packet item 5): `head` in the review request is the exact PR head at request time; `e09a3d7` is the **tested-implementation-head** — the exact code head at which every command in this file was executed. The evidence document is committed on top of it, so the PR head differs only by this documentation commit; code content is identical.

## Review loop history

1. Round 1 (`HEAD ~= 488b4c4`): initial candidate; Harness `REQUEST_CHANGES` with five blocking corrections (integrate current PR #14; real `stayAlive` loop; per-pass base ref resolution; restart must RESUME leads and recover invalid claims deterministically; fix review-packet SHA semantics).
2. Round 2 (`ada2e18`): implemented live reconcile, per-pass base resolution, restart resume with void/rollback. Independent DSH real-git validation found three concrete defects (all outside the committed fixture-based tests):
   - healthy lead whose worktree HEAD advanced was wrongly voided on restart instead of resumed;
   - an indeterminate session probe (`undefined`, e.g. no `DSH_HOME`) voided healthy claims as `stale-session`;
   - re-admission on a lingering branch at a different SHA failed to attach the branch.
3. Round 3 (`6e21479`, now replayed as `e09a3d7`): fixed all three; independent DSH re-validation of the exact defects + the full acceptance surface now PASS.

## Acceptance matrix — all PASS (re-executed by DSH at `e09a3d7`)

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| 1 | one reconcile admits up to configured concurrency; one independent root DSH agent/session per admitted Ticket | PASS | smoke admits dummy Tickets concurrently through `ctx.agents.create` on the real `@deepseek-ai/dsh@0.1.0-rc.8` runtime |
| 2 | unique session id, dedicated branch/worktree, exact per-binding base SHA, AGENTS.md §3 + Ticket bootstrap prompt | PASS | smoke bindings carry distinct `sessionId`, `branch`, `worktree`; recorded `baseSha` per binding; prompts match `AGENTS.md section 3` and `issues/<n>` |
| 3 | claimed/running Ticket never spawned twice across repeated reconcile or restart/re-entry | PASS | repeated `reconcile` and recorded restart resume same session ids (`restart-resume`/`head-advanced-resume` lines); no new agents or sessions |
| 4 | blocked Tickets never admitted; closing blockers makes successors eligible on a later pass (live) | PASS | live reconcile admits a newly-unblocked Ticket on pass 2 of the SAME long-running process (`live-reconcile`); live GitHub classifies #15 READY after its blocker PR #14 merged |
| 5 | DAG readiness independent of scarce resources | PASS | `resources.awaitsResource` remains a separate report bucket; admission does not depend on it |
| 6 | default active concurrency 3, configurable | PASS | `DEFAULT_MAX_ACTIVE=3`; per-pass capacity; `--max-active`/config/env |
| 7 | documented DSH seam; agent loop untouched | PASS | only `ctx.agents.create`/`ctx.agents.resume`/`ctx.sessions.flush` public services; no agent-loop patch |
| 8 | deterministic status/reconcile surface with ready/running/blocked/capacity-limited/invalid/resolution-error + bindings | PASS | `formatReport` stable JSON + summary; smoke shows simultaneous bindings with `live`/`recovered` |
| 9 | publication failure leaves no false claim; rollback safe | PASS | unit tests fault-inject worktree/agent/state/claim; rollback disposes agent, removes worktree, unclaimed; pre-marker crash retried |
| 10 | restart after claim restores a LIVE Ticket Lead, no duplicate, invalid claims never false-running | PASS | `restart-resume` `live=true` same sessions; `head-advanced-resume` `live=true` same session with progressed worktree, no void; `stale-session` (definitively missing session) voided once with durable tombstone and becomes eligible again; `indeterminate-probe` attempts resume and never voids on unknown |
| 11 | moving base: later admissions resolve the then-current ref; historical bindings keep their recorded SHA; no startup freeze | PASS | `moving-base` (ticket31 vs ticket32 different SHAs on later pass) + `branch-readmission` (new base recorded, same branch reused); `resolution failure reports deterministically` unit test |
| 12 | no committed credentials; host auth reused | PASS | only local `gh` CLI; read/write round-trip on live GitHub |
| 13 | tests cover frontier, blockers, admission, concurrency, restart/live loop, moving base, rollback, invalid claims | PASS | `npm test` 32/32 incl. `bounded reconcile loop`, `restart resumes a progressed worktree...`, `default indeterminate session probe...`, git-adapter real-repo tests |
| 14 | integration smoke ≥2 concurrent Tickets + live reconcile + moving base + restart resume + invalid claim, disposable and LLM-free | PASS | `npm run smoke` PASS (retained `/home/code2hack/tmp/dsh-ticket-dispatcher-smoke-ZCCEIe`) |

## Exact commands and results (independently re-executed by DSH at tested head `e09a3d7`)

```
$ git rev-parse HEAD
e09a3d72de48a0733fe9f3aa0ed1e4e5b91f6b86

$ git diff --check                                       -> PASS

$ cd plugins/dsh-ticket-dispatcher && npm test
tests 32, pass 32, fail 0                                -> PASS

$ npm run typecheck (node --check lib/*.js)              -> PASS

$ KEEP_SMOKE=1 npm run smoke
dsh-ticket-dispatcher smoke: PASS
smoke retained: /home/code2hack/tmp/dsh-ticket-dispatcher-smoke-ZCCEIe
```

Smoke proof lines (exact output):

```
SMOKE live-reconcile: ticket=32 admitted_on_pass=2 session=session-ae570040-1058-42a3-9fb1-849101326002
SMOKE moving-base: ticket31=3abdf93b8334cdd706edf2ace43016800a75c325 ticket32=ada8cc1c5fcffa26a6d681187801095f2feee6c2
SMOKE head-advanced-resume: live=true same_session=session-a09a7b7a-e863-413b-ab07-84fe155b5ac4 base=3abdf93b8334cdd706edf2ace43016800a75c325 head=299952850a26360fb2175a59f1b3f2ec239924e7 invalid=0 void=false
SMOKE restart-resume: live=true same_sessions=session-a09a7b7a-e863-413b-ab07-84fe155b5ac4,session-0b22dfd2-314b-4e88-9df7-e8d2a0fa80ac
SMOKE indeterminate-probe: resumed=true live=true session=session-probe-unknown invalid=0 void=false
SMOKE branch-readmission: ticket=51 old_base=ada8cc1c5fcffa26a6d681187801095f2feee6c2 new_base=614cc96e3c3fc9c6e3c068fb34dd7ece5fc3f534 same_branch=true live=true
SMOKE invalid-claim: ticket=41 reason=stale-session tombstone=true ready=true
```

Independent real-git defect repro (now PASS, see "Review loop history" for the round-2 FAILs):

```
[A] restart of a lead whose worktree HEAD advanced: resumed same session, live=true, no void  -> PASS
[B] restart with indeterminate session probe: resume attempted, no void                        -> PASS
[C] re-admission with lingering branch at old SHA: branch reused, Ticket + successor admitted  -> PASS
```

Live GitHub read-only adapter check (same host, real remote):

```
listTickets: #15[OPEN]
durable claims:  (count 0)
classify: ready=[{number:15}], blocked=[], running=[]    <- PR #14 (blocker) MERGED, #15 is on the ready frontier
resolved origin/main: 0673f8c5c30c20caf25532c132b6a27122428578
```

## Behavior notes (deterministic, documented)

- `reconcile` with `stayAlive`/`maxPasses` runs N sequential non-overlapping passes at `intervalMs`, printing a deterministic report per pass, and stops on its cap or SIGINT/SIGTERM. One-shot `status`/`reconcile` remain supported. A `maxPasses` cap is the deterministic bound the smoke/tests use.
- Base ref resolution happens per admission pass (`fetch` then `rev-parse <baseRef>`), or the explicit exact `baseSha` override is used verbatim. Each binding records the exact 40-char SHA resolved at admission; historical bindings keep theirs. Resolution failure on a pass admits nothing and reports `resolutionError`.
- Restart resume uses `ctx.agents.resume({ resumeSessionId })` (proven on rc.8): a checkout on the recorded branch is usable even when the Ticket Lead advanced its HEAD; the persisted session resumes in place under the same id, no duplicate. A missing or wrong-branch dispatcher-owned worktree path is removed and recreated; an existing Ticket branch is reused at its current head instead of re-pinned. Only a definitively absent persisted session voids `stale-session` (single durable `dispatcher-claim:void` tombstone, then the Ticket becomes eligible again); an indeterminate probe attempts resume and only a failed resume voids `invalid-claim`.
- Dispatcher-owned paths are confined under the configured `worktreeRoot`; anything else is rejected before any mutation.

## Assumptions

- GitHub authentication: the local, already-authenticated `gh` CLI (2.45.0) is the only GitHub surface; `gh api --paginate --jq '.[]'` is the pinned read path (no `--slurp` on this build) with contract tests; no repository-committed credential.
- DSH host composition: `spark` runs `@deepseek-ai/dsh@0.1.0-rc.8` at `/home/code2hack/.npm-global/lib/node_modules/@deepseek-ai/dsh`; DSH peers resolve from the running deployment; vLLM `max_seqs` is an inference ceiling, not the active-Ticket limit.
- Agent creation/resume does not require an LLM; the `wakeAgents: true` model-turn bootstrap followup is operator-enabled and was not an acceptance surface of this bootstrap Ticket.
- Smoke is fully disposable (temp DSH home, scratch repo, scratch worktrees) and offline-LLM-free; no product code, no Rokid/device interaction, no change to `SPEC.md` (`SPEC.md` §5 DSH-integration rule followed: DSH internals stay behind the project adapter).

## Review request

See the stacked PR #16 review request `req-ticket-15-acceptance-2` (kind `review`, head = exact PR head at posting, tested-implementation-head = `e09a3d72de48a0733fe9f3aa0ed1e4e5b91f6b86`).
