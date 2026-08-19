# TB0-C0 — one-session product text loop evidence

**Status:** runtime qualification **COMPLETE** (real Rokid).
**Branch:** `tb0/product-text-loop`.
**Base:** `bed16e771f6f99a1672a98e5c8f15bfb12ae0df2`.
**Target:** Rokid serial `1906092617103125`, model `RG-glasses`, firmware `Rokid/glasses/glasses:12/SKQ1.240613.001/1.23.009-20260725-150201:user/release-keys`.

## Exact tested artifacts

- Branch/head (exact tested APK source): `tb0/product-text-loop` @ `bdc71122780416dcf307c89490dabdce4f853e5e` (direct parent `2764671b4cf8e9e6955fd6f1f3d28bac6a112671`; the only delta is the apps/ CSS blinking-cursor change)
- Tested APK: `apps/glasses-android/app/build/outputs/apk/debug/app-debug.apk`, 829,492 bytes, `versionName=0.1.0-g0`, `versionCode=1`, built on u4090 from the exact head above and `adb install -r -t` = Success
- Installed disposable plugin copy/head: the disposable profile holds an npm `file:` copy at `/tmp/dsh-tb0-home/profiles/web/node_modules/dsh-glasses-plugin`; the pre-C0 copy (02:13) lacked `projection.js`, so the installed copy was refreshed with the C0 `lib/` from the `tb0/product-text-loop` checkout (index.js + projection.js; bdc7112 changes only apps/ CSS, so the plugin copy is identical for the exact head). The Rokid wire projection used = that refreshed copy.
- Build host: u4090 (x86_64, `ANDROID_HOME=/opt/android-sdk`, Gradle 8.7, AGP 8.5.2) — installed via `adb install -r -t` = Success
- Device: serial `1906092617103125`, model `RG-glasses`, fingerprint `Rokid/glasses/glasses:12/SKQ1.240613.001/1.23.009-20260725-150201:user/release-keys`
- Disposable DSH: `@deepseek-ai/dsh@0.1.0-rc.7`, profile `web`, instance `:3192` (`DSH_HOME=/tmp/dsh-tb0-home`)
- Session: `<disposable-session-id>` (fresh, tool-less preset `a0-toolfree`)
- Provider/model: `tb0vllm` (api `openai-completions`, `http://192.168.100.11:8887/v1`) → `lfm2.5-vl-3b` (keyless + dummy `TB0VLLM_API_KEY=dev-keyless-a0`; no real credential)
- Product endpoint topology: app WebView `configure(base=http://100.92.81.33:3200)` → `dev/glasses-dev-proxy.mjs` (0.0.0.0:3200) → `127.0.0.1:3192`; lost-response leg via `dev/r0-delay-proxy.mjs` (:3210, 20 s actions delay) → `:3192`

### Host tests (all PASS)

| Test | Result |
| --- | --- |
| `node --check` ×4 (index.js, projection.js, c0-core.js, app.js) | PASS |
| `node plugins/dsh-glasses-plugin/test/projection.test.mjs` | PASS |
| `node apps/glasses-android/test/c0-core.test.mjs` | PASS |
| host-write recovery suite (`DSH_HOME=/tmp/dsh-tb0-home`, `PORT=3195`, seeded `session-tb0-disposable`) | ALL PASS (16 scenarios) |
| Android debug build on u4090 (exact head bdc7112) | PASS (829,492 B) |

Note on the host-write run environment: the suite reads `DSH_HOME` from the
environment and `readSession` throws for a missing session, so it must run with
`DSH_HOME=/tmp/dsh-tb0-home` and the fixture session `session-tb0-disposable`
pre-created (a runtime accommodation, no repo change). Also the disposable
profile's installed plugin copy had to be refreshed to the C0 lib (the profile
holds an npm `file:` copy; the pre-C0 copy lacked `projection.js` and served the
old `{seq,type}` projection — after copying the C0 `lib/` over it, the wire
contract matched the app).

### Normal loop (exact-head, clean 0 → 1 → 2) — fresh disposable session

Fresh session `<disposable-session-id>` (asOf 2, draft rev 0, empty, unlocked).
Android clipboard seeded to the fixed test phrase (throwaway debug fixture, later
uninstalled). Controls via `window.glassesOnSemanticControl(name, "SYNTHETIC_DEBUG_CONTROL")`.

```
boot          NAV  · rev 0 · ready           chat empty
COMMAND_SHORT      -> INPUT · rev 0 · ready
SECONDARY_SHORT    paste  -> rev 1 · ready · "Draft committed" · draft text = phrase
  (whole-word cursor present; cursor-end class, computed opacity alternates
   1 -> 0 -> 1 -> 0 -> 1 over ~2.4 s = blinking verified; visibility visible)
COMMAND_LONG       wheel · "DOWN selects SEND · release cancels"
DOWN               "wheel · SEND selected · release COMMAND"
COMMAND_RELEASE    send  -> NAV · idle · draft cleared
```

Durable (exact-head clean run):
- one Send operation ID `c0-send-223a5201-84d4-4c6e-81ab-429296740d44` (state **accepted**; exactly **one** plugin op);
- paste mutation `c0-mut-94a0f6cd-1535-4789-9669-c8eda192e418` (draft 0 -> 1);
- exactly **one** durable `user/message` (`source.kind=user`, `source.rpcId=c0-send-223a5201-…`, seq 8, text the fixed phrase);
- exactly **one** `assistant/message` (seq 22, text `C0 product loop passed`, provider `tb0vllm`, model `lfm2.5-vl-3b`);
- accepted clear: draft **revision 2**, text **empty**, **locked false** (sent rev 1 -> cleared rev 2);
- chat renders exactly two articles (user seq 8, assistant seq 22); no duplicate messages or event sequences; final mode **Navigation**.

