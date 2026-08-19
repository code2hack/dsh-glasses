# TB0-D1 — reproducible Rokid debug provisioning evidence

**Status:** runtime qualification **COMPLETE** (all D1 gates green).  
**Branch:** `tb0/repro-device-debug`.  
**Base:** `6f512aa39c9b1b496b89cd24c305a518997b0c26`.

## Exact tested artifacts

- Branch/head: `tb0/repro-device-debug` @ `d0fc8bbd4d78b2109c33d2c259928ab2b306b338` (implementation head `cd49498a2b812a2fdbd4fab55fb2ea1b16d3beb8`; AGENTS slice commit on top)
- Debug APK path/size/version: `apps/glasses-android/app/build/outputs/apk/debug/app-debug.apk`, 830,538 B, `versionName 0.1.0-g0`
- Build host: u4090 (x86-64, ANDROID_HOME=/opt/android-sdk, Gradle 8.7, AGP 8.5.2)
- ADB serial/model/fingerprint: 1906092617103125 / RG-glasses / Rokid/glasses/glasses:12/SKQ1.240613.001/1.23.009-20260725-150201:user/release-keys
- D0 runtime head/home/provisioning source: main `6f512aa…`; fresh e2e home `/tmp/dsh-glasses-d1-e2e-…` via `dev/d0-runtime.mjs up` (DSH 127.0.0.1:3198, proxy 0.0.0.0:3203); provisioning JSON piped over SSH stdin
- D1 helper Node version: u4090 nvm node v26.4.0 (`~/.nvm/versions/node/v26.4.0/bin`)

> Runtime-tested head: `d0fc8bbd4d78b2109c33d2c259928ab2b306b338`.
> Implementation head: `cd49498a2b812a2fdbd4fab55fb2ea1b16d3beb8`.
> `04b24a8…` and later commits: evidence/documentation only (no code drift after the tested head).

## Host checks

| Check | Result |
| --- | --- |
| `node --check dev/d1-rokid-debug.mjs` | **PASS** |
| Android `:app:assembleDebug` | **PASS** (830,538 B) |
| exact debug APK installed | **PASS** (adb install -r -t, Success) |
| debug-only clipboard Activity present | **PASS** (src/debug DebugClipboardSeedActivity) |
| release manifest does not contain clipboard Activity | **PASS** (grep absent in src/main/AndroidManifest.xml) |

## Provisioning

- D0 provisioning JSON piped through stdin: `cat /tmp/d1-up.json \| ssh u4090 node dev/d1-rokid-debug.mjs provision --stdin`
- bearer absent from remote argv: PASS (stdin-only transport)
- helper stdout/stderr bearer scan: PASS (0 hits; `bearerEmitted:false`)
- configure result: ok, device serial/package/pid 14897/model/fingerprint reported
- process restart: app relaunched by helper (pid 14897)
- endpoint equality: http://100.92.81.33:3203 matches provisioning endpoint
- expected-session equality: <disposable-session-id> matches provisioning session
- identityFailure: null
- streamVerified: **true** (generation mt0inar3-704226a5, lastSeq 2)
- selected WebView target title/url: "dsh-glasses C0", url file:///android_asset/index.html (CDP port 9334)
- ADB forward created/removed: helper forward (tcp:9334) created then removed; final `adb forward --list` empty

## Clipboard

Fixed phrase:

```text
D1 clipboard reproducibility passed
```

- Activity launch result: DebugClipboardSeedActivity launched via ADB; clipboard seeded from debug intent extra
- debug log row (count only): helper reads verified clipboard value via `GlassesBridge.clipboardText()`; length+SHA-256 only
- host input characters/bytes: 35 / 35
- host SHA-256: 70b425b6cb10d8e6ae1be5da64e5064e77ec29bfad0bf76333fe57167dad3194
- app-observed SHA-256: 70b425b6cb10d8e6ae1be5da64e5064e77ec29bfad0bf76333fe57167dad3194
- exact match: **true**
- stdout/stderr/logcat body-leak scan: PASS (`clipboardBodyEmitted:false`; no plaintext in helper output)

## Synthetic controls

Controls:

```text
COMMAND_SHORT
RIGHT
LEFT
```

Record:

- native `DSHGlassesBridge` log rows: `debug-semantic-control name=COMMAND_SHORT / RIGHT / LEFT source=SYNTHETIC_DEBUG_CONTROL` (pid 14897, three rows)
- provenance exactly `SYNTHETIC_DEBUG_CONTROL`: PASS (all three rows)
- before state: endpoint 3203, expectedSession cfbb4acf…, streamOpen true, streamVerified true, mode navigation, hudVisible true, sessionStatus idle, draft rev 0 empty unlocked
- after COMMAND_SHORT: mode input, native trace row captured
- after RIGHT: word/char motion applied, native trace row captured
- after LEFT: motion applied, native trace row captured
- no claim of physical qualification: NONE made (provenance is SYNTHETIC_DEBUG_CONTROL; physical rows remain unqualified)

## State output

- JSON parse result: parse ok; device/endpoint/session/stream/wheel/draft/action fields present
- device identity fields: serial 1906092617103125, package com.code2hack.glasses, pid 14897, model RG-glasses
- endpoint/session identity: http://100.92.81.33:3203 / <disposable-session-id>
- mode/HUD/write/draft fields: navigation, hudVisible true, writeState ready, draft rev 0 empty unlocked, cursorWord 0
- stream/generation/sequence fields: streamOpen true, streamVerified true, generation mt0inar3-704226a5, lastSeq 2
- bearer absent: yes (not emitted)
- clipboard body absent: yes

## Remaining gaps

- physical function-button short/long: unqualified;
- physical one-/two-finger touch/swipe: unqualified;
- final head-wheel semantics: unqualified;
- production enrollment/pairing: outside D1;
- Photo/Voice/Morse/tabs/Steer/Interrupt: outside D1.

## Verdict

**PASS — TB0-D1 gates green.** Provisioning reached `streamVerified=true` with
the bearer transmitted only on stdin (never argv/stdout/stderr); the debug-only
`DebugClipboardSeedActivity` seeded the Rokid clipboard from the debug source
set and the helper verified the exact SHA-256 (35 bytes) with no plaintext
leak; all three synthetic controls produced native
`DSHGlassesBridge debug-semantic-control … source=SYNTHETIC_DEBUG_CONTROL`
traces; and every helper-created ADB forward disappeared after the command
(final `adb forward --list` empty). No D1 evidence qualifies physical controls.
