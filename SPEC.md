# dsh-glasses Implementation Specification

**Status:** Draft normative implementation contract, revision 3  
**Date:** 2026-08-18  
**Repository:** `code2hack/dsh-glasses`  
**Products:** **dsh-glasses** = Rokid glasses client; **dsh-glasses-plugin** = DeepSeek Harness plugin and glasses server

This document is the current source of truth for the first production-capable `dsh-glasses` design. When implementation and this specification disagree, this specification wins until both are deliberately updated in the same commit.

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

---

## 1. Product contract

`dsh-glasses` connects Rokid AI glasses directly to DeepSeek Harness (`dsh`) without a phone companion application.

The system has two products:

1. **dsh-glasses** — a lightweight Android application on Rokid AI glasses. It is a native device/input shell around a dedicated glasses-optimized WebView. It captures Rokid controls and head posture, owns ephemeral cursor/selection/viewport state, and provides Camera2 and microphone access through a narrow native bridge.
2. **dsh-glasses-plugin** — a DSH plugin running on the user's dual-DGX-Spark workstation. It attaches selected DSH sessions, projects them into a glasses-specific protocol, owns committed drafts and media, performs authentication and synchronization, runs Voice recognition and Morse completion, and translates semantic glasses actions into DSH operations.

The first deployment target is the user's dual-Spark workstation, where a resident text-serving workload already consumes most accelerator memory. Every optional local model or runtime MUST coexist with that workload and MUST fail admission cleanly rather than destabilizing DSH.

### 1.1 Required capabilities

The first production-capable version MUST support:

- plugin-side attachment of selected existing DSH sessions;
- glasses-side switching among those attachments as tabs;
- retained and live session history;
- client-local Navigation and Input modes selected explicitly by `COMMAND`;
- a blinking word-sized cursor and rendered-HUD-line navigation;
- selection, copy, paste, replace, and cut;
- an invisible head-navigation mode for scrolling and tab switching;
- one plugin-authoritative committed draft per eligible input target;
- synchronized text, structured choices, image tokens, Voice slices, and Morse words;
- semantic Send, Steer, Interrupt, and request-resolution operations;
- Camera2 Photo capture with plugin staging and atomic draft commitment;
- server-host streaming Voice recognition with explicit audio-fence commitment;
- modal Morse entry with deterministic local completion and explicit whole-word commitment;
- exact mixed text/image ordering;
- explicit multimodal, text-only, and unknown-capability handling;
- deterministic reconnection, idempotency, and no blind replay.

### 1.2 Explicit non-goals

The initial product MUST NOT provide:

- a Fold6 or other phone companion application;
- a general-purpose browser or the stock DSH Web UI on the glasses;
- a terminal emulator, tmux client, ANSI parser, or shell surface;
- glasses-side session creation, deletion, archival, attachment, detachment, or reordering;
- a sidebar, taskbar, permanent tab strip, or desktop management UI;
- arbitrary access to unattached DSH sessions or unrestricted DSH APIs;
- provider credential or runtime management on the glasses;
- silent image dropping, OCR, captioning, placeholder substitution, or provider switching;
- durable full-resolution photo storage on the glasses after plugin staging;
- cloud ASR, Rokid cloud speech recognition, or Voice transcription by the conversational model;
- LLM-based Morse completion or learned personal completion history.

### 1.3 Poker-Dealer inheritance

`dsh-glasses` reuses these Poker-Dealer principles:

- source-neutral controls;
- `BEGIN`/`UPDATE`/`END`/`CANCEL` interaction lifecycles;
- exact target, generation, revision, and cursor fencing;
- server authority for committed content;
- complete snapshots and revisioned deltas;
- idempotent operation identities;
- no blind replay after unknown acceptance;
- committed-content preservation with ephemeral modal-state loss on forced exit.

It does not inherit Poker-Dealer's phone topology, card/pile boundary-driven Input entry, old operation meanings, or old Photo/Morse/ASR bindings.

---

## 2. Intended topology

```text
Dual DGX Spark workstation
┌──────────────────────────────────────────────────────────────────────┐
│ DeepSeek Harness                                                     │
│ ├─ authoritative session logs and live agents                        │
│ ├─ provider/model adapters                                           │
│ ├─ durable attachment service                                        │
│ └─ dsh-glasses-plugin                                                │
│    ├─ pinned DSH compatibility adapter                               │
│    ├─ attachment/tab manager                                         │
│    ├─ glasses projection reducer                                     │
│    ├─ committed draft and rich-clipboard store                       │
│    ├─ Photo staging/session manager                                  │
│    ├─ Voice runtime/session manager                                  │
│    ├─ Morse profile/completion/session manager                       │
│    ├─ device authentication and authorization                        │
│    └─ narrow glasses HTTP/streaming edge                             │
└───────────────────────────────▲──────────────────────────────────────┘
                                │
                                │ TLS through Tailscale Funnel
                                │ plus application authentication
                                │
┌───────────────────────────────┴──────────────────────────────────────┐
│ Rokid AI glasses                                                     │
│ dsh-glasses                                                          │
│ ├─ native Android shell                                              │
│ │  ├─ Rokid SDK/broadcast/KeyEvent/MotionEvent adapter               │
│ │  ├─ click/hold classifier                                          │
│ │  ├─ IMU/head-pose adapter                                          │
│ │  ├─ Camera2 and microphone lifecycle                               │
│ │  ├─ device credentials                                             │
│ │  └─ origin-checked native bridge                                   │
│ └─ dedicated WebView UI                                              │
│    ├─ active-session projection                                      │
│    ├─ cursor/selection/viewport reducer                              │
│    ├─ lightweight inactive-tab state                                 │
│    └─ committed draft-token projection                              │
└──────────────────────────────────────────────────────────────────────┘
```

The stock DSH listener and unrestricted DSH APIs MUST NOT be exposed wholesale through Funnel.

---

## 3. Terminology and durable identity

### 3.1 Session, attachment, and tab

A **DSH session** is DSH's authoritative conversation and execution context.

An **attachment** is the plugin's decision to expose one DSH session to one authenticated glasses device.

A **tab** is the glasses presentation of an attachment. Its wire identity is an opaque `attachmentId`, not a visual index.

