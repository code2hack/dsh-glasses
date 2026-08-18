# dsh-glasses Implementation Specification

**Status:** Draft normative implementation contract, revision 2  
**Date:** 2026-08-18  
**Repository:** `code2hack/dsh-glasses`  
**Products:** **dsh-glasses** = Rokid glasses client; **dsh-glasses-plugin** = DeepSeek Harness plugin and glasses server

This document is the current source of truth for the initial `dsh-glasses` design. When implementation and this specification disagree, this specification wins until both are deliberately updated in the same commit.

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

---

## 1. Product contract

`dsh-glasses` connects Rokid AI glasses directly to DeepSeek Harness (`dsh`) without a phone companion application.

The system consists of two products:

1. **dsh-glasses** — a lightweight Android client on Rokid AI glasses. It is a small native device/input shell around a dedicated glasses-optimized web surface. It renders attached DSH sessions, captures Rokid controls and head posture, owns local cursor/selection/viewport state, and provides Camera2, microphone, and other device capabilities to the web UI through a narrow native bridge.
2. **dsh-glasses-plugin** — a plugin mounted in DSH on the user's dual-DGX-Spark workstation. It selects and attaches DSH sessions, projects them into a glasses-specific protocol, owns committed drafts and media, performs authenticated synchronization, and translates semantic glasses actions into DSH operations.

The initial deployment target is the user's dual-Spark workstation, where DSH is already running. The glasses-facing service may be exposed through Tailscale Funnel, but Funnel is only transport reachability. Application authentication and per-device authorization remain mandatory.

### 1.1 Product purpose

The first production-capable version MUST support:

- attaching selected existing DSH sessions from the plugin-side management surface;
- displaying attached sessions as switchable tabs on the glasses;
- reading retained and live session history;
- observing running sessions without pulling the viewport away from historical content the user is reading;
- maintaining one plugin-authoritative committed draft per eligible input target;
- synchronizing draft text, selected choices, and image tokens;
- sending a new message, steering a running session, or interrupting it through explicit semantic operations;
- deterministic reconnection without duplicate input or blind replay;
- a glasses-native word cursor, selection, copy, paste, replace, and cut interaction model;
- an invisible head-navigation mode for scrolling and tab switching;
- Photo capture through Camera2, with immediate server-side staging and later atomic draft-token commitment;
- streaming Voice recognition on the DSH server host, with provisional transcript slices and explicit revision-bound commitment into the synchronized draft;
- exact mixed text/image ordering in the canonical draft and submitted DSH message;
- explicit handling of multimodal, text-only, and unknown-capability models.

### 1.2 Explicit non-goals

The initial product MUST NOT attempt to provide:

- a Fold6 or other phone companion application;
- a general-purpose Android browser;
- the stock DSH Web UI on the glasses;
- a terminal emulator, shell, tmux client, or ANSI screen scraper;
- session creation, deletion, archival, attachment, detachment, or reordering from the glasses;
- a sidebar, taskbar, persistent tab strip, or desktop-style management interface;
- arbitrary access to DSH APIs or sessions not attached to the authenticated glasses device;
- provider credential or model-runtime management from the glasses;
- silent image removal, flattening, OCR, captioning, or placeholder substitution for a text-only model;
- durable storage of full-resolution draft images on the glasses after successful plugin staging;
- final Morse interaction semantics before that mode receives its own accepted design revision.

### 1.3 Relationship to Poker-Dealer

`dsh-glasses` reuses selected principles from `code2hack/Poker-Dealer`, especially:

- source-neutral control normalization;
- complete interaction lifecycles with cancellation;
- exact target and revision pinning;
- plugin/server authority for durable draft content;
- snapshots, revisions, connection epochs, and deterministic resynchronization;
- idempotent operation identities;
- no blind replay after an unknown outcome;
- preserving committed content while discarding uncommitted modal state on forced exit.

It does not reuse Poker-Dealer's phone topology, card/pile boundary-driven input entry, old canonical operation meanings, or old Photo/Morse/ASR button mappings.

---

## 2. Intended topology

```text
Dual DGX Spark workstation
┌──────────────────────────────────────────────────────────────────────┐
│ DeepSeek Harness                                                     │
│ ├─ authoritative session logs and live agents                        │
│ ├─ provider/model adapters                                           │
│ ├─ durable attachment store                                          │
│ └─ dsh-glasses-plugin                                                │
│    ├─ DSH compatibility adapter                                      │
│    ├─ attachment/tab manager                                         │
│    ├─ glasses projection reducer                                     │
│    ├─ committed draft and rich-clipboard store                       │
│    ├─ Photo staging/session manager                                  │
│    ├─ Voice recognition/session manager                              │
│    ├─ authentication and device authorization                        │
│    └─ glasses HTTP/SSE edge                                          │
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
│ │  ├─ function-button click/hold classifier                          │
│ │  ├─ IMU/head-pose adapter                                          │
│ │  ├─ Camera2 and microphone lifecycle                               │
│ │  ├─ device credentials                                             │
│ │  └─ narrow origin-checked native bridge                            │
│ └─ dedicated WebView UI                                              │
│    ├─ active-session projection                                      │
│    ├─ local cursor/selection/viewport reducer                        │
│    ├─ lightweight inactive-tab state                                 │
│    └─ draft-token projection                                         │
└──────────────────────────────────────────────────────────────────────┘
```

The stock DSH listener and unrestricted DSH APIs MUST NOT be exposed wholesale through Funnel. The plugin MUST expose only the narrow glasses protocol and assets authorized for the authenticated device.

---

## 3. Terminology and durable identity

### 3.1 DSH session

A **DSH session** is the authoritative DSH conversation and execution context identified by DSH's session identity. DSH's append-only session log is authoritative for model-visible history.

### 3.2 Attachment and tab

An **attachment** is the plugin's decision to expose one DSH session to one glasses device.

A **tab** is the glasses presentation of an attachment. The wire identity MUST be an opaque `attachmentId`, not a visual numeric index.

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

Detaching and later reattaching the same DSH session MUST create a fresh attachment generation so stale operations cannot mutate the new attachment.

### 3.3 Projection

A **projection** is the glasses-specific, bounded, renderable representation derived from DSH session events. The glasses MUST NOT need to understand every raw DSH event type.

### 3.4 Draft target

A **draft target** is one exact editable destination:

- a normal DSH-session composer;
- a request panel containing structured choices plus an editable input field;
- another future plugin-declared editable target.

A request-choice-only panel is not a Photo target.

### 3.5 Draft states

Draft content uses these terms:

- **local working content** — the glasses' optimistic view before plugin acknowledgment;
- **committed draft content** — content accepted into a specific plugin-owned draft revision;
- **submitted content** — committed draft content whose exact Send, Steer, or request-resolution operation was accepted by DSH.

For photos, two additional states exist:

- **provisional capture** — a full-resolution image temporarily held by the glasses during capture/upload;
- **staged photo asset** — original bytes durably accepted by the plugin but not yet represented by a committed draft image token.

A photo is not committed draft content merely because its bytes were staged.

For Voice, an **uncommitted transcript slice** is recognition output owned by one active Voice session that has not yet advanced the plugin-authoritative draft revision. It may be displayed provisionally on synchronized surfaces but is not committed draft content or DSH session history.

### 3.6 Control and action

A **raw event** is a Rokid SDK event, Android broadcast, `KeyEvent`, `MotionEvent`, HID event, or IMU sample.

A **control operation** is one source-neutral Layer-B operation:

```text
RIGHT
LEFT
DOWN
UP
PRIMARY
SECONDARY
COMMAND
```

A **semantic action** is the mode-specific interpretation of a control, such as moving the cursor, scrolling the viewport, switching a tab, cutting a token range, committing a Photo session, committing or discarding a Voice slice, sending a draft, steering, or interrupting.

