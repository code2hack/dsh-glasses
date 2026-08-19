# TB0-G0 glasses shell + real-device connectivity — evidence

**Status:** bootstrap/SSE/reconnect/restart proven on the real Rokid (2026-08-19); raw physical presses pending hardware-qualification.  
**Branch:** `tb0/glasses-shell` (base merge `c54833f`).

## Base / tested commits

- Base: `c54833f` (merged `main`; PR #1 read proof, PR #2 host write).
- Initial shell: `a2ef7cb`; evidence scaffold: `9147688`.
- Worker-control rules: `a673eb6`.
- ChatGPT pre-install corrections through `2442e92`:
  - framework-only Android dependencies; no undeclared coroutines;
  - lifecycle-safe authenticated bridge and one owned SSE connection;
  - non-invasive key dispatch (`super.dispatchKeyEvent` preserved);
  - non-assertive native-side-effect tracing;
  - bootstrap/SSE race closure, sequence de-duplication, clean-close reconnect;
  - session-mismatch check and visible session projection;
  - bounded WebView console/resource diagnostics;
  - downstream-lifetime-bound narrow proxy stream.
- The Gradle/APK build started before these corrections is obsolete and MUST NOT
  be installed. Rebuild from current `origin/tb0/glasses-shell`.
- APK variant: debug (`app-debug.apk`, versionName `0.1.0-g0`).

## Device (u4090 USB ADB route)

- Host: u4090 (`100.103.206.123`), route `ssh spark → u4090 → adb`.
- Serial: `1906092617103125`; model `RG-glasses`/`RG_glasses`; state `device`.
- Fingerprint (verified 2026-08-19):
  `Rokid/glasses/glasses:12/SKQ1.240613.001/1.23.009-20260725-150201:user/release-keys`
  (matches expected).
- Tailscale installed on device: `com.tailscale.ipn` (identity NOT touched).
- Spark tailnet: `100.92.81.33`; Rokid tailnet peer `100.87.122.122`
  (`pong via DERP(hkg)` confirmed 2026-08-19). No credentials recorded.

## Endpoint topology (private only)

- Dedicated disposable DSH instance: `DSH_HOME=/tmp/dsh-tb0-home`,
  `dsh --profile web --host 127.0.0.1 --port 3190` (loopback only; the harness
  intentionally refuses `--host 0.0.0.0` for RCE safety).
- Narrow dev proxy `dev/glasses-dev-proxy.mjs` bound `0.0.0.0:3200`, forwarding
  **only** `/glasses/v1/*` to the loopback listener. Everything else, including
  `/api/*`, returns `403`.
- Verified before APK: bootstrap `200` through
  `100.92.81.33:3200/glasses/v1/bootstrap`; `/api/*` → `403`; no bearer → `401`;
  SSE `hello` passes through.
- G0 session is supplied only through `DSH_GLASSES_TB0_SESSION_ID` and is not
  committed.

## Bootstrap / SSE (verified pre-APK)

- Bootstrap: `ok:true`, protocolMajor 1, rotated `serverGeneration`,
  `attachment.status`, `history.asOfSeq`, minimal projections, and `writeState`.
- SSE: heartbeat + `projection` frames.
- Client recovery is bootstrap-first. Once SSE reports open, the WebView takes a
  second authoritative snapshot to close the bootstrap→subscribe race, then
  de-duplicates queued stream events by sequence.
- Any stream close/error schedules bounded reconnect; sequence or generation
  gaps trigger another bootstrap.

## Raw input table (real-device traces pending)

`nativeEffect` in app logs remains `unknown`; native Rokid side effects are
recorded separately from observed system/UI behavior and MUST NOT be inferred
merely because the app received an event.

| Interaction | dispatch callbacks | keyCode/scan | pointer data | monotonic timing | separately observed native side effect |
|---|---|---|---|---|---|
| function button short press | pending | | | | |
| function button long press | pending | | | | |
| two-finger short touch (`SECONDARY` candidate) | pending | | | | |
| head-pose availability | pending | | | | |

## Remaining gates

- Fetch current branch and rebuild the corrected APK on u4090.
- Install through verified USB ADB; launch; provision endpoint/session/token into
  app-private storage without recording the token.
- Verify visible bootstrap projection on the physical Rokid.
- Cause one independent durable DSH event and verify its exact SSE sequence.
- Break and restore the product network route; prove bootstrap-first recovery
  with no duplicate visible sequence.
- Force-stop/restart the app and prove reconstruction.
- Capture bounded `DSHGlasses`/`DSHGlassesBridge` logs for the required physical
  interactions and correlate any native operation separately.
- Inspect real sensor availability for the later head-navigation wheel.
- Open draft PR `tb0: connect the Rokid glasses shell` after the corrected shell
  first boots on-device.


## On-device verification results (2026-08-19)

APK: `app-debug.apk` `0.1.0-g0` (AGP 8.5.2, Kotlin 1.9.24, no AndroidX), built on
u4090 (x86_64; spark is aarch64 and AGP's aapt2 Maven artifact is x86_64-only).
Compile-unblock fixes on the branch (upstream KDoc nested-comment bug + BuildConfig
gate): `122bce4`, `542329f`. Draft PR: https://github.com/code2hack/dsh-glasses/pull/3.

- Install: `adb install -r -t` Success; `versionName=0.1.0-g0`, `versionCode=1`.
- Launch: lifecycle `onCreate/onResume/windowFocus` logged; WebView `DSH_G0 init`.
- Provisioning: via ADB + WebView CDP (debug socket forwarded over u4090 USB ADB);
  credential stored in app-private `shared_prefs/glasses_private.xml` (never Git).
- Tailscale recovery (mandatory route): Rokid was offline (last seen 1h) → launched
  `com.tailscale.ipn` via ADB, UI showed "Not connected" + blue Connect → tapped →
  "Connected"; identity `code2hack.github` preserved; spark verified `pong` + `active`.
- Bootstrap (on-device renders): protocol 1, generation `mszrpmnz-e…`, asOfSeq 2→11,
  attachment status `unavailable`→`idle`, `writeState: ready`, event rows `[11…0]`.
- Live SSE (independent DSH surface): one `session.prompt` durable event via host RPC
  → on-device asOfSeq 2→11, nine `projection-applied` rows, each exactly once,
  no duplicate seqs (CDP DOM `[data-seq]` assert).
- Controlled reconnect: proxy stop → `stream-state error|closed` → `reconnect-scheduled`
  with backoff; proxy start → `bootstrap-applied` → `stream-state open` →
  `recovery-start{reason:stream-open}` → second authoritative snapshot →
  `recovery-complete`; no duplicates.
- App restart: force-stop → relaunch (no reprovision) → configuration restored from
  app-private prefs → `bootstrap-applied asOfSeq:11` → `recovery-complete`.
- Raw tracer warm-up (same OS dispatch path as physical presses): synthetic
  `DPAD_CENTER`, `ENTER`, tap → `DISPATCH_KEY DOWN/UP` (keyCode, scanCode 0, repeat,
  meta, flags, source, device `Virtual`, monotonic down/event/observed uptimes,
  `nativeEffect=unknown`) and `DISPATCH_TOUCH` (pointerCount, id, x/y, pressure, tool,
  source `0x1002`, history). Full example lines in `~/tmp/dsh-glasses-ADB/g0/g0-input-log.txt`.
- Head pose: `dumpsys sensorservice` lists `Game Rotation Vector` (QTI, wake+nw),
  gyroscope `icm4x6xx` (TDK), accelerometer(+uncalibrated), linear accel — rotation
  vector available for the later wheel.

## Not yet hardware-qualified (physical presses cannot be automated over ADB)

- Function-button short press; function-button long press; two-finger short touch.
  ADB can inject the same OS dispatch path (synthetic warm-up captured above), but
  REAL button/touch hardware evidence needs a physical press; recorded here per
  AGENTS §15 rather than interrupting code2hack. Bounded captures are ready.

## Proxy upstream-lifetime verification (2026-08-19)

Direct test of the corrected narrow proxy (`2b9d6c8`, streams bound to client
lifetime): while the Rokid app was streaming, the proxy process owned exactly 1
established upstream connection to the disposable DSH (`ss` owner pid matched
the proxy). After `adb shell am force-stop` of the app (downstream gone, proxy
still running), the proxy's upstream connections to `127.0.0.1:3190` dropped to
**0** within 8 s — no orphaned upstream SSE. Launched again → `conn: live`,
session panel restored, asOfSeq 11, rows `[11..0]` with no duplicates.