```ts
interface GlassesAttachment {
  attachmentId: string
  attachmentGeneration: number
  sessionId: string
  label: string
  order: number
  state: 'idle' | 'running' | 'waiting-user' | 'unavailable' | 'unknown'
  capabilities: AttachmentCapabilities
}
```

Reattaching the same DSH session creates a fresh attachment generation so stale operations cannot target the new attachment.

### 3.2 Projection

A **projection** is the bounded glasses-specific representation derived from DSH session events. The glasses MUST NOT depend on every raw DSH event type.

### 3.3 Draft target

A **draft target** is one exact editable destination:

- an ordinary session composer;
- an eligible free-text request-answer field;
- an editable **Other** field;
- the editable input part of a choice-and-input request panel;
- another future target explicitly advertised by the plugin.

### 3.4 Content states

- **Local working content** — an optimistic client view before plugin acknowledgment.
- **Committed draft content** — content accepted into one plugin-owned draft revision.
- **Submitted content** — an exact committed draft accepted by DSH through Send, Steer, or request resolution.
- **Provisional Photo capture** — one full-resolution capture temporarily held on the glasses.
- **Staged Photo asset** — bytes durably held by the plugin but not yet represented by a committed draft token.
- **Voice provisional slice** — recognition output not yet committed to the draft.
- **Morse raw symbol buffer** — dots/dashes of one unfinished character.
- **Morse provisional word** — finished decoded characters not yet committed.
- **Committed Voice slice/Morse word** — exact text accepted into a plugin-authoritative draft revision.

### 3.5 Control and semantic action

Raw events include Rokid SDK events, Android broadcasts, `KeyEvent`, `MotionEvent`, HID input, and IMU samples.

The source-neutral Layer-B controls are:

```text
RIGHT
LEFT
DOWN
UP
PRIMARY
SECONDARY
COMMAND
```

A semantic action is the mode-specific interpretation of a control. Raw events MUST NOT leak into draft, projection, or DSH mutation logic.

---

## 4. Authority and state ownership

### 4.1 DSH authority

DSH is authoritative for:

- session identity and durable history;
- model-visible user, assistant, tool, and lifecycle events;
- live agent state;
- provider/model routing and actual modality support;
- accepted Send, Steer, Interrupt, and request resolution;
- submitted durable attachment references.

### 4.2 Plugin authority

`dsh-glasses-plugin` is authoritative for:

- device registry and authorization;
- attachment set, order, generation, and capabilities;
- glasses projections and revisions;
- every committed draft revision;
- committed text, choices, images, Voice slices, and Morse words;
- original staged and committed image bytes;
- rich clipboard image references;
- pending/unknown operations and reconciliation;
- Photo sessions and staged assets;
- Voice model packs, profiles, runtime, fences, provisional transcript, and committed-slice identity;
- Morse profiles, character tables, lexicons, target leases, completion derivation, and committed-word identity.

### 4.3 Glasses authority

`dsh-glasses` is authoritative only for:

- selected tab;
- local viewport and scroll anchors;
- Navigation/Input cursor and selection;
- base and transient mode;
- unfinished physical interactions;
- head-pose anchors;
- optimistic unacknowledged presentation;
- Camera2 preview and one capture while staging;
- glasses microphone capture, sample counter, and bounded unsent audio queue;
- Morse raw symbols, monotonic timer, provisional decoded word, and selected candidate index.

The glasses is not the durable authority for committed draft content, image originals, Voice state, completion candidates, or committed modal output.

### 4.4 Commitment rule

Only a plugin acknowledgment advancing the authoritative target revision makes content committed.

Mutation outcomes are:

```text
accepted
rejected
unknown
```

An unknown outcome locks the affected operation until authoritative reconciliation. It is never replayed under a fresh operation ID.

---

## 5. DSH integration boundary

DSH is a developer-preview project and may introduce compatibility-breaking changes. The plugin MUST isolate DSH internals behind a project-owned adapter and MUST pin/test the supported upstream revision.

```ts
interface GlassesDshAdapter {
  listAttachableSessions(): Promise<AttachableSession[]>
  readProjectionPage(sessionId: string, cursor?: string): Promise<ProjectionPage>
  observeSession(sessionId: string, listener: SessionListener): Disposable
  getAgentState(sessionId: string): Promise<AgentProjection>
  followup(target: MutationTarget, message: CanonicalMessage): Promise<MutationOutcome>
  steer(target: MutationTarget, message: CanonicalMessage): Promise<MutationOutcome>
  interrupt(target: MutationTarget): Promise<MutationOutcome>
  resolveRequest(target: MutationTarget, response: CanonicalResponse): Promise<MutationOutcome>
  saveImage(input: StagedImageInput): Promise<DurableImageRef>
  readAuthorizedImage(sessionId: string, attachmentId: string): Promise<ImageBytes>
}
```

Anything model-visible MUST be reconstructable from the DSH session log. Browser URLs, glasses paths, staging paths, provider URLs, raw base64, Voice audio, Voice provisional text, Morse symbols, provisional words, and completion candidates are not canonical durable session content.

---

## 6. Attachment and tab management

Only the plugin-side management surface may attach, detach, reorder, relabel, or change authorization.

The glasses may only switch among attachments in its accepted snapshot.

- Reorder preserves selection by `attachmentId`.
- Detaching a background tab does not move selection.
- Detaching the selected tab chooses the new occupant of its old index, then the preceding tab, then empty state.
- Attachment generation fences all writes.

Each tab retains lightweight local state:

- Navigation cursor;
- Input cursor;
- selection;
- scroll anchor;
- following/history-reading state;
- unread watermark;
- base mode;
- last acknowledged draft revision.

Only the active tab's full DOM SHOULD be mounted.

No permanent tab strip is required. A brief post-switch overlay MAY show index, state, and label.

---

## 7. Synchronization protocol

The initial transport SHOULD use:

- authenticated bootstrap/snapshot;
- server-to-glasses SSE or equivalent held-open stream;
- authenticated mutation POSTs;
- bounded history paging;
- session-authorized image reads;
- a dedicated authenticated Voice audio stream or later bidirectional transport.

### 7.1 Epochs and snapshots

Every authenticated connection has a fresh `connectionEpoch`. A complete snapshot contains:

```ts
interface GlassesSnapshot {
  protocolMajor: number
  serverGeneration: string
  connectionEpoch: string
  attachmentSetRevision: number
  streamSequence: number
  attachments: AttachmentProjection[]
  drafts: DraftProjection[]
}
```

