# TRACER_BULLET_TB0 — host write slice (tb0/host-write)

**Status:** design + implementation contract for the TB0 write slice (post-TB0-H0).
**Date:** 2026-08-19
**Repo:** `code2hack/dsh-glasses` @ branch `tb0/host-write`
**Normative:** `SPEC.md` rev3 + `docs/TRACER_BULLET_TB0.md` (Send-only actions; Steer → TB0.1).

Evidence base: `docs/evidence/tb0-dsh-compat-2026-08-19.md` (incl. §TB0-H0 read proof), which proved forward/backward identity seams against installed `@deepseek-ai/dsh@0.1.0-rc.7`.

## 1. Pinned write seams (from installed rc.7 sources)

| Seam | Source | Signature / shape |
| --- | --- | --- |
| User message shape | `dsh-llm/lib/types/message.d.ts` | `Message { id: MessageId; role; content: ContentBlock[]; source: MessageSource }`; `UserMessage extends Message { role:'user' }` |
| Stable message identity | `dsh-llm/lib/types/brand.d.ts` | `MessageId = Branded<'MessageId'>`; `MessageId(id)` |
| Message creation | `dsh-llm/lib/types/message.d.ts` | `createUserMessage({ content, source })` mints + freezes a **fresh stable `id`** (never caller-supplied) |
| Text block | `dsh-llm` `ContentBlock` | `{ type: 'text', text: string }` (text-only TB0) |
| Idle Send / Steer | `dsh-agent-loop/lib/types/agent.d.ts` | `send(message: UserMessage, target: InboxTarget, wakeup: true)`; `followup(input)`; `steer(input)`; live agent via `ctx.agents.get(sessionId)` |
| Inbox admission | `dsh-agent/lib/types/inbox.d.ts` | `insert(target, message)` durably records; `inserted(message)`/`claimed(message, turn)` notifications; duplicate identity throws |
| Durable log read | `dsh-session-query` / `dsh-session` | `readSession(sessionId).events`; `user/message` events carry `message` with the stable `id` |
| Durable plugin storage | `dsh-storage` / `KvUnit` | version-stamped units; atomic durable per-call writes; `UNIT_NAME_RE` |

## 2. Message identity + no-replay model

- The **glasses generates an opaque `operationId`** per submit (UUID), kept client-side for retry/reconciliation.
- At **Send admission the plugin calls `createUserMessage`** → gets the stable `MessageId`. This id is the durable, client-generated identity downstream.
- The plugin **records the operation ledger row before touching the agent**:
  `{ operationId, messageId, sessionId, state:'pending', draftRevision, asOfSeqAtSend }` (KvUnit `ledger`).
- Then **idle Send**: `ctx.agents.get(sessionId)?.send(userMessage, target, true)`.
- **Only one live user-message can carry a given `MessageId`** (identity uniqueness enforced by dsh message creation + inbox duplicate-throw), so **two published user/message events with the same id is structurally impossible** — the zero-or-one property comes from DSH's identity model, and our job is to *verify* it, not only assert it.

## 3. Durable draft + ledger schema (dsh-storage KvUnit)

Plugin units under one storage unit name (matches `UNIT_NAME_RE`), versioned `1`:

**`drafts`** — one record per attachment/session (`key = sessionId`):
```
{ revision: number          // monotonic, plugin-authoritative
  content: string           // current frozen draft text (text-only TB0)
  committedSeq: number      // session asOfSeq at last plugin acknowledgment
  status: 'editing' | 'submitted' | 'cleared'
  lastOperationId?: string }
```
Mutations bump `revision`; the glass acknowledges `revision` exactly (no stale ack accepted).

**`ledger`** — one row per submit (`key = operationId`):
```
{ operationId: string
  messageId: MessageId
  sessionId: SessionId
  state: 'pending' | 'accepted' | 'rejected'
  draftRevision: number
  asOfSeqAtSend: number }
```

## 4. Route semantics (auth'd, /glasses/v1/*)

- `POST /glasses/v1/draft/mutations` — body `{ kind:'setText'|'ack', revision, text? }`:
  - `setText`: validate `revision === current+1` → bump, durable write, ack `D+1`.
  - `ack`: mark plugin acknowledged revision (idempotent for already-acked).
- `POST /glasses/v1/actions` — **Send only for TB0**:
  - body `{ kind:'send', operationId, draftRevision }`.
  - Reconciled submit: if ledger already has `operationId` with a durable `messageId`, **do not re-create the message** — go straight to acceptance check (exactly-one).
  - Else create the user message, write the ledger row (`pending`), and `send(…, wakeup: true)`; respond `202 { operationId, messageId, draftRevision }`.

## 5. Acceptance boundary (ambiguous-outcome reconciliation)

After a submit (or reconnect after a severed submit):

1. Read the session log via `sessionQuery.readSession(sessionId)`.
2. Find `user/message` events whose `message.id === messageId`.
3. Outcomes:
   - **exactly 1** → DSH accepted: ledger → `accepted`, draft → `cleared` (after authoritative admission is durable; asOfSeq covers the event).
   - **exactly 0** → not accepted: ledger → `rejected`, draft **retained** at the submitted revision; glass is told to keep/show the draft.
   - **≥ 2** → automatic failure (see §2: structurally impossible; guard raises a surfaced error + evidence capture).

The plugin must never re-send a `MessageId` it has already seen durable; re-sending is only ever a NEW `createUserMessage` when a fresh submit is explicitly intended.

## 6. Host-only zero-or-one test (disposable instance, as TB0 requires)

Reuse the TB0-H0 disposable harness (DSH_HOME under `/tmp`, port 3190, keyless test provider). Procedure:

1. Create a disposable session (host `session.create` RPC).
2. Authenticated `/bootstrap` → state + draft empty.
3. `setText` mutation → `/actions send {operationId:A, revision}` → **deliberately sever the glasses connection immediately after transport acceptance** (before observing the turn).
4. Reconnect → `/bootstrap` → reconcile `ledger[A]` against the session log:
   - assert user/message events carrying `messageId[A]` ∈ {0, 1};
   - if 1 → draft cleared, exactly one durable user message; if 0 → draft retained, zero user messages.
   - assert **never 2**.
5. Plugin restart → reconstruction: draft + ledger survive (KvUnit), bootstrap history identical.

Merge gate for `tb0/host-write`: the automated zero-or-one reconciliation test above passes (and the two-directional 0/1 branches are both exercised).

## 7. Out of scope for this slice

`steer` (TB0.1), `interrupt`/cancel of a turned agent, image/photo blocks, Voice/Morse, multiple tabs, production pairing/Funnel, `Last-Event-ID` wire resync (bootstrap-first), glass-side UI.

## 8. Delivery

Commit the write implementation + this contract + evidence, on `tb0/host-write`; report exact commit, test results (both 0 and 1 branches), and residuals to the thread before merging.
