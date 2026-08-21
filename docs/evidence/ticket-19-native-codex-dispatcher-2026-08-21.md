# Ticket #19 — Bootstrap: native-Codex dispatcher validation evidence

- **Ticket:** #19 (Milestone `Bootstrap`, Gate `autonomous`)
- **Branch / base:** `workflow/ticket-19` off `c6e5d120972251a762b28890d4d24727615bc1a3` (`origin/main` at bootstrap)
- **Validated implementation head:** `833c655cfb7a004c7cf437baeacb62faac9ca371` (all code validation below ran on this exact tree)
- **Final candidate head / PR:** branch HEAD including this evidence; PR #25 (supersedes closed #22)
- **Produced:** 2026-08-21 on **spark** (repo `code2hack/dsh-glasses`). Git history + GitHub remain the durable record; this doc is reproducible on this host with the pinned DSH release.

## TL;DR

Every Ticket #19 acceptance requirement is demonstrated by the checked-in automated suites below. Automatic Ticket execution is enabled. The dispatcher admits, persists, restarts, watches, and completes exactly named DSH sessions; the generated bootstrap carries the full v2 protocol (bounded ChatGPT-plan attempt before code via the exact `mcp-chatgpt` → `ChatGPT project = dsh-glasses` / `ChatGPT session = CTO` endpoint, explicit availability fallback, fresh one-shot native Codex, non-deadlocking dual review); native Codex capability was exercised with two real, fresh, self-contained, non-mutating `subagent_codex` invocations on the bound Ticket DSH session; no persistent Codex lifecycle state exists anywhere; and the reviewer round-1 findings (below) were all addressed on the validated head.

## 1. Unit validation (deterministic, offline)