The glasses installs a snapshot atomically before writes are enabled. Wrong bases, gaps, overflow, malformed deltas, or generation changes force resynchronization.

### 7.2 Mutation envelope

```ts
interface MutationEnvelope<T> {
  operationId: string
  connectionEpoch: string
  serverGeneration: string
  controlGeneration: number
  attachmentId: string
  attachmentGeneration: number
  sessionId: string
  targetId: string
  expectedDraftRevision?: number
  expectedAgentState?: string
  body: T
}
```

Stale attachment, target, control, draft, agent, or plugin state causes rejection, never reinterpretation.

### 7.3 Backpressure

The plugin coalesces high-frequency model, Voice, and Morse provisional updates. A slow projection client reconnects and resynchronizes instead of silently losing semantic revisions.

Voice uses stricter bounded audio backpressure and reserves transport capacity for fences and termination.

---

## 8. Raw-input qualification and canonical mappings

Target firmware:

```text
Rokid/glasses/glasses:12/SKQ1.240613.001/1.23.009-20260725-150201:user/release-keys
```

A dedicated tracer MUST qualify exact SDK events, broadcasts, key/motion events, IMU behavior, lifecycle, and native side effects.

| Control | Intended built-in Rokid operation |
| --- | --- |
| `RIGHT` | single-finger swipe forward |
| `LEFT` | single-finger swipe backward |
| `DOWN` | dual-finger swipe forward |
| `UP` | dual-finger swipe backward |
| `PRIMARY` | single-finger touch |
| `SECONDARY` | dual-finger touch |
| `COMMAND` | function button |

### 8.1 Interaction lifecycle

Every source interaction has:

```text
BEGIN
optional UPDATE/HOLD
END or CANCEL
```

The first source owns canonical input until completion. Competing input is ignored, not queued.

Cancellation, focus loss, disconnection, backgrounding, or native-bridge loss MUST NOT synthesize a click, double-click, paste, cut, mode transition, wheel selection, Photo action, Voice fence, Morse symbol, commit, or exit.

### 8.2 Click classification

`PRIMARY`, `SECONDARY`, and `COMMAND` may have short, double, or long meanings. Classification snapshots the mode and selection state at sequence start.

A single action that conflicts with double-click waits until the double-click window closes. Long press cancels short/double classification. A completed first action MUST NOT be followed by an incompatible second-click action.

Modal Voice and Morse override ordinary click synthesis as specified below.

---

## 9. UI state model

```ts
type AppVisibility = 'foreground' | 'background'
type HudVisibility = 'visible' | 'hidden'
type BaseMode = 'navigation' | 'input'

type SelectionState =
  | { kind: 'inactive' }
  | { kind: 'active'; anchorTokenId: string; focusTokenId: string }

type TransientMode =
  | 'none'
  | 'head-navigation'
  | 'command-wheel'
  | 'photo'
  | 'voice'
  | 'morse'
```

HUD hiding preserves selected tab, base mode, cursors, anchors, draft, and choices.

Double `COMMAND` in ordinary Navigation/Input backgrounds the visible activity but does not detach sessions or discard committed drafts.

Any recognized foreground control wakes a hidden HUD. Whether that control is wake-only or also executes remains an open product decision; destructive or mode-changing controls SHOULD be wake-only until qualified.

---

## 10. Word cursor and rendered-line movement

Navigation and Input use a blinking word-sized highlight, not a character `|` cursor.

Punctuation, emoji, and each image token are indivisible word-like units according to the accepted segmentation policy.

- `RIGHT` approximates Vim `w`.
- `LEFT` approximates Vim `b`.
- `DOWN`/`UP` move by actual rendered HUD line.

The client groups post-layout token rectangles into visual lines, retains a preferred horizontal coordinate during vertical movement, chooses the nearest token on the adjacent line, and resets that preferred coordinate after horizontal movement.

Stable block/token identity reanchors the cursor after streaming or reflow.

---

## 11. Navigation mode

Input box is hidden and conversation content receives the maximum viewport.

| Control | Navigation action |
| --- | --- |
| `RIGHT` | next word/token |
| `LEFT` | previous word/token |
| `DOWN` | corresponding token on next rendered line |
| `UP` | corresponding token on previous rendered line |
| single `PRIMARY`, selection inactive | start selection |
| single `PRIMARY`, selection active | copy selection and leave selection |
| double `PRIMARY`, selection inactive | copy current word/token |
| single `SECONDARY` | no-op |
| double `SECONDARY` | hide HUD |
| single `COMMAND` | enter Input |
| double `COMMAND` | background app |
| long `COMMAND` | invisible head navigation until release |

Selection freezes the anchor, stops blinking, and extends/contracts with directional movement. Copy uses semantic projection text rather than visually truncated DOM scraping.

---

## 12. Invisible head-navigation mode

Long `COMMAND` in Navigation captures the current head pose when the long threshold is crossed.

| Relative pose | Action |
| --- | --- |
| up | continuous scroll up |
| down | continuous scroll down |
| left | previous tab once per excursion |
| right | next tab once per excursion |
| return to dead zone | stop and re-arm |
| release/cancel | clear anchor and stop |

Vertical velocity increases with displacement and is capped.

Lateral switching latches after one threshold crossing and re-arms only after returning to the central dead zone.

Dominant-axis arbitration, dead zone, hysteresis, and stale-pose cancellation prevent diagonal double-actions.

These are semantic viewport/tab actions, not synthetic cursor controls.

---

## 13. Input mode

The input box and committed draft are visible. Input and Navigation retain separate cursor state. Entry/exit is explicit through single `COMMAND`, not boundary-driven.

### 13.1 Input controls

| Control | Selection inactive | Selection active |
| --- | --- | --- |
| `RIGHT` | next word/token | move selection edge right |
| `LEFT` | previous word/token | move selection edge left |
| `DOWN` | next rendered line | move edge to next line |
| `UP` | previous rendered line | move edge to previous line |
| single `PRIMARY` | start selection | copy selection and leave |
| double `PRIMARY` | copy current token | copy selection once and leave |
| single `SECONDARY` | paste before current token with separator | replace selection with clipboard and leave |
| long `SECONDARY` | cut current token | cut selection and leave |
| double `SECONDARY` | hide HUD | replace once; never hide |
| single `COMMAND` | enter Navigation | enter Navigation |
| double `COMMAND` | background app | background app |
| long `COMMAND` | command wheel | command wheel |

