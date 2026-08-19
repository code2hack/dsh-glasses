# TB0-C0 — one-session product text loop evidence

**Status:** runtime qualification pending.  
**Branch:** `tb0/product-text-loop`.  
**Base:** `bed16e771f6f99a1672a98e5c8f15bfb12ae0df2`.  
**Target:** Rokid serial `1906092617103125`, exact firmware fingerprint to be recorded from the tested run.

## Exact tested artifacts

- Branch/head:
- Plugin source head:
- APK path/size/version:
- Build host:
- Install result:
- Disposable DSH version/profile/session: `<disposable-session-id>`
- Provider/model/preset:
- Product endpoint topology:

## Host tests

| Test | Result |
| --- | --- |
| `node --check plugins/dsh-glasses-plugin/lib/index.js` | pending |
| `node --check plugins/dsh-glasses-plugin/lib/projection.js` | pending |
| `node --check apps/glasses-android/app/src/main/assets/c0-core.js` | pending |
| `node --check apps/glasses-android/app/src/main/assets/app.js` | pending |
| `node plugins/dsh-glasses-plugin/test/projection.test.mjs` | pending |
| `node apps/glasses-android/test/c0-core.test.mjs` | pending |
| host-write recovery suite | pending |
| Android debug build | pending |

## Projection qualification

Record sanitized examples for:

- projected `user/message`;
- projected `assistant/chunk` block-start, text-delta, text block-end;
- projected final `assistant/message`;
- generic lifecycle event;
- proof that reasoning text, tool-call fields, raw event data, attachments, and credentials are absent.

## Real-Rokid baseline

- USB ADB route/state:
- Tailscale/private product route:
- Bootstrap identity/generation/asOfSeq:
- Retained user/assistant messages rendered:
- DOM message count and sequence uniqueness:
- Session-mismatch regression:

## Normal product loop (`SYNTHETIC_DEBUG_CONTROL`)

Clipboard:

```text
Reply with exactly: C0 product loop passed
```

Controls:

```text
COMMAND_SHORT → SECONDARY_SHORT → COMMAND_LONG → DOWN → COMMAND_RELEASE
```

Record:

- mutation operation ID:
- draft revision before/paste acknowledgement:
- pasted authoritative text and cursor behavior:
- Send operation ID:
- all Send HTTP states/polls (same ID/body):
- durable `user/message.source.rpcId` count:
- accepted-clear revision/text/lock:
- partial assistant observed (DOM/MutationObserver/trace):
- final assistant message/text:
- mode after acceptance:
- duplicate message/sequence checks:

## Restart and reconnect

- force-stop/relaunch reconstruction:
- no re-Send proof:
- proxy stop/restart recovery:
- no duplicate messages/sequences:
- viewport-away-from-bottom result:

## Lost downstream response

- delay fixture command/port:
- mutation/Send operation IDs:
- upstream-complete marker timestamp:
- force-stop timestamp before downstream response:
- restart bootstrap/write state:
- exact same Send body retry:
- durable rpcId count after retry:
- draft and assistant-history reconstruction:

## Hidden HUD wake-only

- draft revision/text before hide:
- `SECONDARY_DOUBLE` result:
- first `SECONDARY_SHORT` wake-only result:
- unchanged draft proof:
- second `SECONDARY_SHORT` mutation result:

## Remaining gaps

- function-button short/long physical mappings: unqualified;
- one-/two-finger physical touch/swipe mappings: unqualified;
- Navigation-mode cursor and HUD-line movement: outside C0;
- selection/cut/replace: outside C0;
- Steer/Interrupt: outside C0;
- Photo/Voice/Morse/images/tabs: outside C0.

## Verdict

Pending.