Raw device events MUST NOT leak into web UI reducers, draft logic, or DSH mutation code.

---

## 4. Authority and state ownership

### 4.1 DSH authority

DSH is authoritative for:

- session existence and identity;
- durable session history;
- model-visible user, assistant, tool, and control events;
- live agent identity and status;
- provider/model routing and actual modality support;
- Send/Steer/Interrupt acceptance;
- submitted image attachment references after message acceptance.

### 4.2 Plugin authority

`dsh-glasses-plugin` is authoritative for:

- the glasses device registry and authorization;
- the set and order of attachments exposed to each device;
- attachment generations and capabilities;
- glasses projections and their revisions;
- every committed draft revision;
- committed text, structured choice selections, and image tokens;
- original staged and committed draft-photo bytes after successful staging;
- plugin-side rich clipboard references;
- pending/unknown mutation identities and reconciliation state;
- Photo-session staging metadata;
- installed and selected Voice model packs, revisions, profiles, and runtime state;
- active Voice-session identities, sample offsets, fences, provisional transcripts, and committed-slice identities;
- provider/modality preflight results exposed to the glasses.

### 4.3 Glasses authority

`dsh-glasses` is authoritative only for:

- the currently selected tab;
- local viewport and scroll anchors;
- navigation and input cursors;
- active word selection and its anchor/focus;
- current base mode and transient mode;
- unfinished physical interactions and head-pose anchors;
- optimistic unacknowledged draft presentation;
- Camera2 preview state;
- one current captured image while it is being staged;
- ephemeral Photo-session descriptors mirrored from plugin acknowledgments;
- the live glasses-microphone capture stream and its source-owned next-sample offset;
- a bounded unsent Voice-audio queue needed to bridge transport and fence acknowledgments.

The glasses MUST NOT be the durable authority for committed draft text, choices, image tokens, original photo assets, Voice model state, or committed Voice slices.

### 4.4 Commitment rule

Only a successful plugin acknowledgment advancing the authoritative draft revision makes text, choices, image tokens, or a Voice transcript slice committed.

The glasses MAY render an optimistic local mutation, but it MUST retain the operation identity and expected base revision until one of these outcomes is established:

- `accepted` — install the returned authoritative revision;
- `rejected` — replace the optimistic view with the authoritative draft;
- `unknown` — lock the affected mutation and reconcile; never replay it as a new operation.

---

## 5. DSH integration boundary

DeepSeek Harness is a developer-preview product with compatibility-breaking changes expected. `dsh-glasses-plugin` MUST isolate all upstream DSH dependencies behind a narrow compatibility adapter and MUST be tested against an explicitly pinned DSH revision or release.

The plugin SHOULD use DSH's documented extension seams rather than patching the agent loop. Current upstream architecture exposes session logs, live agents, durable content blocks, and attachment services through plugin-facing services and events. The exact methods used by this project remain isolated behind an interface equivalent to:

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
  stageImage(input: StagedImageInput): Promise<DurableImageRef>
  readAuthorizedImage(sessionId: string, attachmentId: string): Promise<ImageBytes>
}
```

All code outside this adapter MUST depend on project-owned types rather than unstable DSH internals.

### 5.1 Model-visible content

Anything submitted to a model MUST be reconstructable from the DSH session log. Canonical submitted images MUST be represented by durable DSH image attachment references, not browser object URLs, glasses paths, plugin staging paths, provider URLs, or base64 embedded in durable session events.

Voice audio and provisional transcript slices are not model-visible content. Only Voice text committed into a plugin-owned draft and later accepted through Send, Steer, or request resolution may become model-visible DSH content.

### 5.2 Mixed-content qualification

Current DSH provides durable image content blocks and provider modality handling. Before implementation is considered complete, compatibility tests MUST prove:

- the exact plugin API for supplying already-staged images;
- preservation of the project's canonical text/image ordering;
- historical inline image rendering;
- original-image retrieval through session-authorized attachment reads;
- behavior of Send and Steer with image-bearing messages;
- explicit rejection by text-only routes;
- retention of the exact draft after rejection or unknown acceptance.

If current DSH cannot represent one project requirement directly, the compatibility adapter MAY add a project-local projection or admission layer, but it MUST NOT silently reorder, drop, or flatten images.

---

## 6. Attachment and tab management

The plugin is the only surface allowed to:

- attach a DSH session;
- detach it;
- reorder attached sessions;
- rename the glasses-facing label;
- change per-device visibility or permissions.

The glasses may only switch among attachments already present in its latest accepted attachment snapshot.

### 6.1 Selection preservation

The glasses MUST preserve the selected attachment by `attachmentId`, not visual index.

Reordering attachments MUST NOT change the selected session.

If the selected attachment is detached, the glasses selects:

1. the new occupant of the removed tab's prior index;
2. otherwise the preceding surviving tab;
3. otherwise the empty state.

A background-tab detach MUST NOT move the selected tab.

### 6.2 Per-tab local state

Each attached tab retains lightweight process-local state:

- navigation cursor identity;
- input cursor identity;
- selection state;
- scroll anchor and offset;
- following-versus-history-reading state;
- unread watermark;
- base mode;
- last acknowledged draft revision.

Only the active tab's full conversation DOM SHOULD be mounted. Inactive tabs SHOULD retain state and bounded projection data without retaining a complete rendered DOM tree.

### 6.3 Visual chrome

The glasses UI MUST NOT display a permanent sidebar, taskbar, or desktop-style tab strip.

After a tab switch, it MAY briefly show an overlay such as:

```text
2/5 · RUNNING · dsh-glasses architecture
```

The overlay MUST not permanently consume conversation space.

---

## 7. Glasses synchronization protocol

The transport implementation may evolve, but the initial protocol SHOULD use:

- one bootstrap/snapshot request;
- one held-open server-to-glasses stream, initially SSE;
- ordinary authenticated POST requests for glasses-to-plugin operations;
- bounded history paging for older projection content;
- session-authorized image reads.

Voice audio MAY use a dedicated authenticated streaming request or a future bidirectional transport, but it MUST preserve the same connection epoch, session fencing, queue bounds, and reserved control capacity defined by this specification.

A later WebSocket transport MAY replace SSE only if measurements justify it without weakening the protocol invariants below.

### 7.1 Connection epoch and revisions

Every authenticated connection has a fresh `connectionEpoch`. A new epoch supersedes an older socket for the same device.

A complete snapshot contains at least:

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

The glasses MUST install a complete snapshot atomically before enabling semantic writes.

Projection deltas MUST declare their base revision and stream sequence. A gap, wrong base, overflow, malformed patch, or server-generation change forces snapshot resynchronization.

### 7.2 Operation identity

Every mutation crossing to the plugin contains an idempotency identity and exact target fence:

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

An operation with stale attachment generation, control generation, target, draft revision, or session state MUST be rejected without reinterpretation.

### 7.3 Slow clients and streaming

The plugin MUST coalesce high-frequency model and provisional Voice transcript deltas before sending them to the 480×640 client. It MUST NOT require one DOM update per model token or ASR decoder update.

A slow client MUST be disconnected and resynchronized rather than silently dropping semantic revisions. Voice audio backpressure follows the stricter bounded-queue and terminal-failure rules in section 23.

---

## 8. Raw-input qualification and canonical controls

The target firmware is:

```text
Rokid/glasses/glasses:12/SKQ1.240613.001/1.23.009-20260725-150201:user/release-keys
```

Before final bindings are accepted, a dedicated input tracer MUST record Rokid SDK events, broadcasts, Android `KeyEvent`/`MotionEvent`, IMU state, lifecycle, and native side effects on this exact firmware.

The accepted Layer-B operation names and intended default physical bindings are:

| Control operation | Rokid built-in operation |
| --- | --- |
| `RIGHT` | single-finger swipe forward |
| `LEFT` | single-finger swipe backward |
| `DOWN` | dual-finger swipe forward |
| `UP` | dual-finger swipe backward |
| `PRIMARY` | single-finger touch |
| `SECONDARY` | dual-finger touch |
| `COMMAND` | function button |

The names describe logical cursor-space directions and roles, not raw Android keycodes.

### 8.1 Interaction lifecycle

Every physical interaction has:

```text
BEGIN
optional UPDATE/HOLD
END or CANCEL
```

The first physical source beginning an interaction owns canonical input until it ends or cancels. Competing raw events are ignored and never queued.

Focus loss, `ACTION_CANCEL`, device disconnection, application backgrounding, or native-bridge loss MUST cancel an unfinished interaction. Cancellation MUST NOT synthesize a click, double-click, cut, paste, mode switch, wheel choice, Photo capture, Photo commit, Voice fence, or Voice exit.

### 8.2 Click classification

`PRIMARY`, `SECONDARY`, and `COMMAND` have short, double, or long meanings depending on mode. The classifier MUST latch the relevant mode and selection state at the beginning of the click sequence.

A first short release whose single-click action conflicts with double-click MUST remain pending until the double-click window expires. A long press cancels short/double interpretation.

No first-click side effect may later be followed by an incompatible double-click side effect.

---

## 9. UI state model

The UI SHOULD model independent dimensions rather than one giant enum:

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
  | 'morse'
  | 'voice'
```

