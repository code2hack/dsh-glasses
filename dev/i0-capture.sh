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
GETEVENT_MODE="${GETEVENT_MODE:-auto}" # auto | timestamp | plain
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

  local getevent_lines=0
  local getevent_usage_errors=0
  local getevent_process_status="missing"
  local getevent_event0_status="missing"
  local getevent_event1_status="missing"
  local logcat_lines=0
  local logcat_error_lines=0
  local logcat_process_status="missing"

  if [[ -f "$RUN_DIR/getevent-live.txt" ]]; then
    getevent_lines="$(wc -l < "$RUN_DIR/getevent-live.txt" | tr -d ' ')"
  fi
  if [[ -f "$RUN_DIR/getevent-live.err" ]]; then
    getevent_usage_errors="$(grep -Eic 'usage:|unknown option|invalid option|bad option|unrecognized option' "$RUN_DIR/getevent-live.err" || true)"
  fi
  if [[ -f "$RUN_DIR/getevent-live.status" ]]; then
    getevent_process_status="$(tr -d '[:space:]' < "$RUN_DIR/getevent-live.status")"
  fi
  if [[ -f "$RUN_DIR/getevent-event0.status" ]]; then
    getevent_event0_status="$(tr -d '[:space:]' < "$RUN_DIR/getevent-event0.status")"
  fi
  if [[ -f "$RUN_DIR/getevent-event1.status" ]]; then
    getevent_event1_status="$(tr -d '[:space:]' < "$RUN_DIR/getevent-event1.status")"
  fi
  if [[ -f "$RUN_DIR/logcat-live.txt" ]]; then
    logcat_lines="$(wc -l < "$RUN_DIR/logcat-live.txt" | tr -d ' ')"
  fi
  if [[ -f "$RUN_DIR/logcat-live.err" ]]; then
    logcat_error_lines="$(wc -l < "$RUN_DIR/logcat-live.err" | tr -d ' ')"
  fi
  if [[ -f "$RUN_DIR/logcat-live.status" ]]; then
    logcat_process_status="$(tr -d '[:space:]' < "$RUN_DIR/logcat-live.status")"
  fi

  {
    echo "capture_end_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "capture_exit_status=$status"
    echo "getevent_live_lines=$getevent_lines"
    echo "getevent_usage_errors=$getevent_usage_errors"
    echo "getevent_process_status=$getevent_process_status"
    echo "getevent_event0_status=$getevent_event0_status"
    echo "getevent_event1_status=$getevent_event1_status"
    echo "logcat_live_lines=$logcat_lines"
    echo "logcat_error_lines=$logcat_error_lines"
    echo "logcat_process_status=$logcat_process_status"
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

# This firmware's toybox getevent rejects the combined `-lt` spelling. Probe
# `-t` alone; if it is unavailable, fall back to plain hexadecimal events and
# prefix each received line with a host-arrival timestamp. Static `-lp` output
# below supplies the symbolic code inventory in either mode.
GETEVENT_ARGS=()
GETEVENT_CAPTURE_MODE="plain-host-arrival-time"
GETEVENT_PROBE_STATUS=0
case "$GETEVENT_MODE" in
  auto)
    timeout 1 "$ADB" -s "$SERIAL" shell getevent -t /dev/input/event1 \
      > /dev/null 2> "$RUN_DIR/getevent-probe.err" || GETEVENT_PROBE_STATUS=$?
    if ! grep -Eqi 'usage:|unknown option|invalid option|bad option|unrecognized option' "$RUN_DIR/getevent-probe.err"; then
      GETEVENT_ARGS=(-t)
      GETEVENT_CAPTURE_MODE="device-timestamp"
    fi
    ;;
  timestamp)
    GETEVENT_ARGS=(-t)
    GETEVENT_CAPTURE_MODE="device-timestamp-forced"
    : > "$RUN_DIR/getevent-probe.err"
    ;;
  plain)
    : > "$RUN_DIR/getevent-probe.err"
    ;;
  *)
    echo "Invalid GETEVENT_MODE=$GETEVENT_MODE (expected auto, timestamp, or plain)" >&2
    exit 2
    ;;
