# TB0-G0 glasses shell + real-device connectivity — evidence

**Status:** in progress (hardware + build phases).
**Branch:** `tb0/glasses-shell` (base merge `c54833f`).
**Committed:** `c4c2ee7` docs advance · `a8a04b7` dev proxy · `a2ef7cb` Android shell skeleton.

## Base / tested commits
- Base: `c54833f` (merged main; PR #1 read proof, PR #2 host write).
- Slice head: `a2ef7cb` (to be updated after build/test commits).
- APK variant: debug (`app-debug.apk`, versionName `0.1.0-g0`).

## Device (u4090 USB ADB route)
- Host: u4090 (`100.103.206.123`), route `ssh spark→u4090 → adb`.
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
- Narrow dev proxy `dev/glasses-dev-proxy.mjs` bound `0.0.0.0:3200` forwarding
  **only** `/glasses/v1/*` to the loopback listener; everything else (incl.
  `/api/*` host RPC) returns `403`. Verified: bootstrap 200 via
  `100.92.81.33:3200/glasses/v1/bootstrap`, `/api/*` → 403, no token → 401.
- G0 configured session (configured only via `DSH_GLASSES_TB0_SESSION_ID`, not
  committed).
- SSE pass-through verified over the tailnet proxy (`event: hello`).

## Bootstrap / SSE (verified pre-APK)
- Bootstrap: `ok:true`, protocolMajor 1, rotated `serverGeneration`,
  `attachment.status` (pre-agent `unavailable`), `history.asOfSeq`, minimal
  projections; `writeState` present.
- SSE: heartbeat + `projection` frames; reconnect is bootstrap-first (no
  `Last-Event-ID`), matching the merged contract.

## Raw input table (to be filled with real-device traces)
| Interaction | action(s) | keyCode/scan | pointer | coords | tool | ts | native visible |
|---|---|---|---|---|---|---|---|
| function button short press | (pending) | | | | | | |
| function button long press | (pending) | | | | | | |
| two-finger short touch (SECONDARY) | (pending) | | | | | | |
| head-pose availability | (pending) | | | | | | |

## Remaining blockers / next
- APK build on u4090 (in progress).
- Install via USB ADB; launch; provision credential via app-private storage.
- Bootstrap render + live SSE event on device; disconnect/reconnect; app restart
  reconstruction.
- Fill the raw-input table with bounded timestamped traces; record native
  conflicts (if any).
- Open draft PR `tb0: connect the Rokid glasses shell` once the shell boots.