If clipboard is empty, paste is a no-op. Replacement does not erase selected text with empty content, but selection still ends.

The selection state at first `SECONDARY` contact governs the whole short/double sequence. A selection-active double replaces once and never becomes Hide after selection collapses. A selection-inactive double hides and never first pastes.

### 13.2 Rich clipboard

```ts
type ClipboardPart =
  | { kind: 'text'; text: string }
  | { kind: 'image-ref'; assetId: string; tokenMetadata: ImageTokenMetadata }
```

Plain text SHOULD mirror to Android clipboard. Image references remain authenticated plugin-internal references.

Cutting an image token removes its draft reference but retains the asset while referenced by clipboard, pending/unknown operations, pending/unknown submission, or session history.

---

## 14. Command wheel

Long `COMMAND` in ordinary Input opens:

```text
             Photo

    Morse                Voice

         Send / Steer / Interrupt
```

The bottom sector is derived from authoritative state:

| Agent state | Draft | Action |
| --- | --- | --- |
| running | nonempty | Steer |
| running | empty | Interrupt |
| not running | nonempty | Send |
| not running | empty | disabled |
| stale/unknown/conflicting | any | disabled |

A draft is nonempty if it has nonblank text, an image token, a selected structured choice, or eligible free-text answer.

The wheel snapshots attachment, session, target, draft revision, agent state, displayed semantic action, control generation, and wheel ID. Release revalidates everything and never substitutes a newly different action.

Photo, Voice, and Morse availability follows their target rules.

---

## 15. Plugin-authoritative draft model

```ts
interface DraftState {
  target: DraftTarget
  revision: number
  body: DraftPart[]
  decisions: DecisionSelection[]
}

type DraftPart =
  | { kind: 'text'; text: string }
  | {
      kind: 'image'
      tokenId: string
      assetId: string
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
      bytes: number
      width: number
      height: number
      sha256: string
    }

interface DecisionSelection {
  questionId: string
  selectedChoiceIds: string[]
  otherText?: string
}
```

Choices remain structured and MUST NOT be flattened into prompt text.

Every mutation carries operation ID, exact target, expected revision, and control generation. The initial implementation SHOULD permit at most one unresolved target mutation.

### 15.1 Send, Steer, Interrupt, and request resolution

Send/Steer freezes the exact committed draft revision and referenced assets.

- Acceptance clears only that exact revision.
- Rejection retains it.
- Unknown acceptance locks it and reconciles from authoritative DSH history.

Interrupt is a semantic agent cancellation bound to observed running state, never terminal-key emulation.

Request choices and editable input are submitted atomically according to the exact request contract. Photo, Voice, Morse, or ordinary input targeting a request MUST NOT be reinterpreted as a normal follow-up.

---

## 16. Photo mode

Photo is a modal Input mode available for an ordinary composer or a choice-and-input/free-text request target. It is unavailable for choice-only panels.

### 16.1 Entry and camera path

Entry pins connection/plugin generation, attachment/session, target, draft revision, insertion cursor, control generation, and fresh `photoSessionId`.

The plugin accepts the Photo session before Camera2 opens.

Qualified path:

```text
Camera2 LIMITED
480×640 preview
4032×3024 JPEG
sensor orientation 270°
1×–8× zoom
session starts at 1×
```

Photo replaces the whole HUD with live preview. Preview transforms never alter original still bytes.

### 16.2 Controls

| Control | Photo action |
| --- | --- |
| `RIGHT` | zoom ×1.25 |
| `LEFT` | zoom ÷1.25 |
| `PRIMARY` | capture full-resolution still |
| long `SECONDARY` | delete latest staged photo in this Photo session |
| short `COMMAND` | atomically commit surviving photos into draft and exit |
| other controls | no-op |

During capture, staging, deletion, or final commit, competing Photo controls are blocked.

### 16.3 Capture and staging

On `PRIMARY`:

1. Camera2 captures one full-resolution JPEG.
2. Preview freezes.
3. Glasses temporarily holds the original.
4. Bytes transfer to the authenticated Photo session.
5. Plugin validates format, dimensions, length, digest, session, target, and storage.
6. Plugin durably stages and acknowledges an opaque asset identity.
7. Glasses deletes its full-resolution copy only after acknowledgment.
8. Preview resumes.

Staging is synchronization, not DSH/model submission.

A failed capture/stage inserts no token and deletes the local temporary capture.

### 16.4 Atomic Photo-session commitment

Short `COMMAND` sends one ordered batch of surviving staged assets at the pinned cursor.

All image tokens commit in one draft revision or none commit. Partial insertion is forbidden.

Success:

- promotes assets to draft-referenced state;
- inserts atomic `📷` tokens in capture order;
- closes Camera2;
- restores Input HUD;
- places cursor after the last token, or at the original position if none survive;
- retains only lightweight token descriptors on glasses.

### 16.5 Staged deletion

Long `SECONDARY` deletes only the newest staged asset owned by the current `photoSessionId`. It never deletes an older draft photo, another session's photo, or submitted history.

### 16.6 Forced exit and unknown commitment

Before a commit request, forced exit closes Camera2, deletes all staged assets for that Photo session, and inserts no token.

If commit acceptance is unknown, the glasses exits modal state and reconciles the same operation ID:

- committed tokens survive if the plugin committed;
- otherwise staging is removed;
- no new commit is issued.

Committed Photo content survives; provisional/staged state does not, except while needed to reconcile an unknown commit.

### 16.7 Image fidelity and lifetime

The plugin preserves exact original bytes and embedded metadata. It MUST NOT silently downscale, re-encode, strip metadata, or substitute preview bytes.

Derived previews are nonauthoritative caches.

Assets are retained while referenced by Photo staging, draft, rich clipboard, pending/unknown mutation, pending/unknown submission, or session history.

### 16.8 Draft image tokens

A committed image is an indivisible word-like token rendered as `📷`. It may be selected, copied, cut, pasted by reference, or deleted as a whole. The emoji itself is never submitted in place of the image.

---

## 17. Canonical mixed text/image messages

Exact ordering is represented as ordered content blocks:

