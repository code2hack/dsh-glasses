# TB0 — DSH compatibility evidence (read-only)

**Date:** 2026-08-19
**Host:** spark (DGX Spark, NVIDIA GB10) — the dual-Spark workstation where `dsh-glasses-plugin` will run.
**Repo:** `code2hack/dsh-glasses` @ branch `tb0/compat-contract`.
**Status:** installed-artifact/source-contract qualification **complete**; runtime plugin read proof **pending** (tracked as TB0-H0).
**Scope:** Host-only read compatibility proof required by the TB0 execution contract. No glasses, no Funnel, no draft mutation, no Send, no Photo/Voice/Morse. Nothing in this document contains credentials, private endpoints, prompt text, or session IDs.

---

## 1. Pinned live installation (recorded from the live box, not memory)

| Artifact | Live value |
| --- | --- |
| DSH package | `@deepseek-ai/dsh@0.1.0-rc.7` |
| DSH install path | `/home/code2hack/.npm-global/lib/node_modules/@deepseek-ai/dsh` |
| DSH dist integrity (npm) | `sha512-ZceDCJ8FAywih+USW/OMk9jEhunlvJBGEz4kqrhau23hPzbciOazZrywH0nBRsaalSeAJ1JGBmjtw4OSjToStw==` |
| DSH upstream repo | `github.com/deepseek-ai/deepseek-harness`, package dir `apps/cli` |
| Source commit SHA | Not baked into the installed npm artifact (no `.git`, no `gitHead` in `package.json`). **Pin = version + dist integrity** until a matching upstream SHA is confirmed from the source checkout; recorded as a residual. |
| Node.js | `v24.14.1` |
| npm | `11.11.0` |
| pnpm | `11.22.0` |
| DSH_HOME | `/home/code2hack/.dsh` |
| Active profile | `web` (`$DSH_HOME/profiles/web`) |
| Profile bundles (`dsh.profile.bundles`) | `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@dsh-external/dsh-super-injector` (all resolved at `0.1.0-rc.7` where versioned) |
| Profile root config | `cordis.yml` = `[]` (empty; the tree is composed as patches) |
| User patch layer | `cordis.patch.yml` — currently `mcp-browser` (@playwright/mcp, headless chromium) + `mcp-chatgpt` (@playwright/mcp `--cdp-endpoint http://127.0.0.1:9222`) |
| Effective composed config | `dsh --profile web --dump-config` → 520-line tree (timer, hmr[disabled], llm, session, typert, typert-loader, typert-gateway/api-gateway, session-title, user-questions, agent, agent-default-model, …). Raw environment-specific dump retained locally only (NOT committed); SHA-256 `27d34c0724c0069e75d119fa59da51b09ebb1f69a59f137727896b6e28a88c79`. |
| Plugin loading mechanism | `dsh` CLI boots the profile; bundles named in `dsh.profile.bundles` resolve first from the dsh installation, then from the profile's `node_modules`; the cordis loader (`cordis-plugin-loader`, `dsh-cordis-host-runner`/`dsh-app-boot`) composes `cordis.patch.yml` over bundle layers. Out-of-tree plugins are added through `dsh plugin` → pnpm in the profile dir. |
| Persisted session store | `$DSH_HOME/sessions/<workspace-slug>/<session-id>/session.jsonl.zstd` — 6 durable session logs present, including the live session used for this proof. |

Why `0.1.0-rc.7` rather than the guessed `0.1.0-rc.6`: recorded from the installed `package.json` and from the running pm2 process (`dsh`, 0.1.0-rc.7).

---

## 2. Contract proof (source-path → symbol → signature)

All paths are under the installed package tree
`/home/code2hack/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`.
The plugin will call these through the DSH service context (`ctx`) exactly as shell/headless and web agents do.

### 2.1 Listing persisted and live sessions
- `dsh-session-query/lib/types/index.d.ts` — `abstract class SessionQueryEngine extends Service`
  - `listSessions(signal?: AbortSignal): Promise<SessionRecord[]>`
  - `filterSessions(filters: readonly SessionResultFilter[], signal?): Promise<SessionRecord[]>`
- `dsh-session-query/lib/types/corpus.d.ts` — `listSessions(signal?): Promise<SessionRecord[]>`; `projectMany<Value>(sessionIds, project, signal?)`.
- Proven from source; live store readable at `$DSH_HOME/sessions/**/session.jsonl.zstd`.

### 2.2 Reading bounded history for one session
- `dsh-session-query/lib/types/index.d.ts`
  - `readSession(sessionId: SessionId): Promise<SessionLogSnapshot>` — bounded window read (`readWindowMax` default 50, config `dsh-session-query/lib/types/config.d.ts`).
  - `readTitle(sessionId, signal?): Promise<SessionTitleSnapshot | undefined>`