Hiding the HUD MUST NOT discard the selected tab, base mode, cursor, scroll anchor, draft, or committed selection choices.

Double `COMMAND` backgrounds the visible activity while leaving `dsh-glasses` running subject to Android lifecycle limits. It MUST NOT detach sessions, discard committed drafts, or terminate DSH work.

Any recognized control operation while the application is foreground MUST wake a hidden HUD. Whether the wake-triggering operation is consumed or also executed remains an explicit open decision; destructive and mode-changing actions SHOULD default to wake-only until that decision is accepted.

---

## 10. Word cursor and rendered-line geometry

Both Navigation and Input use a **blinking word-sized highlight block**, not a character-shaped `|` cursor.

A navigable unit is a user-visible word/token according to the client segmentation policy. Punctuation and emoji are separate units where the platform segmentation exposes them. Every committed image token is one indivisible word-like unit.

`RIGHT` and `LEFT` perform Vim-like word-start movement:

- `RIGHT` approximates `w`;
- `LEFT` approximates `b`.

`DOWN` and `UP` move across actual rendered HUD lines, not Markdown source lines, logical paragraphs, or semantic lines.

The client MUST:

1. measure navigable token rectangles after layout;
2. group tokens into visual lines by vertical geometry;
3. retain a preferred horizontal coordinate during repeated vertical movement;
4. choose the nearest token on the adjacent rendered line;
5. reset the preferred coordinate after horizontal movement.

Cursor identity SHOULD be based on stable projection block identity plus token offset so reflow can re-anchor to the same semantic token.

---

## 11. Navigation mode

In Navigation mode:

- the input box is hidden;
- the conversation receives the maximum available viewport height;
- one content token carries the blinking cursor;
- committed draft content is not directly editable.

### 11.1 Navigation controls

| Control | Action |
| --- | --- |
| `RIGHT` | move to next word/token start |
| `LEFT` | move to previous word/token start |
| `DOWN` | move to corresponding token on next rendered HUD line |
| `UP` | move to corresponding token on previous rendered HUD line |
| single `PRIMARY`, selection inactive | start wordwise selection |
| single `PRIMARY`, selection active | copy selection and leave selection |
| double `PRIMARY`, selection inactive | copy current word/token without entering selection |
| single `SECONDARY` | no-op |
| double `SECONDARY` | hide the whole HUD |
| single `COMMAND` | enter Input mode |
| double `COMMAND` | background the visible application |
| long `COMMAND` | enter invisible head-navigation mode until release |

### 11.2 Selection

Starting selection freezes the anchor at the current token, stops cursor blinking, and keeps the highlighted anchor visible.

Directional movement moves the active edge and expands or contracts the inclusive token range between anchor and focus.

A later single `PRIMARY` copies the selected semantic text/token range exactly once, leaves selection, collapses the cursor at the active edge, and resumes blinking.

Double `PRIMARY` while selection is inactive copies only the current token.

Copying projected session text MUST use the underlying semantic projection rather than scraping visually truncated DOM text.

---

## 12. Invisible head-navigation mode

Long `COMMAND` in Navigation activates an invisible head-navigation mode.

The head-pose origin anchor is captured when the function-button hold crosses the accepted long-press threshold, not necessarily at initial button-down.

While held:

| Relative head movement | Action |
| --- | --- |
| up | continuously scroll viewport upward |
| down | continuously scroll viewport downward |
| left | switch exactly once to previous attached tab per distinct excursion |
| right | switch exactly once to next attached tab per distinct excursion |
| return to origin dead zone | stop scrolling and re-arm lateral switching |
| release/cancel `COMMAND` | stop all actions and discard anchor |

Vertical scroll speed SHOULD increase with displacement and MUST be capped.

Lateral switching MUST use an excursion latch:

```text
cross threshold → switch once → latch
remain displaced → no additional switch
return to dead zone → re-arm
cross threshold again → switch once
```

Dominant-axis arbitration, dead zones, hysteresis, and stale-pose cancellation MUST prevent one diagonal movement from both scrolling and switching tabs.

Head-navigation actions are semantic viewport/tab actions and MUST NOT emit synthetic `UP`, `DOWN`, `LEFT`, or `RIGHT` cursor controls.

---

## 13. Input mode

In Input mode:

- the input box and committed draft projection are visible;
- the same word-sized cursor model is used;
- conversation history remains visible above the input box;
- entering Input does not depend on reaching the bottom of history;
- leaving Input does not depend on moving before the draft head.

Single `COMMAND` explicitly switches between Navigation and Input.

Navigation and Input SHOULD retain separate cursor/anchor state so mode switching restores each mode's last meaningful position.

### 13.1 Input controls

| Control | Selection inactive | Selection active |
| --- | --- | --- |
| `RIGHT` | move to next word/token | move active selection edge right |
| `LEFT` | move to previous word/token | move active selection edge left |
| `DOWN` | move to token on next rendered draft line | move active selection edge to next rendered line |
| `UP` | move to token on previous rendered draft line | move active selection edge to previous rendered line |
| single `PRIMARY` | start selection | copy selection once and leave selection |
| double `PRIMARY` | copy current word/token | copy selection once and leave selection |
| single `SECONDARY` | paste clipboard before current word/token with an automatic separator | replace selection with clipboard once and leave selection |
| long `SECONDARY` | cut current word/token | cut selection into clipboard and leave selection |
| double `SECONDARY` | hide HUD | replace selection once; never hide HUD |
| single `COMMAND` | enter Navigation | enter Navigation |
| double `COMMAND` | background application | background application |
| long `COMMAND` | open command wheel | open command wheel |

### 13.2 Clipboard semantics

The product requires a typed **dsh-glasses rich clipboard** because a draft selection may include plugin-owned image tokens that cannot be represented safely as plain Android clipboard text.

```ts
type ClipboardPart =
  | { kind: 'text'; text: string }
  | { kind: 'image-ref'; assetId: string; tokenMetadata: ImageTokenMetadata }
```

Plain-text copies SHOULD also mirror text into the Android system clipboard. Image references MUST remain authenticated project-internal references and MUST NOT be encoded as fake text paths or public URLs.

If the clipboard is empty:

- inactive-selection paste is a no-op;
- active-selection replacement performs no draft mutation and still leaves selection, preserving the selected content unchanged.

Pasting before the current word/token MUST insert one logical separator between the pasted payload and the current token when needed. It MUST NOT silently rewrite the payload's internal spacing.

