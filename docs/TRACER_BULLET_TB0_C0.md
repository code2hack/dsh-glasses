# TB0-C0 — one-session product text loop

**Status:** implementation branch `tb0/product-text-loop`; runtime qualification pending.  
**Base:** `bed16e771f6f99a1672a98e5c8f15bfb12ae0df2` (A0 merged in PR #9).  
**Provenance:** product behavior exercised through `SYNTHETIC_DEBUG_CONTROL` until physical bindings are separately qualified.

## 1. Goal

Close the remaining text-only tracer-bullet loop on the real Rokid:

```text
projected retained history
→ authoritative draft visible in Input mode
→ native clipboard paste
→ durable draft mutation
→ Send-only command-wheel action
→ exactly-one durable user message
→ visible streamed assistant text
→ final assistant message
→ restart/reconnect reconstruction
```

C0 consumes the already-proven H0/host-write/G0/I0/R0/A0 seams. It does not redesign them.

## 2. Included

- one statically configured DSH session;
- text-only `user/message` and `assistant/message` projection;
- visible text `assistant/chunk` projection and client-side partial accumulation;
- one chronological chat-history surface;
- plugin-authoritative draft revision/text/lock display;
- explicit Navigation and Input modes;
- Input-mode whole-word cursor and RIGHT/LEFT movement;
- Input-mode single SECONDARY clipboard paste before the current word, with automatic spacing;
- Input-mode synthetic command wheel: long COMMAND → DOWN → COMMAND release → Send;
- same-operation-ID persistence and polling for draft mutation and Send;
- hidden-HUD wake-only first operation;
- bootstrap-first SSE recovery, sequence de-duplication, and hard session mismatch;
- restart and lost-downstream-response recovery.

## 3. Explicitly excluded

- any production physical binding;
- Navigation-mode word/HUD-line cursor movement;
- PRIMARY selection/copy and cut/replace behavior;
- UP/DOWN ordinary HUD-line movement;
- command-wheel Photo, Voice, and Morse entries;
- Steer and Interrupt;
- multiple tabs;
- images or other attachment blocks;
- reasoning display;
- tool-call display or execution UI;
- production pairing/Funnel hardening;
- release build or UI polish beyond the 480×640 tracer surface.

## 4. Projection wire contract

Every projection contains only:

```ts
{ seq: number, type: string }
```

Selected event types add the following narrow fields.

### User message

```ts
{
  seq: number
  type: 'user/message'
  message: {
    role: 'user'
    id: string
    text: string
    rpcId: string
  }
}
```

Only text blocks are joined. Images and every raw DSH-only field are omitted.

### Final assistant message

```ts
{
  seq: number
  type: 'assistant/message'
  turn: number | null
  step: number | null
  message: {
    role: 'assistant'
    id: string
    text: string
    provider: string
    model: string
  }
  usage: {
    inputTokens: number | null
    outputTokens: number | null
  }
}
```

Only final text blocks and minimal model attribution are exposed.

### Assistant chunk

```ts
{
  seq: number
  type: 'assistant/chunk'
  turn: number | null
  step: number | null
  chunk: {
    type: string
    index?: number
    blockType?: string
    text?: string
  }
}
```

C0 exposes visible text only for:

- `block-start` metadata;
- `text-delta` text;
- text `block-end` replacement.

Reasoning text, tool arguments/names, usage detail, finish replay data, raw provider response objects, and attachments are never projected.

## 5. Client authority and recovery

- Bootstrap is authoritative for history, session status, draft, write state, session identity, generation, and `asOfSeq`.
- Live SSE is applied only after the hello frame proves the configured session identity.
- A sequence gap, generation change, or reconnect forces a fresh bootstrap.
- Projected events are de-duplicated by monotonic sequence.
- A final `assistant/message` replaces the partial for the same turn/step.
- Incoming text keeps the viewport at the bottom only when it was already near the bottom; reading older history must not be interrupted.

### Pending mutation

Before POSTing a draft mutation, the client persists the exact body and target cursor in session-scoped DOM storage. A transport failure retries the same operation ID/body. A success or proven conflict clears the local pending record and refreshes bootstrap.

### Pending Send

Before POSTing Send, the client persists the exact body in session-scoped DOM storage. `prepared`, `dispatching`, and `unknown` states poll the same operation ID/body. Accepted settlement clears the local record, returns to Navigation, and bootstraps. Process/reply loss never creates a new Send ID.

## 6. Synthetic semantic controls

The debug bridge emits the same reducer input expected from future qualified physical bindings, with provenance `SYNTHETIC_DEBUG_CONTROL`.

| Synthetic control | C0 behavior |
| --- | --- |
| `COMMAND_SHORT` | toggle Navigation/Input |
| `RIGHT` / `LEFT` | move the Input draft cursor by word |
| `SECONDARY_SHORT` | paste native clipboard before current word |
| `COMMAND_LONG` | open Input command wheel |
| `DOWN` | select bottom Send sector while wheel is open |
| `COMMAND_RELEASE` | execute selected Send, or cancel if none |
| `SEND` | direct test alias for Send |
| `SECONDARY_DOUBLE` / `HUD_HIDE` | hide HUD |
| first control while hidden | wake only; consume the operation |

All other controls are traced as deferred and must not mutate state.

## 7. Host tests

Run from the repository root:

```bash
node --check plugins/dsh-glasses-plugin/lib/index.js
node --check plugins/dsh-glasses-plugin/lib/projection.js
node --check apps/glasses-android/app/src/main/assets/c0-core.js
node --check apps/glasses-android/app/src/main/assets/app.js
node plugins/dsh-glasses-plugin/test/projection.test.mjs
node apps/glasses-android/test/c0-core.test.mjs
node plugins/dsh-glasses-plugin/test/host-write-recovery.test.mjs
```

The existing host-write suite must remain green; C0 may not weaken Send transaction semantics.

## 8. Real-Rokid acceptance

Use u4090 USB ADB for build/install/observation and the private Rokid↔Spark route for product traffic.

### Baseline and rendering

1. Install the debug APK built from the exact C0 head.
2. Bootstrap one disposable text-producing session.
3. Verify retained user/assistant text renders chronologically.
4. Verify projected DOM/event objects contain no raw event payload, reasoning text, tool data, bearer token, or attachment bytes.

### Normal loop

Clipboard:

```text
Reply with exactly: C0 product loop passed
```

Drive:

```text
COMMAND_SHORT
SECONDARY_SHORT
COMMAND_LONG
DOWN
COMMAND_RELEASE
```

Prove:

- Input mode exposes the authoritative draft and word cursor;
- clipboard paste advances draft revision once and preserves automatic spacing;
- wheel selects Send only after DOWN;
- every pending Send poll uses the same operation ID/body;
- exactly one durable `user/message` has `source.rpcId == operationId`;
- assistant text appears first as projected chunks when available, then as one final message;
- final assistant text is nonempty;
- accepted clear increments the draft revision once, empties/unlocks it, and returns to Navigation;
- no rendered message or diagnostic sequence is duplicated.

### Restart/reconnect

- Force-stop/relaunch after acceptance: history and empty authoritative draft reconstruct without re-Send.
- Stop/restart the narrow proxy: bootstrap-first recovery restores the same messages with no duplicate sequence/message.
- Scroll away from the bottom before a new event: incoming output must not pull the viewport.
- Configure a wrong session: the existing hard-fail identity panel must still block all server content/streaming.

### Lost downstream response

Use the committed R0 delay fixture. After its upstream-complete marker but before the delayed response reaches the client, force-stop the app. On restart prove:

- the client recovers the session-scoped pending Send;
- bootstrap/server reconciliation reaches accepted;
- retry uses the exact same Send ID/body;
- durable user-message count remains one;
- the draft is empty and unlocked;
- assistant history reconstructs.

### Hidden HUD

Hide via `SECONDARY_DOUBLE`, then inject `SECONDARY_SHORT`:

- first operation only wakes the HUD;
- draft revision/text are unchanged;
- a second `SECONDARY_SHORT` performs the paste.

## 9. Evidence

Create:

```text
docs/evidence/tb0-c0-product-text-loop-2026-08-19.md
```

Record exact commits/APK/device, operation IDs, revision chain, durable rpcId counts, projected event examples, partial/final DOM evidence, restart/reconnect/lost-response results, viewport result, hidden-HUD result, and all remaining physical gaps.

## 10. Merge gate

C0 is merge-ready only when host tests pass and the real Rokid proves:

```text
clipboard → authoritative draft → same-ID Send → exactly-one user message
→ visible assistant output → final assistant message → restart/reconnect recovery
```

No physical function/touch binding is required or implied by C0.