```ts
[
  { type: 'text', text: 'Compare this:\n' },
  { type: 'image', attachment: imageA },
  { type: 'text', text: '\nwith this:\n' },
  { type: 'image', attachment: imageB },
]
```

DSH history SHOULD render bounded inline previews in canonical order and open the stored original on activation.

Provider classes:

1. **Known multimodal** — allow after validation.
2. **Known text-only** — block image-bearing Send/Steer before submission.
3. **Unknown** — adapter may decide, but rejection retains the exact committed draft/assets.

The product never silently drops, captions, OCRs, replaces, reorders, or sends only text portions. A future conversion workflow must be explicit.

The plugin submits the whole ordered draft from plugin-owned storage; glasses does not re-upload originals at Send/Steer.

---

## 18. Voice mode

Voice is a modal Input mode that transcribes the glasses microphone on the DSH server host and commits explicit slices into the reviewed draft. It never submits directly.

### 18.1 Eligible targets and start fence

Voice may target:

- ordinary composer;
- eligible free-text request field;
- editable **Other**;
- editable choice-and-input field.

It cannot target read-only or choice-only content.

Start pins connection/plugin generation, attachment/session, target/revision, insertion anchor, control generation, glasses microphone, selected streaming ASR pack/revision, validated profile, and fresh `voiceSessionId`.

The glasses shows `Preparing…` and locks the target.

Before microphone open, the glasses confirms foreground, permission, capturability, native bridge, and noncancellation. The plugin confirms authentication, authorization, target/revision, model integrity, profile validity, loaded runtime, fresh ID, and bounded resources.

Failure returns to Input with `Voice unavailable` for one second.

### 18.2 Runtime and microphone

Recognition runs locally under the plugin or a plugin-owned worker on the DSH host.

Initial Voice MUST NOT use cloud ASR, Rokid/Android recognition, glasses inference, a phone, or the conversational model.

Only streaming ASR models are supported.

Runtime admission MUST account for the resident text-serving workload. CPU or separately admitted acceleration is allowed; unavailable resources fail preparation cleanly.

The sole initial source is the glasses microphone. It never hot-switches.

### 18.3 Audio contract

```text
16 kHz
mono
signed little-endian PCM16
```

```ts
interface VoiceAudioFrame {
  voiceSessionId: string
  firstSampleOffset: number
  pcm16: ArrayBuffer
}
```

Frames use whole samples and contiguous source-owned offsets. Gaps, overlaps, duplicates, misalignment, wrong session, or post-termination frames terminate rather than being guessed around.

There is no codec, replay, or unfinished-session recovery.

The initial queue is approximately two seconds/64 KiB and is strictly bounded. Control, fences, cancellation, and acknowledgments have reserved transport capacity.

### 18.4 Provisional transcript

The plugin owns one uncommitted slice. Partials, recognizer final output, punctuation, endpointing, and internal segment boundaries remain provisional.

Silence never commits. Only explicit `PRIMARY` commits.

Projection updates coalesce to at most about 10 Hz; commit/discard/delete/failure/termination bypass coalescing.

Raw audio and provisional text never enter committed drafts, DSH history, model context, logs, or backups.

### 18.5 Voice controls

| Control | Voice action |
| --- | --- |
| `PRIMARY` | fence and commit current slice; begin next slice |
| long `SECONDARY`, slice nonempty | fence and discard current slice; begin next |
| long `SECONDARY`, slice empty | delete latest safely deletable slice committed by this Voice session |
| short `COMMAND` | normal exit |
| long `COMMAND` | emergency exit; never command wheel |
| other controls | no-op |

Ordinary navigation, clipboard, selection, HUD hide, tab switching, and wheel reopening are unavailable.

### 18.6 Commit fence

`PRIMARY` snapshots the microphone's exact next-sample offset.

- Pre-fence samples belong to current slice.
- Post-fence samples belong to next slice.
- Plugin consumes every pre-fence sample and finalizes the exact interval.
- Plugin atomically inserts text and assigns stable committed-slice identity.
- Post-fence capture continues as next provisional slice.

Displayed partial text is not authoritative.

While unresolved, another `PRIMARY`, long `SECONDARY`, and short `COMMAND` are unavailable. Capture continues only within bounded queue. Long `COMMAND` remains available.

### 18.7 Discard/delete fence

Long `SECONDARY` also captures exact sample offset.

If current slice is nonempty, plugin settles and discards pre-fence recognition/audio, commits nothing, and starts next slice with post-fence samples.

If empty, it deletes only the latest exact slice committed by this `voiceSessionId`. It never guesses neighboring/preexisting/other-session text.

### 18.8 Exit, failures, and lease

Short `COMMAND` stops capture, terminates runtime session, discards current provisional state, preserves committed slices, releases lease, and returns to Input.

Long `COMMAND` is emergency exit. Pending mutation and exit use one-winner semantics; unknown result reconciles the same operation ID.

Voice terminates on overflow, malformed audio, runtime failure, irreconcilable mutation, permission/audio-focus loss, background/process loss, target/attachment loss, plugin generation change, connection loss, host loss, or irreconcilable revision conflict.

Committed slices survive; provisional state never resumes.

There is no user-facing handoff. Voice acquires an automatic target-scoped lease. Other surfaces observe but cannot mutate that target until exit. Same-target external mutation is rejected or explicitly terminates Voice before admission, never positionally merged.

---

## 19. Morse mode

Morse is a modal Input mode entered from the command wheel. It turns touch durations into Morse symbols, decodes a provisional word locally, obtains deterministic plugin-side completion candidates, and commits complete words through exact draft mutations.

Morse never directly Sends, Steers, Interrupts, resolves a request, mutates choices, changes image tokens, or calls an LLM.

```text
touches
→ glasses-local raw symbol buffer
→ glasses-local decoded provisional word
→ deterministic plugin completion candidates
→ explicit whole-word commit
→ plugin-authoritative draft revision
→ later Send / Steer / request resolution
```

### 19.1 Eligible targets

Morse may target:

- ordinary composer;
- eligible free-text request field;
- editable **Other**;
- editable input in a choice-and-input panel.

It MUST NOT target read-only/choice-only content, stale/unauthorized targets, an active Input selection, unresolved conflicting mutation, or a target already leased by another modal editor.

