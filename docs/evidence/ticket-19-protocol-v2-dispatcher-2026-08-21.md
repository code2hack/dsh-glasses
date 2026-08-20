# Ticket #19 — protocol-v2 Ticket Dispatcher (paired DSH+Codex, watchdog) — design & acceptance evidence

- Ticket: https://github.com/code2hack/dsh-glasses/issues/19
- Manual bootstrap DSH agent: `dsh-glasses-Bootstrap-#19-DSH`
- Paired persistent Codex thread: `dsh-glasses-Bootstrap-#19-Codex`
- Base: `origin/main` @ `8b45edb2a99f0be4615583ce9e16da4303b4c530` (rebased; includes PRs #18/#20/#21 — protocol v2 + startup-plan/hard-help mandates)
- Tested implementation head: `b6ba392` on `workflow/ticket-19` (rebased onto `8b45edb`)
- Branch / worktree: `workflow/ticket-19` / `/home/code2hack/Projects/glasses/dsh-glasses-t19`
- Evidence date: 2026-08-21 (host `spark`, aarch64)

## Scope

Upgrade `plugins/dsh-ticket-dispatcher` so every admitted Ticket materializes and
maintains the protocol-v2 DSH+Codex pair and a DSH-liveness watchdog, per Issue #19
and the accepted protocol in `AGENTS.md` / `docs/WORKFLOW.md` (protocol v2 on `origin/main`).

Out of scope: product/Rokid behavior, Milestone planning, LLM scheduling,
`mcp-chatgpt` changes, review-prompt content beyond exposing the paired addresses.

## Seams (empirically verified on this host, 2026-08-21)

### DSH lifecycle (`@deepseek-ai/dsh@0.1.0-rc.8`)

- `ctx.get("agents").create({ sessionId, meta, agentOptions })` / `.resume({ resumeSessionId, agentOptions })`
  are the supported agent lifecycle services. No agent-loop patch.
- DSH names are binding attributes (DSH sessions carry `sessionId` only); the exact
  DSH name is recorded in the durable binding and delivered in the bootstrap prompt.
- **Watchdog lifecycle signal**: the live agent handle exposes `handle.agent.status`
  (`'idle' | 'running'`, mirrored by `agent/status` events). `running` = progressing;
  `idle` = quiesced. Dispatchers must ground wake decisions on this supported signal,
  not on a fragile inactivity timeout.
- `handle.agent.followup(...)` sends the minimal continuation instruction to the SAME
  session (no replacement identity).
- Persistence: `$DSH_HOME/sessions/--<worktree-cwd>--/<sessionId>/` (probed with
  `createSessionProbe` as today).

### Codex persistent thread (`codex-cli 0.147.0`, app-server)

- Transport: the local app-server daemon exposes a **WebSocket JSON-RPC 2.0** endpoint
  on `~/.codex/app-server-control/app-server-control.sock` (verified handshake/framing).
  Daemon management: `codex app-server daemon start|version|restart`.
- Seam per thread: `initialize` → `thread/start` (cwd = worktree) → `thread/name/set`
  (exact Codex name) → `turn/start` with `input: [{type:"text", text: <exact name>}]`
  (the ONLY first prompt) → await `turn/completed` → thread `idle`.
- The first prompt is byte-for-byte exactly the assigned Codex name; no second
  bootstrap message is ever sent. Later review/debug = another `turn/start` on the
  same `threadId`.
- Reconstruction: `thread/read {threadId, includeTurns}` returns the same thread +
  turn history; restart reconstructs the SAME thread, never a replacement.
- **Configuration surface (owner directive, protocol-v2 runtime settings only):**
  - polling/heartbeat interval, default **120 s** (configurable);
  - Codex thinking effort, default **MAX** (configurable);
  - NO Codex profile setting and NO model setting in the dispatcher: the installed
    Codex removed per-thread `profile=` config and `--profile` is daemon-level, so
    every thread inherits the running daemon/profile/model. Verified: a thread created
    with no model override resolves the daemon default model (`gpt-5.6-sol`, the `Sol`
    model). Thinking effort is applied through `thread/start` `config.model_reasoning_effort`
    and `turn/start` `effort` (real supported persistent-thread API).

## Milestone / name derivation (deterministic)

- `parseMilestone(body)` reads the `## Milestone` section. Derivation is mechanical:
  take the first line, split on whitespace/`/ , | — – ; :`, take the FIRST token matching
  `^[A-Za-z0-9][A-Za-z0-9._-]*$` (≤ 64 chars). Reject missing/empty sections and inputs
  with no valid token (no silent invention). Examples: `M1` → `M1`;
  `Bootstrap / protocol-v2 transition` → `Bootstrap` (declared first token);
  `Workflow bootstrap — …` → `Workflow`; missing section → rejection.
- Current-protocol mandates carried in the dispatcher bootstrap/continuation
  (AGENTS.md on main 8b45edb): DSH must request a ChatGPT startup `plan` through
  `mcp-chatgpt` (project `dsh-glasses`, session `CTO`) and receive it before the
  first production edit (Codex stays idle during startup planning); on hard/stuck
  problems DSH MUST send one identical git-only debug request to BOTH ChatGPT and
  Codex; dual PASS on the exact same head before closeout; durable
  `dispatcher-closeout:` marker so the watchdog never re-wakes a finished Ticket.
- `derivePairNames({project, milestone, number})` →
  `<project>-<milestone>-#<number>-DSH` and `<project>-<milestone>-#<number>-Codex`.
- Manual #19 bootstrap exception: the bootstrap prompt itself fixes the token
  `Bootstrap`; it is NOT generalized into product Milestone naming.

## Paired admission (atomic at workflow level)

```
Ticket + Milestone
  -> resolve exact current base SHA
  -> build binding { dshName, codexName, sessionId, branch, worktree, baseSha,
                     bootstrapPrompt, codex: { threadId?, thinkingEffort }, status }
  -> git.createWorktree
  -> dsh.createAgent(DSH session)
  -> codex.createThread(start + name/set + first turn = exact name
       + wait seed TERMINAL/idle; fails publication otherwise; verified:
       first prompt byte-exact, exactly one user turn, thread idle)
  -> (same-name persistent thread already on the daemon -> REUSE it, never duplicate)
  -> local state save
  -> github.writeClaim (durable binding incl. names + codex threadId + milestone)
  -> dsh.wakeAgent(DSH starts immediately)
  (Codex remains idle)
```

Fault-injected rollback points: worktree/branch creation, DSH creation, Codex thread
creation, Codex seed, local save, GitHub claim publication. A partial pair never
becomes a false healthy claim.

## Watchdog

Per pass, for every unfinished admitted binding:

- durable completion signal: a GitHub closeout marker `dispatcher-closeout:` on the
  Ticket (written by DSH at closeout, consistent with AGENTS.md closeout) OR the
  Ticket CLOSED. Completed bindings are disposed and never woken, and release capacity.
- not live (restart) → reconstruct pair (resume same DSH session + same Codex thread,
  no reseed). Idempotency/identity gates: resume only when the persisted session's log
  contains the binding worktree (a foreign orphan is voided `stale-session`, never
  silently resumed); the admitted base SHA stored in the binding is preserved and never
  re-resolved; the bootstrap is woken once per durable session — a session whose log
  already contains the bootstrap sentinel is NOT re-woken after a restart.
- live and `status === 'running'` → progressing, no wake.
- live and `status === 'idle'` (quiesced) → resume/wake the SAME DSH session with the
  minimal recorded continuation instruction, at most once per heartbeat interval
  (bounded cadence), only while unfinished.

## Out of scope notes

- No change to `mcp-chatgpt`; ChatGPT stays `ChatGPT project = dsh-glasses`,
  `ChatGPT session = CTO` (per PR #20 on main).
- No product/Rokid/SPEC change.

## Acceptance evidence (exact tested head)

- Tested implementation head: `53a868fefa20e2bde2bc8acfbed1d8045466a88a`
  (branch `workflow/ticket-19`, pushed `origin/workflow/ticket-19`)
- PR: https://github.com/code2hack/dsh-glasses/pull/22
- Unit: `npm test` = 68/68 PASS; `node --check` on all lib/test modules; `git diff --check` clean.
- Real-seam smoke `npm run smoke` (scratch git repo + scratch `DSH_HOME` + real codex
  app-server (`~/.codex/app-server-control/app-server-control.sock`) + DS4 vLLM
  default model for the wake phase) — PASS assertions:

  ```
  SMOKE pair-admission: sessions=dsh-glasses-S1-#21-DSH,dsh-glasses-S1-#22-DSH threads=01a020bb-af07-7e03-a708-7c8040f842b7,01a020bd-496c-7632-bc1b-d1e55d3b55b8
  SMOKE named-sessions: dsh-glasses-S1-#21-DSH@dsh-glasses-S1-#21-DSH | dsh-glasses-S1-#22-DSH@dsh-glasses-S1-#22-DSH
  SMOKE codex-first-prompt-exact: dsh-glasses-S1-#21-Codex=dsh-glasses-S1-#21-Codex | dsh-glasses-S1-#22-Codex=dsh-glasses-S1-#22-Codex
  SMOKE restart-reconstruct: same_sessions=2/2 same_threads=true live=true invalid=0
  SMOKE moving-base: ticket31=0c1a63bd67523e4b4f4e0d43024672f08a489685 ticket32=b504a5f8d43e2478f851f70241b23f56ce1d730e
  SMOKE real-wake: dsh_session=dsh-glasses-S2-#41-DSH codex_thread=01a020c0-f74b-7a23-aa08-8057c3f511e8 thinking=max
  SMOKE watchdog-completed: retired_ticket=41 running_after=0 thread_count=1
  SMOKE invalid-claim: ticket=51 reason=stale-session tombstone=true ready=true
  SMOKE branch-readmission: ticket=52 same_name=true new_base=06c12c3c47b097eb20aae8178705329ad1513180
  SMOKE scope: no product code or Rokid touched (scratch repo/worktrees only)
  ```

- Proofs covered by the above smoke lines: paired names, DSH session id == name,
  exact byte-for-byte first prompt (single user turn), idle seeded Codex, immediate
  DSH start (real wake), same-pair restart reconstruction (no duplicate session or
  thread), per-binding exact base preservation under moving refs, watchdog no-wake
  on completed tickets, stale-session tombstone (orphan worktree/session
  `#`-encoding path handling), branch readmission reusing the same-name thread.
- Config proofs: `codexThinking=max` default asserted in smoke; heartbeat default
  120 s unit-proved (`heartbeatIntervalMs` defaults and override paths).
- Host assumptions: `code2hack`@`spark` (aarch64 Ubuntu); `dsh` from npm-global;
  codex app-server daemon already running; `zstd` at `/usr/bin/zstd`; DS4 vLLM at
  `http://192.168.1.9:8888/v1` for the model-backed wake phase; `DSH_SCOPE` per
  host; settings copied from host `~/.dsh/settings.yaml` into the scratch home.

Closeout (dual review + marker) appended at closeout.
