# TB0-I0 Rokid physical input qualification — evidence

**Outcome:** qualification matrix below; physical-only rows remain **unqualified**
(genuine physical presses are required and are NOT automated over ADB). Supporting
facts (device nodes, synthetic paths, prior same-firmware records) are recorded
here as reference, explicitly NOT as new dsh-glasses physical traces.
**Branch:** `tb0/i0-input`, base `main` merge `96da64e` (TB0-G0).
**Date:** 2026-08-19.

## Qualification matrix

| Control candidate | Current APK physical trace | Synthetic path | Prior same-firmware evidence | Status |
| --- | --- | --- | --- | --- |
| function short | pending | tested (KEYCODE_PROG1 via `adb input keyevent 188`; captured by tracer) | not available in Poker-Dealer records found | unqualified |
| function long | pending | tested (key DOWN + delayed UP path; tracer rows) | **available** — Poker-Dealer long-press 2026-08-16: `KEYCODE_NOTIFICATION down/up` then `KEYCODE_PROG_BLUE down` → native `launchRokidAI` ordered broadcast `ACTION_AI_START ordered=true abort=true` | unqualified |
| one-finger touch/swipes | pending | tested (injected swipe; `DISPATCH_TOUCH` MOVE/UP pointer rows captured) | not available in Poker-Dealer records found | unqualified |
| two-finger touch/swipes | pending | not tested (adb `input` is single-pointer; multi-touch `sendevent` deferred) | not available in Poker-Dealer records found | unqualified |
| head pose | sensor-qualified (Game Rotation Vector QTI wake+non-wake, gyroscope `icm4x6xx`, accelerometer; see G0 evidence) | replay not tested | n/a (no prior head-pose record) | partially qualified |

## Prior same-firmware reference (Poker-Dealer, citation only)

- Record: `Poker-Dealer/.worktrees/issue-64/docs/evidence/rg-m4-pairing-long-press-2026-08-16.md`
  (spark path `/home/code2hack/Projects/glasses/Poker-Dealer/.worktrees/issue-64/docs/evidence/rg-m4-pairing-long-press-2026-08-16.md`).
- Tested production package: `com.code2hack.poker`, commit `b4b303b…`.
- Device: Android 12 / API 32, build `SKQ1.240613.001` `release-keys` (same platform
  family as the dsh-glasses target firmware `SKQ1.240613.001/1.23.009-20260725-150201`).
- Physical long-press sequence (verbatim): `KEYCODE_NOTIFICATION down 17:33:47.524`;
  `KEYCODE_NOTIFICATION up 17:33:47.547`; `KEYCODE_PROG_BLUE down 17:33:48.024`;
  `launchRokidAI true; ordered broadcast sent`; `PokerAiLongPress exact
  ACTION_AI_START ordered=true abort=true`.
- Extracted facts: key identity (NOTIFICATION, PROG_BLUE), native side effect
  (Rokid AI ordered broadcast with abort), rough timing (down/up deltas), device
  nodes used (documented in Poker-Dealer record). **Cited as prior reference only —
  never as a trace produced by the new dsh-glasses APK.**

## Supporting non-physical facts (not a substitute for physical traces)

- Device nodes (from TB0-G0 evidence): `event1 ROKID,PSOC-TP-R` capabilities
  KEY_ENTER/UP/LEFT/RIGHT/DOWN, KEY_PROG1/2/3, KEY_BACK, KEY_F13/F14,
  KEY_DASHBOARD; `event0 qpnp_pon` KEY_VOLUMEDOWN/KEY_MENU. Full getevent -lp in
  G0 evidence (documented in `docs/evidence/tb0-g0-rokid-shell-2026-08-19.md`).
- `dumpsys input` (3 devices), `dumpsys sensorservice` (Game Rotation Vector +
  gyro), Rokid package inventory — recorded in G0 evidence.
- Tracer foundation is non-invasive: delegates events after logging; captures
  action/key/scan/source/device/pointer/pressure/tool and monotonic up/down/observed
  uptimes; `nativeEffect=unknown` until separately correlated.

## Passive capture (armed)

A long-lived passive recorder is running on u4090 to catch an **incidental** real
physical interaction without interrupting the user:

- rotates `logcat -v threadtime DSHGlasses:I` into
  `~/tmp/dsh-glasses-ADB/i0/passive-logcat.txt`;
- periodically samples `getevent -lt /dev/input/event1` into
  `~/tmp/dsh-glasses-ADB/i0/passive-getevent.txt`.

Once a genuine physical short/long press or two-finger touch occurs, the tracer
rows + raw device deltas will be correlated with lifecycle/focus/system logs and
the matrix rows above will be promoted from "pending" to recorded, then
re-qualified.

## Explicit boundary

Physical-only controls are **NOT claimed passed**. Synthetic ADB events,
`/dev/input` capability listings, prior Poker-Dealer records, and sensor
inventories are supporting evidence only and cannot close the hardware gate.

## Debug semantic-control injection seam (next-slice continuation)

A **debug-only** semantic-control injection seam was added (same branch) so future
work can exercise semantic controls without hardware: `GlassesBridge.debugSemanticControl(name)`
(no-op unless DEBUG; logs `debug-semantic-control <name>` and delivers
`window.glassesOnSemanticControl(name)` → traced `semantic-control-injected
{source:"debug-seam",name,time}`). It deliberately does NOT touch physical
bindings; TB0-I0 physical rows remain unqualified.