The Morse wheel sector is disabled while Input selection is active. Morse does not replace selection implicitly.

### 19.2 Start request and automatic lease

Start pins:

- connection/plugin generation;
- attachment/session;
- exact target and expected draft revision;
- stable insertion cursor/token-boundary anchor;
- control generation;
- selected Morse profile/revision;
- fresh `morseSessionId`.

The glasses shows `Preparing…` and locks the target while the plugin confirms authentication, authorization, target/revision, absence of conflicts, profile integrity, and fresh ID.

Acceptance acquires an automatic target-scoped Morse lease. Other surfaces remain usable elsewhere but the exact target is read-only. No user-facing handoff is required.

Failure returns to Input with `Morse unavailable` for one second.

### 19.3 Profile and artifacts

```ts
interface MorseProfile {
  profileId: string
  revision: number
  characterTableId: string
  characterTableDigest: string
  interCharacterMs: number
  lexiconId?: string
  lexiconRevision?: string
  lexiconDigest?: string
  maxCompletionCandidates: number
}
```

Initial profile:

```text
inter-character: 300–2000 ms
step:            50 ms
default:         700 ms
max candidates:  5
```

The complete profile is snapshotted per session.

Dot/dash duration threshold is a glasses monotonic-clock constant snapshotted at entry. It requires real-device qualification; initial implementation SHOULD start with the Android long-press timeout observed on the target firmware.

The repository contains one exact versioned test fixture derived from printable ITU-R M.1677-1 mappings:

- Latin letters;
- figures;
- printable punctuation/signs represented by the table.

Latin letters decode lowercase. Prosigns are invalid text and never hidden commands. There are no special sequences for Send, Enter, newline, tab, wheel actions, DSH skills, or agent commands.

### 19.4 Session state

```ts
interface MorseSessionState {
  morseSessionId: string
  sessionRevision: number
  targetId: string
  insertionAnchor: StableDraftAnchor
  expectedDraftRevision: number
  rawSymbolBuffer: readonly ('.' | '-')[]
  provisionalWord: string
  wordRevision: number
  completionCandidates: readonly MorseCompletion[]
  selectedCompletionIndex: number | null
  committedWords: readonly MorseCommittedWordRef[]
  pendingMutation: MorseMutation | null
}
```

Raw buffer, provisional word, candidates, selection, and timer are ephemeral and never enter committed snapshots, DSH history, model context, logs, backups, notifications, or reconnect recovery.

### 19.5 Presentation

The Input field remains visible. The blinking cursor becomes a nonblinking insertion anchor. Provisional word uses provisional styling and selected completion appears as a dim ghost suffix.

A small fixed glasses-local slot MAY show raw symbols:

```text
· − ·
```

It does not reflow the draft and is never projected to DSH.

DSH-side UI may show provisional word, selected ghost completion, and `Morse active`, but not raw symbols.

### 19.6 Duration-only classification

While Morse is active:

- `PRIMARY` is short/long only;
- `SECONDARY` is short/long only;
- ordinary double-click synthesis is disabled.

Two rapid short `PRIMARY` touches are two dots. Two rapid short `SECONDARY` touches are two provisional backspaces, never Hide.

A second short `COMMAND` in the same rapid sequence is swallowed after exit so it cannot switch restored Input or background the app.

### 19.7 Dot, dash, and character timer

| Interaction | Symbol |
| --- | --- |
| short `PRIMARY` | dot `.` |
| long `PRIMARY` | dash `-` |

Exactly one symbol is appended on release. Long `PRIMARY` never leaks a dot before dash.

Each symbol restarts the full inter-character timer. No character finalizes while any control remains held.

When timer expires:

- valid sequence decodes one character, appends to provisional word, advances `wordRevision`, clears raw buffer, and refreshes completion;
- invalid sequence appends nothing, clears raw buffer, and shows `Invalid Morse` for 500 ms.

Beginning a control suspends timer and snapshots remainder. Cancellation without state change resumes remainder. State-changing operation restarts or stops timer as defined.

An ineligible operation is discarded and never applied later.

### 19.8 Control map

| Control | Morse action |
| --- | --- |
| short `PRIMARY` | append dot |
| long `PRIMARY` | append dash |
| `RIGHT` | commit selected completion plus one space |
| `LEFT` | commit directly decoded provisional word plus one space |
| `DOWN` | next completion candidate |
| `UP` | previous completion candidate |
| short `SECONDARY` | provisional backspace |
| long `SECONDARY` | clear provisional state, or delete latest safely deletable session word |
| short `COMMAND` | normal exit |
| long `COMMAND` | emergency exit; never command wheel |
| other controls | no-op |

Ordinary cursor, selection, clipboard, HUD hide, tab switching, and command wheel are unavailable.

### 19.9 Short SECONDARY

If raw symbol buffer is nonempty, short `SECONDARY` clears the complete current symbol buffer and stops the timer.

If raw buffer is empty and provisional word is nonempty, it deletes the last finished character, advances `wordRevision`, invalidates candidates, and requests completion for the shorter prefix.

If both are empty, it is a no-op. It never deletes committed draft text.

### 19.10 Long SECONDARY

If raw buffer or provisional word is nonempty, long `SECONDARY` clears both, stops timer, clears candidates, advances `wordRevision`, commits nothing, and keeps Morse active.

If provisional state is empty, it requests deletion only of the latest complete word committed by this exact `morseSessionId`.

It never deletes preexisting text, neighboring guesses, another session's word, another target, or an unprovable range.

### 19.11 Deterministic completion

Completion runs locally in the plugin and MUST NOT:

- call an LLM;
- inspect surrounding draft, session history, choices, or personal typing history;
- query a remote service;
- start or modify a DSH turn;
- learn automatically.

```ts
interface MorseCompletionRequest {
  morseSessionId: string
  wordRevision: number
  provisionalWord: string
  lexiconId: string
  lexiconRevision: string
}
```

Completion is available only when raw buffer is empty, provisional word has at least two ASCII Latin letters, and the entire word is an eligible lexical prefix.

Digits, punctuation, mixed technical strings, and unsupported characters disable completion but remain eligible for literal `LEFT` commitment.

The plugin returns at most five candidates. Each preserves exact prefix, appends only a suffix, belongs to pinned lexicon revision, and carries exact `wordRevision`.

Ranking:

1. pinned frequency/commonness;
2. fewer appended characters;
3. Unicode lexical order.

A finalized/deleted character invalidates old candidates and selects the first in the new list. Stale responses are ignored.

### 19.12 Candidate navigation

`DOWN`/`UP` operate only when raw buffer is empty, candidate list is current, and no mutation is pending.

`DOWN` selects next; `UP` selects previous. No wrap. Selection is ephemeral, not a draft mutation.

### 19.13 RIGHT: completion commit

`RIGHT` commits the selected completion when:

- provisional word is nonempty;
- current selected candidate matches exact `wordRevision`;
- no mutation is pending;
- target lease and draft revision are valid.

**The raw symbol buffer may be nonempty.**

On a valid commit, the glasses forcibly clears the complete raw buffer, stops the inter-character timer, and discards its unfinished character. It commits only the selected candidate derived from finished provisional text.

Committed text is candidate plus one ASCII space.

The request includes exact session/word revisions, operation ID, target/anchor, expected draft revision, prefix, candidate ID, lexicon revision, and complete candidate text. Plugin independently verifies it.

Without a valid candidate, `RIGHT` is a no-op and MUST NOT clear raw buffer/timer or fall back to literal commitment.

### 19.14 LEFT: literal commit

`LEFT` ignores candidates and commits only the directly decoded provisional word when:

- provisional word is nonempty;
- no mutation is pending;
- target/revision fences are valid.

**The raw symbol buffer may be nonempty.**

On valid commit, the glasses forcibly clears the complete raw buffer, stops timer, and discards the unfinished character. It commits only already decoded provisional text plus one ASCII space.

Latin remains lowercase; figures/punctuation remain decoded.

If provisional word is empty, `LEFT` is a no-op and raw buffer/timer continue normally.

### 19.15 Atomic commitment

A valid `RIGHT` or `LEFT` atomically:

- clears raw buffer;
- stops timer;
- discards unfinished character;
- freezes provisional word, candidate if applicable, insertion anchor, and expected draft revision;
- sends one plugin-authoritative draft mutation.

Discarded raw symbols are never restored after rejection/unknown outcome because they were never decoded or committed.

On acceptance:

- text inserts at anchor;
- draft revision advances once;
- plugin assigns stable committed-word identity;
- anchor advances after text;
- provisional word/candidates/selection clear;
- new empty Morse word begins without leaving mode;
- both surfaces install authoritative revision.

```ts
interface MorseCommittedWordRef {
  morseSessionId: string
  wordId: string
  operationId: string
  targetId: string
  committedDraftRevision: number
  insertedRange: StableDraftRange
  committedText: string
}
```

Trailing space belongs to committed range.

During commit/deletion, every Morse input except long `COMMAND` is blocked. Glasses does not optimistically advance the authoritative anchor.

### 19.16 Exact session-word deletion

With empty provisional state, long `SECONDARY` may delete only the latest surviving `MorseCommittedWordRef`.

Deletion is pessimistic and revision-bound. Success removes exact word plus trailing space, advances revision, returns anchor to former range start, removes identity from session stack, and keeps Morse active.

Changed/split/moved/replaced/unprovable ranges are rejected. Irreconcilable result installs authoritative draft, exits Morse, and shows `Morse interrupted` for one second.

### 19.17 Exit and recovery

Short `COMMAND` exits when no commit/delete mutation is unresolved. It discards raw/provisional/completion state, preserves committed words, releases lease, and returns to Input at authoritative anchor. It does not commit, Send, reopen wheel, switch Navigation, or background.

Long `COMMAND` is emergency exit and remains available during pending mutation. Mutation/exit use one-winner semantics; unknown outcome reconciles same operation ID.

Morse terminates on app/process/background, bridge/connection, plugin generation, attachment, target/editability, lease, irreconcilable revision, malformed protocol, or unreconcilable unknown operation loss.

Forced exit discards all ephemeral Morse state, preserves committed words, releases lease, and never restores unfinished word after reconnect.

There is no explicit handoff. External same-target mutation is rejected or first terminates Morse under explicit adapter rule; it is never merged by positional guess.

### 19.18 Notices and acceptance evidence

Notices:

```text
Morse unavailable
Invalid Morse
Morse interrupted
```

Normal exit has no notice.

Real-device acceptance MUST prove:

- reliable short/long dot/dash and SECONDARY classification without leakage;
- rapid taps remain separate Morse operations;
- timer suspend/resume and no finalization while held;
- valid/invalid decoding;
- raw-buffer clearing and finished-character backspace;
- completion ranking/navigation and stale rejection;
- `RIGHT`/`LEFT` commits with both empty and nonempty raw buffers;
- forced raw-buffer clearing and timer stop on valid commit;
- exact session-word deletion;
- lease and same-target protection;
- rejection/unknown reconciliation without duplicates;
- committed-word survival with complete ephemeral loss;
- no persistence of raw symbols, provisional words, candidates, selection, or timer;
- long-duration use without timer drift or state accumulation.

Remaining constants are dot/dash threshold, pinned character-table artifact/digest, initial lexicon artifact/license/digest, display styling, notice timings, and unresolved-mutation timeout. They MUST NOT change accepted semantics.

---

## 20. HUD visibility, rendering, and performance

Double `SECONDARY` hides only where active mode permits.

Backgrounding cancels unfinished interactions, wheel/head state, and all modal modes under their forced-exit rules. DSH work continues independently.

Projection blocks may include text, code, tool, status, request, error, and image blocks. Large content may initially collapse but remains completely recoverable through expansion/paging.

Each tab has:

- **following** — streamed output remains pinned;
- **reading history** — new content indicates arrival but does not move viewport.

Committed draft images may render as `📷` without downloading originals. Historical images use bounded previews and fetch originals only on explicit demand.

Voice and Morse provisional UI MUST be visually distinct and MUST NOT advance committed draft revision or enter history.

---

## 21. Security and privacy

Funnel is public reachability, not application authorization.

The glasses edge MUST:

- use TLS;
- authenticate device-specific revocable identity;
- authorize every session, draft, image, Voice stream, Morse session, and mutation;
- prevent cross-device draft/media/modal-state access;
- expose no unrestricted DSH endpoint;
- place no provider/Funnel/general DSH credential on glasses;
- use an origin-checked typed native bridge;
- reject arbitrary native signing, filesystem, camera, microphone, or shell requests;
- exclude session content, drafts, images, audio, provisional Voice/Morse state, and credentials from ordinary logs/diagnostics.

