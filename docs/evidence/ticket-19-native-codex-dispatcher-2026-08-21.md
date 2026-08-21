# Ticket #19 — Bootstrap: native-Codex dispatcher validation evidence

- **Ticket:** #19 (Milestone `Bootstrap`, Gate `autonomous`)
- **Branch / base:** `workflow/ticket-19` off `c6e5d120972251a762b28890d4d24727615bc1a3` (`origin/main` at bootstrap)
- **Validated implementation head:** `b06d65aa6d0bdd85e4af398864c5e366060799c8` (all code validation below ran on this exact tree)
- **Final candidate head / PR:** branch HEAD including this evidence; PR #25 (supersedes closed #22)
- **Produced:** 2026-08-21 on **spark** (repo `code2hack/dsh-glasses`). Git history + GitHub remain the durable record; this doc is reproducible on this host with the pinned DSH release.

## TL;DR

Every Ticket #19 acceptance requirement is demonstrated by the checked-in automated suites below. Automatic Ticket execution is enabled. The dispatcher admits, persists, restarts, watches, and completes exactly named DSH sessions; the generated bootstrap carries the full v2 protocol (bounded ChatGPT-plan attempt before code via the exact `mcp-chatgpt` → `ChatGPT project = dsh-glasses` / `ChatGPT session = CTO` endpoint, explicit availability fallback, fresh one-shot native Codex, non-deadlocking dual review); native Codex capability was exercised with two real, fresh, self-contained, non-mutating `subagent_codex` invocations on the bound Ticket DSH session; **the reviewer-availability contract was exercised as real integration smoke on a real conversational Ticket DSH agent against the real pinned native-Codex reviewer** (an available `REQUEST_CHANGES` stays blocking until addressed; a helper that is unavailable never blocks; both helpers down → DSH continues and completes alone when its own gate passes); completion markers are source-bound and trusted-writer enforced **with a fail-closed default** on the real GitHub adapter; no persistent Codex lifecycle state exists anywhere.

## 1. Unit validation (deterministic, offline)

