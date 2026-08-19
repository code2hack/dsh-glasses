# TB0-I0 Rokid physical input qualification — evidence

**Outcome:** automatable input plumbing is under qualification; all physical-only bindings remain **unqualified** until genuine hardware traces are captured.  
**Branch:** `tb0/i0-input`.  
**Base:** `6d1e1925b967cda3c19731decc570d02da2c9c6d` (`main`, including final G0 regression evidence).  
**Date:** 2026-08-19.  
**Target:** serial `1906092617103125`; fingerprint `Rokid/glasses/glasses:12/SKQ1.240613.001/1.23.009-20260725-150201:user/release-keys`.

## Evidence provenance labels

Every interaction claim MUST use exactly one label:

- `PHYSICAL` — a genuine Rokid hardware interaction captured by the current APK and synchronized low-level/framework tracers;
- `SYNTHETIC_ADB` — Android framework-level injection such as `adb shell input`;
- `SYNTHETIC_SENDEVENT` — Linux input injection through a debug-only path;
- `PRIOR_REFERENCE` — official Rokid or Poker-Dealer evidence from the same firmware/device family.

Only `PHYSICAL` evidence can close a physical-control row.

## Qualification matrix

| Control candidate | Current APK physical trace | Synthetic path | Prior same-firmware evidence | Status |
| --- | --- | --- | --- | --- |
| function short | pending | `SYNTHETIC_ADB`: KEYCODE_PROG1 (`adb input keyevent 188`) reached the non-invasive tracer | no usable Poker-Dealer short-press record found | **unqualified** |
| function long | pending | `SYNTHETIC_ADB`: key DOWN plus delayed UP reached the tracer | `PRIOR_REFERENCE`: Poker-Dealer physical long press produced NOTIFICATION then PROG_BLUE and native `ACTION_AI_START` | **unqualified** |
| one-finger touch/swipes | pending | `SYNTHETIC_ADB`: injected swipe produced `DISPATCH_TOUCH` MOVE/UP rows | no usable Poker-Dealer record found | **unqualified** |
| two-finger touch/swipes | pending | not tested; Android `adb input` is single-pointer and low-level multi-touch injection is deferred | no usable Poker-Dealer record found | **unqualified** |
| head pose | physical input binding not applicable to availability; dynamic delivery test pending on this branch | `SYNTHETIC_ADB` inventory: Game Rotation Vector + gyro available; replay pending | n/a | **partially qualified** |

## Prior same-firmware reference (`PRIOR_REFERENCE` only)

- Source record: `Poker-Dealer/.worktrees/issue-64/docs/evidence/rg-m4-pairing-long-press-2026-08-16.md`.
- Tested package: `com.code2hack.poker`, commit `b4b303b…`.
- Device family: Android 12/API 32, build `SKQ1.240613.001 release-keys`, matching the dsh-glasses platform family.
- Recorded physical long-press sequence:
  - `KEYCODE_NOTIFICATION` down `17:33:47.524`;
  - `KEYCODE_NOTIFICATION` up `17:33:47.547`;
  - `KEYCODE_PROG_BLUE` down `17:33:48.024`;
  - native `launchRokidAI`; ordered `ACTION_AI_START` with abort.

This record informs hypotheses about key identity, timing, and native conflict. It is never represented as a trace produced by the current `dsh-glasses` APK.

## Supporting non-physical facts

- `/dev/input/event1`: `ROKID,PSOC-TP-R`; capabilities include ENTER, directional keys, PROG1/2/3, F13/F14, BACK, DASHBOARD.
- `/dev/input/event0`: `qpnp_pon`; capabilities include VOLUMEDOWN and MENU.
- `dumpsys input`: three input devices; PSOC touch/key source present.
- `dumpsys sensorservice`: Game Rotation Vector, gyroscope, accelerometer, and linear acceleration are available.
- The current `InputTracer` delegates events after logging and records action, key/scan/source/device, pointer/pressure/tool, monotonic down/event/observed times, lifecycle, and focus. `nativeEffect` remains `unknown` until separately correlated.

## Reproducible synchronized capture

`dev/i0-capture.sh` records one bounded window on u4090 using the verified USB ADB route. It captures:

- `getevent -lt` for event0 and event1;
- `DSHGlasses`, `DSHGlassesBridge`, and `DSHGlassesSensor` logs plus relevant system input/lifecycle logs;
- focused-window and resumed-Activity samples;
- input/sensor/package inventories;
- before/after screenshot and UI hierarchy;
- a manifest containing commit, device, firmware, host, and timing.

Each resulting interaction must be classified after capture; a capture window begins as `UNCLASSIFIED_CAPTURE_WINDOW` and is not physical evidence merely because the recorder was armed.

A long-lived passive recorder is also armed on u4090 to catch an incidental real interaction without interrupting the user. Its current PIDs/output directory and last health check must be recorded before PR settlement.

## Dynamic head-pose tracer

This branch adds debug-only `SensorTracer` instrumentation:

- registers `TYPE_GAME_ROTATION_VECTOR` and gyroscope while the Activity is resumed;
- logs sensor name/vendor/version, wake-up/reporting properties, sensor timestamp, observed `elapsedRealtimeNanos`, accuracy, and values;
- caps output at approximately 20 Hz;
- unregisters on pause/destroy;
- performs no scrolling, tab switching, anchoring, thresholding, or semantic action.

A real-device build/run must prove dynamic sample delivery before the head-pose row advances beyond inventory-only status.

## Debug semantic trace-injection seam

`GlassesBridge.debugSemanticControl(name)` is DEBUG-gated and delivers a bounded name to `window.glassesOnSemanticControl(name)`. In the current I0 branch the JavaScript handler records only a `semantic-control-injected` trace.

This proves bridge/JS notification plumbing only. It does **not** yet invoke a product reducer, mutate a draft, Send, or qualify a physical binding. Any later behavior driven through it must be labeled `SYNTHETIC_DEBUG_CONTROL`.

## Acceptance rule for physical rows

A physical binding may be frozen only after at least three consistent genuine trials prove:

- complete BEGIN/UPDATE-or-HOLD/END-or-CANCEL lifecycle;
- stable Linux event identity and Android mapping;
- short/long/double timing where relevant;
- focus/background cancellation behavior;
- whether a conflicting Rokid-native operation also fires;
- no unexplained divergence.

## Remaining gates

Before PR #6 is ready:

1. build/install the branch APK on u4090 and prove `DSHGlassesSensor` dynamic samples;
2. run `dev/i0-capture.sh` and record its healthy output directory/line counts;
3. update `AGENTS.md` to the active I0 branch/base;
4. retain the physical rows as unqualified unless genuine incidental interactions are captured;
5. record the exact tested commit/APK and all synthetic commands/results.