(Earlier pre-review exploratory turns on an earlier disposable session produced
additional revisions/turns while the seven-leg matrix was captured; the evidence
above is the clean chain the exact-head regression proves.)

### Restart/reconnect

`am force-stop` then relaunch: all retained user/assistant texts reconstruct
chronologically (chat seqs 8,23,31,42), no re-Send (no new durable
user/message), draft remains empty at the authoritative revision.

### Viewport preservation

After growing history to 16 articles (scrollHeight 873/clientHeight 469),
scrolled the chat to top (top=0, distance-to-bottom 496 px) and sent a new turn:
the incoming streamed/final output appended below while `scrollTop` stayed at 0
(distance-to-bottom grew to 525 px) — no pull-to-bottom when reading older
history. Near-bottom stickiness remains active when already at the bottom.

### Hidden HUD (wake-only)

In INPUT mode: `SECONDARY_DOUBLE` → HUD hidden (`body.hud-hidden`). First
`SECONDARY_SHORT` → **"HUD awake · operation consumed"**, draft revision/text
unchanged (still rev 4). Second `SECONDARY_SHORT` → paste performed
("Draft committed", rev 5).

### Identity mismatch

Configured `session-00000000-…` (wrong id): app entered **SESSION MISMATCH**
hard-fail — "Transport is stopped and endpoint content is hidden"; no server
content or streaming. Reconfiguring the correct session restored the surface.

### Lost downstream response (R0 delay fixture)

App pointed at `:3210` (r0-delay-proxy, 20 s `/actions` response delay). The
wheel-send op `c0-send-8156bd23-9d64-4fa9-bf42-3a4ea2ece3fd` completed upstream
(marker `{"op":…,"upstreamStatus":202/200,"marker":"upstream-complete"}` fires
before the delayed downstream response returns). The app was force-stopped while
still in "Send response unknown · same-ID retry 2". On relaunch:
- pending Send recovered from session-scoped storage, retried with the **same**
  operation ID/body;
- bootstrap/server reconciliation reached **accepted** (op state accepted);
- durable `user/message` count for that op = **exactly 1** (no re-Send);
- draft empty and unlocked (rev 6);
- assistant history reconstructs (chat seqs …49 user, 59 assistant).

The restart/reconnect, viewport, hidden-HUD, identity-mismatch, and
lost-downstream legs below were captured on the 2764671-built APK (product code
identical to the exact head except the apps/ CSS cursor animation, which the
exact-head clean regression above re-verifies).

## Projection qualification (sanitized examples)

```json
{"seq":31,"type":"user/message",
 "message":{"role":"user","id":"<uuid>","text":"Reply with exactly: C0 product loop passed","rpcId":"c0-send-…"}}

{"seq":42,"type":"assistant/message","turn":1,"step":1,
 "message":{"role":"assistant","id":"<uuid>","text":"C0 product loop passed","provider":"tb0vllm","model":"lfm2.5-vl-3b"},
 "usage":{"inputTokens":31,"outputTokens":6}}

{"seq":13,"type":"assistant/chunk","turn":1,"step":1,"chunk":{"type":"block-start","index":0,"blockType":"text"}}
(… text-delta …) {"chunk":{"type":"text-delta","index":0,"text":"C0 product "}}
(… block-end …)  {"chunk":{"type":"block-end","index":0,"block":{"type":"text","text":"C0 product loop passed"}}}
```

A scan of the served bootstrap/stream found NO credentials, `replayState`,
reasoning text, tool fields, raw event data, or attachment bytes in projected
events (the only `attachment` occurrence is the protocol resume header
`attachment:{attachmentId, sessionId, status}`).

#
## Validation directive follow-up (Worker validation, PR #10 draft)

Re-run from the exact PR head `05faafe060547f207ccf3bb1ee21f36a772706d9`:

- Every host command in `docs/TRACER_BULLET_TB0_C0.md` §7: `node --check`
  (index.js, projection.js, c0-core.js, app.js) OK; `projection.test.mjs`
  PASS; `c0-core.test.mjs` PASS; host-write recovery suite **ALL PASS**
  (16 scenarios). No syntax/test failure encountered.
- Normal synthetic loop driven **through `GlassesBridge.debugSemanticControl`**
  (native bridge, `source=SYNTHETIC_DEBUG_CONTROL`): logcat (DSHGlassesBridge,
  pid 14652) records all five controls
  `COMMAND_SHORT / SECONDARY_SHORT / COMMAND_LONG / DOWN / COMMAND_RELEASE`.
  Result on the fresh session: paste rev 2->3, wheel SEND, exactly one durable
  `user/message` for the send op `c0-send-2947a32a-070d-462b-b82…` (seq 30),
  one `assistant/message` (seq 40, `C0 product loop passed`), accepted clear to
  rev 4 (empty, unlocked), final mode Navigation, chat seqs 8/22/30/40 with no
  duplicates.
- Restart, proxy reconnect, viewport preservation, hidden-HUD wake-only,
  wrong-session hard-fail, and actual-client lost-response recovery remain
  verified on the same product code (see earlier sections; the exact-head
  regression re-ran the normal loop + cursor blink on `bdc7112`).

Primary evidence used: structured native (logcat DSHGlassesBridge), plugin
(state/ops), CDP (body/DOM/chat), and complete durable-log correlation.

## Remaining physical gaps

No production function/touch binding is exercised or implied by C0; physical
rows remain unqualified. The passive recorder remains armed.