Command: `npm test` in `plugins/dsh-ticket-dispatcher` → **65 tests, 65 pass, 0 fail**. `npm run typecheck` (node --check lib/*.js) → **clean**.

Coverage relevant to Ticket #19:

- **Named DSH admission:** exact identity `dsh-glasses-<milestone>-#<n>-DSH` for name and session id; marker schemaVersion 2 with name/sessionId/branch/worktree/baseSha; no duplicate claims on reconcile or restart; crash-between-flush reuses the persisted session; restart reconstructs the same session and worktree.
- **Milestone contract / declared-section authority:** the Ticket's declared `## Milestone` body section is the sole identity authority; a native GitHub milestone **object** never substitutes (invalidMilestone until the section is declared) and can never reach `dshName` as `[object Object]` at any dispatch layer; a plain string is accepted only as the offline-fixture contract representation; invalid-milestone OPEN tickets are excluded and reported (`invalidMilestone`) and an existing claim on such a Ticket can never abort a pass (regression-tested). HTML comments in the milestone block ignored.
- **Bootstrap protocol content:** exact `mcp-chatgpt` + `ChatGPT project = dsh-glasses` + `ChatGPT session = CTO` identity; bounded start-up plan attempt before the first production edit; `UNAVAILABLE` is non-blocking while `UNPASSED`/`REQUEST_CHANGES`/blocking findings must be addressed; dual hard-problem help and dual final exact-head review; fresh one-shot non-mutating `subagent_codex`; "must not wait indefinitely on a helper"; closeout instruction to write `ticket-complete:` with the exact head SHA.
- **Watchdog:** live+progressing ⇒ no-op; live-but-quiescent unfinished ⇒ wake the **same** session with a minimal continuation only; not loaded + persisted ⇒ resume the same id then wake with the minimal continuation (not the bootstrap); completed (closed or valid matching marker) ⇒ disposed and never re-woken; a **malformed** completion marker (missing/non-hex/short head) does **not** retire a binding.
- **Completion markers — source-bound + trusted writer + FAIL-CLOSED:** a `ticket-complete:` marker is authoritative only when it (a) carries a valid exact 40-hex `head`, (b) is posted on the Ticket's **own** issue (self-declared `ticket` equals the source issue), and (c) — for the REAL GitHub adapter — is authored by an allowlisted `completionAuthors` writer; with an **empty allowlist the real adapter authorizes NO marker** (fail-closed: only the CLOSED issue state can retire a Ticket), so an arbitrary same-issue commenter on a public repository cannot retire an unfinished Ticket. The offline fixture store is operator-owned disposable state and trusts its own records. Cross-issue, foreign, allowlist-less, and malformed markers are ignored, so the watchdog keeps supervising.
- **Stale-identity guard:** a claim marker whose `sessionId` does not match the Ticket's current deterministic DSH identity (legacy/arbitrary claims) is rejected at load (`failed`/`stale-identity`) so the Ticket re-admits under the exact deterministic id and a foreign worker cannot hijack restart.
- **Identity collision (non-retriable, per CTO design mandate):** a persisted session for the deterministic id under a different worktree key is a durable terminal `identity-collision` **while it exists** — no claim void, no recursive session-dir deletion, no resume/create, no re-admission into an active collision. Automatic re-admission happens only after the dispatcher's own probe proves the conflicting persisted log is gone (external clear); it then re-admits the **same** deterministic id, never into an active collision.
- **Identities/bindings/closeout:** tombstones match by session id; state carries zero Codex lifecycle fields; every report carries `heartbeatMs` equal to the configured interval (default 120000).

## 2. Real-DSH + real-native-Codex smoke (integration, disposable)

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

## 3. Availability-fallback and blocking-verdict semantics — exercised as real integration smoke

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

## 4. Preservation of prior guarantees

All previously accepted guarantees remain under test: frontier admission with capacity, deterministic moving-base, failed-fetch fails closed with no admission, worktree isolation, claim idempotency, restart reconstruction, identity-collision and stale-session fail-closed probes, publication rollback (4 fault paths), resource/DAG separation, credential handling (env + owner-only credentials file), deterministic stable reports, and a heartbeat default exactly 120s owning only polling config.

## 5. Reviewer rounds — findings and resolution (durable record)

### Round 1 (fresh native Codex, head `871269d0010ec2ade6232e2694962cc8b688bdb6`) → addressed on `833c655`

1. **Watchdog resumed-session wake used the full bootstrap** — resumed/recreated Ticket Leads now wake with the minimal continuation only; fresh admissions always receive the full bootstrap.
2. **Collision path recursively deleted collided session dirs** — collisions are non-retriable terminal tombstones while present, with no deletion, no void, no re-admission into an active collision.
3. **Completion markers accepted without an exact head** — `parseCompleteMarker` requires a valid exact 40-hex `head`; malformed markers ignored.
4. **Smoke did not pin the deployment** — the smoke resolves and asserts the installed DSH/Codex versions for equality.
5. **AGENTS.md §12 carried Ticket-specific live state** — rewritten state-free; validation history lives in `docs/WORKFLOW.md` §13 and this evidence doc.

The CTO design approval (request `r19-2026-08-21b-startup-plan-1`) required: (a) wrong-cwd persisted identity = non-retriable identity collision (re-admission only after the collision clears), and (b) the completion marker formally specified before the watchdog relies on it. Both implemented + covered.

### Round 2 (fresh native Codex 5 findings + CTO 5 findings on head `b55725a2ef21d9706d17c08c5e0079fe947111bb`) → addressed on `2130879`

Fresh native Codex: continuation wake re-verified + unit-covered; collision non-retriable terminal + cleared re-admission unit-covered; exact-head markers; pinned-version equality + real in-probe non-mutation witness; milestone object leak fixed.

CTO findings (2 not raised by Codex):

A. **Completion markers must be source-bound and trusted-writer** — implemented via `bindSourceCompletions` + `completionAuthors`.
B. **Availability fallback must be exercised in real integration smoke** — implemented as section 3 (all four legs, real reviewer).

### Round 3 (fresh native Codex on head `423ae8651004d88de0a2a126cccb75e4edf3483a`) → 4 findings, addressed on `20fe4be`

1. **Claim reconciliation crashed on an invalid-Milestone Ticket with an existing claim** (`dshName` throws before invalid-milestone filtering) — `dshName`/`bootstrapPrompt` are now computed only for deterministic-valid milestones; the claim degrades to `failed`/`stale-identity`, the Ticket is reported `invalidMilestone`, and the pass completes. Regression test added.
2. **`completionAuthors` absent from the exported config schema** — declared in `Config` (array of trusted writers, default empty); documented for public repositories.
3. **Missing `## Milestone` fell back to native GitHub milestone metadata** — the declared section is now the sole authority for real tickets; a milestone object degrades to invalid, a plain string is accepted only as the offline-fixture contract representation. Tests updated.
4. **Collision contract clarity** — inline comment records the CTO design mandate: terminal while any collision exists; automatic re-admission only after the dispatcher's own probe proves the conflicting persisted log is gone; never re-admits into an active collision.

### Round 3 (CTO on head `423ae86`) → 3 blockers, addressed on `b06d65a`

1. **Milestone metadata must not rescue a Ticket lacking a declared `## Milestone`** — `milestoneValid` now requires a plain non-empty STRING at every dispatch layer: a native GitHub milestone object or missing value is `invalidMilestone`, never an admission fallback, and can never crash `dshName` even through a raw adapter record. Object-milestone dispatch regression test added.
2. **Trusted completion writers must be fail-closed at the real GitHub adapter** — with an empty allowlist the real adapter authorizes NO marker: only the CLOSED issue state retires a Ticket, so an arbitrary same-issue public commenter cannot retire one; production configures `completionAuthors` to the DSH closeout identity. `completionAuthors` is declared in the exported config schema. Fail-closed + allowlist unit coverage added (offline fixture store retains its operator-owned trust-store semantics).
3. **README stated a fake reviewer CLI** — corrected to describe the real pinned native-Codex reviewer seam that is actually exercised.

### Round 4 (fresh native Codex + CTO)

Undergone at branch HEAD (see PR #25); verdicts recorded durably on the PR.

## 6. Reproduce

```bash
cd plugins/dsh-ticket-dispatcher
npm test
npm run typecheck
npm run smoke        # requires the pinned DSH deployment + ~/.codex auth on this host
```

## 7. Residual uncertainty / deferred

- The smoke's live-model turns are not asserted (the local DS4 model endpoint is not part of this Ticket's gate); dispatch is deterministic regardless of model reachability, and both the Codex seam and the availability contract are asserted with **real** invocations.
- A reopen/rework escape uses a new sessionId under the same logical name; documented, not acceptance-blocking.
- Native Codex auth currently rides the host `~/.codex/auth.json` (`auth_mode: chatgpt`); no per-Ticket Codex profile/model/thinking configuration exists by design (declared out of scope for #19).
- Reviewer-availability was exercised with the reviewer side real and deterministic; the reverse one-sided leg (ChatGPT available + reviewer absent) is covered by the same entitlement logic at the code/unit level, but ChatGPT is not composed in the disposable profile, so that leg is not literally run against a real ChatGPT account here. The protocol invariant (any non-blocking technical result + at least one helper → continue; none → continue alone) is identical for both sides.
