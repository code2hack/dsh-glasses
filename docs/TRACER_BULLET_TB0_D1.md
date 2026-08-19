# TRACER_BULLET_TB0_D1 — reproducible Rokid debug provisioning

**Status:** implementation ready for runtime qualification.  
**Base:** `6f512aa39c9b1b496b89cd24c305a518997b0c26`.  
**Branch:** `tb0/repro-device-debug`.

## 1. Goal

Make the merged C0/D0 development loop reproducible on the Rokid without an
ad-hoc clipboard APK or hand-written Chrome DevTools Protocol commands:

```text
D0 provisioning JSON
→ debug APK provisioned through existing GlassesBridge.configure()
→ debug-only clipboard seeded from ADB
→ WebView CDP target discovered/reused
→ synthetic semantic controls driven reproducibly
→ machine-readable token-free device/debug state returned
```

D1 is development infrastructure only. It does not qualify any physical control
and does not alter production interaction semantics.

## 2. Included

- a debug-only exported clipboard-seed Activity compiled only into the debug APK;
- one host-side Node helper intended to run on the active ADB host (normally
  u4090) with commands `provision`, `state`, `clipboard`, and `control`;
- D0 provisioning JSON accepted on stdin so the bearer never appears in process
  arguments;
- deterministic ADB/WebView discovery and forwarding;
- CDP evaluation through the already-enabled debuggable WebView;
- provisioning through `GlassesBridge.configure(base, token, sessionId)` followed
  by a process restart and bootstrap/stream verification;
- clipboard verification by length + SHA-256 only (clipboard contents are never
  logged by the helper);
- semantic controls driven only through
  `GlassesBridge.debugSemanticControl(name)`, preserving native provenance
  `SYNTHETIC_DEBUG_CONTROL`.

## 3. Explicit non-goals

- no physical function/touch/head-pose mapping;
- no production enrollment/pairing;
- no release build changes;
- no DSH/provider changes;
- no new Navigation/Input semantics;
- no Photo/Voice/Morse/tabs/Steer/Interrupt behavior;
- no remote-SSH orchestration inside the helper; workers invoke it on u4090
  through the existing project SSH workflow.

## 4. Canonical host flow

On Spark, preserve D0 `up` stdout as JSON, then pipe it to u4090 without exposing
its bearer in the remote command line:

```bash
cat /tmp/d0-up.json | ssh u4090 \
  'cd /home/code2hack/Projects/glasses/dsh-glasses && \
   node dev/d1-rokid-debug.mjs provision --stdin'
```

On u4090 directly:

```bash
node dev/d1-rokid-debug.mjs state
printf '%s' 'hello world' | node dev/d1-rokid-debug.mjs clipboard --stdin
node dev/d1-rokid-debug.mjs control COMMAND_SHORT RIGHT LEFT
```

Defaults:

```text
adb=/opt/android-sdk/platform-tools/adb
serial=1906092617103125
package=com.code2hack.glasses
CDP port search starts at 9333
```

All defaults are overridable.

## 5. Debug clipboard fixture

`DebugClipboardSeedActivity` exists only under `src/debug`. Its Activity manifest
entry also exists only in the debug source set. It accepts one Base64 UTF-8 extra
named `text_b64`, writes `ClipData.newPlainText("dsh-debug", text)`, logs only
character count, and immediately finishes.

The host helper Base64-encodes requested clipboard text before invoking the
Activity. It verifies the app-observed clipboard through CDP by comparing exact
text in memory while emitting only length and SHA-256. No clipboard body is
printed to stdout/stderr.

## 6. CDP contract

For each command the helper:

1. verifies the exact ADB serial and installed package;
2. launches `MainActivity` when needed and resolves the current app PID;
3. creates one free host TCP forward to
   `localabstract:webview_devtools_remote_<pid>`;
4. queries `/json` and selects the dsh-glasses local-asset page target;
5. speaks Chrome DevTools Protocol over WebSocket and correlates request IDs;
6. evaluates with `awaitPromise=true` and `returnByValue=true`;
7. removes only the forward it created when the command exits.

A session mismatch, missing `c0DebugState()`, or ambiguous WebView target is a hard
error.

## 7. Provisioning acceptance

Given fresh D0 provisioning JSON and the installed exact D1 debug APK, prove:

```text
helper parses stdin
→ bearer absent from argv/stdout/stderr
→ GlassesBridge.configure(...) returns true
→ app process restarts
→ c0DebugState.endpoint == D0 provisioning endpoint
→ c0DebugState.expectedSession == D0 fresh session
→ identityFailure == null
→ streamVerified == true
```

Output may contain endpoint and a redacted session prefix, never the bearer.

## 8. Clipboard acceptance

For:

```text
D1 clipboard reproducibility passed
```

prove:

```text
ADB launches debug-only clipboard Activity
→ Activity exits
→ GlassesBridge.clipboardText() returns same text in CDP
→ emitted length and SHA-256 match host input
→ helper/logcat never emit clipboard body
```

## 9. Synthetic-control acceptance

Drive at least:

```text
COMMAND_SHORT
RIGHT
LEFT
```

through the helper. Require native logcat rows with
`source=SYNTHETIC_DEBUG_CONTROL`, plus `c0DebugState()` transitions consistent
with the already-merged C0 reducer. This proves only the reproducible debug path.

## 10. State acceptance

`state` must return JSON containing device identity, app PID, selected WebView
target, endpoint/session identity, mode/HUD/write state/draft metadata and stream
state. It must never contain the bearer or clipboard body.

## 11. Merge gate

D1 is merge-ready when the exact branch APK/helper prove:

```text
D0 JSON → provision → verified live C0 session
clipboard helper → exact digest match
control helper → native SYNTHETIC_DEBUG_CONTROL trace + C0 state change
state helper → token-free machine-readable snapshot
```

No physical row is closed or upgraded by D1.
