# TB0-I0 — Rokid input-plumbing qualification evidence

**Outcome:** automatable input plumbing is **qualified** on the target Rokid;
all physical function/touch bindings remain **unqualified** until genuine
hardware traces are captured.

**Branch:** `tb0/input-qualification`  
**Base:** `6d1e1925b967cda3c19731decc570d02da2c9c6d` (`main`, including final G0 evidence)  
**Target serial:** `1906092617103125`  
**Fingerprint:** `Rokid/glasses/glasses:12/SKQ1.240613.001/1.23.009-20260725-150201:user/release-keys`  
**Qualified APK:** `com.code2hack.glasses`, debug `0.1.0-g0`, 818872 B.

## Evidence provenance

Every interaction claim uses one provenance label:

- `PHYSICAL` — a genuine Rokid hardware interaction captured by the current APK
  and synchronized low-level/framework tracers;
- `SYNTHETIC_ADB` — Android framework-level injection such as
  `adb shell input`;
- `SYNTHETIC_SENDEVENT` — Linux input injection through a debug-only path;
- `PRIOR_REFERENCE` — official Rokid or Poker-Dealer evidence from the same
  firmware/device family.

Only `PHYSICAL` evidence can close a physical-control row.

## Current qualification matrix

| Control/source | Current evidence | Native-conflict evidence | Status |
|---|---|---|---|
| Function-button short | Synthetic framework path only; no genuine current-APK press | Unknown | **Unqualified** |
| Function-button long | Synthetic delayed DOWN/UP; prior Poker long-press reference only | Prior reference reports Rokid AI launch path | **Unqualified** |
| One-finger touch/swipe | Synthetic tap/swipe reached the non-invasive tracer | Unknown | **Unqualified** |
| Two-finger touch/swipe | No reliable ADB multi-pointer injection; no genuine trace | Unknown | **Unqualified** |
| Game Rotation Vector, type 15 | Current APK registered and received dynamic samples | N/A | **Qualified as head-pose source** |
| Gyroscope, type 4 | Current APK registered and received dynamic samples | N/A | **Qualified as supplementary source** |
| Head-wheel anchor/dead-zone/threshold/tab semantics | Not implemented or exercised | N/A | **Unqualified** |

## Capture topology

```text
Spark worker
  -> SSH u4090
  -> tmux dsh-glasses-adb
  -> /opt/android-sdk/platform-tools/adb
  -> USB Rokid 1906092617103125
```

Product traffic remains Rokid ↔ Spark over Tailscale/private LAN. ADB is
strictly diagnostics and control.

## Recorder implementation

`dev/i0-capture.sh` records a bounded synchronized window containing:

- concurrent `/dev/input/event0` and `/dev/input/event1` readers;
- `DSHGlasses`, `DSHGlassesBridge`, and `DSHGlassesSensor` logs;
- relevant Activity/window/input-framework logs;
- bounded foreground/focus probes;
- input, sensor, package, and firmware inventories;
- before/after screenshots and UI hierarchy;
- a manifest binding the run to commit, host, device, timing, and per-channel
  process status.

Target-specific behavior discovered during qualification:

- target toybox rejects combined `getevent -lt`;
- target toybox accepts one device argument per `getevent` process;
- event0 and event1 therefore require separate concurrent bounded readers;
- `getevent -t` is supported on this target and is the qualified runtime mode.

Final recorder hardening also:

- bounds one-shot ADB inventory/screenshot/UI-dump/pull commands with
  `ADB_PROBE_TIMEOUT` (default 15 s);
- bounds every focus sample with `FOCUS_SAMPLE_TIMEOUT` (default 5 s);
- persists event0, event1, aggregate, and logcat process statuses;
- uses host `time.monotonic_ns()` prefixes if plain fallback mode is needed,
  preserving subsecond timing rather than whole-second `systime()` values.

## Dynamic sensor proof

Current APK runtime evidence on the real Rokid:

- Game Rotation Vector inventory: `type=15`, QTI provider, available;
- gyroscope inventory: `type=4`, `icm4x6xx`, TDK-InvenSense, available;
- both registrations returned `ok=true`;
- sample rows include `sensorTimestampNs`, `observedElapsedNs`, `accuracy=3`,
  and values;
- active-head smoke counts:
  - type 15: **313** samples;
  - type 4: **379** samples;
- Activity pause produced `DSHGlassesSensor: unregistered`;
- Activity resume re-registered both sensors and sample delivery resumed;
- no sample caused a semantic control, draft mutation, network action, scroll,
  tab switch, or Send.

Accepted boundary:

```text
type-15 dynamic source: qualified
type-4 supplementary source: qualified
head-wheel interpretation/thresholds: unqualified
```

Earlier 329/548 sample counts came from the superseded `tb0/i0-input` branch and
are supporting evidence only. The accepted current-branch qualification uses the
active-head 313/379 smoke and the verified lifecycle sequence.

## Synchronized-recorder progression

### W1 — framework/focus useful; low-level syntax failed

