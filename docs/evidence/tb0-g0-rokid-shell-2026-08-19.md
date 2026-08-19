# TB0-G0 glasses shell + real-device connectivity — evidence

**Outcome:** TB0-G0 core connectivity **PASS on real Rokid** (2026-08-19).
**Branch:** `tb0/glasses-shell` (base merge `c54833f`); draft PR #3.

## Tested APK / source head

- APK: `app-debug.apk`, `com.code2hack.glasses`, `versionName 0.1.0-g0`,
  `versionCode 1`, debug variant, framework-only deps (no AndroidX/coroutines).
  Built on u4090 (x86_64; AGP aapt2 Maven artifact is x86_64-only, so spark
  aarch64 is not a build host for this slice); spark's Gradle cache seeded the
  u4090 cache over LAN for the AGP 8.5.2 closure.
- Source head for on-device core tests: `542329f` (contains ChatGPT pre-install
  corrections through `2442e92`/`56f124d`/`2b9d6c8`/`a70fe17` plus worker
  compile-unblocks `122bce4` + `542329f`).
- Final cleanup head (proxy fix + mismatch blocking): `029781c` and later; the
  final rerun below installs from that head.

## Device

- u4090 USB ADB route (`ssh spark → u4090 → adb`); serial `1906092617103125`,
  model `RG-glasses`/`RG_glasses`, state `device`.
- Fingerprint (verified):
  `Rokid/glasses/glasses:12/SKQ1.240613.001/1.23.009-20260725-150201:user/release-keys`
  (matches expected).
- Tailscale: `com.tailscale.ipn` installed; identity `code2hack.github`
  preserved (never cleared/replaced). Rokid tailnet peer `100.87.122.122`.
- Endpoint: dedicated disposable DSH (loopback `127.0.0.1:3190`) + narrow dev
  proxy `dev/glasses-dev-proxy.mjs` on spark (`0.0.0.0:3200`), forwarding **only**
  `/glasses/v1/*`; `/api/*` → 403; no-token → 401. The proxy builds its upstream
  from the **validated pathname+query** only (never raw `req.url`), so
  absolute/authority-form request targets can never select another host;
  verified by the committed repeatable smoke `dev/glasses-proxy-smoke.mjs`
  (bootstrap→forwarded; `/api`→403, upstream untouched; `//other-host/...` and
  `http://other-host/...` → our upstream only). Proxy streams are bound to the
  downstream client lifetime: verified live (force-stop app → proxy upstream
  connections to `:3190` drop to 0 within 8s).

## Correctness wording (MVP-accurate)

The app is a **local-asset WebView** with external navigation blocked and a
**path-restricted native bridge** (`GlassesBridge`); it does not inspect the
calling frame's origin on every JS-interface invocation. The bridge keeps the
credential native-side (app-private storage), restricts requests to
`/glasses/v1/*`, and owns exactly one lifecycle-bound SSE connection.

## Verification runs (real Rokid)

- Install: `adb install -r -t` Success; package `versionName=0.1.0-g0`.
- Tailscale recovery (mandatory route): Rokid was offline → launched
  `com.tailscale.ipn` via ADB, UI "Not connected" + Connect tapped → "Connected";
  spark confirmed `pong` + `active`.
- Provisioning: ADB-led (WebView CDP over the forwarded
  `webview_devtools_remote` socket); credential only in app-private prefs.
- Bootstrap render: protocol 1, generation `mszrpmnz-e…`, asOfSeq 2→11,
  attachment status `unavailable`→`idle`, `writeState ready`, session panel
  (session id, protocol, generation, asOfSeq, status, write state) visible.
- Live SSE: one durable event via host `session.prompt` from an independent DSH
  surface → on-device asOfSeq 2→11, nine `projection-applied` rows, each exactly
  once; CDP `#events [data-seq]` no duplicates.
- Controlled reconnect: proxy stop → `stream-state error|closed` →
  `reconnect-scheduled` backoff; proxy start → `bootstrap-applied` →
  `stream-state open` → `recovery-start{reason:stream-open}` → second
  authoritative snapshot → `recovery-complete`; no duplicates.