Command: `npm test` in `plugins/dsh-ticket-dispatcher` → **59 tests, 59 pass, 0 fail** (test/core 16, test/dispatcher 30, test/adapters 10, test/loop + test/state 8; the collision/continuation/marker suites were extended in review round 2). `npm run typecheck` (node --check lib/*.js) → **clean**.

Coverage relevant to Ticket #19:

- **Named DSH admission:** exact identity `dsh-glasses-<milestone>-#<n>-DSH` for name and session id; marker schemaVersion 2 with name/sessionId/branch/worktree/baseSha; no duplicate claims on reconcile or restart; crash-between-flush reuses the persisted session; restart reconstructs the same session and worktree.
- **Milestone contract:** valid `## Milestone` required for admission; invalid-milestone OPEN tickets excluded and reported (`invalidMilestone`); HTML comments in the milestone block ignored.
- **Bootstrap protocol content:** exact `mcp-chatgpt` + `ChatGPT project = dsh-glasses` + `ChatGPT session = CTO` identity; bounded start-up plan attempt before the first production edit; `UNAVAILABLE` is non-blocking while `UNPASSED`/`REQUEST_CHANGES`/blocking findings must be addressed; dual hard-problem help and dual final exact-head review; fresh one-shot non-mutating `subagent_codex`; "must not wait indefinitely on a helper"; closeout instruction to write `ticket-complete:` with the exact head SHA.
- **Watchdog:** live+progressing ⇒ no-op; live-but-quiescent unfinished ⇒ wake the **same** session with a minimal continuation only; not loaded + persisted ⇒ resume the same id then wake with the minimal continuation (not the bootstrap); completed (closed or valid matching marker) ⇒ disposed and never re-woken; a **malformed** completion marker (missing/non-hex/short head) does **not** retire a binding.
- **Identity collision (non-retriable, per CTO design mandate):** a persisted session for the deterministic id under a different worktree key is a durable terminal `identity-collision` — no claim void, no recursive session-dir deletion, no resume/create, no re-admission into an active collision; when the collided session log is removed outside the dispatcher, a later pass re-admits the **same** deterministic id (never auto-admits into an active collision).
- **Identities/bindings/closeout:** tombstones match by session id; completion markers are authoritative only with a valid exact 40-hex `head`; state carries zero Codex lifecycle fields; every report carries `heartbeatMs` equal to the configured interval (default 120000).

## 2. Real-DSH + real-native-Codex smoke (integration, disposable)

Command: `npm run smoke` in `plugins/dsh-ticket-dispatcher` → **PASS** (output: `dsh-ticket-dispatcher smoke: PASS`). The smoke builds a disposable Git repo, DSH home, profile, settings, credentials, agent preset exposing `subagent_codex`, two dummy ready Ticket fixtures, and local state — no GitHub calls, no product code, no Rokid.

**Pinned deployment actually exercised (asserted by the smoke, not just assumed):**

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
  - first invocation (~27.9 s): self-contained, git-grounded, read-only task 1;
  - second invocation (~13.8 s): a distinct fresh run of task 2;
  - the Ticket worktree stayed byte-identical (HEAD and `git status --porcelain` unchanged) — **non-mutating**;
  - no persistent Codex session or thread was created.

## 3. Availability-fallback and blocking-verdict semantics

Enforced at the bootstrap-content level (unit-tested) and by `docs/WORKFLOW.md` §3: both helpers down → DSH continues alone; one helper down → proceed with the other; a technical `UNPASSED`/`REQUEST_CHANGES`/blocking finding is NOT `UNAVAILABLE` and must be addressed before completion. The dispatcher itself never blocks on any LLM/helper.

## 4. Preservation of prior guarantees

All previously accepted guarantees remain under test: frontier admission with capacity, deterministic moving-base, failed-fetch fails closed with no admission, worktree isolation, claim idempotency, restart reconstruction, identity-collision and stale-session fail-closed probes, publication rollback (4 fault paths), resource/DAG separation, credential handling (env + owner-only credentials file), deterministic stable reports, and a heartbeat default exactly 120s owning only polling config.

## 5. Reviewer round 1 (fresh native Codex) — findings and resolution, all addressed on 833c655

A fresh one-shot native Codex review of head `871269d0010ec2ade6232e2694962cc8b688bdb6` (deadline-check trim) returned `REQUEST_CHANGES` with five findings; each was addressed on the validated implementation head `833c655`:

1. **Watchdog resumed-session wake used the full bootstrap** — resumed/recreated (reconnected) Ticket Leads now wake with the minimal continuation only; fresh admissions still always receive the full bootstrap.
2. **Collision path recursively deleted collided session dirs** — collisions are now non-retriable terminal tombstones with no deletion, no void, no re-admission into an active collision; the `removeOrphanSession` helper/wiring was removed and the surrogate tests re-specified to the non-destructive contract.
3. **Completion markers accepted without an exact head** — `parseCompleteMarker` now requires a valid exact 40-hex `head`; malformed markers are ignored so the watchdog keeps supervising (new positive/negative unit coverage).
4. **Smoke did not pin the deployment** — the smoke now resolves and asserts the installed DSH/Codex bundle versions and Codex CLI version (section 2), so the pinned composition is explicit, reproducible evidence.
5. **AGENTS.md §12 carried Ticket-specific live state** — rewritten as a state-free static protocol section; validation history lives in `docs/WORKFLOW.md` §13 and this evidence doc.

The CTO's design approval (2026-08-21, request `r19-2026-08-21b-startup-plan-1`, pinned CTO conversation) approved the overall direction and explicitly required: (a) wrong-cwd persisted identity = non-retriable identity collision rather than stale-session re-admission, and (b) the completion marker be formally specified before the watchdog relies on it. Both became hard requirements and are implemented + covered above.

## 6. Reproduce

```bash
cd plugins/dsh-ticket-dispatcher
npm test
npm run typecheck
npm run smoke        # requires the pinned DSH deployment + ~/.codex auth on this host
```

## 7. Residual uncertainty / deferred

- The smoke's live-model turns are not asserted (the local DS4 model endpoint is not part of this Ticket's gate); the Codex seam is asserted directly with real invocations, and dispatch is deterministic regardless of model reachability.
- A reopen/rework escape uses a new sessionId under the same logical name; documented, not acceptance-blocking.
- Native Codex auth currently rides the host `~/.codex/auth.json` (`auth_mode: chatgpt`); no per-Ticket Codex profile/model/thinking configuration exists by design (declared out of scope for #19).
- Final head re-review (fresh native Codex + CTO) verdict, once recorded, supersedes the review history in section 5.
