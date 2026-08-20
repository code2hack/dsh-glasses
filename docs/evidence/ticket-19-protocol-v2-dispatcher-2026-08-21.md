# Ticket #19 — protocol-v2 Ticket Dispatcher (paired DSH+Codex, watchdog) — design & acceptance evidence

- Ticket: https://github.com/code2hack/dsh-glasses/issues/19
- Manual bootstrap DSH agent: `dsh-glasses-Bootstrap-#19-DSH`
- Paired persistent Codex thread: `dsh-glasses-Bootstrap-#19-Codex`
- Base: `origin/main` @ `e3536f96f7c2cb32bc48236efdb35d2355a950d4`
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
  -> codex.createThread(start + name/set + first turn = exact name + await idle)
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
  no reseed) → wake once.
- live and `status === 'running'` → progressing, no wake.
- live and `status === 'idle'` (quiesced) → resume/wake the SAME DSH session with the
  minimal recorded continuation instruction, at most once per heartbeat interval
  (bounded cadence), only while unfinished.

## Out of scope notes

- No change to `mcp-chatgpt`; ChatGPT stays `ChatGPT project = dsh-glasses`,
  `ChatGPT session = CTO` (per PR #20 on main).
- No product/Rokid/SPEC change.

## Acceptance evidence (filled at closeout)

- Tested implementation head: TBD
- PR: TBD
- Test commands/results, paired names/IDs from disposable smoke, Codex first-prompt
  proof, idle proof, DSH-start proof, watchdog wake proof, no-spurious-wake proof,
  completed-no-wake proof, restart/idempotency proof, moving-base/rollback proof,
  config defaults/overrides proof, host assumptions: appended below at closeout.
