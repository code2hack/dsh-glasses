# M1 (#28) implementation plan — stream and resynchronize one session exactly once

```text
PLAN_SOURCE = CHATGPT
PLAN_REQUEST = dsht28-plan-1
Date           = 2026-08-22
Repo           = code2hack/dsh-glasses
Milestone      = M1
Ticket         = #28
Admission base = 6ac06af4a06f1547d26bfe822d6a5b81aef8c64b (origin/main after merged #27 / PR #48)
Branch         = workflow/ticket-28
Worktree       = /home/code2hack/Projects/glasses/dsh-glasses-28
```

This is the durable implementation contract for Ticket #28. It was produced by
the project's first-line expert (ChatGPT / Sensei project session) before any
production edit, per AGENTS.md §11. It extends — never rewrites — the accepted
#27 read-only single-attachment contract (SPEC §§3, 7, 20, 22, §25 M1).

## Ticket scope (from the Ticket body)

What to build: extend the single attached session through live projection,
bounded history paging, following/history-reading behavior, and deterministic
reconnect so output remains current without duplication or blind replay.

Acceptance criteria:

- **AC1** Each connection uses a fresh epoch and monotonically ordered stream
  sequence based on an installed complete snapshot.
- **AC2** Live assistant, tool, status, request, error, and image projection
  blocks update the active session without duplicating durable history.
- **AC3** Following mode stays pinned to new output; history-reading mode
  preserves the viewport and exposes an unread indication.
- **AC4** Older history pages prepend with stable identity and do not reorder
  or duplicate already installed blocks.
- **AC5** Gaps, overflow, malformed deltas, server-generation changes, and
  stale bases disable writes and force a complete atomic resynchronization.
- **AC6** Reconnect and client restart restore the same committed history
  exactly once and never replay a semantic operation.

Out of scope (do not build): release packaging/signing/publication; human
controls/manual visual judgment/physical input; broad safeguards; multiple
attachments/tabs; **all write operations** (draft mutation / Send / Steer /
Interrupt / request resolution stay quarantined and unregistered).

## Hard-problem warnings and locked resolutions (frozen before T28-01)

### 1. Do not use DSH history `seq` as the live transport sequence

#27 deliberately made `snapshot.streamSequence === snapshot.history.asOfSeq`
because there was no live-delta domain yet. #28 KEEPS that equality **at
snapshot installation**, but defines live ordering as a **connection-epoch
local dense transport sequence**. The durable DSH source sequence `event.seq`
remains the durable-history watermark and is carried on every delta.

```text
snapshot:              connectionEpoch = E   streamSequence = N   history.asOfSeq = N
first delta:           connectionEpoch = E   baseStreamSequence = N   streamSequence = N+1   event.seq = <durable DSH seq>
next delta:            baseStreamSequence = N+1   streamSequence = N+2   event.seq = ...
```

Only `baseStreamSequence === streamSequence - 1` (exact) is accepted. A
`+2`/backwards/duplicate transport sequence is a fault → write-disabled →
complete atomic resync. SSE `id:` may equal the transport `streamSequence` for
diagnostics only; it **must not** become a replay cursor (no Last-Event-ID
resume). Reconnect always goes back through a full bootstrap with a fresh epoch.

### 2. Close the bootstrap→stream race (the highest-risk correctness item)

Never open the stream and cold-read independently of it, and never let the
client "bridge" a gap between the installed snapshot tail and the first live
delta. The server uses a **subscribe-buffer-catch-up-live** protocol per
connection epoch:

```text
subscribe to adapter.observeSession(sessionId) first
  -> bounded in-memory buffer for that epoch (256 events / 512 KiB)
  -> cold-read the session tail via adapter.readProjectionAfter(baseHistoryAsOfSeq)
  -> merge/dedupe by durable event.seq
  -> deliver the snapshot base (hello) then the ordered deltas
  -> if the tail read or the buffer cannot close cleanly -> resync-required + close
```

The client must not install any delta unless it follows **exactly** the
installed snapshot's transport sequence AND carries a compatible durable
`event.seq` (greater than installed `history.asOfSeq`). Anything else is a
fault → stop stream → full resync.