- `SessionLogSnapshot` carries the session `header` + `events` (corpus read in `corpus.d.ts`).

### 2.3 Subscribing to new session events
- `dsh-session-projection/lib/types/index.d.ts`
  - "the service subscribes to `session/event` once; every committed event passes" through every registered unit
  - `ProjectionDefinition.apply(state, event): S` (pure transition per committed event)
  - `ProjectionChangeListener = (session, key, value, seq) => void`
  - `ProjectionSnapshot { asOfSeq, values }`; watermark `session/subscribed.lastSeq` (`-1` empty log)
  - `SessionProjectionRegistry.register(definition): () => void`
- This is the live session-event subscription path used to drive the glasses projection delta on the host side.

### 2.4 Resolving the live Agent for a session
- `dsh-agent` (`dsh-agent/lib/types/index.d.ts`, `runtime-types.d.ts`) owns `AgentHandle` with `agent/status` events and per-agent `ctx`; "Disposal removes the agent from its registry".
- `dsh-agent-loop/lib/types/agent.d.ts` — the live loop handle exposing `followup/steer/cancel/send/inject` (below).
- **Residual (implementation step):** the exact public resolver symbol that maps `sessionId → AgentHandle` must be pinned in TB0 implementation. It is exercised today by the stock web/shell agent wiring, not isolated as a standalone named export we could yet cite by line number.

### 2.5 Reading idle versus running
- `dsh-agent/lib/types/runtime-types.d.ts`
  - `export type AgentStatus = 'idle' | 'running'`
  - "`idle` means no driver is active; `running` begins when waking input starts cancellable pre-step processing and lasts while the driver drains, closes, or checkpoints turns."
  - `agent/status` transition events; `status: AgentStatus` on the handle.
- Matches the SPEC `AttachmentState: 'idle' | 'running' | …` projection surface.

### 2.6 calling `followup()`
- `dsh-agent-loop/lib/types/agent.d.ts` — `followup(input: UserMessage): void`

### 2.7 calling `steer()`
- `dsh-agent-loop/lib/types/agent.d.ts` — `steer(input: UserMessage): void`
- Companion: `send(message: UserMessage, target: InboxTarget, wakeup: boolean): void`, `inject(input: UserMessage): void`, `whenIdle(): Promise<void>`.

### 2.8 calling `cancel()`
- `dsh-agent-loop/lib/types/agent.d.ts` — `cancel(cause: AgentCancelCause, options?: CancelOptions): void`
- `dsh-agent/lib/types/runtime-types.d.ts` — full cancel semantics: "Clear queued and steering work — unless `keepInbox` — and abort the active turn or between-turn task … With no active activity, cancellation is a no-op and does not arm later work." `runMaintenance<T>(task)` also aborts on cancel.

### 2.9 Registering plugin HTTP routes
- `dsh-host-webserver/lib/types/index.d.ts`
  - `ctx.webServer` — "HTTP and upgrade route registries, index transform taps, and the single fallback seat"
  - `register(route: WebRoute): () => void` — "Duplicate (kind, path) throws"; kind+path+handler named route; disposer removes it.
  - `registerUpgrade(route: WebUpgradeRoute): () => void`
  - `registerFallback(handler): () => void`

### 2.10 Holding an SSE response open
- `dsh-host-webserver/lib/types/index.d.ts` — `WebRoute.handler` "Owns the full response lifecycle **(may hold the response open, e.g. SSE)**".
- Node `http` (`node:http`, `Duplex`) server: SSE = a handler keeps the response object open and writes `text/event-stream` frames; exact framing is plugin-owned.

### 2.11 Storing plugin-owned durable draft state
- `dsh-storage/lib/types/index.d.ts` + `backend.d.ts`
  - `class Storage extends Service` with `backend: BackendRegistry`, `domain` forms; `storageBackendServiceKey(name)`
  - `StorageBackend { kv?: KvFacet; close(): Promise<void> }`
  - `KvUnit` — durable atomic per-call writes; writes durable once resolved ("a crash after resolution followed by a re-open observes the write"); version-stamped units (`version-mismatch`, `malformed-medium`, `closed`); `UNIT_NAME_RE` for safe unit/table names.
- This is the seam for the plugin's committed-text draft store with monotonic revision.

