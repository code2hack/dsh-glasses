# dsh-glasses implementation instructions

This file is the mandatory entry point for every new implementation session working in this repository.

## Read order

Before changing code:

1. Read this file completely.
2. Read `SPEC.md` (normative source of truth, currently revision 3).
3. Read `docs/TRACER_BULLET_TB0.md` (the frozen TB0 execution contract).
4. Read `docs/evidence/tb0-dsh-compat-2026-08-19.md` (live DSH seam audit).
5. Inspect current code and evidence only after understanding the normative architecture.

If code disagrees with `SPEC.md`, the specification wins until code and specification are deliberately changed in the same commit.

## Current product

- **dsh-glasses** — lightweight Android app on Rokid RG-glasses (native shell + dedicated WebView; Camera2, mic, Rokid input).
- **dsh-glasses-plugin** — a DSH plugin on the user's dual-DGX-Spark workstation; attaches DSH sessions, projects them over `/glasses/v1/*`, owns committed drafts, later Voice/Morse/Photo.
- No phone companion. Dealer/Fold6 is out of scope.

## Hosts

| Host | Role | Notes |
| --- | --- | --- |
| **spark** (DGX, NVIDIA GB10, aarch64) | Primary dev + plugin host; DSH_HOME `/home/code2hack/.dsh` | runs the resident DSH web profile |
| **u4090** (Ubuntu x86-64, RTX 4090) | **Rokid debug relay — first priority for glasses ADB** | reachable via SSH `code2hack@100.103.206.123` |

## Debugging Rokid (priority order)

1. **USB on u4090 (first priority).** SSH to u4090 and use `$HOME/Android/Sdk/platform-tools/adb`. The glasses appear as serial `1906092617103125` (product `glasses`, model `RG_glasses`). Screenshot: `adb -s <serial> exec-out screencap -p > shot.png`. UI dump: `adb -s <serial> shell uiautomator dump && adb -s <serial> shell cat /sdcard/ui.xml`.
2. **TCP/IP over Tailscale.** The Rokid runs **Tailscale** (peer `rokid`, IPv4 `100.87.122.122`). If not already enabled, enable it over the USB connection: `adb -s <serial> tcpip 5555` then `adb connect 100.87.122.122:5555`. Verify with `adb devices -l` and `adb -s <ip>:5555 get-state`.
3. If the device is missing on these routes, follow the Poker-Dealer ADB recovery ordering (USB → local Wi-Fi `:5555` → mDNS → known Wireless-debugging endpoint) but keep u4090 as the ADB host and never treat reachability as a healthy transport without `get-state`. **Tailscale recovery path: if the Rokid is not on the tailnet, enable it via adb** (boot `com.tailscale.ipn`, ensure it connects), then resume the `:5555` route.
4. Ask the user only after all automatic routes fail. ADB remains diagnostic/control tooling, never a product transport.

Evidence-style screenshots and `uiautomator` text dumps are the primary glasses-observability; the LocateAnything vision service (see below) can ground elements on screenshots when needed.

## Safeguards and security posture (MVP)

- **Safeguards MUST be as few as possible during MVP development. Security is the least important concern in MVP.**
- TB0 still uses one pre-provisioned random dev bearer credential, scoped to `/glasses/v1/*` only, never granting access to stock DSH APIs, easily revoked. No Funnel, no production pairing, no production hardening for TB0.

## Source of truth and decision hierarchy

`SPEC.md` > TB0 docs > evidence > code. Update `SPEC.md` only when live DSH evidence contradicts a normative assumption.

## Current slice state (2026-08-19)

- TB0 contract is frozen on branch `tb0/compat-contract` (draft PR: `tb0: freeze contract and prove DSH read compatibility`).
- Evidence status: installed-artifact/source-contract qualification **complete**; **runtime plugin read proof pending** (TB0-H0: minimal `plugins/dsh-glasses-plugin/`, session from `DSH_GLASSES_TB0_SESSION_ID`, bounded history + live events + status projection, `/bootstrap` + `/stream`, auth required, 501 stubs for draft/actions; prove disconnect/reconnect and plugin restart).
- **Never commit a real session ID.** Configure sessions only via `DSH_GLASSES_TB0_SESSION_ID`.
- Do not begin draft writes, Send, Android UI, Photo/Voice/Morse, ASR or vision integration until TB0-H0 is merged.

## Local model services (outside TB0, on spark)

ASR (`~/Models/ASR/parakeet-tdt-0.6b-v2`) and vision (`~/Models/IMG/nvidia/LocateAnything-3B`) are served by standalone services under `~/Models/serve/` (pm2: `glasses-vision` :8123, `glasses-asr` :8124). They are **external to the dsh-glasses repository and TB0**; keep them isolated and do not let them perturb the resident DSH stack during the compatibility proof.

## Completion discipline (cherry-picked from Poker-Dealer)

- Keep each change narrow and testable; commit docs and code in coherent units.
- Never claim real-hardware or runtime compatibility without recorded evidence.
- Leave the repository in a state where a fresh session can determine the active design solely from files on the default branch.
