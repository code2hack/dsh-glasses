# Ticket #19 — Bootstrap: native-Codex dispatcher validation evidence

- **Ticket:** #19 (Milestone `Bootstrap`, Gate `autonomous`)
- **Branch / base:** `workflow/ticket-19` off `c6e5d120972251a762b28890d4d24727615bc1a3` (`origin/main`)
- **Scope:** raise `plugins/dsh-ticket-dispatcher` + pinned DSH workflow composition to the current native-Codex protocol; enable automatic Ticket execution; no persistent Codex lifecycle.
- **Produced:** 2026-08-20 on **spark** (repo `code2hack/dsh-glasses`). All evidence below is reproducible on this host with the pinned DSH release; git history + GitHub remain the durable record.

## TL;DR

Every acceptance requirement in Ticket #19 is demonstrated by the checked-in automated suites below. Automatic Ticket execution is enabled. The dispatcher now admits, persists, restarts, watches, and completes exactly named DSH sessions; the generated bootstrap carries the full v2 protocol (ChatGPT-plan attempt before code, availability fallback, fresh one-shot native Codex, non-deadlocking dual review); native Codex capability was exercised with two real, fresh, self-contained, non-mutating `subagent_codex` invocations on the bound Ticket DSH session; and no persistent Codex lifecycle state exists anywhere.

## 1. Unit validation (deterministic, offline)

Command: `npm test` in `plugins/dsh-ticket-dispatcher` → **55 tests, 55 pass, 0 fail** (test/core 15, test/dispatcher 27, test/adapters 11, test/loop + test/state 8). `npm run typecheck` (node --check lib/*.js) → **clean**.

Coverage relevant to Ticket #19:

- **Named DSH admission:** exact identity `dsh-glasses-<milestone>-#<n>-DSH` for name and session id; marker schemaVersion 2 with name/sessionId/branch/worktree/baseSha; no duplicate claims on reconcile or restart; crash-between-flush reuses the persisted session; restart reconstructs the same session and worktree.
- **Milestone contract:** valid `## Milestone` required for admission; invalid-milestone OPEN tickets excluded and reported (`invalidMilestone`); HTML comments in the milestone block ignored.
- **Bootstrap protocol content:** exact `mcp-chatgpt` + `ChatGPT project = dsh-glasses` + `ChatGPT session = CTO` identity; bounded start-up plan before the first production edit; `UNAVAILABLE` treated as non-blocking while `UNPASSED`/`REQUEST_CHANGES`/blocking findings must be addressed; dual hard-problem help and dual final exact-head review; fresh one-shot non-mutating `subagent_codex`; "must not wait indefinitely on a helper"; closeout instruction to write `ticket-complete:` with exact head SHA.
- **Watchdog:** live+progressing ⇒ no-op; live-but-quiescent unfinished ⇒ wake the **same** session with a minimal continuation; completed (closed or matching marker) ⇒ disposed and never re-woken.
- **Identities/bindings/closeout:** tombstones match by session id; claim/completion markers tolerant v1+v2; state carries zero Codex lifecycle fields; every report carries `heartbeatMs` equal to the configured interval (default 120000).

## 2. Real-DSH + real-native-Codex smoke (integration, disposable)

Command: `npm run smoke` in `plugins/dsh-ticket-dispatcher` → **PASS**. The smoke builds a disposable Git repo, DSH home, profile (bundles `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-agent-presets` + `@deepseek-ai/dsh-subagent-codex`), settings, credentials, agent preset (exposes `subagent_codex`), two dummy ready Ticket fixtures, and local state — no GitHub calls, no product code, no Rokid.

Observed (2026-08-20, spark):

- **Lifecycle:** two dummy Tickets admitted as exactly named persistent DSH sessions (`dsh-glasses-M1-#21-DSH`, `dsh-glasses-M1-#22-DSH`) with distinct worktrees/branches pinned to the exact base SHA; persisted session logs present under the exact `projectKey`/`encodeSegment` layout; repeated reconcile restarts reconstruct the **same** two sessions (sessionIds identical, session dirs unchanged, no void markers, no duplicates).
- **Session inventory:** `$DSH_HOME/sessions` contains exactly the two bound Ticket sessions under their encoded names — no Codex session/thread persisted.
- **Moving base / watchdog:** in a live 3-pass process, Ticket #31 keeps its original base while #32 (blocked → then unblocked) is admitted on the moved base; the same session id is retained across passes (no duplicate admission by the in-process watchdog).
- **Completion:** a `ticket-complete:` marker retires Ticket #61 permanently (`completed`, never re-admitted, never re-woken, no re-created session) while #62 proceeds; repeated reconcile does not duplicate.
- **Native Codex capability (REAL):** on the dispatcher-bound Ticket DSH session `dsh-glasses-M1-#21-DSH`, `subagent_codex` is present at the composed agent scope and executed **twice as fresh one-shot invocations in the Ticket worktree**:
  - task 1 (28.7 s): reported `First line: disposable dispatcher smoke repository` and committed-change count — self-contained, git-grounded, read-only;
  - task 2 (23.2 s): reported top-level entries `README.md` and "worktree is clean" — a distinct fresh run;
  - the Ticket worktree stayed byte-identical (HEAD and `git status --porcelain` unchanged) — **non-mutating**;
  - no persistent Codex session or thread was created.

## 3. Availability-fallback and blocking-verdict semantics

Enforced at the bootstrap-content level (unit-tested) and by the protocol doc (`docs/WORKFLOW.md` §3): both helpers down → DSH continues; one helper down → proceed with the other; a technical `UNPASSED`/`REQUEST_CHANGES`/blocking finding is NOT `UNAVAILABLE` and must be addressed before completion. The dispatcher itself never blocks on any LLM/helper.

## 4. Preservation of prior guarantees

All previously accepted guarantees remain under test: frontier admission with capacity, deterministic moving-base, rollback (4 fault paths), failed-fetch fails closed with no admission, worktree isolation, claim idempotency, restart reconstruction, identity-collision and stale-session fail-closed probes, resource/DAG separation, credential handling (env + owner-only credentials file), deterministic stable reports.

## 5. Reproduce

```bash
cd plugins/dsh-ticket-dispatcher
npm test
npm run typecheck
npm run smoke        # requires the pinned DSH deployment + ~/.codex auth on this host
```

## 6. Residual uncertainty / deferred

- The smoke's live-model turns are not asserted (the local DS4 model endpoint is not part of this Ticket's gate); the Codex seam is asserted directly with real invocations, and dispatch is deterministic regardless of model reachability.
- A reopen/rework escape uses a new sessionId under the same logical name; documented, not acceptance-blocking.
- Native Codex auth currently rides the host `~/.codex/auth.json` (`auth_mode: chatgpt`); no per-Ticket Codex profile/model/thinking configuration exists by design (declared out of scope for #19).