### 2.12 Correlating a submitted user message with durable session events
- `SessionEvent` carries a monotonic `seq`; projections and clients expose the shared watermark (`session/subscribed.lastSeq`, `ProjectionSnapshot.asOfSeq`).
- `dsh-session-query` `readSession` returns the bounded event log for one session and `dsh-session-query/lib/types/documents.d.ts` builds per-event records/search docs — a submitted message maps to one user-message event in the event stream, identifiable by seq.
- `dsh-agent-loop` `send(message: UserMessage, target: InboxTarget, wakeup)` shows the input boundary; wake classification is captured at insertion time.
- **Residual:** exact durable event identity (message id vs seq) used for the plugin's no-blind-replay reconciliation is an implementation decision recorded in `docs/TRACER_BULLET_TB0.md` §no-replay.

---

## 3. Host-only read proof performed

- Read the live `dsh` process (`pm2`, `@deepseek-ai/dsh@0.1.0-rc.7`).
- Ran `dsh --profile web --dump-config` against the live `web` profile; 520-line composed tree captured (see §1).
- Confirmed the durable session store layout and 6 persisted logs under `$DSH_HOME/sessions/`.
- Read all contract signatures from the installed packages' shipped TypeScript declarations (`lib/types/*.d.ts`) — **no memory, no docs-only claims**.
- A disposable workspace session under `$DSH_HOME/sessions/<workspace-slug>/` was used for read correlation. No private content was read or recorded, and **no session identity is committed** in this document. (TB0-H0 will run the runtime proof against a fresh disposable session configured only via `DSH_GLASSES_TB0_SESSION_ID`.)

## 4. Directly proven vs inferred/residual

**Directly proven:** version/dependency pins; effective profile composition; durable session store exists and is readable; `listSessions`, `readSession` (bounded), `session/event` subscription + projection registry, `AgentStatus` idle/running, `followup/steer/cancel`, `webServer.register`/`registerUpgrade` with SSE-capable handlers, durable `Storage`/`KvUnit` writes, seq-based message correlation primitives — all against installed sources.

**Inferred / unresolved (to pin during TB0 implementation):**
- Highest-confidence resolver symbol `sessionId → AgentHandle` (exists in live wiring; not yet a cited named export).
- Whether a `WebRoute` path conflicts with the stock web-app's SPA/upgrade routes (route patterns already reject duplicates at startup; probe will confirm the `/glasses/v1/*` namespace is free).
- `dsh-storage` unit/table schema choice for the committed text draft (plugin-owned), and its revision/version stamp.
- `followup` vs `steer` exact user-message shape (`UserMessage`) and how `InboxTarget` boundaries map to an "idle-session Send" vs "running steer".
- SSE framing/multiplexing detail (host-side kept open; glass-side reconnection is TB0).

## 5. Live DSH vs SPEC.md — incompatibilities found

No blocking incompatibilities. Recorded notes:

- DSH's own `AttachmentStore` (`dsh-attachment`, `ctx.attachments`) is an **immutable binary image attachment** service, **not** a session-exposure ("attachment/tab") service. SPEC.md §2/§3's "attachment" concept is **plugin-owned**; the plugin must implement it on top of `dsh-session`/`dsh-session-query`/`dsh-session-projection`. This is consistent with SPEC §1.1 and §5 — no SPEC change required.
- `followup`/`steer`/`cancel` exist as `dsh-agent-loop` methods exactly as SPEC.md requires for semantic Send/Steer/Interrupt. The SPEC's "Send or Steer" distinction maps to: idle → `followup`/`send(…, wakeup)`, running → `steer`.
- The SPEC's `AttachmentState` vocabulary (`idle/running/waiting-user/unavailable/unknown`) maps to DSH `AgentStatus` (`idle/running`) plus plugin-local state for the remaining values. No conflict; the two extra SPEC states are projection-local.
- Plugin route registration is safe provided `/glasses/v1/*` doesn't collide with the web app's registered routes (probe in TB0 before freezing, per SPEC).

*If TB0 implementation contradicts any normative SPEC assumption, `SPEC.md` will be updated in the same commit, per its own §1 rule.*

---

## TB0-H0 runtime read proof (2026-08-19) — PASSED

Runtime gate executed on a **fully disposable isolated DSH instance**; the resident DSH/text-serving stack was not touched. All output below is sanitized; no session IDs are recorded (the disposable session was supplied only via `DSH_GLASSES_TB0_SESSION_ID`).