Cutting an image token removes only its draft reference. The original image asset remains retained while referenced by the rich clipboard, pending/unknown mutations, a pending/unknown submission, or submitted history.

### 13.3 Sequence latching

The selection state at the first `SECONDARY` contact governs the complete short/double sequence.

Examples:

- first contact while selection active plus a second short contact replaces the selected range once and MUST NOT hide the HUD after selection collapses;
- first contact while selection inactive plus a second short contact hides the HUD and MUST NOT first paste;
- long-hold recognition performs cut and cancels short/double interpretation.

The same one-winner rule applies to `PRIMARY` and `COMMAND` click sequences.

---

## 14. Command wheel

Long `COMMAND` in ordinary Input mode opens the visible command wheel:

```text
             Photo

    Morse                Voice

         Send / Steer / Interrupt
```

The top, left, and right sectors have fixed placement. The bottom is one semantic sector whose current label and operation are derived from the exact session and draft state.

| Session state | Draft state | Bottom action |
| --- | --- | --- |
| running | nonempty | `Steer` |
| running | empty | `Interrupt` |
| not running | nonempty | `Send` |
| not running | empty | disabled/no-op |
| unknown, stale, or conflicting mutation pending | any | disabled/no-op |

A draft is nonempty when it contains any committed nonblank text, committed image token, committed structured choice, or eligible committed free-text answer.

The wheel MUST snapshot and revalidate:

- attachment ID and generation;
- DSH session identity;
- target identity;
- draft revision;
- active agent/turn state;
- selected semantic bottom action;
- control generation;
- wheel-session identity.

If release-time state no longer matches, release is a no-op. The wheel MUST NOT substitute a different action from the one shown and stabilized.

The wheel SHOULD reuse relative-pose dead zone, dominant-axis selection, stable dwell, hysteresis, and release-to-confirm principles proven in Poker-Dealer.

Photo is disabled for a request-choice-only target and enabled for an ordinary composer or a request target that includes an editable input field.

Voice is governed by section 23. Morse placement is fixed by this revision, but its internal control protocol remains TBD.

---

## 15. Plugin-authoritative draft model

A draft is a structured ordered document, not a plain string with a side list of images.

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

Selected choices MUST remain structured choices. They MUST NOT be converted to ordinary prompt text merely to share draft synchronization machinery.

### 15.1 Draft mutations

Every committed draft mutation is revision-bound:

```ts
interface DraftMutation {
  operationId: string
  targetId: string
  expectedDraftRevision: number
  controlGeneration: number
  mutation: DraftMutationBody
}
```

The plugin serializes conflicting mutations per target. The first implementation SHOULD allow at most one unresolved user mutation per target to keep recovery deterministic.

### 15.2 Send, Steer, and Interrupt

Send and Steer freeze the exact committed draft revision and all referenced assets until the DSH outcome is known.

- acceptance clears only that exact committed draft revision after DSH acceptance is authoritative;
- rejection retains the draft and assets unchanged;
- unknown acceptance locks the frozen draft and reconciles from DSH session history without blind replay.

Interrupt is an explicit semantic cancellation operation bound to the currently observed running agent/turn state. It MUST NOT be terminal-key emulation.

A pending Interrupt need not freeze ordinary draft preparation, but it MUST prevent a second conflicting Interrupt.

---

## 16. Photo mode

Photo is a modal Input mode entered from the command wheel.

It is available only when the active target is:

- an ordinary editable session composer; or
- a request panel containing both structured choices and an editable input field.

It is unavailable for request-choice-only panels.

### 16.1 Entry fence

Before Camera2 opens, Photo pins:

- exact DSH session identity;
- attachment ID and generation;
- exact draft target;
- expected draft revision;
- exact insertion cursor;
- control generation;
- fresh `photoSessionId`.

The plugin MUST accept and register the Photo session before the camera opens. A stale, noneditable, unauthorized, or unsupported target refuses entry and leaves ordinary Input active.

### 16.2 Camera path

Photo replaces the complete normal green HUD with a live 480×640 camera preview.

The initial qualified Rokid path is:

- public Android Camera2, not CameraX or a proprietary media transport;
- 480×640 preview;
- 4032×3024 JPEG still capture;
- sensor orientation 270°;
- 1× through 8× zoom, subject to actual Camera2 range;
- each Photo session starts at 1×.

Preview transforms MUST NOT alter original still bytes.

### 16.3 Photo controls

| Control | Photo action |
| --- | --- |
| `RIGHT` | zoom in by ×1.25 |
| `LEFT` | zoom out by ÷1.25 |
| `PRIMARY` | capture a full-resolution still |
| long `SECONDARY` | delete the latest surviving staged photo from this Photo session |
| short `COMMAND` | atomically commit the Photo session into the draft and exit |

Zoom is clamped to the camera-supported range and applies consistently to preview and still capture.

Controls without an explicit Photo mapping are no-ops. During capture, upload, staged deletion, or final Photo-session commit, every competing Photo operation is blocked until that transaction reaches one winner.

### 16.4 Two-phase Photo lifecycle

Photo uses two server-side phases:

```text
capture and stage each image
              ↓
deliberate exit atomically inserts all surviving image tokens
```

A successfully staged photo is not yet committed draft content.

#### Phase A — capture and stage

On `PRIMARY`:

1. Camera2 captures one full-resolution JPEG.
2. The preview freezes.
3. The glasses temporarily owns the captured original.
4. The original is transferred to the authenticated plugin Photo session.
5. The plugin validates the exact bytes, supported image format, dimensions, length, digest, target/session identity, and storage result.
6. The plugin durably stages the asset and returns an opaque staged asset identity plus metadata.
7. Only after the acknowledgment does the glasses delete its full-resolution local copy.
8. The live preview resumes.

The glasses then retains only a lightweight descriptor:

```ts
interface StagedPhotoDescriptor {
  photoSessionId: string
  stagedAssetId: string
  sequence: number
  mediaType: 'image/jpeg'
  width: number
  height: number
  bytes: number
  sha256: string
}
```

A failed capture or staging attempt inserts no draft token and deletes the uncommitted local capture. If the Photo target remains valid, the live preview resumes.

This staging is synchronization with `dsh-glasses-plugin`; it is not submission to DSH or a model.

#### Phase B — atomic Photo-session commit

Short `COMMAND` requests one atomic draft mutation containing the ordered surviving staged assets and the pinned insertion cursor.

Given draft revision `R` and staged photos `[P1, P2, P3]`, the plugin either:

```text
commits revision R+1 containing image tokens [P1, P2, P3]
```

or commits no token from that Photo session.

Partial insertion such as `P1` and `P2` succeeding while `P3` fails is forbidden.

On success:

- staged assets become durable draft assets;
- one atomic image token per asset is inserted in capture order at the pinned cursor;
- Camera2 closes;
- the ordinary green HUD returns in Input mode;
- the authoritative draft projection displays `📷 📷 📷` at the exact insertion position;
- the cursor lands immediately after the final surviving token;
- if no photo survives, the cursor returns to the original position;
- the glasses retains only token descriptors, not original image bytes.

### 16.5 Staged-photo deletion

Long `SECONDARY` deletes only the newest staged asset belonging to the current `photoSessionId`.

It MUST NOT delete:

- older committed draft images;
- arbitrary draft images;
- images from another Photo session;
- submitted session attachments.

If no staged photo remains, long `SECONDARY` is a no-op.

Deletion is exact-asset and revision/session-bound. A late or ambiguous result MUST NOT delete a different asset.

### 16.6 Deliberate and forced exit

A deliberate short-`COMMAND` exit succeeds only after the atomic Photo-session draft commit is accepted.

A forced exit occurs on target loss, control loss, application backgrounding, camera failure, device process loss, plugin generation replacement, or another condition that makes continued Photo ownership unsafe.

Before any commit request is sent, forced exit MUST:

- close Camera2;
- discard the current Photo session;
- delete all staged assets from that Photo session;
- insert no image tokens.

If a Photo-session commit was sent and its result is unknown, forced exit closes Camera2 and drops local modal state but MUST reconcile the same operation identity:

- if the plugin committed it, the committed image tokens survive in the authoritative draft;
- if it did not commit, staged assets are deleted;
- the glasses MUST NOT issue a new commit.

This preserves the invariant:

> Committed Photo content survives; provisional and merely staged Photo-session state does not survive an aborted session unless required temporarily to reconcile an unknown commit.

### 16.7 Exact image preservation

The plugin MUST preserve the captured original image bytes and embedded metadata. It MUST NOT silently:

- downscale the original;
- re-encode it;
- strip EXIF or other embedded metadata;
- replace it with the 480×640 preview;
- upload a thumbnail as the model input.

Derived previews or thumbnails MAY be generated for display, but they are nonauthoritative caches. Clicking an image in the DSH session UI should open the stored original.

### 16.8 Storage ownership and garbage collection

Plugin image assets may be in these reference states:

```text
PHOTO_STAGED
DRAFT_REFERENCED
CLIPBOARD_REFERENCED
SUBMISSION_PENDING
SESSION_REFERENCED
ORPHANED
```

An asset MUST NOT be deleted while referenced by an active Photo session, committed draft token, rich clipboard, pending or unknown mutation, pending or unknown submission, or submitted DSH session history.

Abandoned staged assets MUST be cleaned only after Photo-session and unknown-operation reconciliation prove that no committed token references them.

### 16.9 Image tokens in ordinary Input

After Photo-session commit, each image appears as an atomic `📷` token at the exact draft position.

An image token:

- is one indivisible word-like cursor unit;
- may be included in a selection;
- may be copied or cut through the rich clipboard;
- may be pasted by reference without re-uploading the original;
- cannot be edited character-by-character;
- retains its plugin asset identity and metadata independently of the display emoji.

The literal camera emoji is presentation only and MUST NOT be submitted in place of the image.

---

## 17. Canonical mixed text/image messages

The plugin MUST preserve the exact order of draft text and image tokens.

Example authoring order:

```text
Compare this scene:
📷
with this one:
📷
```

Canonical content is equivalent to:

```ts
[
  { type: 'text', text: 'Compare this scene:\n' },
  { type: 'image', attachment: imageA },
  { type: 'text', text: '\nwith this one:\n' },
  { type: 'image', attachment: imageB },
]
```

The canonical project representation is authoritative even if one provider transport requires an adapter-specific conversion.

### 17.1 DSH history presentation

Submitted user messages SHOULD render in DSH session history with images among text at their canonical ordering. Inline images SHOULD show a bounded preview, and activating one SHOULD open the stored original.

The UI MUST NOT reduce an ordered message to a misleading generic suffix such as `[2 images attached]` when the underlying DSH content-block model can preserve placement.

### 17.2 Provider capability classes

The plugin MUST distinguish:

1. **Known multimodal** — the selected route declares image input. Send/Steer may proceed after all other validation.
2. **Known text-only** — the selected route explicitly excludes image input. An image-bearing draft is blocked before submission.
3. **Unknown capability** — no reliable declaration exists. The plugin may allow the DSH/provider adapter to decide, but rejection must retain the exact committed draft and assets.

For a text-only route, the product MUST NOT silently:

- drop images;
- replace them with `📷` or `[Image]` text;
- run OCR;
- generate captions;
- send only the text portions;
- switch models or providers.

A future explicit user-selected image-to-text conversion workflow may be designed separately.

### 17.3 Submission atomicity

Send or Steer transmits the complete ordered committed draft from plugin-owned storage. The glasses does not re-upload original images during Send/Steer.

The DSH-facing adapter MUST make the user message model-visible only after every referenced image is durably available and the exact content sequence is valid.

A failed image admission or provider rejection appends no partial user message and leaves the entire committed draft available for correction or model change.

---

## 18. Request choices and editable request input

A request panel may contain:

- choices only; or
- choices plus an editable text/image-capable input field.

Choices remain structured and are synchronized as part of the plugin-authoritative target draft.

Photo is disabled for choices-only panels. Voice is disabled for choices-only panels unless an editable **Other** field has been activated.

For choices-plus-input panels:

- Photo inserts image tokens only into the editable input sequence at its pinned cursor;
- Voice commits recognized text only into the exact editable input sequence at its pinned cursor;
- existing selected choices remain unchanged;
- the command wheel bottom action resolves the exact request only when the complete response is valid;
- request resolution submits choices and input as one atomic semantic response when required by the DSH request contract.

The plugin MUST NOT reinterpret Photo, Voice, or text input as a normal follow-up when the target is a request response.

---

## 19. HUD visibility, wake, and application backgrounding

Double `SECONDARY` hides the HUD only where the active mode table permits it.

Any recognized foreground operation wakes a hidden HUD. Hidden HUD state does not discard committed or local navigation state.

Double `COMMAND` performs a back/exit-style transition that backgrounds the visible activity while leaving the application running. On backgrounding:

- unfinished physical interactions cancel;
- head-navigation and command-wheel state cancel;
- Photo, Voice, and Morse are forced to exit under their modal rules;
- committed draft content remains on the plugin;
- selected tab and lightweight viewport state are preserved where possible;
- DSH sessions continue running independently.

The initial product SHOULD maintain its authenticated plugin connection in the background while Android permits it, but it MUST recover deterministically if Android suspends or kills the process.

---

## 20. Projection and rendering constraints

The 480×640 display and limited battery require a deliberately small UI.

The plugin SHOULD project raw DSH events into a small set of display blocks, for example:

```ts
type DisplayBlock =
  | TextBlock
  | CodeBlock
  | ToolBlock
  | StatusBlock
  | RequestBlock
  | ErrorBlock
  | ImageBlock
```

The plugin may fold token deltas, sanitize Markdown, identify code/tool output, and calculate stable block/token identities before transmission.

Large output MAY begin collapsed, but complete content MUST remain recoverable through expansion or bounded paging. Collapse is view state, not silent summarization or truncation.

### 20.1 Streaming and follow state

Each tab has two reading conditions:

- **following** — the viewport is at the newest content and may remain pinned as output streams;
- **reading history** — new output increments an indicator but MUST NOT move the viewport.

Returning to the live edge restores following.

### 20.2 Image rendering on glasses

Committed draft images may render as lightweight `📷` tokens without downloading originals.

Historical session images MAY use plugin-provided bounded previews, but full originals MUST be fetched only on explicit demand and MUST remain nonpersistent on the glasses unless a later accepted cache policy says otherwise.

### 20.3 Provisional Voice rendering

A Voice provisional transcript MUST be visually distinguishable from committed draft text on both the glasses and the synchronized DSH-side draft surface.

Rendering or replacing a provisional transcript MUST NOT advance the committed draft revision, enter session history, or alter the pinned insertion range. A commit, discard, deletion, failure, or terminal result bypasses ordinary coalescing and removes or replaces the provisional projection immediately.

---

## 21. Security and privacy

Tailscale Funnel exposes a service beyond the private tailnet. Therefore the product MUST apply its own security boundary.

The glasses edge MUST:

- use TLS;
- authenticate a device-specific, revocable identity;
- authorize every session, draft, image, Voice stream, and mutation against that device's attachment set;
- avoid exposing stock DSH endpoints or credentials;
- avoid placing provider credentials, Funnel administration secrets, or general DSH credentials on the glasses;
- prevent one device from reading another device's drafts, staged assets, audio, or provisional transcripts;
- keep original images, draft text, choices, raw Voice audio, provisional transcripts, and session content out of ordinary logs and diagnostics;
- use an origin-checked, narrowly typed native WebView bridge;
- reject arbitrary native signing, filesystem, camera, microphone, or shell requests from untrusted web origins.