- Combined `getevent -lt` printed usage and produced no low-level stream.
- Framework logs, focus samples, screenshots, and UI hierarchy were still useful.
- W1 is not a low-level-reader pass.

### W2 — two-device argument failed

- `getevent ... event0 event1` printed usage because target toybox accepts exactly
  one device argument.

### W2b — serial per-node experiment; diagnostic only

- One-device syntax worked.
- The event0 reader blocked for the whole window, so event1 was never opened.
- W2b is explicitly **not** a dual-node pass.

### W2c — concurrent dual-node reader pass

Directory: `20260819T124516Z-w2c`

```text
capture_exit_status=0
getevent_capture_mode=device-timestamp
getevent_event0_status=124
getevent_event1_status=124
getevent_process_status=124
getevent_usage_errors=0
getevent_live_lines=0
```

All event0/event1/aggregate error files were empty. Zero lines means no genuine
physical event occurred; no press was forced.

### W2e — logcat status surface pass

The concurrent event0/event1 readers and the status-aware logcat reader all
exited through the intended host timeout:

```text
event0=124
event1=124
getevent aggregate=124
logcat=124
usage errors=0
```

### W2f — bounded focus sampler pass

Directory: `20260819T130220Z-w2f`  
Duration: 45 s  
Tested recorder head: `99b6ab5`

```text
capture_exit_status=0
event0=124
event1=124
getevent aggregate=124
logcat=124
getevent_usage_errors=0
getevent_live_lines=0
focus_sample_status=0  (40 of 40 samples)
```

Every focus probe completed inside the 5-second bound. An older W2d timestamp
claim that predated the concurrent-reader commit was discarded and is not used
as evidence.

### W2g — hardened recorder pass

Directory: `20260819T131518Z-w2g`  
Duration: 45 s  
Tested branch head: `84849912ef1480ce4f1431c83fe407afd034ee64`
(includes recorder hardening commit `8c1a392`)

```text
capture_exit_status=0
getevent_event0_status=124
getevent_event1_status=124
getevent_process_status=124
logcat_process_status=124
getevent_usage_errors=0
focus_sample_status=0  (40 of 40 samples)
```

This is the accepted final target-path run for the hardened recorder. Target
mode remained `device-timestamp`; the monotonic-nanosecond plain fallback was not
needed on this firmware.

## Synthetic framework-path evidence

Provenance: `SYNTHETIC_ADB`.

With the glasses app foreground, these reached the non-invasive tracer:

- ENTER (`keyCodeInt=66`);
- DPAD UP/DOWN/LEFT/RIGHT (`19/20/21/22`);
- BACK (`4`);
- one-pointer tap;
- one-pointer swipe with DOWN, MOVE rows, and UP.

Injected key events came from Android's `Virtual` device with `scanCode=0`.
Touch injection used source `0x1002`. These prove framework/tracer plumbing, not
physical Rokid mappings.

When `com.tailscale.ipn` was the resumed Activity, an injected DPAD_UP and tap
produced zero glasses-app `DISPATCH_*` rows. The app did not fabricate a
completed interaction for events it did not receive. This does not qualify
mid-hold physical cancellation.

## Prior same-firmware reference

Provenance: `PRIOR_REFERENCE` only.

The only usable archived Poker-Dealer physical-input record found on this
firmware family is a long press from 2026-08-16:

```text
KEYCODE_NOTIFICATION down
KEYCODE_NOTIFICATION up
KEYCODE_PROG_BLUE down
native launchRokidAI
ordered ACTION_AI_START with abort
```

No archived Poker evidence was found for a physical short press, two-finger
gesture, `KEY_DASHBOARD`, `KEYCODE_ENTER`, or scan code 28. Poker semantics and
event consumption are not carried into this project.

## Passive recorder

A passive loop remains armed in tmux `dsh-glasses-adb` to catch incidental
genuine hardware interactions without interrupting `code2hack`.

Latest recorded restart:

```text
loop PID: 186944
launcher: /tmp/passive-loop.sh
window started: 20260819T131258Z-passive
mode: LABEL=passive, DURATION=1800
```

The previous unbounded-focus window stalled past its intended duration and was
terminated by exact PID, directly motivating the bounded-focus correction. The
loop invokes the committed worktree script on every rotation, so subsequent
windows adopt the latest bounded one-shot probes and monotonic plain fallback.

A capture window is not automatically `PHYSICAL`; individual interactions must
be classified after correlation.

## Physical acceptance rule

A physical binding may be frozen only after at least three consistent genuine
trials prove:

- complete begin/update-or-hold/end-or-cancel lifecycle;
- stable Linux input identity and Android mapping;
- timing sufficient for short/double/long classification;
- focus/background cancellation;
- any conflicting Rokid-native action;
- no unexplained divergence.

## Remaining open hardware gates

- physical function-button short press;
- physical function-button long press;
- physical one-finger touch/swipe;
- physical two-finger touch/swipe;
- native Rokid conflict/exclusivity for each;
- final head-wheel anchor, dead-zone, thresholds, continuous-scroll behavior,
  and one-step tab-switch behavior.

These gaps do not block merging the input-observation plumbing.
