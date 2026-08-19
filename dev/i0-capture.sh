#!/usr/bin/env bash
# TB0-I0 synchronized, bounded Rokid input capture.
# Run on u4090 inside tmux `dsh-glasses-adb`. This observes only; it never
# clears logs, injects input, changes Tailscale, or transports product traffic.
set -euo pipefail

ADB="${ADB:-/opt/android-sdk/platform-tools/adb}"
SERIAL="${SERIAL:-1906092617103125}"
DURATION="${DURATION:-600}"
SAMPLE_INTERVAL="${SAMPLE_INTERVAL:-1}"
LABEL="${LABEL:-armed}"
OUT_ROOT="${OUT_ROOT:-$HOME/tmp/dsh-glasses-ADB/i0}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$OUT_ROOT/${STAMP}-${LABEL}"
mkdir -p "$RUN_DIR"

if ! "$ADB" -s "$SERIAL" get-state | grep -qx device; then
  echo "Rokid ADB unavailable: serial=$SERIAL" >&2
  exit 2
fi

PIDS=()
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait "${PIDS[@]:-}" 2>/dev/null || true

  {
    echo "capture_end_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "capture_exit_status=$status"
  } >> "$RUN_DIR/manifest.txt"

  "$ADB" -s "$SERIAL" exec-out screencap -p > "$RUN_DIR/screen-after.png" 2> "$RUN_DIR/screen-after.err" || true
  "$ADB" -s "$SERIAL" shell uiautomator dump /sdcard/dsh-i0-window.xml > "$RUN_DIR/uiautomator-after-command.txt" 2>&1 || true
  "$ADB" -s "$SERIAL" pull /sdcard/dsh-i0-window.xml "$RUN_DIR/window-after.xml" > "$RUN_DIR/uiautomator-after-pull.txt" 2>&1 || true
  echo "TB0-I0 capture saved: $RUN_DIR"
  exit "$status"
}
trap cleanup EXIT INT TERM

REPO_HEAD="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
FINGERPRINT="$($ADB -s "$SERIAL" shell getprop ro.build.fingerprint | tr -d '\r')"
MODEL="$($ADB -s "$SERIAL" shell getprop ro.product.model | tr -d '\r')"

cat > "$RUN_DIR/manifest.txt" <<EOF
provenance=UNCLASSIFIED_CAPTURE_WINDOW
note=Classify each resulting interaction as PHYSICAL, SYNTHETIC_ADB, SYNTHETIC_SENDEVENT, or PRIOR_REFERENCE in the evidence document.
capture_start_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
host=$(hostname)
repo_head=$REPO_HEAD
adb=$ADB
serial=$SERIAL
model=$MODEL
fingerprint=$FINGERPRINT
duration_seconds=$DURATION
sample_interval_seconds=$SAMPLE_INTERVAL
label=$LABEL
EOF

# Static inventory snapshots.
"$ADB" -s "$SERIAL" shell cat /proc/bus/input/devices > "$RUN_DIR/proc-bus-input-devices.txt" 2>&1 || true
"$ADB" -s "$SERIAL" shell getevent -lp > "$RUN_DIR/getevent-capabilities.txt" 2>&1 || true
"$ADB" -s "$SERIAL" shell dumpsys input > "$RUN_DIR/dumpsys-input.txt" 2>&1 || true
"$ADB" -s "$SERIAL" shell dumpsys sensorservice > "$RUN_DIR/dumpsys-sensorservice.txt" 2>&1 || true
"$ADB" -s "$SERIAL" shell dumpsys package com.code2hack.glasses > "$RUN_DIR/dumpsys-package.txt" 2>&1 || true
"$ADB" -s "$SERIAL" exec-out screencap -p > "$RUN_DIR/screen-before.png" 2> "$RUN_DIR/screen-before.err" || true
"$ADB" -s "$SERIAL" shell uiautomator dump /sdcard/dsh-i0-window.xml > "$RUN_DIR/uiautomator-before-command.txt" 2>&1 || true
"$ADB" -s "$SERIAL" pull /sdcard/dsh-i0-window.xml "$RUN_DIR/window-before.xml" > "$RUN_DIR/uiautomator-before-pull.txt" 2>&1 || true

# Low-level Linux input events from the currently identified power/touch nodes.
(
  timeout "$DURATION" "$ADB" -s "$SERIAL" shell getevent -lt /dev/input/event0 /dev/input/event1 \
    > "$RUN_DIR/getevent-live.txt" 2> "$RUN_DIR/getevent-live.err" || true
) &
PIDS+=("$!")

# Framework/app/system logs. Do not clear logcat before this capture.
(
  timeout "$DURATION" "$ADB" -s "$SERIAL" logcat -v monotonic \
    DSHGlasses:V DSHGlassesBridge:V DSHGlassesSensor:V \
    ActivityTaskManager:I ActivityManager:I WindowManager:I InputReader:I \
    InputDispatcher:I ViewRootImpl:I '*:S' \
    > "$RUN_DIR/logcat-live.txt" 2> "$RUN_DIR/logcat-live.err" || true
) &
PIDS+=("$!")

# Foreground/focus samples correlated by host and device monotonic clocks.
(
  end=$((SECONDS + DURATION))
  while (( SECONDS < end )); do
    printf '\n=== host_utc=%s host_epoch_ms=%s ===\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$(date +%s%3N)"
    "$ADB" -s "$SERIAL" shell 'printf "device_uptime="; cat /proc/uptime; dumpsys window windows | grep -E "mCurrentFocus|mFocusedApp|mObscuringWindow"; dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity" | head -n 8' 2>&1 || true
    sleep "$SAMPLE_INTERVAL"
  done
) > "$RUN_DIR/focus-live.txt" 2>&1 &
PIDS+=("$!")

# Wait until the bounded window ends or the operator stops it with Ctrl-C.
wait "${PIDS[@]}" || true