The exact initial pairing ceremony remains TBD, but it MUST issue device-specific revocable credentials and MUST NOT rely only on secrecy of the Funnel URL.

Photo originals and staged files MUST use private plugin/DSH storage with restrictive permissions. Temporary glasses captures MUST use private backup-excluded storage and MUST be deleted after acknowledged staging or terminal failure.

Raw Voice audio and provisional transcript slices MUST remain bounded, transient, and excluded from durable drafts, DSH session history, ordinary diagnostics, and backups. The streaming-only Voice design MUST discard consumed audio as soon as the recognizer and any unresolved fence no longer require it.

---

## 22. Recovery and no-replay rules

The product MUST treat network changes, Funnel interruption, WebView reload, glasses process loss, plugin restart, DSH restart, and workstation reboot as recoverable events.

### 22.1 Glasses reconnect

On reconnect, the glasses:

1. authenticates;
2. establishes a new connection epoch;
3. downloads a complete snapshot;
4. stages it separately from the current read-only view;
5. atomically installs it;
6. enables writes only after revision and generation checks pass.

Unfinished gestures, selections whose target no longer exists, command wheels, head anchors, Photo preview, Voice, Morse, and uncommitted modal content MUST NOT resume automatically.

Committed draft text, choices, image tokens, and committed Voice slices are restored from the plugin snapshot without downloading original images or restoring raw audio.

### 22.2 Unknown operations

An operation whose acceptance is unknown MUST be reconciled by the same `operationId` and authoritative target state.

The client MUST NOT generate a new operation identity and replay:

- draft insertion;
- paste/replace/cut;
- choice selection;
- Photo-session commit;
- staged-image deletion;
- Voice-slice commit;
- Voice-slice discard;
- Voice-session slice deletion;
- Send;
- Steer;
- Interrupt;
- request resolution.

### 22.3 Plugin and DSH recovery

The plugin MUST rebuild session projections from DSH logs and restore its own committed drafts and asset-reference state from plugin storage.

A plugin generation change invalidates transient modes and old write eligibility. The glasses returns to read-only state until a new snapshot is installed.

Voice never resumes across plugin generation replacement, glasses reconnect, process replacement, or application backgrounding. Previously committed slices remain in the plugin-owned draft; provisional audio and text are discarded.

A DSH restart during an accepted or unknown Send/Steer MUST produce an explicit accepted, rejected, interrupted, or unknown result based on authoritative history; the plugin MUST NOT fabricate completion.

---

## 23. Voice mode

Voice is a modal Input mode entered from the command wheel. It converts glasses-microphone audio into reviewable text in the plugin-authoritative draft. Voice never directly sends, steers, interrupts, or resolves a request.

### 23.1 Eligible targets

Voice may target:

- the ordinary DSH-session composer while the glasses is in Input mode;
- an eligible free-text request-answer field;
- the editable **Other** field of an option question;
- the editable input portion of a request panel containing choices plus input.

Voice MUST NOT target:

- a read-only session card;
- a choice-only request panel without an active editable **Other** field;
- a stale, collapsed, detached, unauthorized, or noneditable target.

### 23.2 Voice start fence

Selecting Voice sends the plugin a start request pinned to:

- connection epoch and plugin generation;
- attachment ID and attachment generation;
- exact DSH session identity;
- exact target field identity;
- exact target revision;
- exact insertion cursor or stable draft anchor;
- control generation;
- microphone source, fixed to the glasses microphone in the initial version;
- selected streaming ASR model-pack ID and immutable revision;
- selected validated profile identity and revision or digest;
- fresh `voiceSessionId`.

The glasses temporarily shows:

```text
Preparing…
```

and locks the exact target.

The glasses native shell MUST confirm:

- the application remains foreground;
- microphone permission is granted;
- audio capture can be opened;
- the native bridge and requested connection epoch remain valid;
- the preparation has not been cancelled.

The plugin MUST confirm:

- the glasses-to-plugin connection is authenticated;
- the attachment and target are authorized;
- the target still exists and is editable;
- the expected target revision still matches;
- the requested streaming model pack is installed and integrity-verified;
- the profile is valid for that exact pack revision;
- the recognition runtime has loaded;
- the `voiceSessionId` is fresh;
- bounded runtime resources are available.

The microphone MUST NOT open until both sides have accepted preparation.

Failure cancels preparation, unlocks the target, returns to ordinary Input, and shows `Voice unavailable` for one second. The plugin MAY retain a sanitized diagnostic cause, but MUST NOT log raw audio or transcript content.

The plugin owns the complete authoritative pack/profile definition. The glasses carries only the selected identities and expected revisions needed to fence preparation.

### 23.3 Recognition location and runtime

Recognition runs locally on the DSH server host under `dsh-glasses-plugin` or a plugin-owned local worker.

The initial Voice path MUST NOT use:

- Rokid cloud speech recognition;
- Android cloud speech recognition;
- glasses-side ASR inference;
- a phone companion;
- an external cloud ASR service;
- the active conversational model.

Only streaming ASR models are supported. Offline batch recognition, whole-slice spool decoding, and Poker-Dealer's offline Silero-VAD path are not part of this project.

Voice runtime admission MUST NOT assume unused GPU memory merely because the host has accelerators. The implementation may use CPU or a separately admitted accelerator backend, but it MUST remain compatible with the resident DSH text-serving workload and fail preparation cleanly when resources are unavailable.

### 23.4 Microphone source

The only initial source is the **glasses microphone**.

`dsh-glasses` owns microphone permission, audio capture, and the monotonic source sample counter. It transmits audio to `dsh-glasses-plugin` and never hot-switches to another source within an active Voice session.

Permission denial before start produces `Voice unavailable`. Permission revocation, microphone failure, or audio-focus loss after start terminates Voice under section 23.13.

### 23.5 Audio format and transport

The glasses produces:

```text
16 kHz
mono
signed little-endian PCM16
```

Every audio frame contains whole samples and an exact first-sample offset:

```ts
interface VoiceAudioFrame {
  voiceSessionId: string
  firstSampleOffset: number
  pcm16: ArrayBuffer
}
```

The plugin rejects rather than guesses around:

- sample gaps;
- overlaps;
- duplicate sample ranges;
- odd-byte or malformed PCM16 alignment;
- frames from the wrong Voice session;
- frames after termination;
- frames preceding the acknowledged sample position.

There is no compressed audio codec, retained-audio replay, or recovery of an unfinished Voice stream in the initial version.

At 16 kHz mono PCM16, two seconds of raw audio is approximately 64 KiB. The initial queued-audio budget SHOULD be calibrated around that value and MUST remain bounded.

Transport capacity MUST be reserved for:

- commit fences;
- discard fences;
- terminal exit;
- acknowledgments;
- failures;
- cancellation.

An audio backlog MUST NOT starve the operation that commits, discards, or stops Voice.

### 23.6 Provisional transcript model

The plugin owns exactly one current uncommitted transcript slice for each active Voice session.

Recognition output appears in the pinned target as visibly provisional text. It is not part of the authoritative committed draft and MUST NOT advance the draft revision.

Interim projections SHOULD be coalesced to at most approximately 10 Hz. Commit acknowledgments, discard/delete results, failures, and terminal events bypass coalescing.

The following remain provisional:

- recognizer partials;
- recognizer “final” output;
- punctuation produced at a speech pause;
- endpoint detection;
- internal streaming-model segment boundaries.

Silence MUST NOT automatically commit text. Only an explicit `PRIMARY` operation can commit the current slice.

The provisional slice MUST NOT enter DSH session history, model context, persistent logs, backups, or a committed draft snapshot.

### 23.7 Voice controls

Voice overrides the ordinary Input control meanings:

| Control | Voice behavior |
| --- | --- |
| `PRIMARY` | fence and commit the current provisional slice; begin a new empty slice |
| long `SECONDARY`, current slice nonempty | fence and discard the current provisional slice; begin a new empty slice |
| long `SECONDARY`, current slice empty | delete the most recent slice committed by this exact Voice session |
| short `COMMAND` | normal Voice exit; preserve committed slices and discard provisional state |
| long `COMMAND` | immediate/emergency Voice exit; never reopen the command wheel |
| every other control | no-op |

Ordinary cursor navigation, selection, paste, replace, cut, HUD hiding, tab switching, and command-wheel reopening are unavailable while Voice is active.

If `PRIMARY` fences a genuinely empty slice, it commits no empty mutation, acknowledges as a no-op, and begins or retains an empty next slice.

If long `SECONDARY` observes an empty current slice and this Voice session has no safely deletable committed slice, it is a no-op and Voice remains active.

### 23.8 Commit by audio fence

`PRIMARY` MUST NOT commit the last partial text merely because it is currently displayed.

When `PRIMARY` is accepted:

1. the glasses microphone source snapshots its exact next-sample offset;
2. that offset becomes the operation's audio fence;
3. every sample before the fence belongs to the current slice;
4. every sample at or after the fence belongs to the next slice;
5. the plugin consumes every pre-fence sample;
6. the streaming recognizer finalizes the exact pre-fence interval;
7. the plugin performs one atomic revision-bound text insertion at the pinned Voice cursor;
8. the plugin assigns a stable committed-slice identity;
9. the plugin acknowledges the exact operation and authoritative draft revision;
10. post-fence samples become the beginning of the next provisional slice without leaving Voice.

The glasses' last displayed partial is never authoritative.

While the commit fence is unresolved:

- another `PRIMARY` is unavailable;
- long `SECONDARY` is unavailable;
- short `COMMAND` is unavailable;
- capture may continue only within the bounded queue;
- long `COMMAND` remains available as the emergency exit.

Committed text becomes visible on both the glasses and the synchronized DSH-side draft surface only through the authoritative draft revision.

### 23.9 Long SECONDARY: discard or delete

Long `SECONDARY` captures the microphone's exact next-sample offset as a discard/delete fence. The plugin decides whether the current slice was empty from authoritative pre-fence state, not a possibly stale screen projection.

#### Nonempty current slice

The plugin:

1. consumes enough exact pre-fence audio to settle the slice boundary;
2. discards the provisional transcript and recognition state for that slice;
3. discards queued data belonging to the discarded slice;
4. commits no draft text;
5. starts the next slice with post-fence samples.

Voice remains active.

#### Empty current slice

The plugin deletes only the most recent draft slice committed by the exact `voiceSessionId`.

It MUST NOT delete:

- text that existed before Voice started;
- arbitrary neighboring words;
- text committed by another Voice session;
- text in another target;
- a slice whose exact committed identity can no longer be mapped safely after later edits.

Each committed Voice slice therefore has identity equivalent to:

```ts
interface VoiceCommittedSlice {
  voiceSessionId: string
  sliceId: string
  operationId: string
  targetId: string
  committedDraftRevision: number
  insertedRange: StableDraftRange
}
```

If safe exact deletion is no longer possible, the plugin rejects and reconciles rather than guessing. Voice remains active after a successful deletion, rejection, or valid no-op.

### 23.10 Voice exit

Short `COMMAND` is the normal exit operation when no commit/discard mutation is unresolved.

It:

- stops microphone capture;
- terminates the plugin recognition session;
- discards queued audio;
- discards the current provisional transcript;
- preserves all previously committed Voice slices;
- releases the target-scoped Voice lease;
- unlocks the target;
- returns to ordinary Input mode.

Long `COMMAND` never opens the action wheel while Voice is active. It performs an immediate/emergency exit and remains available while a commit or discard fence is unresolved.

A pending mutation and terminal exit follow one-winner semantics:

- if commit won first, its committed text remains and exit discards only later provisional state;
- if exit won first, the pending mutation is rejected;
- late audio frames, recognition outputs, and callbacks are fenced out after termination.

No normal exit notice is required. A failure may show one of the notices in section 23.13.

### 23.11 Streaming-only duration and resource rules

There is no project-defined maximum Voice-session duration.

A Voice session may continue while:

- the glasses remains foreground and authorized;
- the microphone remains available;
- the target remains valid;
- the transport remains within its bounded queue;
- the streaming recognizer remains healthy;
- plugin resource policy permits continued recognition.

No fixed duration means neither unbounded queued PCM nor retention of the whole session's raw audio. Consumed samples MUST be discarded as soon as the recognizer and unresolved fences no longer require them.

A streaming model may use endpointing, punctuation, internal acoustic chunks, language detection, or bounded recurrent/cache state. Those are implementation details and MUST NOT create automatic draft commits.

### 23.12 Revision and no-replay safety

Every Voice commit, discard, deletion, and exit includes or is fenced by:

- `voiceSessionId`;
- monotonic Voice-session revision;
- `operationId`;
- exact target identity;
- expected draft revision;
- source-owned sample fence where applicable;
- attachment and connection generation;
- control generation.

The plugin permits at most one unresolved nontermination Voice mutation at a time.

Duplicate delivery of the same operation is idempotent. A lost acknowledgment is reconciled through the same operation identity and base revision. The glasses MUST NOT create a fresh operation and replay a Voice commit, discard, or deletion that may already have succeeded.

### 23.13 Failure and forced exit

These conditions terminate Voice:

- audio-queue overflow;
- malformed, discontinuous, duplicate, or wrong-session audio;
- recognition-runtime failure;
- irreconcilable atomic draft-commit failure;
- microphone permission revocation;
- microphone or audio-focus loss;
- glasses application backgrounding or process loss;
- target disappearance or loss of editability;
- attachment detachment or generation change;
- plugin process/generation replacement;
- glasses-to-plugin connection loss;
- DSH host loss;
- irreconcilable draft-revision conflict.

Termination:

- preserves committed Voice slices;
- discards current provisional audio and text;
- clears transient recognition state;
- releases the target-scoped Voice lease;
- unlocks the target when that target still exists;
- fences late callbacks;
- returns to the latest authoritative UI state or reconnect flow.

The glasses MAY show:

```text
Voice unavailable
Voice overloaded
Voice failed
Voice interrupted
```

for a bounded transient duration. Detailed diagnostics MUST remain sanitized and MUST NOT contain raw audio or transcript text.

### 23.14 Synchronization without explicit handoff

There is no Dealer-style user-facing human-control handoff between `dsh-glasses` and the DSH-side session UI.

Both surfaces observe one plugin-authoritative committed draft. Every committed Voice slice appears on both surfaces as soon as the authoritative draft revision advances. The current provisional slice MAY also appear on the DSH-side UI, but it MUST remain visibly provisional and nonpersistent.

The first implementation MUST use an automatic target-scoped Voice lease:

- entering Voice acquires exclusive mutation authority for the exact target;
- no user-facing “take control” or handoff action is required;
- the DSH-side UI remains fully usable for other sessions and targets;
- the exact Voice target is temporarily read-only on other surfaces;
- both surfaces continue receiving committed and provisional projections;
- normal exit or forced termination releases the lease automatically.

An external same-target mutation while Voice owns the lease MUST be rejected or terminate Voice according to an explicit adapter rule. It MUST NOT be merged by positional guess.

Committed Voice slices live first in the plugin-owned draft. They do not become durable DSH session-history events or model-visible text until the later Send, Steer, or request-resolution action succeeds:

```text
speech
→ provisional plugin transcript
→ PRIMARY fence
→ committed synchronized draft slice
→ later Send / Steer / request resolution
→ durable DSH user message
→ model-visible content
```

### 23.15 Morse placeholder

Morse remains a command-wheel mode with these accepted high-level invariants:

