# TB0-G0 glasses shell + real-device connectivity — evidence

**Status:** in progress (real-APK install and hardware trace pending).  
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
