# TRACER_BULLET_TB0 — host write slice (tb0/host-write)

**Status:** amended contract; implementation + committed reproducible recovery test ALL PASS (2026-08-19).
**Date:** 2026-08-19
**Repo:** `code2hack/dsh-glasses` @ branch `tb0/host-write`
**Normative:** `SPEC.md` rev3 + `docs/TRACER_BULLET_TB0.md` (Send-only actions; Steer → TB0.1).

Evidence base: `docs/evidence/tb0-dsh-compat-2026-08-19.md` (incl. §TB0-H0 read proof and earlier write-slice records, which are superseded where this document differs).

## 0. Guiding guarantees (reviewed amendments)

The zero-or-one user-message guarantee comes from TWO plugin-side facts, not from a global DSH uniqueness assumption:

1. The plugin durably records dispatch state per operation id and **never calls `session.prompt` more than once for one operation id**.
2. Acceptance is settled only from **exact durable positive evidence** (`user/message.source.rpcId === operationId`); absence in one bounded read is never classified as rejection.

## 1. Pinned write seams (from installed rc.7 sources, runtime-verified)

| Seam | Source | Verified |
| --- | --- | --- |
| In-process admission | `ctx.apiProxy.sessions.prompt({ rpcId, payload: { sessionId, mode: 'queue', content } })` (`ApiProxy` provided as `ctx.apiProxy` by `@deepseek-ai/dsh-host-apiproxy`) | Yes |
| Prompt → durable correlation | `session.prompt` rpcId lands in the durable `user/message` as `message.source.rpcId` (`source: { kind: 'user', rpcId }`) | Yes (observed `rpc-corr-test-abc123`) |
| Operation identity | glasses `operationId` == DSH prompt `rpcId` == durable `user/message.source.rpcId` | Yes |
| Full-log reconciliation | `ctx.sessionQuery.readSession(sessionId)` returns the complete raw event log (scan from recorded pre-dispatch seq to tail) | Yes |
| Durable discard evidence | `agent/inbox/spliced` with `outcome: 'canceled'` carrying the inserted message | Inspect at runtime |
| Durable plugin storage | dsh-storage `json` backend KvUnit; unit/table names must match `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` | Yes (hyphens rejected) |

`MessageId` is **not** the external correlation identity. `createUserMessage` mints a fresh random id internally; it is used only incidentally and is not claimed as client-generated.

## 2. Single atomic state document

One KvUnit record per session (table `state`, key = sessionId), one durable write per transition:

```ts
interface Tb0WriteStateV1 {
  schemaVersion: 1;
  sessionId: string;
  draft: {
    revision: number;
    text: string;
    lockedByOperationId?: string;   // set on prepare, cleared on accepted
    lastMutationDigest?: string;    // for mutation idempotency (same op+same req)
  };
  operations: Record<string, Tb0Operation>;
}

type SendState = 'prepared' | 'dispatching' | 'accepted' | 'rejected' | 'unknown';

interface Tb0Operation {
  operationId: string;
  state: SendState;
  requestDigest: string;      // exact request body digest
  draftRevisionAtPrepare: number;
  preDispatchSeq: number;     // session asOfSeq recorded before dispatch
  lastError?: string;
}
```

Transitions are each **one** `putRecord` (atomic, durable):

- prepare (Send) and lock draft;
- settle `accepted` and clear draft (single write);
- settle `rejected` and retain draft;
- settle/preserve `unknown` and keep draft locked.

## 3. Admission (Send) — exact sequence

`POST /glasses/v1/actions` body:

```json
{ "kind": "send", "operationId": "uuid", "draftRevision": 3, "contentDigest": "sha256-of-request" }
```

1. Validate draft; if `draft.lockedByOperationId` is set and differs → `409 draft-locked`.
2. Load `operations[operationId]`:
   - exists with state `prepared | dispatching | accepted | unknown` → **do not call DSH again**; return the stored result (optionally re-running reconciliation for `prepared/dispatching/unknown` first).
   - exists with a different `requestDigest` → `409 operation-conflict`.
   - exists `rejected` → return stored rejected (no re-dispatch for TB0).
3. Persist `prepared` + draft lock (one write).
4. Persist `dispatching` (one write; records `preDispatchSeq`).
5. Call `ctx.apiProxy.sessions.prompt({ rpcId: operationId, payload: { sessionId, mode: 'queue', content: [{ type: 'text', text }] } })` **exactly once**.
   - Prompt error (pre-dispatch failure) → settle `rejected` (one write, draft retained).
   - `accepted: true` → **no draft clear yet**; operation stays `dispatching`.
6. Reconcile durable facts; settle atomically.

## 4. Reconciliation — never classify absence as rejection

Scan the complete session log from `preDispatchSeq` to the current tail; for each `user/message` event check exact `source.kind === 'user' && source.rpcId === operationId`.

- **positive durable user/message** → settle `accepted`; clear draft (release lock) — one write.
- **durable discard evidence** (`agent/inbox/spliced` with `outcome: 'canceled'` for the rpcId) → settle `rejected` — one write.
- **pre-dispatch failure** (prompt threw) → settle `rejected` — one write.
- **anything else (still queued, agent running, event beyond window, absent)** → keep `unknown` (or `prepared`/`dispatching`), draft retained + locked.

## 5. Draft mutation — simplified

`POST /glasses/v1/draft/mutations` body:

```json
{ "operationId": "uuid", "expectedRevision": 3, "mutation": { "kind": "replace", "text": "..." } }
```

Plugin increments to revision `expectedRevision + 1` (i.e. `expectedRevision` is the revision the client believes is current; plugin writes `current + 1`). No client ack mutation — the successful HTTP response plus later bootstrap snapshot acknowledge the authoritative revision.

Idempotency:

- same operationId + same request → return stored result;
- same operationId + different request → `409 operation-conflict`;
- stale `expectedRevision` → `409 revision-conflict` plus the authoritative draft in the body;
- unresolved Send lock (from `prepared/dispatching/unknown`) → `409 draft-locked`.

## 6. Fault tests to preserve (before PR ready)

1. **Crash after `prepared`, before dispatch** → zero DSH user/messages; draft retained; repeated `/actions` never re-dispatches.
2. **Crash after DSH admission, before settlement** → reconciliation finds exact `source.rpcId`; exactly one durable user/message; draft clears once.
3. **Response lost after durable settlement** → same operationId returns stored `accepted`; no new prompt.
4. **Concurrent identical `/actions`** → one prompt dispatch and one durable user/message.
5. **Operation-id conflict** → `409 operation-conflict`; no dispatch.
6. **Long response pushes the user/message outside the first bounded page** → reconciliation (full-log scan from preDispatchSeq) still finds it and never misclassifies as zero/rejected.

## 7. Out of scope for this slice

`steer` (TB0.1), interrupt/cancel, image/photo blocks, Voice/Morse, multiple tabs, production pairing/Funnel, `Last-Event-ID` wire resync (bootstrap-first), glass-side UI. Agent live-ness for admission is handled by the host `session.prompt` path (matches H0 residual; no `agent-unavailable` special case needed).

## 8. Delivery order

1. `docs: correct TB0 at-most-once Send contract` — this document.
2. `feat: add durable TB0 draft and Send` — Rework of `plugins/dsh-glasses-plugin` to the amended design.
3. `test: prove TB0 zero-or-one admission` — fault-injection tests on the disposable instance; evidence appended to `docs/evidence/tb0-dsh-compat-2026-08-19.md`; report exact commit + results before marking PR ready.
