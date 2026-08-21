# Ticket #19 — Bootstrap: native-Codex dispatcher validation evidence (sequential-helper protocol)

- **Ticket:** #19 (Milestone `Bootstrap`, Gate `autonomous`)
- **Branch:** `workflow/ticket-19`; **PR:** #25 (supersedes closed #22)
- **Three identities recorded (must stay distinct):**
  1. **Admitted base** (historical): `c6e5d120972251a762b28890d4d24727615bc1a3` (`origin/main` at #19 bootstrap)
  2. **Authority-sync baseline** (workflow delta): `fe547f22af76b127b592a4e4bf96fa5b361e6b16` (`origin/main` merged into this branch as `0da5ee2cdb3fd08646e2ea14b972fda45b2f09e9`; sequential-helper authority, docs-only merge that did not touch `plugins/`)
  3. **Final exact-head candidate:** `PENDING R9 FREEZE` — the authoritative SHA will be recorded in PR #25 / Ticket #19 closeout AFTER exact-head validation (a commit cannot embed its own final SHA; no doc-only commit is created after freeze just to insert it)
- **Produced:** 2026-08-21 on **spark** (repo `code2hack/dsh-glasses`). Git history + GitHub remain the durable record; this doc is reproducible on this host with the pinned DSH release.

## Status

Automatic Ticket execution is enabled (workflow §16 `VALIDATED by Bootstrap Ticket #19 … automatic Ticket execution is now enabled`). The dispatcher admits, persists, restarts, watches, and completes exactly named DSH sessions. The generated bootstrap/continuation prompts now teach the **strict sequential-helper protocol** from the current workflow authority (AGENTS §§4–10, fe547f22-era): ChatGPT FIRST; fresh native Codex subagent as escalation ONLY (objective `UNAVAILABLE` or the same unresolved planning/progress/debug/review chain surviving exactly three unsuccessful ChatGPT loops); DSH alone only as last resort; **never** ChatGPT+Codex in parallel for the same step; a helper-produced DETAILED ORDERED plan + checkable to-do list before the first production edit; a mandatory progress checkpoint after EVERY completed to-do item (routed ChatGPT-first, Codex on escalation/unavailability, both unavailable → record durably and continue); and sequential final-review routing — a ChatGPT PASS means **no Codex review is invoked**; ChatGPT `UNAVAILABLE` escalates to a fresh Codex exact-head review; the third unsuccessful ChatGPT review loop escalates to Codex instead of a fourth ChatGPT request; both helpers unavailable → independent completion only when every non-review gate passes and no unresolved known blocking finding remains. `UNAVAILABLE` is recorded only on objective execution failure (timeout, rate/quota/usage limit, provider outage, transport/tool failure); a returned technical verdict (`UNPASSED`/`REQUEST_CHANGES`/a blocking finding) is the opposite of `UNAVAILABLE` and must be addressed. Prior dual/parallel-helper wording (`two PASSes preferred`, `PASS + UNAVAILABLE` pairings, `attempt it against BOTH`, `best-effort redundant helpers`) is fully removed from generated prompts, unit contracts, README, and smoke.

Completion markers are source-bound and trusted-writer enforced **with a fail-closed default** on the real GitHub adapter: with an empty `completionAuthors` allowlist the real adapter authorizes NO marker and only a CLOSED issue retires a binding. The full bootstrap is delivered on the FIRST successful wake; a failed bootstrap wake is retried with the **full** bootstrap (durable `bootstrapped` flag) and never silently degraded to a continuation prompt. No persistent Codex lifecycle state exists anywhere in the dispatcher. Re-work/reopen of Ticket #19 never creates a second identity: `name === sessionId === dsh-glasses-Bootstrap-#19-DSH`.

## Reviewer and checkpoint history (this exact worker chain)

| # | Artifact | Head / volume | Verdict |
|---|----------|---------------|---------|
| — | Fresh Codex round 1 | r1 fixes + evidence | REQUEST_CHANGES → resolved |
| — | CTO round 1 (`dsht19-review-1`) | r1 evidence | blockers → resolved (`b06d65a`) |
| — | Fresh Codex round 2 | r2 evidence | REQUEST_CHANGES → resolved |
| — | CTO round 2 (`dsht19-review-2`) | r2 evidence | blockers → resolved (`2130879`) |
| — | CTO round 3 (`dsht19-review-3`) | HEAD `423ae86` | REQUEST_CHANGES — 3 blockers → addressed (`b06d65a`) |
| — | Fresh Codex round 3 | HEAD `509c112` | 3 findings → resolved (`56556eb`) |
| — | CTO round 4 (`dsht19-review-4`) | HEAD `1bbc524` | 1 blocker (CLOSED invalid-Milestone crash) → fixed (`464734d`, `509c112`, `56556eb`) |
| — | Fresh Codex round 4 | HEAD `509c112` | 5 findings → all fixed (`56556eb`) |
| — | Fresh Codex round 5 | HEAD `509c112` | 3 findings: #1 evidence/doc mismatch → pending-final; #2 bootstrap-retry FIXED (`56556eb`); #3 CLOSED crash FIXED (`56556eb`) |
| R1 | CTO (dsht19-plan-reconcile-1) | merge+pin `0da5ee2` | PASS |
| R2 | CTO `dsht19-progress-R2` | audit inventory | PASS |
| R3 | CTO `dsht19-progress-R3` | bootstrap/continuation rewrite | PASS |
| R4 | CTO `dsht19-progress-R4` | sequential unit contracts (72/72) | PASS |
| R5 | CTO `dsht19-progress-R5` | sequential smoke matrix + full real smoke PASS | PASS |
| R6 | CTO `dsht19-progress-R6` | README sequential rewrite | PASS |
| R7 | evidence rewrite + PR #25 body | docs-only | PASS |
| R8 | integration commit + push `a888e2c` | pushed head; 72/72 + typecheck + full smoke PASS; PR #25 mergeable/clean | PASS |
| R9 | full validation on final head + fresh Codex final review | §R9 | PENDING |

Every CTO verdict above is recorded against the exact head at the time of review; a production-code change invalidates any earlier PASS for the new exact head. GitHub/PR remains the durable authority for all of the above.

**Why the FINAL review of this Ticket routes to fresh Codex rather than ChatGPT:** under fe547f22's sequential protocol, a final review is ChatGPT-first, and only after three unsuccessful ChatGPT review loops on the SAME exact-head review chain does it escalate to a fresh native Codex. Ticket #19's final-review chain has already completed three CTO (ChatGPT) review loops (`dsht19-review-2`, `dsht19-review-3`, `dsht19-review-4`) — each returning `REQUEST_CHANGES`, each since addressed on the branch — so the review chain is Codex-escalated. R1–R6 progress checkpoints (plan source `dsht19-plan-reconcile-1`) continue to go ChatGPT-first as ordinary progress routing; only the final-review chain follows the escalation rule.

## 1. Unit validation (deterministic, offline)

Command: `npm test` in `plugins/dsh-ticket-dispatcher` → **72 tests, 72 pass, 0 fail**. `npm run typecheck` → **clean**.

Coverage relevant to Ticket #19:

- **Named DSH admission / stable identity:** exact identity `dsh-glasses-<milestone>-#<n>-DSH` (`name === sessionId === dshName({milestone, number})`); marker schemaVersion 2 with name/sessionId/branch/worktree/baseSha; no duplicate claims on reconcile or restart; crash-between-flush reuses the persisted session; restart reconstructs the same session/worktree; rework/reopen never creates a second identity (the three identities in this doc's header are *tree* identities, not Ticket identities).
- **Milestone contract / declared-section authority:** the Ticket's declared `## Milestone` body section is the sole identity authority (HTML comments stripped, single- and multi-line); native GitHub milestone **object**, missing value, or malformed string (`""`, `"M 1"`, `"   "`) never substitutes — each is `invalidMilestone` (validation checks the exact `dshName` charset and is **state-independent**); a CLOSED Ticket with invalid/empty declared Milestone + existing claim retires durably as `complete` (completedBy: closed) without crashing or waking (CTO+Codex finding); invalid-milestone OPEN Tickets are excluded/reported and an existing claim on one can never abort a pass.
- **Bootstrap protocol content (sequential, fe547f22):** exact `mcp-chatgpt` + `ChatGPT project = dsh-glasses` + `ChatGPT session = CTO`; ChatGPT FIRST and NEVER parallel; helper-produced DETAILED ORDERED plan + checkable to-do list before the first production edit (ChatGPT → fresh Codex if objectively unavailable → DSH self-plan only if both unavailable); mandatory progress checkpoint after EVERY completed to-do item with full field set (ticket, todo-item, status, head, result, validation, evidence, next), routed ChatGPT-first (Codex on unavailability/escalation; both unavailable → record durably + continue); one-complete-ChatGPT-loop definition; exactly-three-loop same-chain escalation with **no fourth ChatGPT loop**; scoped escalation then return to ChatGPT-first; hard-problem ChatGPT-first; final review ChatGPT-first — **ChatGPT PASS → no Codex**, unavailable → Codex exact-head review, third non-pass loop → Codex; both-unavailable → independent completion only with no unresolved blocking finding; `UNAVAILABLE` = objective failure only and technical verdicts are never relabeled; fresh one-shot non-mutating `subagent_codex` (`inspect/reason/report only; do not modify the Ticket worktree`), zero dispatcher Codex lifecycle; negative contract tests assert the old dual-helper wording (`ask BOTH`, `two PASSes preferred`, `PASS + UNAVAILABLE`/`UNAVAILABLE + PASS`, `best-effort redundant helpers`, `use both results`) is gone; continuation prompt instructs re-checking CURRENT durable AGENTS/WORKFLOW + active helper-produced plan/checkpoint state and forbids treating a lingering bootstrap as immutable.
- **Watchdog:** live+progressing ⇒ no-op; loaded-but-quiescent unfinished ⇒ wake the **same** session — **full bootstrap if the first bootstrap wake never succeeded (`bootstrapped=false`), otherwise a minimal continuation**; failed bootstrap wake retried with the FULL bootstrap on later passes (durable flag, Codex finding #2); completed (closed or valid matching marker) ⇒ disposed/never re-woken; malformed marker (missing/non-hex/short head) does not retire.
- **Completion markers — source-bound + trusted writer + FAIL-CLOSED:** authoritative only when (a) valid exact 40-hex `head`, (b) posted on the Ticket's own issue, (c) — REAL GitHub adapter — authored by an allowlisted `completionAuthors` writer; with an empty allowlist **no marker is authorized** (fail-closed; only CLOSED issue state retires), so an arbitrary public-repo commenter cannot retire an unfinished Ticket. Offline fixture store is operator-owned disposable state and trusts its own records. Cross-issue/foreign/allowlist-less/malformed markers ignored.
- **Stale-identity guard:** a claim marker whose `sessionId` does not match the Ticket's deterministic identity is rejected (`failed`/`stale-identity`); the Ticket re-admits under its exact id.
- **Identity collision (non-retriable, per CTO design mandate):** persisted session for the deterministic id under a different worktree key is a durable terminal `identity-collision` while it exists; automatic re-admission only after the probe returns a definitive `persisted`/`missing`; indeterminate `unknown` keeps the tombstone (Codex finding #2); re-admission uses the same id, never into an active collision.
- **Identities/bindings/closeout:** tombstones match by session id; state carries zero Codex lifecycle fields; every report carries `heartbeatMs` equal to the configured interval (default 120000).

## 2. Real-DSH + real-native-Codex smoke (integration, disposable)

Command: `npm run smoke` in `plugins/dsh-ticket-dispatcher` → **PASS** (`dsh-ticket-dispatcher smoke: PASS`) on the validated head (§R8). Disposable Git repo, DSH home, profile, presets exposing `subagent_codex`, fixture marker store — no GitHub calls, no product code, no Rokid.

**Pinned deployment actually exercised (asserted for equality):** `dsh-base=0.1.0-rc.8`, `dsh-session-persistence-jsonl=0.1.0-rc.8`, `dsh-subagent-codex=0.1.0-rc.8`, `dsh-tool-subagent=0.1.0-rc.8`, `dsh-agent-presets=0.1.0-rc.8`, `codex=0.148.0`.

Unchanged lifecycle assertions, all still PASS on the final head:

- **Named admission + restart:** two dummy ready Tickets admitted as exactly named persistent sessions; restart reconstructs the same sessions; no duplicates; **no persistent Codex session or thread** is ever created.
- **Moving base + watchdog:** a moving base is honored; the in-process watchdog wakes the same session (no replacement identity).
- **Durable completion retirement:** a valid `ticket-complete:` marker or CLOSED issue retires a binding; no duplicate re-admission.
- **Real codex seam non-mutation:** two real, fresh, one-shot, self-contained, read-only `subagent_codex` invocations driven on the bound Ticket DSH session; worktree byte-identical before/after; fresh invocations return results (observed fresh1_ms / fresh2_ms in the run log).
- **Real-agent reviewer-availability contract (retained):** available reviewer's `REQUEST_CHANGES` stays blocking until addressed (`blocked-then-fixed`); stays OPEN while the gate stays unmet (`stays-blocked`); one-helper-down completes with the available reviewer (`one-helper-down`); both-down completes on the agent's own independent gate (`both-down`).

**Phase 6 — sequential-helper protocol matrix (new):** deterministic legs on the REAL DSH agent (production dispatcher adapter) with a scripted disposable ChatGPT stand-in, the REAL pinned native-Codex seam for escalations, and an observable helper event ledger (kind/order/count/non-overlap asserted per leg). All 10 legs PASS; helper-event ledger kind/order/count and a mechanical never-parallel guard (any in-flight overlap fails the leg) are asserted per leg. Representative observed real-Codex escalations: planning escalation `ms=51415` (returned a real two-item plan), hard-chain escalation `ms=78631` (PASS), exact-head review escalations `ms=40859` and `ms=43031` (PASS on the COMMITTED candidate head). Progress checkpoints are sent to the first-line helper with the FULL field set (ticket/todo-item/status/head/result/validation/evidence/next), which the scripted helper mechanically verifies on receipt. Leg list:

1. `plan-chatgpt-ok` — ChatGPT plan obtained; **zero** Codex calls anywhere.
2. `plan-codex-escalation` — ChatGPT plan objectively UNAVAILABLE → fresh real Codex plan; ordinary checkpoints return to ChatGPT-first.
3. `three-loops-chain` — exactly **3 COMPLETE ChatGPT loops** on the same hard chain (each loop = request → technical non-PASS → DSH apply/fix+validate step recorded durably → still non-passing) → fresh real Codex; **no 4th ChatGPT**; the apply count is asserted = 3 so no loop is counted without its fix step; afterward a checkpoint routes ChatGPT-first again (scoped escalation).
4. `final-chatgpt-pass` — ChatGPT PASS → **zero** Codex review calls.
5. `final-chatgpt-unavail-codex` — ChatGPT UNAVAILABLE at final review → fresh real Codex exact-head review of the **committed** candidate → PASS.
6. `final-three-loops-codex` — 3 COMPLETE non-pass ChatGPT review loops (apply/fix+validate between loops, apply count asserted = 3) → fresh real Codex → PASS (no 4th ChatGPT).
7. `blocking-request-changes` — an available reviewer's `REQUEST_CHANGES` blocks (no DONE); the single apply/fix+validate step (asserted apply count = 1) brings the candidate to the exact gate; then re-approval completes.
8. `checkpoint-unavail-codex` — a progress-checkpoint first-line helper call objectively UNAVAILABLE → the SAME checkpoint escalates to fresh real Codex exactly once; ordinary flow then returns to ChatGPT-first (final review still ChatGPT PASS, no Codex review).
9. `plan-both-down` — both helpers unavailable → DSH self-plan and continues.
10. `final-both-down` — both unavailable at final review → independent completion only with the gate met.

The Phase 6 probe applies **exact-head review semantics to EVERY final-review request regardless of which helper receives it**, and proves the discipline MECHANICALLY. One preparation (commit-if-changed + HEAD identification + a strictly increasing per-request preparation token) is minted immediately before EACH request — including each of the three ChatGPT loop requests and every request that will return objective `UNAVAILABLE`. EVERY request carries the exact committed head AND the exact token minted by the immediately-preceding preparation, and the scripted first-line receiver verifies that EQUALITY (not merely the format) before producing ANY verdict — PASS, technical `REQUEST_CHANGES`, or `UNAVAILABLE` alike. The probe asserts exactly one preparation per review request and a committed candidate head for every completion, and the parent smoke walks every leg's raw event stream and requires EVERY review-final event to be immediately preceded by its final-review-candidate preparation (no existential loophole, no orphan/stale/unprepared request can pass). It resets the worktree baseline deterministically per scenario, applies bounded codex retries on objective transport failures (`collab spawn failed`, `failed to refresh available models`) — all classified as objective `UNAVAILABLE` per the protocol (never as technical verdicts), and terminates the composed probe just like the shipped probes (`appExit(0)`), which removed the flaky-hang class observed during development. This matrix, the unit contracts, and the generated bootstrap text together make Ticket #19's sequential protocol mechanically testable and teachable to future Dispatcher-created sessions.

## 3. Production configuration note

Run the dispatcher as its own DSH profile (not inside the `web`/`headless` bundles) and set the `completionAuthors` allowlist (e.g. `completionAuthors: ['code2hack']`) so real GitHub marker writes are authorized for known writers; without it the real adapter is fail-closed — **no completion marker is accepted/authorized** (the adapter may still post a comment, but it is not treated as terminal) and only the CLOSED issue state retires a Ticket. Heartbeat interval default is exactly 120s.

## 4. Files changed in this branch (final candidate)

`AGENTS.md`, `docs/WORKFLOW.md`, `.github/ISSUE_TEMPLATE/agent-ticket.md` (workflow-delta merge `0da5ee2`, docs-only), `plugins/dsh-ticket-dispatcher/{lib/core.js, README.md, test/core.test.mjs, test/smoke/dsh-smoke.mjs}` + new `plugins/dsh-ticket-dispatcher/test/smoke/sequential-helper-probe.mjs`, plus this evidence, on `workflow/ticket-19` for PR #25. The delta merge explicitly left `plugins/` untouched; all sequential-helper behavior changes were introduced by this Ticket on top of the pinned authority.

---
## Appendix A — Historical evidence (superseded, preserved for audit)

This appendix preserves the complete pre-`fe547f22` validation record for Ticket #19 (heads up to and including `56556eb9fbec441b17fb28204d367e09334067f2`) **verbatim** for auditability. It documents the dual/parallel-helper ("v2") protocol era and the durable computational guarantees that remain unchanged in the sequential era (identity, Milestone declared-section authority, fail-closed completion, watchdog, identity collision, full-bootstrap retry, no Codex lifecycle). With `fe547f22` (sequential-helper authority), the helper-routing semantics in generated prompts, unit contracts, README, and smoke documented here have been **superseded** by the strict sequential protocol in the main body above; the reviewer/CTO history table in the main body is the authority for that transition.


- **Ticket:** #19 (Milestone `Bootstrap`, Gate `autonomous`)
- **Branch / base:** `workflow/ticket-19` off `c6e5d120972251a762b28890d4d24727615bc1a3` (`origin/main` at bootstrap)
- **Validated implementation head:** `56556eb9fbec441b17fb28204d367e09334067f2` (all code validation below ran on this exact tree)
- **Final candidate head / PR:** branch HEAD including this evidence; PR #25 (supersedes closed #22). Round-2 evidence commit sits on top of 56556eb (evidence-only).
- **Produced:** 2026-08-21 on **spark** (repo `code2hack/dsh-glasses`). Git history + GitHub remain the durable record; this doc is reproducible on this host with the pinned DSH release.

### TL;DR

Every Ticket #19 acceptance requirement is demonstrated by the checked-in automated suites below. Automatic Ticket execution is enabled. The dispatcher admits, persists, restarts, watches, and completes exactly named DSH sessions; the generated bootstrap carries the full v2 protocol (bounded ChatGPT-plan attempt before code via the exact `mcp-chatgpt` → `ChatGPT project = dsh-glasses` / `ChatGPT session = CTO` endpoint, explicit availability fallback, fresh one-shot native Codex, non-deadlocking dual review); native Codex capability was exercised with two real, fresh, self-contained, non-mutating `subagent_codex` invocations on the bound Ticket DSH session; **the reviewer-availability contract was exercised as real integration smoke on a real conversational Ticket DSH agent against the real pinned native-Codex reviewer** (an available `REQUEST_CHANGES` stays blocking until addressed; a helper that is unavailable never blocks; both helpers down → DSH continues and completes alone when its own gate passes); completion markers are source-bound and trusted-writer enforced **with a fail-closed default** on the real GitHub adapter; the full v2 bootstrap is delivered on the FIRST successful wake and a failed bootstrap wake is retried with the FULL bootstrap (never silently degraded to a continuation prompt); no persistent Codex lifecycle state exists anywhere.

### 1. Unit validation (deterministic, offline)

Command: `npm test` in `plugins/dsh-ticket-dispatcher` → **69 tests, 69 pass, 0 fail**. `npm run typecheck` (node --check lib/*.js) → **clean**.

Coverage relevant to Ticket #19:

- **Named DSH admission:** exact identity `dsh-glasses-<milestone>-#<n>-DSH` for name and session id; marker schemaVersion 2 with name/sessionId/branch/worktree/baseSha; no duplicate claims on reconcile or restart; crash-between-flush reuses the persisted session; restart reconstructs the same session and worktree.
- **Milestone contract / declared-section authority:** the Ticket's declared `## Milestone` body section is the sole identity authority; a native GitHub milestone **object**, a missing value, or a malformed string (`""`, `"M 1"`, `"   "`) never substitutes — each is invalidMilestone and can never reach `dshName` at any dispatch layer (validity checks the exact dshName identity charset and is **independent of Ticket state**); an HTML comment block (single- or multi-line, including fully commented-out metadata) can never supply the milestone; a CLOSED Ticket with an invalid/empty declared Milestone and an existing claim retires durably as `complete` (completedBy: closed) without crashing or being woken (CTO finding); invalid-milestone OPEN tickets are excluded and reported (`invalidMilestone`) and an existing claim on such a Ticket can never abort a pass (regression-tested).
- **Bootstrap protocol content:** exact `mcp-chatgpt` + `ChatGPT project = dsh-glasses` + `ChatGPT session = CTO` identity; bounded start-up plan attempt before the first production edit; `UNAVAILABLE` is non-blocking while `UNPASSED`/`REQUEST_CHANGES`/blocking findings must be addressed; dual hard-problem help and dual final exact-head review; fresh one-shot non-mutating `subagent_codex`; "must not wait indefinitely on a helper"; closeout instruction to write `ticket-complete:` with the exact head SHA.
- **Watchdog:** live+progressing ⇒ no-op; live-but-quiescent unfinished ⇒ wake the **same** session — **full v2 bootstrap if the first bootstrap wake never succeeded (bootstrapped=false), otherwise** a minimal continuation; not loaded + persisted ⇒ resume the same id then wake (same full-bootstrap-vs-continuation rule); a failed bootstrap wake is retried with the FULL bootstrap on later passes, never silently degraded to a continuation prompt (fresh native-Codex finding); completed (closed or valid matching marker) ⇒ disposed and never re-woken; a **malformed** completion marker (missing/non-hex/short head) does **not** retire a binding.
- **Completion markers — source-bound + trusted writer + FAIL-CLOSED:** a `ticket-complete:` marker is authoritative only when it (a) carries a valid exact 40-hex `head`, (b) is posted on the Ticket's **own** issue (self-declared `ticket` equals the source issue), and (c) — for the REAL GitHub adapter — is authored by an allowlisted `completionAuthors` writer; with an **empty allowlist the real adapter authorizes NO marker** (fail-closed: only the CLOSED issue state can retire a Ticket), so an arbitrary same-issue commenter on a public repository cannot retire an unfinished Ticket. The offline fixture store is operator-owned disposable state and trusts its own records. Cross-issue, foreign, allowlist-less, and malformed markers are ignored, so the watchdog keeps supervising.
- **Stale-identity guard:** a claim marker whose `sessionId` does not match the Ticket's current deterministic DSH identity (legacy/arbitrary claims) is rejected at load (`failed`/`stale-identity`) so the Ticket re-admits under the exact deterministic id and a foreign worker cannot hijack restart.
- **Identity collision (non-retriable, per CTO design mandate):** a persisted session for the deterministic id under a different worktree key is a durable terminal `identity-collision` **while it exists** — no claim void, no recursive session-dir deletion, no resume/create, no re-admission into an active collision. Automatic re-admission happens only after the dispatcher's own probe returns a **definitive** gone-state (`persisted` or `missing`); an indeterminate `unknown` probe keeps the terminal tombstone (no evidence of clearance). It then re-admits the **same** deterministic id, never into an active collision.
- **Identities/bindings/closeout:** tombstones match by session id; state carries zero Codex lifecycle fields; every report carries `heartbeatMs` equal to the configured interval (default 120000).

### 2. Real-DSH + real-native-Codex smoke (integration, disposable)

Command: `npm run smoke` in `plugins/dsh-ticket-dispatcher` → **PASS** (output: `dsh-ticket-dispatcher smoke: PASS`) on the exact validated implementation head above. The smoke builds a disposable Git repo, DSH home, profile, settings, credentials, agent presets exposing `subagent_codex`, dummy ready Ticket fixtures, and local state — no GitHub calls, no product code, no Rokid.

**Pinned deployment actually exercised (asserted by the smoke for equality, not existence):**

```
SMOKE pinned: dsh-base=0.1.0-rc.8 dsh-session-persistence-jsonl=0.1.0-rc.8
  dsh-subagent-codex=0.1.0-rc.8 dsh-tool-subagent=0.1.0-rc.8
  dsh-agent-presets=0.1.0-rc.8 codex=0.148.0
```

Observed (2026-08-21, spark):

- **Lifecycle:** two dummy Tickets admitted as exactly named persistent DSH sessions (`dsh-glasses-M1-#21-DSH`, `dsh-glasses-M1-#22-DSH`) with distinct worktrees/branches pinned to the exact base SHA; persisted session logs present under the exact `projectKey`/`encodeSegment` layout; repeated reconcile restart reconstructs the **same** two sessions (identical sessionIds, dirs unchanged, no duplicates, no re-created agents).
- **Session inventory:** `$DSH_HOME/sessions` contains exactly the two bound Ticket sessions under their encoded names — no Codex session/thread persisted (`no_codex_sessions=true`).
- **Moving base / watchdog:** in a live multi-pass process, Ticket #31 keeps its original base while #32 (blocked → then unblocked) is admitted on the moved base; the same session id is retained across passes (no duplicate admission by the in-process watchdog, `same_session_on_watchdog=true`).
- **Completion:** a `ticket-complete:` marker with a valid 40-hex head retires Ticket #61 permanently (`completed`, never re-admitted, never re-woken, no re-created session) while #62 proceeds; repeated reconcile does not duplicate.
- **Native Codex capability (REAL):** on the dispatcher-bound Ticket DSH session `dsh-glasses-M1-#21-DSH`, `subagent_codex` was present at the composed agent scope and executed **twice as fresh one-shot invocations in the Ticket worktree**:
  - two distinct fresh runs (bounded seconds each) of self-contained, git-grounded, read-only tasks;
  - the Ticket worktree stayed byte-identical (HEAD and `git status --porcelain` unchanged immediately around each call) — **non-mutating**;
  - no persistent Codex session or thread was created.

### 3. Availability-fallback and blocking-verdict semantics — exercised as real integration smoke

The CTO's requirement that availability be **behaviorally proven in real integration smoke** is met. The smoke drives the REAL conversational Ticket DSH session (`dsh-glasses-M1-#21-DSH`) through the REAL `dsh-tool-subagent` → `dsh-subagent-codex` (pinned app-server) seam. The only deterministic channel the real reviewer reads — the Ticket worktree candidate content — is controlled; ChatGPT is not composed in the disposable profile (objective helper absence), exactly as in production semantics.

For each blocking scenario the probe first runs its **own deterministic gate-check** through `subagent_codex` against the candidate content and requires a real `REQUEST_CHANGES` verdict before proceeding (the reviewer cannot be skipped; the gate-check itself is real native Codex). Completion is a byte-observable side effect (`DONE` file written by the agent only when the protocol permits).

Observed in the PASS run:

| leg | name | expected | observed | proves |
| --- | --- | --- | --- | --- |
| 1 | `blocked-then-fixed` | done=true | done=true | an AVAILABLE reviewer's `REQUEST_CHANGES` is honored as blocking — no completion while it stands — and after the gate is fixed a real re-review approves and completion happens |
| 2 | `stays-blocked` | done=false | done=false | the same available reviewer keeps `REQUEST_CHANGES` while the gate stays unmet (agent told not to change the file): Ticket remains OPEN despite the agent working; no premature completion |
| 3 | `one-helper-down` | done=true | done=true | ChatGPT unavailable + reviewer available/approving ⇒ proceed with the available helper and complete |
| 4 | `both-down` | done=true | `complete` | ChatGPT absent AND `subagent_codex` not composed (deterministic reviewer unavailability) ⇒ DSH continues alone and completes when its own independent acceptance gate passes |

Both blocking legs required and asserted `AVP gatecheck=… verdict=REQUEST_CHANGES` from the probe's real codex call against the placeholder candidate; both completion legs asserted the `DONE` file only exists after an approving verdict, and its absence while a blocking verdict stands. Result line: `SMOKE availability: blocked-then-fixed=true stays-blocked=false one-helper-down=true both-down=complete`.

The dispatcher itself never blocks on any LLM/helper; `UNAVAILABLE` is not `UNPASSED`/`REQUEST_CHANGES`/blocking, and a technical blocking finding must be addressed before closeout.

### 4. Preservation of prior guarantees

All previously accepted guarantees remain under test: frontier admission with capacity, deterministic moving-base, failed-fetch fails closed with no admission, worktree isolation, claim idempotency, restart reconstruction, identity-collision and stale-session fail-closed probes, publication rollback (4 fault paths), resource/DAG separation, credential handling (env + owner-only credentials file), deterministic stable reports, and a heartbeat default exactly 120s owning only polling config.

### 5. Reviewer rounds — findings and resolution (durable record)

#### Round 1 (fresh native Codex, head `871269d0010ec2ade6232e2694962cc8b688bdb6`) → addressed on `833c655`

1. **Watchdog resumed-session wake used the full bootstrap** — resumed/recreated Ticket Leads now wake with the minimal continuation only; fresh admissions always receive the full bootstrap.
2. **Collision path recursively deleted collided session dirs** — collisions are non-retriable terminal tombstones while present, with no deletion, no void, no re-admission into an active collision.
3. **Completion markers accepted without an exact head** — `parseCompleteMarker` requires a valid exact 40-hex `head`; malformed markers ignored.
4. **Smoke did not pin the deployment** — the smoke resolves and asserts the installed DSH/Codex versions for equality.
5. **AGENTS.md §12 carried Ticket-specific live state** — rewritten state-free; validation history lives in `docs/WORKFLOW.md` §13 and this evidence doc.

The CTO design approval (request `r19-2026-08-21b-startup-plan-1`) required: (a) wrong-cwd persisted identity = non-retriable identity collision (re-admission only after the collision clears), and (b) the completion marker formally specified before the watchdog relies on it. Both implemented + covered.

#### Round 2 (fresh native Codex 5 findings + CTO 5 findings on head `b55725a2ef21d9706d17c08c5e0079fe947111bb`) → addressed on `2130879`

Fresh native Codex: continuation wake re-verified + unit-covered; collision non-retriable terminal + cleared re-admission unit-covered; exact-head markers; pinned-version equality + real in-probe non-mutation witness; milestone object leak fixed.

CTO findings (2 not raised by Codex):

A. **Completion markers must be source-bound and trusted-writer** — implemented via `bindSourceCompletions` + `completionAuthors`.
B. **Availability fallback must be exercised in real integration smoke** — implemented as section 3 (all four legs, real reviewer).

#### Round 3 (fresh native Codex on head `423ae8651004d88de0a2a126cccb75e4edf3483a`) → 4 findings, addressed on `20fe4be`

1. **Claim reconciliation crashed on an invalid-Milestone Ticket with an existing claim** (`dshName` throws before invalid-milestone filtering) — `dshName`/`bootstrapPrompt` are now computed only for deterministic-valid milestones; the claim degrades to `failed`/`stale-identity`, the Ticket is reported `invalidMilestone`, and the pass completes. Regression test added.
2. **`completionAuthors` absent from the exported config schema** — declared in `Config` (array of trusted writers, default empty); documented for public repositories.
3. **Missing `## Milestone` fell back to native GitHub milestone metadata** — the declared section is now the sole authority for real tickets; a milestone object degrades to invalid, a plain string is accepted only as the offline-fixture contract representation. Tests updated.
4. **Collision contract clarity** — inline comment records the CTO design mandate: terminal while any collision exists; automatic re-admission only after the dispatcher's own probe proves the conflicting persisted log is gone; never re-admits into an active collision.

#### Round 3 (CTO on head `423ae86`) → 3 blockers, addressed on `b06d65a`

1. **Milestone metadata must not rescue a Ticket lacking a declared `## Milestone`** — `milestoneValid` now requires a plain non-empty STRING at every dispatch layer: a native GitHub milestone object or missing value is `invalidMilestone`, never an admission fallback, and can never crash `dshName` even through a raw adapter record. Object-milestone dispatch regression test added.
2. **Trusted completion writers must be fail-closed at the real GitHub adapter** — with an empty allowlist the real adapter authorizes NO marker: only the CLOSED issue state retires a Ticket, so an arbitrary same-issue public commenter cannot retire one; production configures `completionAuthors` to the DSH closeout identity. `completionAuthors` is declared in the exported config schema. Fail-closed + allowlist unit coverage added (offline fixture store retains its operator-owned trust-store semantics).
3. **README stated a fake reviewer CLI** — corrected to describe the real pinned native-Codex reviewer seam that is actually exercised.

#### Round 4 (fresh native Codex on head `1bbc524` / article `509c112`) → 5 findings + 2 CTO blockers, addressed on `56556eb`

Fresh native Codex (article `509c112`):

1. **`milestoneValid` accepted malformed strings (`" "`, `"M 1"`) that later make `dshName` throw** — milestone validity now uses the exact `dshName` identity charset pattern; malformed strings are `invalidMilestone`, never reach `dshName`, and cannot abort a pass (regression-tested at the dispatch layer).
2. **An `unknown` probe cleared an identity collision** — a collision tombstone is demoted only on a **definitive** probe (`persisted` or `missing`); `unknown` (no DSH home / indeterminate) keeps the terminal tombstone. Regression-tested.
3. **Multi-line HTML comments supplied the milestone** (`<!--\nM1\n-->` admitted as `M1`) — HTML comment blocks (single- and multi-line, including fully commented-out metadata) are stripped before scanning. Regression-tested.
4. **Schema comment stated an empty `completionAuthors` trusts any author** — corrected to the fail-closed reality (implementation and README already matched).
5. **Evidence claimed rework uses a new sessionId** — corrected: rework/reopen reuses the exact same deterministic identity (`name === sessionId`), never a second identity.

CTO (request `dsht19-review-4-1bbc524`) — **one remaining blocker**:

6. **CLOSED invalid-Milestone Tickets with an existing claim could still crash reconciliation** — `milestoneValid` was state-dependent (`state !== "OPEN"` bypass), so a CLOSED Ticket normalized to `""` passed the guard and made `dshName` throw before retirement. Milestone validity is now **independent of Ticket state**, and any CLOSED source Ticket short-circuits claim reconciliation to a durable `complete` tombstone (`completedBy: closed`) regardless of milestone validity, claim match, or `dshName` throw-ability. Regression covers CLOSED + claim with empty, space-containing, and whitespace milestone values; the Ticket retires, is never woken, and never aborts a pass.

Fresh native Codex (article `56556eb`) — **one remaining blocker**:

7. **A failed bootstrap wake permanently degraded the agent to the continuation prompt** — the first successful wake of a fresh session MUST carry the full v2 bootstrap; a transient first-wake failure must be retried, not silently downgraded. The binding now persists an explicit `bootstrapped` field (DSH wake-delivery state, not Codex lifecycle): admission records `bootstrapped:false`, it is cleared only after the full bootstrap wake succeeds, and quiescent/reconnected sessions with `bootstrapped:false` receive the FULL bootstrap again while bootstrapped/legacy sessions keep the minimal continuation. Wake-failure-retry regression added (the harness models a created-but-idle agent).

#### Round 5 (fresh native Codex + CTO on final head)

Undergone at branch HEAD (see PR #25); verdicts recorded durably on the PR.

### 6. Reproduce

```bash
cd plugins/dsh-ticket-dispatcher
npm test
npm run typecheck
npm run smoke        # requires the pinned DSH deployment + ~/.codex auth on this host
```

### 7. Residual uncertainty / deferred

- The smoke's live-model turns are not asserted (the local DS4 model endpoint is not part of this Ticket's gate); dispatch is deterministic regardless of model reachability, and both the Codex seam and the availability contract are asserted with **real** invocations.
- Rework/reopen of a completed Ticket keeps the EXACT same deterministic identity (`name === sessionId` is invariant; the deterministic id derives from the declared Milestone + number), re-probing the persisted session before materializing anything — no second identity is ever created for the same logical Ticket.
- Native Codex auth currently rides the host `~/.codex/auth.json` (`auth_mode: chatgpt`); no per-Ticket Codex profile/model/thinking configuration exists by design (declared out of scope for #19).
- Reviewer-availability was exercised with the reviewer side real and deterministic; the reverse one-sided leg (ChatGPT available + reviewer absent) is covered by the same entitlement logic at the code/unit level, but ChatGPT is not composed in the disposable profile, so that leg is not literally run against a real ChatGPT account here. The protocol invariant (any non-blocking technical result + at least one helper → continue; none → continue alone) is identical for both sides.