### Environment
- DSH artifact: `@deepseek-ai/dsh@0.1.0-rc.7` (same pin as §1).
- Disposable `DSH_HOME=/tmp/dsh-tb0-home` (fresh profile: `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app` + `dsh-glasses-plugin`), served with `dsh --profile web --port 3190`.
- Plugin package: `plugins/dsh-glasses-plugin/` (out-of-tree, installed via pnpm `file:` link into the disposable profile).
- Test agent provider (disposable-only): keyless local `tb0vllm` route (`http://127.0.0.1:8889/v1`, `api: openai-completions`, model `lfm2.5-vl-3b`) — no secrets, no network beyond loopback, never mounted in the resident profile.
- Credential: one random dev bearer token, scoped only to `/glasses/v1/*`, injected via `DSH_GLASSES_TB0_TOKEN`.

### Sanitized boot command
```
DSH_HOME=/tmp/dsh-tb0-home \
DSH_GLASSES_TB0_SESSION_ID=<disposable-session-id> \
DSH_GLASSES_TB0_TOKEN=<dev-bearer> \
  dsh --profile web --port 3190
```
Plugin log on load: `[dsh-glasses-plugin] ready: session=<id> generation=<rotated>`.

### Runtime-proven behavior

| Check | Result |
| --- | --- |
| Config schema + env defaults | Loaded; schemastery `.default(fn)` is NOT lazy — env is resolved at module scope (fixed in-slice). |
| Service injection | `webServer`, `sessionQuery`, `agents`, `session/event` all resolved at boot. |
| Route registration / conflict | All `/glasses/v1/*` registrations succeeded; **no duplicate/conflict throw**; unknown subpaths → 404 via the prefix handler. |
| Auth | No bearer → HTTP 401 on `/bootstrap`, `/stream`, stubs. |
| Stubs | `POST /glasses/v1/draft/mutations` and `/glasses/v1/actions` → HTTP 501 `NOT_IMPLEMENTED` (bearer accepted). |
| Bounded history (bootstrap) | Authenticated `GET /bootstrap` returned `protocolMajor: 1`, rotated `serverGeneration`, `attachment{attachmentId, sessionId, status}`, `history{asOfSeq, events[]}`; **43 events, asOfSeq 42** reconstructed from the durable store; events projected minimally (`seq`, `type`). |
| Live agent resolver | `ctx.agents.get(sessionId)` → `AgentHandle`; `.status` observed `unavailable` (pre-turn / post-restart) and `idle` after a completed turn. |
| Live event subscription | `ctx.on('session/event', cb)` (host cordis Context) delivered committed events with monotonic `seq`; SSE frames `id: <seq>` / `event: projection` / `data: {seq,type,generation}` — one observed `user/message` at seq 19 inside a turn (`turn/start`16 → `step/start`18 → `user/message`19 → `step/end`20 → `turn/end`21). |
| Status transition | Pre-turn `unavailable`; during a turn the durable turn/step event sequence shows the running window; post-turn bootstrap reports `idle`. Direct bootstrap-during-running not captured (see residuals). |
| SSE disconnect/reconnect | After closing the observer, a new prompt advanced `asOfSeq` 28→35 while offline; a reconnected stream emitted `hello` only (no replay), and after a fresh prompt resumed **contiguously at 36** (`asOfSeq+1`) with no duplicates/gaps through 42. |
| Plugin restart reconstruction | Instance restarted with the same env: bootstrap returned **asOfSeq 42 / 43 events** again with a rotated `serverGeneration` (`ok: true`). |

### Remainder / residuals
- Host agent status is process-local: after plugin restart the session's agent is `unavailable` until a prompt wakes it (matches the agent/session registry being per-process). TB0 must define the status-resume policy for reconnect.
- No `Last-Event-ID` wire resync is implemented; reconnection semantics are **bootstrap-first** (client re-reads `/bootstrap`, then opens `/stream`) — "no silent delta drop; a gap forces a new bootstrap" as allowed by the TB0 contract.
- Step 10 of the prescribed test (bootstrap verification with the plugin fully stopped after reconstruction) was folded into the restart check above; the independent-surface events were produced via the host `session.prompt` RPC (`mode: queue`, text content) — a genuine client-side surface, not the plugin.

### Directly proven vs inferred
**Proven at runtime:** plugin load; route registration without conflict; bearer auth; 501 stubs; bounded history read (`session-query`); monotonic live events (`session/event`); idle/running turn shapes via durable events; SSE gapless continuation + reconnect resync; restart reconstruction of history.
**Inferred/residual (recorded above):** exact `sessionId → AgentHandle` resolver remains `ctx.agents.get(sessionId)` (no separate named export pinned); status-resume policy; `Last-Event-ID` resync; `followup`/`steer` message shapes (deferred to the write slice).

---

## TB0 host-write runtime proof (2026-08-19) — PASSED

Executed on the same disposable isolated instance (port 3190, keyless `tb0vllm` test provider); resident stack untouched. No session IDs recorded.