esac

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
getevent_mode_requested=$GETEVENT_MODE
getevent_capture_mode=$GETEVENT_CAPTURE_MODE
getevent_probe_status=$GETEVENT_PROBE_STATUS
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
# This target accepts exactly one device argument, so event0 and event1 MUST be
# read by separate concurrent adb/getevent processes. A serial loop would block
# on event0 for the whole window and never observe event1.
#
# A normal bounded reader exits through host `timeout` with status 124. Zero
# lines means no low-level event occurred; it is not a reader failure when BOTH
# node statuses are 124, usage_errors=0, and stderr has no permission/device
# error.
(
  : > "$RUN_DIR/getevent-live.txt"
  : > "$RUN_DIR/getevent-live.err"
  node_pids=()

  for node in event0 event1; do
    (
      node_status=0
      node_path="/dev/input/$node"
      node_out="$RUN_DIR/getevent-$node.txt"
      node_err="$RUN_DIR/getevent-$node.err"

      if [[ ${#GETEVENT_ARGS[@]} -gt 0 ]]; then
        timeout "$DURATION" "$ADB" -s "$SERIAL" shell getevent \
          "${GETEVENT_ARGS[@]}" "$node_path" 2> "$node_err" \
          | awk -v device="$node" '{ print "device=" device, $0; fflush(); }' \
          > "$node_out" \
          || node_status=$?
      else
        timeout "$DURATION" "$ADB" -s "$SERIAL" shell getevent \
          "$node_path" 2> "$node_err" \
          | awk -v device="$node" '{ print "host_epoch_s=" systime(), "device=" device, $0; fflush(); }' \
          > "$node_out" \
          || node_status=$?
      fi

      printf '%s\n' "$node_status" > "$RUN_DIR/getevent-$node.status"
    ) &
    node_pids+=("$!")
  done

  for pid in "${node_pids[@]}"; do
    wait "$pid" || true
  done

  for node in event0 event1; do
    cat "$RUN_DIR/getevent-$node.txt" >> "$RUN_DIR/getevent-live.txt" 2>/dev/null || true
    if [[ -s "$RUN_DIR/getevent-$node.err" ]]; then
      sed "s/^/device=$node /" "$RUN_DIR/getevent-$node.err" >> "$RUN_DIR/getevent-live.err"
    fi
  done

  status0="$(tr -d '[:space:]' < "$RUN_DIR/getevent-event0.status" 2>/dev/null || echo missing)"
  status1="$(tr -d '[:space:]' < "$RUN_DIR/getevent-event1.status" 2>/dev/null || echo missing)"
  if [[ "$status0" == "124" && "$status1" == "124" ]]; then
    printf '124\n' > "$RUN_DIR/getevent-live.status"
  else
    printf 'event0=%s,event1=%s\n' "$status0" "$status1" > "$RUN_DIR/getevent-live.status"
  fi
) &
PIDS+=("$!")

# Framework/app/system logs. A healthy bounded reader exits through host timeout
# with status 124. Persist that status so an immediate filter/ADB failure cannot
# masquerade as a complete synchronized capture.
(
  logcat_status=0
  timeout "$DURATION" "$ADB" -s "$SERIAL" logcat -v monotonic \
    DSHGlasses:V DSHGlassesBridge:V DSHGlassesSensor:V \
    ActivityTaskManager:I ActivityManager:I WindowManager:I InputReader:I \
    InputDispatcher:I ViewRootImpl:I '*:S' \
    > "$RUN_DIR/logcat-live.txt" 2> "$RUN_DIR/logcat-live.err" \
    || logcat_status=$?
  printf '%s\n' "$logcat_status" > "$RUN_DIR/logcat-live.status"
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