- it is entered only from eligible Input targets;
- it modifies the reviewed plugin-authoritative draft or eligible request-input target;
- it does not directly Send, Steer, Interrupt, or resolve a request;
- committed output uses revision-bound draft mutations;
- uncommitted modal state is discarded on forced exit, target loss, process loss, or connection-generation change;
- committed draft content survives;
- its detailed controls, timing, completion, commit/delete behavior, hints, and exit semantics remain TBD.

The old Poker-Dealer Morse design is reference material only and is not normative for this project.

---

## 24. Hardware and compatibility evidence

No interaction or multimodal claim is production-qualified solely by unit tests.

The project MUST record real-device evidence for:

- every intended Rokid touch/function-button raw event on the target firmware;
- click, double-click, long-press, cancellation, and competing-source behavior;
- whether native Rokid actions also fire;
- Navigation word movement and visual-line movement after wrapping/reflow;
- selection, copy, paste, replace, and cut, including image tokens;
- invisible head scrolling and one-excursion-per-tab switching;
- HUD hide/wake and application backgrounding;
- Camera2 preview, orientation, capture, zoom, repeated capture, staging, deletion, deliberate commit, and forced exit;
- deletion of original glasses-side bytes after staging acknowledgment;
- restoration of committed image tokens after glasses restart without restoring originals;
- exact mixed text/image ordering in a DSH session;
- full-original image preview from DSH history;
- Send and Steer through at least one GPT-class or Qwen-class multimodal route;
- clear blocking/rejection with a text-only DeepSeek route such as the project's DS4 deployment;
- unknown-capability provider rejection without draft loss;
- Voice preparation, permission gating, 16 kHz mono PCM16 capture, contiguous sample offsets, and approximately two-second bounded backpressure;
- Voice provisional transcript coalescing, `PRIMARY` commit fences, long-`SECONDARY` discard/delete fences, normal and emergency exit, and one-winner races;
- streaming Voice recognition on the DSH server host without requiring spare memory from the resident text-serving workload;
- target-scoped Voice lease behavior and synchronized committed/provisional display on glasses and DSH-side UI;
- Voice failure, reconnect, process-loss, target-loss, and unknown-operation cleanup without duplicate committed slices;
- no persistence or replay of raw Voice audio or provisional transcript state;
- reconnect and unknown-operation reconciliation without duplicate tokens or messages;
- battery, memory, low-storage, and long-running stream behavior on the real glasses.

---

## 25. Suggested repository layout

```text
dsh-glasses/
├── apps/
│   ├── glasses-android/          # Android shell, Rokid adapter, IMU, Camera2
│   └── glasses-web/              # lightweight WebView UI and reducers
├── plugins/
│   └── dsh-glasses-plugin/       # DSH adapter, projection, drafts, assets, edge
├── packages/
│   ├── protocol/                 # snapshot, projection, mutation schemas
│   ├── input-model/              # canonical control lifecycle and fixtures
│   ├── draft-model/              # text/choice/image token transactions
│   └── projection/               # DSH events to glasses blocks
├── tools/
│   └── rokid-input-tracer/       # exact-firmware hardware qualification APK
└── docs/
    ├── ROKID_INPUT_MATRIX.md
    ├── PROTOCOL.md
    ├── THREAT_MODEL.md
    └── evidence/
```

Poker-Dealer SHOULD remain a behavioral reference, not a source-code dependency.

---

## 26. Milestone direction

### M0 — Input and DSH compatibility qualification

Complete when:

- the input tracer records the exact target firmware matrix;
- accepted raw-to-control mappings are frozen;
- current DSH session, agent, attachment, mixed-content, and provider-capability paths are tested against a pinned revision;
- unsupported assumptions are converted into explicit adapter requirements.

### M1 — One attached session, read-only

Complete when:

- one plugin-selected DSH session appears on the glasses;
- history bootstraps and live output streams;
- following/history-reading behavior works;
- disconnect and snapshot resync do not duplicate content.

### M2 — Multiple tabs and base interaction

Complete when:

- plugin-only attachment management works;
- local tab switching and per-tab state work;
- Navigation/Input explicit mode switching works;
- word cursor, visual-line movement, selection, HUD hide/wake, and head navigation pass hardware tests.

### M3 — Plugin-authoritative drafts

Complete when:

- text and choices synchronize by revision;
- copy/paste/replace/cut work;
- rich clipboard asset references are safe;
- Send/Steer/Interrupt are exact-state semantic operations;
- rejection and unknown acceptance retain the correct draft.

### M4 — Photo

Complete when:

- Camera2 path is qualified;
- each capture stages to the plugin and deletes its local original after acknowledgment;
- staged deletion and atomic Photo-session commit work;
- forced exit cleanup and unknown commit reconciliation work;
- image tokens participate in draft editing;
- mixed multimodal submission and text-only rejection pass against real DSH routes.

### M5 — Voice

Complete when:

- the glasses microphone streams qualified 16 kHz mono PCM16 with contiguous source-owned offsets;
- a selected integrity-verified streaming ASR pack/profile runs locally on the DSH server host;
- provisional transcript projection, explicit commit fences, discard/delete fences, and normal/emergency exit work;
- the target-scoped Voice lease synchronizes glasses and DSH-side draft surfaces without a user-facing handoff;
- committed slices survive every accepted recovery boundary while raw audio and provisional text do not;
- queue overflow, runtime failure, target loss, connection loss, and unknown operations cannot duplicate or misapply text;
- long-duration real-hardware resource and battery evidence passes alongside the resident DSH workload.

### M6 — Morse

Begins only after Morse receives an accepted normative interaction design.

### M7 — Production hardening

Complete when:

- pairing/authentication and revocation are complete;
- Funnel threat review passes;
- long-duration power/memory/network tests pass;
- storage and asset-reference recovery are proven;
- Voice model/runtime integrity and resource-admission recovery are proven;
- DSH compatibility tests guard the pinned supported revision range;
- real-device evidence covers all production claims.

---

## 27. Open decisions

The following are intentionally not frozen by revision 2:

1. The exact raw Android/Rokid event mapping on the target firmware; Layer-B names and intended physical gestures are frozen, but hardware qualification remains required.
2. Whether a control that wakes a hidden HUD is consumed as wake-only or also performs its ordinary action.
3. The initial device pairing and credential-issuance ceremony.
4. Exact Photo capture, upload, and draft-commit deadlines and deployment image limits.
5. Whether plugin Photo staging uses DSH's attachment service directly before message acceptance or a plugin-owned staging namespace that later promotes into DSH attachments. Either implementation must preserve one original, exact ordering, and no duplicate upload from the glasses at Send/Steer.
6. The exact DSH API path for arbitrary interleaved text/image messages at the pinned upstream revision.
7. The initial streaming Voice model pack/runtime, supported-language catalog, profile schema, and resource-admission thresholds.
8. Exact Voice audio-frame sizing, transport endpoint, fence deadlines, and transient notice durations, within the accepted PCM16 and bounded-queue contract.
9. Complete Morse interaction design.
10. Detailed request-choice-and-input schemas for every DSH request family the product will expose.

---

## 28. Upstream references

This specification is informed by:

- `code2hack/Poker-Dealer` `SPEC.md`, for interaction lifecycle, target fencing, recovery, no-replay principles, and the predecessor Photo/Morse/ASR designs;
- DeepSeek Harness architecture documentation, especially its plugin model, `ctx.sessions`, live-agent APIs, durable session-log rule, and developer-preview compatibility warning;
- DeepSeek Harness's implemented multimodal-image and durable-attachment design, including role-neutral image blocks, content-addressed attachment storage, provider capability checks, explicit text-only rejection, and historical original-image rendering.

Upstream documentation is reference material. This repository's own protocol and compatibility tests remain authoritative for `dsh-glasses` behavior.