### 3. New adapter read seams; keep `readProjectionPage(cursor)` rejecting

Add **bounded predecessor/successor** reads to the project-owned adapter
(`readProjectionBefore(sessionId, { beforeSeq, limit })` and
`readProjectionAfter(sessionId, { afterSeq, limit })`). These are what paging
(#28-06) and catch-up (#28-05) use. `readProjectionPage(sessionId)` stays
cursorless and continues to reject a passed cursor (frozen #27 contract).
Every read validates monotonic unique seq and canonical projection before
returning; malformed pages are rejected, never normalized.

### 4. Older history pages are non-backward — never feed pages through the reducer backwards

`GET /glasses/v1/history` returns older blocks in **ascending** durable seq
order bounded by `beforeSeq`. The client **prepends** the page and rebuilds the
chronological render; it never applies an older page on top of newer state
("never feed pages through the reducer in reverse"). Stable block identities
(`message:u-*`, `message:a-*`, `partial:<turn>:<step>`, typed block ids) make
prepend dedup-safe: a block that already exists must be skipped, never
re-inserted, never reordered. Page prepend must NOT change following/reading
state and must NOT set unread.

### 5. AC5 "writes disabled" has no write endpoints in M1 — its operational meaning

M1 is read-only (all mutation capabilities false; `/draft/mutations`,
`/actions` unregistered → 404; draft/actions POST count stays 0). For #28 the
AC5 fault path is therefore a **write-eligible=false, syncState=resyncing,
stream stopped, "resyncing-readonly" state**: no live delta may be
incrementally merged onto the now-stale base, and the client MUST complete a
fresh atomic bootstrap (new epoch) before accepting anything again. Explicit
negative assertions record that no mutation/action POST fired and no partial
delta installed.

### 6. Deterministic real live `session/event` for the disposable integration (T28-11)

The supported pinned rc.2 path that BOTH durably commits an event AND emits the
real `session/event` is the documented `Session.append()` seam:
`ctx.sessions.get(sessionId).append(type, data, { surfaceOp: 'append' })`.
Verified against pinned rc.2 sources: `append()` writes the event to
`session.events`, clears the snapshot cache, and invokes the `session/event`
firehose (which is exactly what `adapter.observeSession` subscribes to), and
persistence plugins flush it to the zstd log — collectively the durable+live
emission. A **test-only fixture plugin** loaded only into the disposable
profile exposes a narrow append endpoint for the runtime test. No production
`/inject-test-event` backdoor. Preferred order for T28-11: (1) normal rc.2
session operation with a deterministic provider; (2) the pinned
`Session.append` seam via a test-only fixture plugin; (3) otherwise checkpoint
ChatGPT.

### 7. Projection vocabulary must be canonical and typed, never raw

Extend (not replace) projection.js to produce a single canonical projected
event shape used identically by snapshots, paging, catch-up, and live. Typed
projection block families required by AC2: assistant, tool, status, request,
error, image, plus the existing user/message and assistant partial/final.
Rules: stable block ids; durable DSH message ids preferred, deterministic
seq-based fallback only when DSH gives none; final assistant event replaces the
matching partial exactly once; no raw provider/storage/internal payload;
images get a safe canonical identity (attachment reference, not raw base64 bytes
unless the protocol defines it); unknown/forward shapes degrade deterministically,
never duplicated.

### 8. Real rc.2 event shapes (verified from pinned sources `dsh-session` / `dsh-llm`)

Surface events (`user/message`, `assistant/message`, `tool/result`) carry
`surfaceOp: 'append' | {op:'replace',start,end}`. Log-only events: `turn/start`,
`turn/end`, `step/start`, `step/end`, `assistant/chunk`, `tool/call`,
`todo/write`, `request/header`, `request/context`, `session/end-seed`.
There is **no** dedicated status/error/image event type: those are projection
categories derived from durable events (e.g. status from `turn/start`/`turn/end`;
request from `request/header|context`; error from `turn/end` failure / tool
failure / `assistant/message.interrupted`; image from `ImageBlock` content).
`Message` = `{id, role, content[], source}`; `ModelMessageSource` carries
`provider`/`model`; `ToolMessageSource` carries `callId`. Fixture/append data
must match these shapes because `Session.append` runtime-validates JSON.

## Locked #28 wire additions

### Stream hello (first frame after connecting the authenticated stream)

```json
{
  "protocolMajor": 1,
  "serverGeneration": "opaque",
  "connectionEpoch": "opaque",
  "attachmentId": "opaque",
  "attachmentGeneration": 1,
  "sessionId": "selected attached session",
  "baseStreamSequence": 42,
  "baseHistoryAsOfSeq": 42
}
```

It must agree exactly with the installed snapshot before the client accepts any
delta. `baseStreamSequence === snapshot.streamSequence` and
`baseHistoryAsOfSeq === snapshot.history.asOfSeq`.

### Projection delta (every live event frame)

```json
{
  "protocolMajor": 1,
  "serverGeneration": "opaque",
  "connectionEpoch": "opaque",
  "attachmentId": "opaque",
  "attachmentGeneration": 1,
  "sessionId": "selected attached session",
  "baseStreamSequence": 42,
  "streamSequence": 43,
  "event": { "seq": 57, "type": "...", "...": "canonical projection only" }
}
```

SSE `id:` may equal `streamSequence`. The transport sequence is
connection-epoch local; `event.seq` is the durable DSH source sequence.

### History page

```text
GET /glasses/v1/history?epoch=<connectionEpoch>&beforeSeq=<exclusive durable source seq>&limit=<bounded>
```

Response is bound to the same protocol major / server generation / connection
epoch / attachment identity+generation / snapshot base history watermark, in
ascending durable sequence, with `hasMore`/`nextBeforeSeq` when another older
page exists; an empty older page is explicit, never an error. No raw DSH
payload and no unrelated-session content.

## Snapshot capability evolution (only what #28 requires)

Keep the accepted outer snapshot. Change capabilities so the one-attachment
read-only surface advertises live deltas:

```text
historyRead      = true
liveUpdates      = true     (NEW: live stream is now advertised)
draftMutations   = false
send             = false
steer            = false
interrupt        = false
resolveRequest   = false
drafts           = []
streamSequence   = history.asOfSeq at snapshot creation (kept)
```

The server keeps a small **ephemeral issued-snapshot-base record keyed by
`connectionEpoch`**: `{ epoch, serverGeneration, attachmentId,
attachmentGeneration, sessionId, baseStreamSequence, baseHistoryAsOfSeq,
streamClaimed? }`. Protocol/fencing state only — never durable user state.
Pure validation/build helpers for hello/delta/page responses live in a new
`lib/live-sync.js` (recommended) rather than in HTTP handlers.

## Ordered to-do list

### T28-01 — Freeze the #28 contract and verify the #27 baseline

- Commit this ChatGPT plan as the Ticket's durable implementation contract
  (`docs/dev/plan-m1-28-chatgpt-2026-08-22.md`), recording the admitted base,
  PLAN_SOURCE=CHATGPT, PLAN_REQUEST=dsht28-plan-1, the sequence law, locked
  wire contracts, AC matrix, and negative assertions.
- Run the accepted #27 baseline gate to confirm a green foundation:
  `node plugins/dsh-glasses-plugin/test/dsh-compat.test.mjs` (with DSH_BIN),
  `snapshot-contract.test.mjs`, `projection.test.mjs`, `dsh-adapter.test.mjs`,
  `npm --prefix apps/glasses-android ci` + client suites.
- AC: foundation for AC1–AC6. Risk: LOW.
- Checkpoint to ChatGPT before T28-02.

### T28-02 — Canonicalize the complete M1 live projection vocabulary

Extend—not replace—`lib/projection.js` and the client C0 folding model to
cover the renderable categories required by AC2: assistant, tool, status,
request, error, image, plus existing user/message and assistant
partial/final. First fixture the real pinned rc.2 shapes (see hard-warning 8).
Rules: stable block ids; one canonical event shape shared by snapshots,
paging, catch-up, and live; final assistant event replaces matching partial
exactly once; typed blocks; raw provider/storage/internal payload omitted;
image projection has a safe canonical identity. Add a fixture proving replay of
the same complete ordered history yields the same ordered render-block ids.

- Files: `plugins/dsh-glasses-plugin/lib/projection.js`,
  `plugins/dsh-glasses-plugin/test/projection.test.mjs`,
  `apps/glasses-android/app/src/main/assets/c0-core.js`,
  `apps/glasses-android/test/c0-core.test.mjs`, optional synthetic fixtures
  under `plugins/dsh-glasses-plugin/test/fixtures/`.
- Commands: `node plugins/dsh-glasses-plugin/test/projection.test.mjs`;
  `node apps/glasses-android/test/c0-core.test.mjs`.
- AC: AC2, AC4, AC6. Risk: HIGH — stop at the checkpoint if any required
  category cannot derive a safe canonical identity.

### T28-03 — Extend the DSH adapter with bounded predecessor/successor reads

Add `readProjectionBefore(sessionId, { beforeSeq, limit })` and
`readProjectionAfter(sessionId, { afterSeq, limit })` to `lib/dsh-adapter.js`,
validating monotonic unique seq and canonical projection before returning.
`readProjectionPage(cursor)` keeps rejecting cursors (#27 frozen contract).
- Files: `plugins/dsh-glasses-plugin/lib/dsh-adapter.js`,
  `plugins/dsh-glasses-plugin/test/dsh-adapter.test.mjs`,
  `plugins/dsh-glasses-plugin/test/dsh-adapter-runtime.test.mjs`.
- Commands: `node plugins/dsh-glasses-plugin/test/dsh-adapter.test.mjs`;
  `DSH_BIN=... node plugins/dsh-glasses-plugin/test/dsh-adapter-runtime.test.mjs`.
- AC: AC1, AC4, AC5, AC6. Risk: HIGH — upstream isolation boundary.

### T28-04 — Upgrade snapshot capability and introduce issued-base/stream wire contracts

Only the change AC2/AC5 require: `liveUpdates=true`; mutation caps stay false;
`drafts=[]`. Add the ephemeral issued-snapshot-base record keyed by
`connectionEpoch`, and pure `lib/live-sync.js` validation/build helpers for
hello/delta/page. Update server+client mirror of the wire law.
- Files: `lib/snapshot.js`, `lib/index.js`, new `lib/live-sync.js`,
  `test/snapshot-contract.test.mjs`, new `test/live-sync-contract.test.mjs`,
  `assets/snapshot-core.js`, `test/snapshot-core.test.mjs`.
- Prove: fresh bootstrap epochs remain unique; same server generation yields
  fresh epoch per connection; exactly-one-attachment invariants preserved;
  `liveUpdates===true`; mutation caps still false; hello/delta/page law
  acceptance + rejection codes.
- AC: AC1, AC5, AC6. Risk: MEDIUM-HIGH.

### T28-05 — Replace legacy SSE with race-free M1 live streaming

Implement the subscribe-buffer-catch-up-live server path (hard-warning 2) and
the client native-bridge openStream(connectionEpoch, baseStreamSequence)
contract. Enforce buffer bounds (256 events / 512 KiB); overflow → resync +
close. Build `plugins/dsh-glasses-plugin/test/stream.test.mjs` (pure/server
level): hello agreement, ordered deltas, exact base+1 advance, wrong
base/gap/duplicate/backwards/epoch/generation/overflow. Client consumes only
through the #28 sync reducer.
- AC: AC1, AC2, AC5, AC6. Risk: VERY HIGH — bootstrap/SSE race.

### T28-06 — Add bounded authenticated history paging

Register only one read endpoint `GET /glasses/v1/history` (no generic
session/cursor API). Server derives session/attachment/generation from the
issued-epoch record, not from arbitrary client session ids. Response bound to
protocol major/generation/epoch/attachment/watermark; ascending; hard bound;
`hasMore`/`nextBeforeSeq`; empty page explicit.
- Files: `lib/index.js`, new `plugins/dsh-glasses-plugin/test/history-paging.test.mjs`.
- Prove: page < requested beforeSeq; ascending; hard response bound; empty
  page; first/last page; stale epoch rejected; malformed limit/before rejected;
  unauthorized rejected; no unrelated-session leak; original cursorless
  `readProjectionPage` still rejects cursors.
- AC: AC4, AC5, AC6. Risk: MEDIUM.

### T28-07 — Build the pure client synchronization reducer (c0-core)

Add to `assets/c0-core.js` a canonical installed **source-seq keyed event
timeline** plus these pure operations: `installCompleteSnapshot`,
`acceptStreamHello`, `applyStreamDelta`, `prependHistoryPage`,
`enterFollowing`, `enterHistoryReading`, `markResyncRequired`, `reanchor`.
Delta/paged install = validate-all-fences → build detached → atomic install.
Installed durable source seqs are deduplicated once; reassembly is strictly
chronological. Never feed older pages backwards through the reducer.
- Files: `apps/glasses-android/app/src/main/assets/c0-core.js`,
  `apps/glasses-android/test/c0-core.test.mjs`,
  `apps/glasses-android/test/snapshot-core.test.mjs`.
- AC: AC1–AC5. Risk: HIGH.

### T28-08 — Implement following/history-reading + viewport preservation + stable reanchoring

Implement SPEC §20 directly: exactly two presentation states. Following stays
pinned; after accepted new output render then pin to bottom; unread=false.
Reading history activates when the viewport leaves the following threshold;
capture a stable anchor (primary blockId; source seq; pixel offset from
viewport top); new output mutates model/render but restores the anchor; set
unread=true and unreadFromStreamSequence; do not jump to bottom. Do not expose a
misleading numeric unread count for assistant chunks — a "New output"
indication/watermark is semantically safer. Page prepend must preserve the same
anchor and must not set unread. Reanchor preference: same stable block id →
known partial→final replacement mapping → nearest surviving block by source
sequence → deterministic fallback. On full resync, preserve the anchor if it
still exists, else deterministic fallback (never positional guessing).
- Files: `assets/c0-core.js`, `assets/app.js`, `assets/app.css`, c0-core tests.
- AC: AC3, AC4. Risk: MEDIUM-HIGH.

### T28-09 — Wire the real client stream, paging, and full resynchronization

Remove the #27 SSE no-op publish path; open stream(epoch, snapshot.streamSequence);
verify hello; accept exact ordered deltas; on any fault → stop stream →
`syncState=resyncing`, `writeEligible=false`, bounded trace → fresh bootstrap →
install atomically → open a NEW epoch stream. If bootstrap fails, retain the
last valid screen stalled/readonly. Debug state exposes nonsecret sync facts
(epoch/stream/history watermarks, following/reading, unread, resync status,
writeEligible). Paging loads older pages on demand and prepends safely.
- Files: `assets/app.js`, `assets/app.css`, `assets/index.html` if needed, client DOM tests.
- Commands: `cd apps/glasses-android && npm test`.
- AC: AC1–AC6. Risk: HIGH.

### T28-10 — Dedicated fault-injected stream/recovery acceptance suite

New `apps/glasses-android/test/m1-stream-faults.test.mjs` using the existing
DOM/native-bridge harness. Each scenario starts from a known installed snapshot
and injects one fault. Mandatory legs: missing transport sequence; +2 stream
gap; duplicate stream sequence; backwards stream sequence; wrong
baseStreamSequence; malformed JSON; malformed canonical projected event; wrong
connection epoch; wrong server generation; wrong attachment generation;
source-seq backwards/conflict; overflow signal; stream close/network
disconnect; stale history-page response after resync. For every leg assert:
faulting delta did not partially install; stream stopped; syncState != ready;
writeEligible == false; no mutation/action POST; fresh bootstrap required; new
epoch != old epoch; complete snapshot replaces state atomically; old-epoch
delayed delta rejected; final canonical block ids have no duplicates. Also test
generation replacement: old-generation delta → reject/resync; new complete
generation snapshot → accepted atomically.
- AC: AC1, AC3, AC5, AC6. Risk: MEDIUM.

### T28-11 — Real disposable rc.2 live/disconnect/restart integration

New `plugins/dsh-glasses-plugin/test/m1-live-runtime.test.mjs` plus a test-only
fixture plugin (see hard-warning 6). Scenario set (deterministic, unattended):
- A: bootstrap installs a complete snapshot; fixture-driven live output arrives
  through the real SSE stream and updates the installed state exactly-once with
  no duplication of durable history.
- B: disconnect (stream close) → client stops live, syncState != ready, retained
  screen intact, no reuse of the old epoch.
- C: reconnect → fresh bootstrap (new epoch) → same committed history restored
  exactly once → resynchronized live resumes.
- D: restart (fresh client, same durable log) → restore same committed history
  exactly once; no blind replay of any semantic operation.
- E: exact duplicate counting — every durable finalized sentinel appears with
  stableBlockIdCount==1; every expected durable source event installed once.
Hard gate: if rc.2 cannot generate real durable+live events without the
fixture plugin, checkpoint ChatGPT before continuing.
- AC: AC1, AC2, AC4, AC5, AC6. Risk: VERY HIGH.

### T28-12 — Extend narrow-edge E2E + debug-client assertions

Extend `test/m1-narrow-edge.test.mjs` + `dev/glasses-dev-proxy.mjs` +
`apps/glasses-android/test/dom-harness.mjs` so the full chain (real disposable
rc.2 → real plugin → narrow proxy → production client) renders synthetic
content exactly once, streams live deltas through the same chain, pages older
history, preserves following/reading, and demonstrates resync after injected
faults. `npm --prefix apps/glasses-android ci` if harness deps change.
- AC: AC1–AC6. Risk: MEDIUM-HIGH.

### T28-13 — Build and verify the debug APK

```bash
cd apps/glasses-android
/home/code2hack/Android/gradle-9.1.0/bin/gradle :app:assembleDebug --no-daemon
sha256sum app/build/outputs/apk/debug/app-debug.apk
```

Verify packaged client assets are byte-identical to committed source for
`app.js c0-core.js snapshot-core.js index.html app.css` (and any added M1
asset). Automated debug-client (native boundary) assertions: stream state
visible; following/history-reading state; unread; epoch/stream/history
watermarks; resync status; `writeEligible=false`. No physical-Rokid claim.
- AC: AC3, AC5, AC6. Risk: LOW-MEDIUM (build path proven by #27).

### T28-14 — Freeze production head, run the complete acceptance gate, write durable evidence

Freeze one production-code head `P`. After `P`: no production-code changes.
Run only the existing #27 regressions plus the new #28 suites required to
establish the Ticket validation (not general system/hardware qualification):
reducer tests (sequence/paging/following/history-reading/stable reanchoring),
fault-injected stream suite, disposable-DSH live/disconnect/restart suite,
narrow-edge E2E, debug-client assertions, debug APK build. Write durable
evidence under `docs/evidence/`:
`m1-28-acceptance-2026-08-22.json` (machine-readable source of truth) +
`m1-28-acceptance-2026-08-22.md` (human summary) + `m1-28-apk-build-2026-08-22.md`.

Evidence JSON shape (schemaVersion 1, exact base + tested head + branch +
dsh pin/integrity + runtime+apk facts + scenario results + explicit negative
assertions + provenance). No bearer token, disposable session id, private
content, or provider credentials. Evidence is tied to the exact tested
implementation (base AND head). Then request the ChatGPT-first exact-head
review (AGENTS.md §14).
- AC: AC1–AC6. Risk: MEDIUM.

## End-state AC matrix

| Acceptance criterion | Primary implementation | Required proof |
|---|---|---|
| AC1 fresh epoch + monotonic stream sequence on installed snapshot | T28-04, 05, 07, 09 | live-sync + stream + narrow-edge |
| AC2 live assistant/tool/status/request/error/image without duplicating durable history | T28-02, 05, 07, 11 | projection+c0 replay + live runtime |
| AC3 following pinned / history-reading viewport + unread | T28-07, 08, 09, 12 | c0 + DOM + debug-client |
| AC4 older pages prepend stably, no reorder/duplicate | T28-03, 06, 07, 11 | paging+c0+live runtime |
| AC5 gaps/overflow/malformed/generation/stale-base → write-disabled + atomic resync | T28-04, 05, 07, 09, 10 | fault suite + stream + resync |
| AC6 reconnect+restart restore exactly once, no semantic replay | T28-05, 09, 10, 11, 12, 13 | fault + live runtime + restart + APK |

## Explicit negative assertions that must appear in durable evidence (machine-readable)

```text
rawDshPayloadCrossedGlassesEdge          = false
unattachedSessionObserved                = false
mutationCapabilityEnabled                = false
draftRouteRegistered                     = false
actionRouteRegistered                    = false
semanticMutationPostCount                = 0
semanticActionPostCount                  = 0
pendingLegacyOperationReplayed           = false
semanticOperationIdCreatedForReconnect   = false
sseLastEventIdReplayUsed                 = false
oldConnectionEpochAcceptedAfterResync    = false
oldServerGenerationDeltaAccepted         = false
deltaAcceptedWithWrongBase               = false
deltaAcceptedAcrossSequenceGap           = false
malformedDeltaPartiallyInstalled         = false
overflowSilentlyDroppedEvents            = false
incrementalMergeOntoKnownStaleBase       = false
historyPageReorderedInstalledBlocks      = false
historyPageDuplicatedSourceSeq           = false
historyPageDuplicatedStableFinalBlockId  = false
historyPageChangedUnreadState            = false
readingHistoryViewportMovedOnLiveAppend  = false
followingFailedToPinNewOutput            = false
finalAssistantRenderedTogetherWithSupersededPartial = false
providerUrlExposedInProjection           = false
filesystemPathExposedInImageProjection   = false
rawImageBase64ExposedWithoutProtocol     = false
bearerTokenPresentInClientDebugState     = false
releaseBuildProducedOrClaimed            = false
physicalHardwareBehaviorClaimed          = false
manualAcceptanceRequired                 = false
```

Positive exact-once records must accompany the negatives, e.g. every durable
finalized sentinel `stableBlockIdCount == 1` and every expected durable source
event `installedSourceSeqCount == 1`.

## Files / contracts that must NOT be redesigned by #28

- SPEC.md (normative product behavior, §§3/7/20/22/25).
- Single-attachment identity model: opaque `attachmentId`, positive generation,
  `attachmentSetRevision`, one attachment, `state`/capabilities contract.
- `buildCanonicalSnapshot` architecture and the accepted outer snapshot
  envelope (only the `liveUpdates=true` capability change is allowed).
- The atomic `stageSnapshot -> installSnapshot` client structure.
- The server/client mirror wire law (extend, do not fork a second law).
- The project-owned DSH adapter boundary (SPEC §5) — no DSH internals leak.
- `readProjectionPage()` cursorless rejection contract.
- Stable message/partial block-identity laws (unless a genuine correctness bug
  is found and checkpointed).
- Debug provisioning / token ownership / auth model.
- DSH revision pin `@deepseek-ai/dsh@0.1.1-rc.2` + seam list in dsh-compat.json.
- Dormant TB0 write implementation; `/draft/mutations` and `/actions`
  quarantine (stay unregistered / 404); `host-write-recovery.test.mjs`.
- `dev/d0-runtime.mjs` historical rc.7/vLLM harness; historical TB0 evidence.
- Multiple-tab/attachment management, Navigation/Input physical controls,
  Photo/Voice/Morse, release packaging/signing, Funnel/security outside scope.

## Authority/conflict disposition

No required conflict with durable authority: the sequence law keeps the
accepted snapshot equality while introducing a connection-epoch-local transport
sequence (allowed by SPEC §7.1 epochs and the #27 plan's explicit deferral of
live deltas to later work). If any deviation is needed, flag it to ChatGPT for
correction rather than silently changing contract.

```text
Plan verdict: READY. T28-01 may begin.
After every completed T28 item, send the required ChatGPT progress checkpoint.
```
