# Ticket #15 — deterministic Ticket Dispatcher — independent DSH acceptance evidence (rev 3)

- Ticket: https://github.com/code2hack/dsh-glasses/issues/15
- DSH Ticket Lead session: `session-e264b58f-a673-447d-90e2-31d45ddc690c` (host `spark`, aarch64; user `code2hack`)
- Tested implementation head: `fb017e41e16843cf43d047bc9e4881977ac9a7bd` (branch `workflow/ticket-dispatcher`)
- Stacked base: current `origin/main` `0673f8c5c30c20caf25532c132b6a27122428578` (PR #14 merged 2026-08-20T13:12:24Z; PR #16 retargeted to `main` per review packet)
- Evidence date: 2026-08-20
- Codex Coder thread: single fresh `Codex-Thread-ID: 01a01f12-aac0-77c0-a3a7-6921db898642` used for all implementation rounds including round 3 of this review cycle. The final round-3 correction was authored directly by the DSH Ticket Lead per owner instruction and is covered below.

SHA semantics (per review packet item 5): `head` in the review request is the exact PR head at request time; `fb017e4` is the **tested-implementation-head** — the exact code head at which every command in this file was executed. This evidence document is committed on top of it, so the PR head differs only by this documentation commit; code content is identical.

## Review loop history

1. Round 1 (`488b4c4`): initial candidate. Harness `REQUEST_CHANGES` (2026-08-20T13:02:32Z) — integrate current PR #14; real `stayAlive` loop; per-pass base ref resolution; restart must RESUME leads and recover invalid claims deterministically; fix review-packet SHA semantics.
2. Round 2 code (`ada2e18`, replayed as `e09a3d7`): all five corrections. Independent DSH real-git validation found three additional defects (progressed worktree wrongly voided; indeterminate probe voiding healthy claims; re-admission on a lingering branch failing); fixed in round-3 code (`6e21479` → `e09a3d7`).
3. Round 3 review (`05fcaf0`): Harness `REQUEST_CHANGES` (2026-08-20T14:17:27Z) — the permanent two blockers:
   1. **fetch failure must fail the admission pass** — `resolveBase` must not silently fall back to a stale local `origin/main` when `fetch: true` and the configured `origin` fetch fails; only explicit `fetch: false` permits an intentionally local/stale ref.
   2. **documented production profile must `wakeAgents: true`** — the README `Install and run` profile must set it and state it is required for automatic Ticket execution.
   Both implemented by the DSH Ticket Lead (owner-directed, no new Codex round) and re-validated independently — see below.

## Round-3 fixes (this evidence)

1. `lib/adapters.js` `resolveBase()`: with `fetch: true`, if `origin` is configured (`git remote get-url origin` succeeds), `git fetch --quiet origin` must succeed; a failure is no longer swallowed and now aborts the admission pass, surfacing as `resolutionError` with no admissions. If no `origin` is configured, the local ref is resolved (offline/smoke path). `fetch: false` resolves the ref directly (intentional local/stale use).
2. README `Install and run`: the production dispatcher profile explicitly sets `wakeAgents: true` with a comment, and the text + configuration table state that **automatic Ticket execution requires `wakeAgents: true`** (the default remains `false` for manual, LLM-free admission inspect).

## Acceptance matrix — all PASS (re-executed by DSH at `fb017e4`)

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| 1 | one reconcile admits up to configured concurrency; one independent root DSH agent/session per admitted Ticket | PASS | smoke admits dummy Tickets concurrently through `ctx.agents.create` on the real `@deepseek-ai/dsh@0.1.0-rc.8` runtime |
| 2 | unique session id, dedicated branch/worktree, exact per-binding base SHA, AGENTS.md §3 + Ticket bootstrap prompt | PASS | smoke bindings carry distinct `sessionId`, `branch`, `worktree`; recorded `baseSha` per binding |
| 3 | claimed/running Ticket never spawned twice across repeated reconcile or restart/re-entry | PASS | repeated `reconcile` and restart resume same session ids; no new agents or sessions |
| 4 | blocked Tickets never admitted; closing blockers makes successors eligible on a later pass (live) | PASS | live reconcile admits a newly-unblocked Ticket on pass 2 of the SAME process; live GitHub classifies #15 READY after blocker PR #14 merged |
| 5 | DAG readiness independent of scarce resources | PASS | `resources.awaitsResource` separate; admission does not depend on it |
| 6 | default active concurrency 3, configurable | PASS | `DEFAULT_MAX_ACTIVE=3`; `--max-active`/config/env |
| 7 | documented DSH seam; agent loop untouched | PASS | only `ctx.agents.create`/`ctx.agents.resume`/`ctx.sessions.flush` public services |
| 8 | deterministic status/reconcile surface with ready/running/blocked/capacity-limited/invalid/resolution-error + bindings | PASS | `formatReport` stable JSON + summary; simultaneous bindings with `live`/`recovered` |
| 9 | publication failure leaves no false claim; rollback safe | PASS | unit tests fault-inject worktree/agent/state/claim; pre-marker crash retried |
| 10 | restart after claim restores a LIVE Ticket Lead, no duplicate; invalid claims never false-running | PASS | `restart-resume`/`head-advanced-resume` same sessions `live=true`, no void; `stale-session` voided once + tombstone + re-eligible; indeterminate probe attempts resume |
| 11 | moving base: later admissions resolve the then-current ref; historical bindings keep their recorded SHA | PASS | `moving-base` + `branch-readmission` (new base recorded, same branch reused) |
| 12 | **fetch gating**: with `fetch: true`, a failed configured-origin fetch fails that admission pass (`resolutionError`, no admission); no stale `origin/main` fallback; `fetch: false` permits local/stale | PASS | new adapter contract tests + dispatcher integration test (below) |
| 13 | **production profile wakes Ticket Leads**: documented production profile sets `wakeAgents: true` and states it is required for automatic Ticket execution | PASS | README `Install and run` + configuration table (below) |
| 14 | no committed credentials; host auth reused | PASS | only local `gh` CLI |
| 15 | tests cover frontier, blockers, admission, concurrency, restart/live loop, moving base, rollback, invalid claims, fetch gating | PASS | `npm test` 35/35 |
| 16 | integration smoke ≥2 concurrent Tickets + live reconcile + moving base + restart resume + invalid claim + head-advanced + branch-readmission, disposable and LLM-free | PASS | `npm run smoke` PASS (retained `/home/code2hack/tmp/dsh-ticket-dispatcher-smoke-wlx2tc`) |

## Exact commands and results (independently re-executed by DSH at tested head `fb017e4`)

```
$ git rev-parse HEAD
fb017e41e16843cf43d047bc9e4881977ac9a7bd

$ git diff --check                                       -> PASS

$ cd plugins/dsh-ticket-dispatcher && npm test
tests 35, pass 35, fail 0                                -> PASS

$ npm run typecheck (node --check lib/*.js)              -> PASS

$ KEEP_SMOKE=1 npm run smoke
dsh-ticket-dispatcher smoke: PASS
smoke retained: /home/code2hack/tmp/dsh-ticket-dispatcher-smoke-wlx2tc
```

Smoke proof lines (exact output):

```
SMOKE live-reconcile: ticket=32 admitted_on_pass=2 session=session-e7537584-022d-4f23-be99-69a51649b3cf
SMOKE moving-base: ticket31=522e7c2eba35270d072dc359805a306c400f5794 ticket32=2af6913b451854cfb1321cde6e34d0656fdc41ca
SMOKE head-advanced-resume: live=true same_session=session-bebc6390-5935-4e01-a1df-dc4da893889e base=522e7c2eba35270d072dc359805a306c400f5794 head=d32d3e39e649e978cec6d85bc57c9281b5841f16 invalid=0 void=false
SMOKE restart-resume: live=true same_sessions=session-bebc6390-5935-4e01-a1df-dc4da893889e,session-7c19292e-93fb-4c86-a727-dcb116518a6b
SMOKE indeterminate-probe: resumed=true live=true session=session-probe-unknown invalid=0 void=false
SMOKE branch-readmission: ticket=51 old_base=2af6913b451854cfb1321cde6e34d0656fdc41ca new_base=a074c5fc56bcd17d4e935b5c897e4521d2e6b19d same_branch=true live=true
SMOKE invalid-claim: ticket=41 reason=stale-session tombstone=true ready=true
```

Round-3 fetch-failure regression (new contract tests, exact head):

```
✔ resolveBase with fetch=true rejects on a failed configured-origin fetch instead of using a stale origin/main
✔ resolveBase with fetch=true returns the fetched remote head, never a stale local origin/main
✔ a failed configured-origin fetch with a resolvable stale origin/main admits no Ticket
tests 3, pass 3, fail 0                     (part of the 35-test suite)
```

The dispatcher-level regression proves the full gate end-to-end: with a locally-resolvable but stale `refs/remotes/origin/main`, a configured `origin` whose fetch fails, and one OPEN Ticket — `reconcile` returns `resolutionError` (matches `/fetch/`), `running: []`, `ready: [7]`, no agent/worktree creation, no durable claim, and no claimed local state.

Live GitHub read-only adapter check (same host, real remote):

```
listTickets: #15[OPEN]
durable claims:  (count 0)
classify: ready=[{number:15}], blocked=[], running=[]    <- PR #14 (blocker) MERGED, #15 ready
resolved origin/main: 0673f8c5c30c20caf25532c132b6a27122428578
```

## Behavior notes (deterministic, documented)

- `reconcile` with `stayAlive`/`maxPasses` runs N sequential non-overlapping passes at `intervalMs`, printing a deterministic report per pass, stopping on its cap or SIGINT/SIGTERM. One-shot `status`/`reconcile` remain supported.
- Base ref resolution per admission pass: with `fetch: true`, a configured `origin` is fetched first and a failed fetch fails the pass (`resolutionError`, no admissions, no stale fallback); `baseSha` remains an exact override; `fetch: false` resolves the ref directly (intentional local/stale). Each binding records the exact 40-char SHA resolved at admission; historical bindings keep theirs.
- Restart resume uses `ctx.agents.resume({ resumeSessionId })` (proven on rc.8): checkout on the recorded branch is usable even when the Lead advanced HEAD; persisted session resumes under the same id without duplicates. Missing/wrong-branch dispatcher-owned paths are recreated; existing branches reused at current head; only a definitively absent persisted session voids `stale-session` (single durable `dispatcher-claim:void` tombstone, then re-eligible); an indeterminate probe attempts resume and only a failed resume voids `invalid-claim` — nothing false-runs.
- **Automatic Ticket execution requires `wakeAgents: true`** (bootstrap followup + model turn per created/resumed Lead). The default stays `false` (create/claim/report only) for manual LLM-free admission inspect; the README production profile explicitly sets `wakeAgents: true`.

## Assumptions

- GitHub authentication: local, already-authenticated `gh` CLI (2.45.0) is the only GitHub surface; `gh api --paginate --jq '.[]'` is the pinned read path (no `--slurp` on this build, covered by contract tests); no repository-committed credential.
- DSH host composition: `spark` runs `@deepseek-ai/dsh@0.1.0-rc.8` at `/home/code2hack/.npm-global/lib/node_modules/@deepseek-ai/dsh`; DSH peers resolve from the running deployment; vLLM `max_seqs` is an inference ceiling, not the active-Ticket limit.
- Smoke is fully disposable (temp DSH home, scratch repo, scratch worktrees) and offline-LLM-free; the smoke intentionally uses `fetch: false` for local-ref determinism. No product code, no Rokid/device interaction, no `SPEC.md` change (DSH internals stay behind the project adapter per `SPEC.md` §5).

## Review request

See the stacked PR #16 review request `req-ticket-15-acceptance-3` (kind `review`, head = exact PR head at posting, tested-implementation-head = `fb017e41e16843cf43d047bc9e4881977ac9a7bd`).
