# TB0-M0 — ADB-only MVP acceptance evidence

**Status:** PASS (all M0 gates; evidence committed 2026-08-20).  
**Branch:** `tb0/adb-only-mvp-acceptance`.  
**Base:** `97dbec9f759efd4581dbb19c355aa5328f45793b`.  
**Runtime product-flow head:** `d705decd7fc3502769a1441083176b65ef445c73`.  
**D1 disambiguation + restart/hidden-HUD regression head:** `f4c6567d0ca8f84bf80f2fc47356f1618990094e`.  
**Later commits:** documentation-only corrections; no rerun required.  
**Session id:** `<disposable-session-id>` (sanitized; never committed real).

## Exact tested artifacts

- Branch: `tb0/adb-only-mvp-acceptance`.
- D0 runtime head/home/ports: `dev/d0-runtime.mjs`; home `/tmp/dsh-glasses-m0-e2e-20260819T211202Z`; DSH `127.0.0.1:3206`, proxy `0.0.0.0:3207` (loopback-only DSH, narrow proxy `3207 -> 127.0.0.1:3206`).
- Debug APK path/size/version: `apps/glasses-android/app/build/outputs/apk/debug/app-debug.apk`, 830,538 B (debug variant, same product code lineage as D1).
- Build host: u4090 (x86-64, RTX 4090), Gradle 8.7, ANDROID_HOME=/opt/android-sdk.
- ADB serial/model/fingerprint: `1906092617103125` / RG-glasses / `Rokid/glasses/glasses:12/SKQ1.240613.001/1.23.009-20260725-150201:user/release-keys`.
- D1 helper Node version (u4090): v26.4.0 (nvm).

## D0 clean-room runtime

- empty home: strict empty-home policy honored (`/tmp/dsh-glasses-m0-e2e-20260819T211202Z` fresh; `up` created workspace/session automatically).
- `up` result: ok, fresh session `<disposable-session-id>`, bootstrap asOf=2; DSH pid + narrow proxy pid owned by the runtime.
- direct bootstrap: HTTP 200.
- proxy bootstrap: HTTP 200.
- proxy `/api`: HTTP 403 (blocked).
- `status` before device flow: healthy.
- source/installed plugin digests: `sourcePluginMatches=true`, `installedPluginMatches=true` (both plugin-source `lib` and installed-path `lib` re-hashed).

## D1 provisioning

- provisioning transport: SSH stdin (bearer piped over stdin, never argv/stdout/stderr).
- bearer absent from argv/stdout/stderr: leak scan 0 hits.
- streamVerified: true.
- identityFailure: null.
- endpoint/session match: endpoint `http://100.92.81.33:3207` == D0 JSON; expectedSession == `<disposable-session-id>`.
- helper-created forward cleanup: `adb forward --list` empty after provision.

## Clipboard

Input:

```text
Reply with exactly: M0 ADB-only MVP passed
```

- characters/bytes: 42 / 42.
- host SHA-256: `d0bd1b393fc8fc3d3304a2443cce9f5da18c0207e45bea0b7465a2e313c3f12f`.
- app-observed SHA-256: identical.
- exact match: true.
- clipboard body emitted by tooling: false (`clipboardBodyEmitted=false`).

## Synthetic product flow

Controls (single `control` invocation):

```text
COMMAND_SHORT
SECONDARY_SHORT
COMMAND_LONG
DOWN
COMMAND_RELEASE
```

- provenance: `SYNTHETIC_DEBUG_CONTROL` (all steps).
- native debug-control trace rows: 5/5 in logcat, e.g.
  `DSHGlassesBridge: debug-semantic-control name=COMMAND_SHORT source=SYNTHETIC_DEBUG_CONTROL` … `name=COMMAND_RELEASE` (app pid 28730).
- final state after flow: mode=input → after COMMAND_RELEASE converged to writeState=ready, sessionStatus=running→idle after send; synthetic paste+send produced the durable result below.

## Durable result