- App restart (no reprovision): configuration restored from app-private prefs,
  view reconstructed (`bootstrap-applied asOfSeq:11` → `recovery-complete`).
- Session identity mismatch → **hard fail, verified on device** (final APK from
  head `80add8d` incl. `7f5e3b8`/`b785820`/`64aa4e8`/`8f94419`): with
  `session-00000000-...` stored in app-private prefs and a fresh app process,
  the app logged `configuration-loaded` (expected 0000...) -> `transport-stopped
  reason=session-mismatch` -> `DSH_G0 session-mismatch {expected:0000...,
  actual:47d0..., source:bootstrap}`; DOM showed the `identity-error` panel
  (display:block) with expected/actual, `conn=session-mismatch`, and server
  content hidden. Not silently displayed. (Note: in-page `location.reload()` is
  blocked by the app's own external-nav guard, so identity changes apply via a
  fresh app process.)
- Final rerun (abbreviated real-device bootstrap): final APK
  (`app-debug.apk` 815904 B, built from `80add8d`) installed Success, launched,
  bootstrap rendered (protocol 1, gen, asOfSeq 11, status idle, writeState
  ready), `conn: live`.

## Non-manual input facts (per TB0-I0 gate; ADB-captured, not physical presses)

- `/proc/bus/input/devices`:
  - `event0` name `qpnp_pon` (power): KEY = `800 4000000000000 0`;
    `getevent -lp` capabilities: KEY_VOLUMEDOWN, KEY_MENU.
  - `event1` name `ROKID,PSOC-TP-R` (I2C touch panel): KEY =
    `1400 180000040300000 168000000000 10000000`;
    `getevent -lp` capabilities: KEY_ENTER, KEY_UP, KEY_LEFT, KEY_RIGHT,
    KEY_DOWN, KEY_PROG1, KEY_PROG2, KEY_BACK, KEY_F13, KEY_F14, KEY_PROG3,
    KEY_DASHBOARD.
- `dumpsys input`: 3 input devices; `ROKID,PSOC-TP-R` present with touch/key
  sources; qpnp_pon keyboard-type 1.
- `dumpsys sensorservice`: **Game Rotation Vector** (QTI; wake + non-wake),
  gyroscope `icm4x6xx` (TDK), accelerometer (+uncalibrated), linear accel —
  rotation-vector head-pose path available for the later wheel.
- Rokid packages present: `com.rokid.os.sprite.launcher`, `.live`, `.record`,
  `.master.screenstream`, `.assistserver`, `com.rokid.glass.ota`,
  `com.rokid.sysconfig`, `com.rokid.cxrservice`.
- Raw tracer warm-up (same OS dispatch path as physical presses; synthetic):
  `DISPATCH_KEY DOWN/UP` (keyCode incl. symbolic, scanCode, repeat, meta, flags,
  source, device id/name, monotonic down/event/observed uptimes,
  `nativeEffect=unknown`) and `DISPATCH_TOUCH` (pointer count/id, x/y, pressure,
  tool type, source `0x1002`, history). Worked on-device.
- Prior/reference (NOT a physical trace from this APK): local design notes
  `docs/01-brainstorm-rokid-input-and-protocol.md` (untracked) document the
  official Rokid Glass3 SDK button events (`BUTTON_ONE_CLICK`, broadcast
  `com.rokid.glass3.action.button.CLICK`, `ACTION_BUTTON_DOWN/UP`). No archived
  Poker-Dealer hardware-trace file is present in this repo.

## Not yet hardware-qualified → TB0-I0

- physical function-button **short press**
- physical function-button **long press**
- physical **two-finger** short touch

These require a genuine physical press, which cannot be automated over USB ADB.
They are an explicit qualification gate (TB0-I0) and are **not** claimed as
passed. Bounded `DSHGlasses` captures are armed for when a physical press is
performed; `nativeEffect` stays `unknown` until separately correlated with
lifecycle/focus/system logs.
