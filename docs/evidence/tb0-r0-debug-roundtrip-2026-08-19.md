# TB0-R0 — debug user-message admission round trip (real glasses)

**Status:** normal leg PASS and response-loss leg PASS on the real Rokid.
**Outcome:** no durable `assistant/message` exists in the disposable DSH log
(0 events; minimal/ idle agent produced no text reply), so the claim is scoped as
**debug user-message admission round trip**; the zero-or-one Send/recovery proof
stands. A stronger "complete text round trip" claim is NOT made.
**Branch:** `tb0/r0-debug-roundtrip` (stacked on `tb0/input-qualification`
`472b436`; retarget to `main` after PR #7 settles).
**Host/device:** spark worker + u4090 USB ADB; Rokid serial `1906092617103125`,
firmware `Rokid/glasses/glasses:12/SKQ1.240613.001/1.23.009-20260725-150201:user/release-keys`.
**Product route:** Rokid → spark `100.92.81.33:3200` narrow `/glasses/v1/*` proxy
→ disposable DSH `127.0.0.1:3190` (session
`<disposable-session-id>`).

## Provenance

**SYNTHETIC_DEBUG_CONTROL**: every injected round-trip action was initiated by
the operator through WebView CDP and the path-restricted native
`GlassesBridge.fetch()` interface. `debugSemanticControl()` supplied optional
BEGIN/END trace markers only; it never invoked a product reducer, mutated the
draft, or submitted a message. All durable-write behavior was driven through the
real `/glasses/v1/draft/mutations` + `/glasses/v1/actions` endpoints with
explicit operation IDs.

## Normal round trip (passed)

IDs used:
- `mutationId = r0-mut-mt01qwbj-5wltl17f`
- `sendId    = r0-send-mt01qwbj-5wltl17f`
- text: `Reply with exactly: glasses tracer passed`

| Check | Result |
| --- | --- |
| before bootstrap | 200; `draft.revision=0`; `writeState=ready`; 12 history events |
| mutation first | 200 `{ok:true, revision:1}` (expect `rev0+1`) |
| mutation retry (same op+body) | 200 `{ok:true, revision:1}` → stored/idempotent |
| send retry poll | `send1` 202 `state=unknown` (dispatch in flight) → `send2` 200 `state=accepted`, same `operationId` for every poll |
| SSE through glasses stream | history via app bootstrap shows `turn/start, agent/inbox/spliced, step/start, user/message, step/end, turn/end` (asOf 12→18) — delivered through the glasses SSE/projection path. No `assistant/message` event was produced by the idle agent (0 durable assistant messages) |
| final bootstrap | `draft.revision=2 == acknowledged mutation revision 1 + 1`; `text=""`; `locked=false`; `writeState=ready` |
| **exactly-one durable** | from the COMPLETE disposable DSH log (`<disposable-home>/sessions/<workspace>/<disposable-session-id>/session.jsonl.zstd`): exactly **1** `user/message` with `source.kind=user` `source.rpcId=r0-send-mt01qwbj-5wltl17f` (seq 16). The only other file match is a positional `agent/inbox/spliced` (seq 12) with no rpcId — not a second message. |
| plugin operation state | `operations[r0-send-…] = {state:"accepted", frozenText:"Reply with exactly: glasses tracer passed"}`; `draft {revision:2, text:""}` |
| restart reconstruct | force-stop + relaunch → bootstrap 200, `draft{revision:2,text:"",locked:false}`, `writeState=ready`, no re-Send; durable count for the sendId still **1** |

No duplicated durable message; no client-visible rejection; no text/timestamp
matching used (verification is rpcId-exact over the full log).

## Response-loss leg (passed)

A test-only downstream-response delay wrapper ran on spark **private port 3201**
(`/tmp/r0-delay-proxy.mjs`, ESM, forwards `/glasses/v1/*` to the plugin
`127.0.0.1:3190`; for `/actions` it awaited the full upstream response, wrote a
local marker `/tmp/r0-delay-marker.log` (operationId only — no credentials), then
delayed the downstream response ≥15 s). The app was temporarily pointed at
`http://100.92.81.33:3201`.

IDs: `mutationId = r0-rl-mut-mt01wsbq-wxz5lcyl`, `sendId = r0-rl-send-mt01wsbq-wxz5lcyl`,
text identical.

- baseline `draft.revision=4` (note: two stray mutation-only calls from an
  operator diagnostic re-run bumped 2→3→4; same text, never Sent, no durable
  effect; recorded for honesty); mutation → `revision=5`.
- Send fired (not awaited). Upstream completed + dispatched durably
  (`user/message` **seq 23**, `source.rpcId=r0-rl-send-…`), op entered `unknown`
  (dispatch admitted, settlement pending), draft locked. App was force-stopped
  before receiving any response (downstream lost).
- Restart: bootstrap reconcile found the durable message (count 1) →
  `draft {revision:6, text:"", locked:false}`, `writeState ready` — accepted
  history reconstructed with **no re-Send**.
- Retry with the **same sendId + same request body** through the delay wrapper:
  HTTP 200 `{ok, operationId:r0-rl-send-…, state:"accepted", reconciled:true}` —
  stored accepted, no new prompt.
- Exactly-one durable: full log has exactly **1** `user/message` with
  `source.rpcId == r0-rl-send-…` after restart + retry. Plugin operations:
  `r0-send-…` and `r0-rl-send-…` both `accepted`.

## Operator note

Two `r0-rl-mut-*` mutation-only entries (revisions 3,4) were created while
diagnosing the first B1 script run (same R0 text, never Sent, no durable
message); they demonstrate idempotent no-op mutations but are excluded from the
round-trip claims above. The delay wrapper is test-only (`/tmp`), holds no
credentials, and remains bound to private port 3201.