- Send operation id: `<sanitized c0-send-…>`
- durable user/message count: **exactly 1** (seq 7).
- assistant/message count: **exactly 1** (seq 23).
- assistant text: `M0 ADB-only MVP passed` (exact).
- provider/model: tb0vllm / lfm2.5-vl-3b.
- draft revision transition: rev1 -> rev2.
- final draft text/lock: text `""`, locked false (monotonic draft clear to empty/unlocked).
- operation bookkeeping: 1 Send op, state `accepted`; no duplicates.

## Restart / reconnect

- app restart result: `am force-stop` + relaunch; helper reconnected.
- D1 state after restart: ok, same endpoint + expectedSession `<disposable-session-id>`, identityFailure null, writeState ready.
- user/message count after restart: 1.
- assistant/message count after restart: 1 (exact text preserved).
- duplicate user/assistant message detected: **NO**.
- firmware CDP mirror duplication observed: **YES** — device `/json` exposes multiple identical preferred page targets (`dsh-glasses C0`, `file:///android_asset/index.html`), stable across restarts; `/json/close` was rejected by the firmware.
- approved D1 disambiguation regression: state PASS on current duplicate set with `candidateCount=4`, `selectionReason=newest-live-document`; after force-stop/relaunch, state PASS with `candidateCount=3`, `selectionReason=newest-live-document`; subsequent helper invocations showed the firmware mirror set accumulating further (up to 8) while deterministic selection continued to succeed.

## D1 target-disambiguation patch (contract 5349445718)

- Probes each duplicate preferred target over CDP for non-secret liveness only (`typeof window.c0DebugState`, `document.readyState`, `visibilityState`, `hasFocus`, `performance.timeOrigin`, sanitized C0 signature: endpoint/expectedSession/generation/lastSeq/streamOpen/streamVerified/identityFailure/mode/hudVisible).
- Selection order: discard unconnectable/no-c0; unique; newest finite `timeOrigin`; visible+focus; equivalent firmware mirror (identical title/url + identical signature, lexicographic by target id); else preserve ambiguity with sanitized diagnostics.
- Reported selection metadata only: `candidateCount`, `selectionReason` (`unique | newest-live-document | focused-live-document | equivalent-firmware-mirror`).
- No websocket URLs, tokens, or clipboard bodies reported; forward cleanup unchanged in `finally`; no `/json/close` workaround.
- `node --check dev/d1-rokid-debug.mjs` OK.

## Hidden-HUD wake-only

- known starting state: mode=navigation, hudVisible=true, cursorWord=0, action=``.
- `SECONDARY_DOUBLE` result: hudVisible true→false, cursorWord unchanged (HUD hidden).
- first `RIGHT` result: hudVisible false→true, cursorWord unchanged, `action='HUD awake · operation consumed'` — the control was consumed by wake and did not reach its ordinary handler.
- second `RIGHT` result: hudVisible true, cursorWord remains 0, `action='Navigation word motion is outside C0'` — this proves the second control reached the ordinary Navigation handler rather than being wake-consumed again. C0 intentionally does not implement Navigation word motion, so no cursor-position change is expected in this mode.
- provenance: all three controls logged `source=SYNTHETIC_DEBUG_CONTROL`.

## Final health / hygiene

- D0 final `status`: healthy; digests match; bootstrap 200/200; proxy `/api` 403.
- helper-created ADB forwards remaining: none (`adb forward --list` empty).
- resident services modified: none (M0 disposable D0 only; resident DSH untouched).
- `down` x2: first down ok; second down harmless (`ok:true`); ports 3206/3207 freed; home dir preserved.
- physical-hardware qualification claimed: **NO** (all controls synthetic; no physical input).

## Verdict

**PASS — TB0-M0 ADB-only MVP acceptance gates all green.** The clean-room text loop produced exactly one durable user message and one exact assistant response, draft clear was authoritative and monotonic, restart/reconnect reconstructed exactly once, the D1 helper handled the firmware's duplicate CDP mirrors deterministically, hidden-HUD wake-only behavior was verified against the implemented C0 boundary, final D0 health/hygiene remained green, and no physical-hardware qualification is claimed.
