# Ticket #19 — Bootstrap: native-Codex dispatcher validation evidence

- **Ticket:** #19 (Milestone `Bootstrap`, Gate `autonomous`)
- **Branch / base:** `workflow/ticket-19` off `c6e5d120972251a762b28890d4d24727615bc1a3` (`origin/main` at bootstrap)
- **Validated implementation head:** `2130879d5a07083dc6d0c7343836036829f7276d` (all code validation below ran on this exact tree)
- **Final candidate head / PR:** branch HEAD including this evidence; PR #25 (supersedes closed #22)
- **Produced:** 2026-08-21 on **spark** (repo `code2hack/dsh-glasses`). Git history + GitHub remain the durable record; this doc is reproducible on this host with the pinned DSH release.

## TL;DR

Every Ticket #19 acceptance requirement is demonstrated by the checked-in automated suites below. Automatic Ticket execution is enabled. The dispatcher admits, persists, restarts, watches, and completes exactly named DSH sessions; the generated bootstrap carries the full v2 protocol (bounded ChatGPT-plan attempt before code via the exact `mcp-chatgpt` → `ChatGPT project = dsh-glasses` / `ChatGPT session = CTO` endpoint, explicit availability fallback, fresh one-shot native Codex, non-deadlocking dual review); native Codex capability was exercised with two real, fresh, self-contained, non-mutating `subagent_codex` invocations on the bound Ticket DSH session; **the reviewer-availability contract was exercised as real integration smoke on a real conversational Ticket DSH agent against the real pinned native-Codex reviewer** (an available `REQUEST_CHANGES` stays blocking until addressed; a helper that is unavailable never blocks; both helpers down → DSH continues and completes alone when its own gate passes); completion markers are source-bound and trusted-writer enforced; no persistent Codex lifecycle state exists anywhere.

## 1. Unit validation (deterministic, offline)