### Implemented
- `plugins/dsh-glasses-plugin`: `POST /glasses/v1/draft/mutations` (`setText`/`ack`, monotonic revision) and `POST /glasses/v1/actions` (Send-only) replacing the `501` stubs.
- Durable storage via dsh-storage `json` backend KvUnit `glasses_plugin` (tables `drafts`, `ledger`), unit name must satisfy `UNIT_NAME_RE=/^[a-z][a-z0-9_]*$/` (hyphens rejected).
- Message identity: `createUserMessage` mints the stable `MessageId` at Send admission; ledger row `{operationId, messageId, state, draftRevision, asOfSeqAtSend}` is durably written **before** `agent.send(message, 'next-turn', true)`.
- Zero-or-one acceptance: count durable `user/message` events whose id equals the ledger `messageId`.

### Runtime results (sanitized)
| Check | Result |
| --- | --- |
| Write-route auth | 401 without bearer on both routes. |
| `setText rev 1` | 200 `{revision:1, status:'editing'}`; durable in `storages/glasses_plugin.json`. |
| `ack rev 1` | 200 with `committedSeq` snapshot. |
| Stale revision | `setText rev 99` → 409 `revision-conflict {expected:2, got:99}`. |
| Send while agent busy | 202 `{operationId, messageId, accepted:'pending'}`; message queued for next turn. |
| Reconcile — 0 durable | `reconciled:true, state:'rejected'` (message accepted by transporter but not yet in the session log; draft retained). |
| Reconcile — 1 durable | after the turn claimed it: `reconciled:true, state:'accepted'`; draft cleared (`revision:0, status:'cleared'`), ledger `state:'accepted'`. |
| Exactly once | the durable `user/message` event carries the ledger `messageId` exactly once (rc.7 stores the message under `event.data`, `surfaceOp:'append'`); repeated reconcile stays `accepted`. |
| Plugin restart | bootstrap + KvUnit reconstruction: draft + ledger survive with the same values. |

### Residuals (same as read slice)
- `Last-Event-ID` wire resync not implemented (bootstrap-first).
- `steer`/followup shapes, image/photo blocks, Voice/Morse deferred.
- Agent must be live (`ctx.agents.get` non-null) for Send; pre-agent Send returns 503 `agent-unavailable` (host warms the agent on session resume).

---

## TB0 host-write — amended implementation + fault tests (2026-08-19)

Supersedes the earlier write-slice records in this doc where they differ. Executed on the disposable instance; resident stack untouched. No session IDs recorded.

### Amended design implemented (per review)
- Admission via the in-process host service: `ctx.apiProxy.sessions.prompt({ rpcId: operationId, payload: { sessionId, mode: 'queue', content } })` (NOT `ctx.agents.get(...).send`).
- Correlation: glasses `operationId` == prompt `rpcId` == durable `user/message.source.rpcId` (runtime-verified: `source: { kind: 'user', rpcId }`).
- One atomic KvUnit state document (`glasses_plugin` unit, `state` table, key=sessionId): `{ schemaVersion, sessionId, draft { revision, text, lockedByOperationId?, lastMutation? }, operations: Record<opId, Tb0Operation> }`; transitions are single `putRecord` writes.
- Send states `prepared | dispatching | accepted | rejected | unknown`; never more than one `session.prompt` per operationId; `accepted` settled only on exact durable positive; absence never classified as rejection (→ `unknown`, draft locked).
- Draft mutation simplified: `{ operationId, expectedRevision, mutation: { kind: 'replace', text } }`, monotonic revision bump, no client ack; idempotency + `409 operation-conflict` / `409 revision-conflict` / `409 draft-locked`.
- Per-operation in-process serialization for concurrent identical sends.

### Fault-injection results (env-gated test hooks, inert by default)
| Test | Result |
| --- | --- |
| Crash after `prepared`, before dispatch | 0 durable user/messages; draft retained + locked; repeated `/actions` returns prepared/pending with **no re-dispatch**. |
| Crash after DSH admission, before settlement (admission not flushed) | 0 durable; stays `dispatching`/pending; no re-dispatch; draft retained + locked (safe-unknown leg). Normal-path leg: `unknown → accepted`, draft cleared once, count 1. |
| Response lost after durable settlement | Repeated `/actions` returns stored `accepted`; no new prompt; durable count stays 1. |
| Concurrent identical `/actions` | 1 prompt dispatch (instrumented), 1 durable user/message. |
| Operation-id conflict (same op, different digest) | `409 operation-conflict`; no dispatch. |
| Long response pushes message past first bounded page | Full-log scan still finds it (seq 141 of 199); `accepted`; count 1; never misclassified as zero. |
