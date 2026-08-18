# TB0 — DSH compatibility evidence (read-only)

**Date:** 2026-08-19
**Host:** spark (DGX Spark, NVIDIA GB10) — the dual-Spark workstation where `dsh-glasses-plugin` will run.
**Repo:** `code2hack/dsh-glasses` @ branch `tb0/compat-contract`.
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
| Effective composed config | `dsh --profile web --dump-config` → 520-line tree (timer, hmr[disabled], llm, session, typert, typert-loader, typert-gateway/api-gateway, session-title, user-questions, agent, agent-default-model, …). Full dump archived beside this file for the record. |
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
- The disposable live session used for read correlation is the current DSH session of this workspace (`$DSH_HOME/sessions/<workspace-slug>/session-4399885b-…/session.jsonl.zstd`); no private content was read or recorded.

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