Command: `npm test` in `plugins/dsh-ticket-dispatcher` → **62 tests, 62 pass, 0 fail**. `npm run typecheck` (node --check lib/*.js) → **clean**.

Coverage relevant to Ticket #19:

- **Named DSH admission:** exact identity `dsh-glasses-<milestone>-#<n>-DSH` for name and session id; marker schemaVersion 2 with name/sessionId/branch/worktree/baseSha; no duplicate claims on reconcile or restart; crash-between-flush reuses the persisted session; restart reconstructs the same session and worktree.
- **Milestone contract:** the Ticket's declared `## Milestone` is the canonical identity source (body wins; a GitHub milestone object degrades to its string title so `dshName` never receives an object); invalid-milestone OPEN tickets excluded and reported (`invalidMilestone`); HTML comments in the milestone block ignored. Open Tickets without a valid milestone are never admitted.
- **Bootstrap protocol content:** exact `mcp-chatgpt` + `ChatGPT project = dsh-glasses` + `ChatGPT session = CTO` identity; bounded start-up plan attempt before the first production edit; `UNAVAILABLE` is non-blocking while `UNPASSED`/`REQUEST_CHANGES`/blocking findings must be addressed; dual hard-problem help and dual final exact-head review; fresh one-shot non-mutating `subagent_codex`; "must not wait indefinitely on a helper"; closeout instruction to write `ticket-complete:` with the exact head SHA.
- **Watchdog:** live+progressing ⇒ no-op; live-but-quiescent unfinished ⇒ wake the **same** session with a minimal continuation only; not loaded + persisted ⇒ resume the same id then wake with the minimal continuation (not the bootstrap); completed (closed or valid matching marker) ⇒ disposed and never re-woken; a **malformed** completion marker (missing/non-hex/short head) does **not** retire a binding.
- **Completion markers — source-bound + trusted writer:** a `ticket-complete:` marker is authoritative only when it (a) carries a valid exact 40-hex `head`, (b) is posted on the Ticket's **own** issue (self-declared `ticket` must equal the source issue), and (c) is authored by an allowlisted writer when `completionAuthors` is configured. Cross-issue markers, foreign-commenter markers, and malformed markers are ignored, so the watchdog keeps supervising the Ticket.
- **Stale-identity guard:** a claim marker whose `sessionId` does not match the Ticket's current deterministic DSH identity (legacy/arbitrary claims) is rejected at load (`failed`/`stale-identity`) so the Ticket re-admits under the exact deterministic id and a foreign worker cannot hijack restart.
- **Identity collision (non-retriable, per CTO design mandate):** a persisted session for the deterministic id under a different worktree key is a durable terminal `identity-collision` — no claim void, no recursive session-dir deletion, no resume/create, no re-admission into an active collision; when the collided session log is removed outside the dispatcher, a later pass re-admits the **same** deterministic id (never auto-admits into an active collision).
- **Identities/bindings/closeout:** tombstones match by session id; state carries zero Codex lifecycle fields; every report carries `heartbeatMs` equal to the configured interval (default 120000).

## 2. Real-DSH + real-native-Codex smoke (integration, disposable)

Command: `npm run smoke` in `plugins/dsh-ticket-dispatcher` → **PASS** (output: `dsh-ticket-dispatcher smoke: PASS`). The smoke builds a disposable Git repo, DSH home, profile, settings, credentials, agent presets exposing `subagent_codex`, two dummy ready Ticket fixtures, and local state — no GitHub calls, no product code, no Rokid.

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
  - first invocation (~34.0 s): self-contained, git-grounded, read-only task 1;
  - second invocation (~17.7 s): a distinct fresh run of task 2;
  - the Ticket worktree stayed byte-identical (HEAD and `git status --porcelain` unchanged) — **non-mutating**;
  - no persistent Codex session or thread was created.

## 3. Availability-fallback and blocking-verdict semantics — exercised as real integration smoke

The CTO's round-3 finding required the availability fallback to be **behaviorally proven in real integration smoke**, not just prompt-content/unit asserted. The smoke now drives the REAL conversational Ticket DSH session (`dsh-glasses-M1-#21-DSH`) through the REAL `dsh-tool-subagent` → `dsh-subagent-codex` (pinned app-server) seam. The only deterministic channel the real reviewer reads — the Ticket worktree candidate content — is controlled; ChatGPT is not composed in the disposable profile (objective helper absence), exactly as in production semantics.

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

## 5. Reviewer rounds — findings and resolution

### Round 1 (fresh native Codex, head `871269d0010ec2ade6232e2694962cc8b688bdb6`) → addressed on `833c655`

1. **Watchdog resumed-session wake used the full bootstrap** — resumed/recreated (reconnected) Ticket Leads now wake with the minimal continuation only; fresh admissions always receive the full bootstrap.
2. **Collision path recursively deleted collided session dirs** — collisions are non-retriable terminal tombstones with no deletion, no void, no re-admission into an active collision; `removeOrphanSession` removed.
3. **Completion markers accepted without an exact head** — `parseCompleteMarker` now requires a valid exact 40-hex `head`; malformed markers ignored (positive/negative unit coverage).
4. **Smoke did not pin the deployment** — the smoke resolves and asserts the installed DSH/Codex bundle versions for equality (section 2).
5. **AGENTS.md §12 carried Ticket-specific live state** — rewritten as a state-free static protocol section; validation history lives in `docs/WORKFLOW.md` §13 and this evidence doc.

The CTO's design approval (request `r19-2026-08-21b-startup-plan-1`) required: (a) wrong-cwd persisted identity = non-retriable identity collision, and (b) the completion marker formally specified before the watchdog relies on it. Both implemented + covered.

### Round 2 (fresh native Codex 5 findings + CTO 5 findings on head `b55725a2ef21d9706d17c08c5e0079fe947111bb`) → addressed on `2130879`

Fresh native Codex findings:

1. **Continuation wake** — re-verified the watchdog's resumed/recreated wake carries the minimal continuation while fresh admissions keep the full bootstrap; kept, now directly covered by unit tests.
2. **Collision handling** — re-verified collision is a non-retriable durable terminal with no session-dir deletion; added explicit unit coverage that a repeat pass stays stable and that removing the collided log re-admits the same deterministic id.
3. **Exact-head completion markers** — completion is authoritative only with a valid exact 40-hex `head`; source-bound + trusted-author enforcement added (below).
4. **Pinned-version report** — smoke now asserts equality of the pinned DSH/Codex versions, plus a real in-probe non-mutation witness for both Codex calls.
5. **Milestone object leak** — `normalizeIssues` previously passed a GitHub milestone *object* into `dshName` (`[object Object]`, admission abort); the declared `## Milestone` now wins and a milestone object degrades to its string title.

CTO findings (2 not raised by Codex):

A. **Completion markers must be source-bound and trusted-writer** — a `ticket-complete:` marker now only retires a Ticket when it is posted on the Ticket's own issue and authored by an allowlisted `completionAuthors` writer; cross-issue/foreign markers are ignored (unit-covered, fixture + adapter).
B. **Availability fallback must be exercised in real integration smoke** — implemented as section 3: real conversational agent + real pinned native-Codex reviewer, deterministic gates, probe-driven gate-check, all four legs executed and asserted (both helpers down leg composes the agent WITHOUT `subagent_codex`, making reviewer unavailability deterministic rather than auth-dependent).

### Round 3 (fresh native Codex, head `2130879`)

Undergone at branch HEAD (see PR #25); verdict recorded durably on the PR once issued.

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
- Reviewer-availability was exercised with the reviewer side deterministic; the reverse leg (ChatGPT available + reviewer absent) is covered at the code/unit level and by the same entitlement logic, but ChatGPT is not composed in the disposable profile, so that single-sided leg is not literally run on a real ChatGPT account here. The protocol's invariant (any non-blocking technical result + at least one helper → continue) is identical for both sides.