Pairing ceremony remains open, but secrecy of Funnel URL is insufficient.

Photo temporaries use private backup-excluded storage and are deleted after staging acknowledgment or failure.

Voice raw audio/provisional text and Morse raw/provisional/completion/timer state remain transient and nonpersistent.

---

## 22. Recovery and no-replay

On reconnect:

1. authenticate;
2. establish new epoch;
3. download complete snapshot;
4. stage it separately;
5. install atomically;
6. enable writes only after generation/revision validation.

Unfinished gestures, selection on vanished targets, wheels, head anchors, Photo preview, Voice, Morse, and uncommitted modal state never resume automatically.

Committed drafts, choices, image tokens, Voice slices, and Morse words restore from plugin state without restoring image originals to glasses, raw audio, symbols, provisional text, candidates, or timers.

The client never replays under a new operation ID:

- draft insertion/paste/replace/cut;
- choice selection;
- Photo commit/staged deletion;
- Voice commit/discard/session-slice deletion;
- Morse literal/completion commit/session-word deletion;
- Send/Steer/Interrupt/request resolution.

Plugin rebuilds projections from DSH and restores committed drafts/assets from plugin storage.

Plugin generation replacement invalidates transient modes and write eligibility.

A DSH restart during unknown Send/Steer yields explicit accepted/rejected/interrupted/unknown based on authoritative history; completion is never fabricated.

---

## 23. Hardware and compatibility evidence

Production claims require real-device and live-DSH evidence for:

- exact Rokid event/native-conflict matrix;
- click/double/long/cancel behavior;
- Navigation/Input cursor and selection;
- clipboard with image tokens;
- head scrolling and one-excursion tab switching;
- HUD hide/wake/background;
- Camera2 orientation, zoom, capture, staging, deletion, atomic commit, forced exit, exact bytes, and cleanup;
- interleaved DSH images and original preview;
- multimodal Send/Steer and text-only blocking;
- Voice preparation, PCM contract, queue, fences, streaming runtime, lease, failures, and nonpersistence;
- Morse timing, decoding, completion, both commit paths, raw-buffer force-clear, exact deletion, lease, failures, and nonpersistence;
- reconnect and unknown-operation reconciliation without duplicate content;
- battery, memory, storage, and long-duration behavior with resident DSH workload.

---

## 24. Suggested repository layout

```text
dsh-glasses/
├── apps/
│   ├── glasses-android/
│   └── glasses-web/
├── plugins/
│   └── dsh-glasses-plugin/
├── packages/
│   ├── protocol/
│   ├── input-model/
│   ├── draft-model/
│   └── projection/
├── tools/
│   └── rokid-input-tracer/
└── docs/
    ├── ROKID_INPUT_MATRIX.md
    ├── PROTOCOL.md
    ├── THREAT_MODEL.md
    └── evidence/
```

Poker-Dealer remains a behavioral reference, not a source dependency.

---

## 25. Milestones

### M0 — Input and DSH compatibility qualification

- exact firmware tracer matrix;
- frozen raw-to-control mappings;
- pinned DSH APIs for sessions, agents, attachments, mixed content, and model capability;
- explicit adapter requirements for unsupported assumptions.

### M1 — One attached read-only session

- bootstrap history;
- live output;
- following/history-reading;
- disconnect/snapshot resync without duplication.

### M2 — Multiple tabs and base interaction

- plugin-only attachment management;
- per-tab state;
- explicit Navigation/Input;
- cursor, selection, HUD, and head navigation on hardware.

### M3 — Plugin-authoritative drafts

- text/choice synchronization;
- copy/paste/replace/cut;
- rich clipboard image references;
- Send/Steer/Interrupt/request resolution;
- rejection/unknown draft retention.

### M4 — Photo

- qualified Camera2 path;
- per-capture staging and glasses original deletion;
- staged deletion and atomic session commitment;
- forced/unknown cleanup;
- image-token editing;
- real multimodal and text-only routes.

### M5 — Voice

- qualified 16 kHz PCM stream and offsets;
- integrity-verified streaming pack/profile on host;
- provisional projection and explicit fences;
- target lease and synchronized surfaces;
- failure/no-replay/nonpersistence;
- long-duration coexistence with resident workload.

### M6 — Morse

- exact target validation and automatic lease;
- duration-only controls and monotonic timing;
- pinned character table and lexicon;
- ephemeral prefix/candidate synchronization;
- `DOWN`/`UP` candidate selection;
- `RIGHT` completion and `LEFT` literal commit;
- valid commit with nonempty raw buffer forcibly clears buffer/timer;
- exact session-word deletion;
- normal/emergency/forced/reconnect/no-replay behavior;
- no LLM or modal-state persistence.

### M7 — Production hardening

- pairing/authentication/revocation;
- Funnel threat review;
- power/memory/network/storage recovery;
- Voice runtime admission/integrity;
- Morse artifact integrity/timer stability;
- pinned DSH compatibility suite;
- complete real-device evidence.

---

## 26. Open decisions

1. Exact raw Android/Rokid event mapping on target firmware.
2. Whether a hidden-HUD wake control is wake-only or wake-and-execute.
3. Pairing and credential issuance ceremony.
4. Photo deadlines and deployment limits.
5. Whether Photo staging directly uses DSH attachment service or a plugin staging namespace before promotion.
6. Exact pinned DSH API for arbitrary interleaved text/image messages.
7. Initial Voice pack/runtime, languages, profile schema, resource thresholds, frame size, transport, and fence deadlines.
8. Morse dot/dash threshold, pinned printable table, lexicon artifact/license/digest, styling, notice timing, and unresolved-mutation timeout.
9. Detailed request-family schemas exposed to glasses.

---

## 27. Upstream references

This specification is informed by:

- `code2hack/Poker-Dealer` `SPEC.md` for lifecycle, target fencing, recovery, no-replay, and predecessor multimodal designs;
- DeepSeek Harness architecture and session/agent extension seams;
- DeepSeek Harness durable image content and attachment design;
- ITU-R M.1677-1 printable International Morse mappings.

Upstream documentation is reference material. This repository and its compatibility tests are authoritative for `dsh-glasses`.
