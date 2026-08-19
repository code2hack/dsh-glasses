# TB0-R0 — debug semantic-control round trip (real glasses)

**Status:** normal round-trip PASS on the real Rokid; response-loss leg in progress.
**Branch:** `tb0/r0-debug-roundtrip` (stacked on `tb0/i0-input` `45e7eee`; retarget
to `main` after PR #6 merges).
**Host/device:** spark worker + u4090 USB ADB; Rokid serial `1906092617103125`,
firmware `Rokid/glasses/glasses:12/SKQ1.240613.001/1.23.009-20260725-150201:user/release-keys`.
**Product route:** Rokid → spark `100.92.81.33:3200` narrow `/glasses/v1/*` proxy
→ disposable DSH `127.0.0.1:3190` (session
`session-47d05b27-1ddb-49e9-89c2-648013b6bc1d`).

## Provenance

Every injected round-trip control below is **SYNTHETIC_DEBUG_CONTROL**: driven via
the app's debug seam `GlassesBridge.debugSemanticControl(name)` (DEBUG-gated,
bridge+JS notification trace only — it does NOT exercise a product reducer,
mutation, Send, or physical binding). All durable-write behavior was driven
through the real `/glasses/v1/draft/mutations` + `/glasses/v1/actions`
endpoints with explicit operation IDs.

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
| SSE through glasses stream | history via app bootstrap shows `turn/start, agent/inbox/spliced, step/start, user/message, step/end, turn/end` (asOf 12→18) — delivered through the glasses SSE/projection path |
| final bootstrap | `draft.revision=2 == acknowledged mutation revision 1 + 1`; `text=""`; `locked=false`; `writeState=ready` |
| **exactly-one durable** | from the COMPLETE disposable DSH log (`/tmp/dsh-tb0-home/sessions/--tmp-dsh-tb0-workspace--/session-47d05b27-…/session.jsonl.zstd`): exactly **1** `user/message` with `source.kind=user` `source.rpcId=r0-send-mt01qwbj-5wltl17f` (seq 16). The only other file match is a positional `agent/inbox/spliced` (seq 12) with no rpcId — not a second message. |
| plugin operation state | `operations[r0-send-…] = {state:"accepted", frozenText:"Reply with exactly: glasses tracer passed"}`; `draft {revision:2, text:""}` |
| restart reconstruct | force-stop + relaunch → bootstrap 200, `draft{revision:2,text:"",locked:false}`, `writeState=ready`, no re-Send; durable count for the sendId still **1** |

No duplicated durable message; no client-visible rejection; no text/timestamp
matching used (verification is rpcId-exact over the full log).

## Response-loss leg

(To be appended after the downstream-response-delay wrapper run on a separate
private port.)
