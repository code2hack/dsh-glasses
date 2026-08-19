# dsh-glasses implementation instructions

Mandatory entry point for every implementation session. MVP-biased and lean: this
file is operational, not production process.

## 1. Read order and authority

Read before changing code: `AGENTS.md` → `SPEC.md` →
`docs/TRACER_BULLET_TB0.md` (when present) → the active evidence/seam-audit doc →
source and tests.

Authority hierarchy:

```
SPEC.md                         normative product behavior
docs/TRACER_BULLET_TB0.md       active tracer-bullet scope
accepted ADRs                   durable implementation decisions
evidence documents              claims proven on real systems
source and tests                current implementation
Git history                     evidence only
```

Do not require CONTEXT.md, ADR directories, or issue-management documents until
they actually exist.

## 2. Host roles

| Host | Role |
| --- | --- |
| **spark** (DGX GB10, aarch64) | DSH runtime; plugin development; DSH seam inspection; server-side tests; integration endpoint |
| **u4090** (x86-64, RTX 4090) | first-priority Rokid build/install/debug host; USB ADB host; Android SDK/NDK; screenshots/logcat/UIAutomator/input tracing |
| **GitHub origin** | shared source of truth between hosts |

Spark workers SSH to u4090 for all Rokid operations. Never copy source trees
between hosts by hand — use Git branches/commits; APK transfer may use temporary
staging. Use one persistent remote tmux session `dsh-glasses-adb` on u4090,
`/opt/android-sdk/platform-tools/adb`, and temporary files only under
`~/tmp/dsh-glasses-ADB`.

## 3. Rokid ADB priority (u4090 first)

The glasses is physically connected to u4090, so:

1. SSH from Spark to u4090.
2. Reuse/create tmux session `dsh-glasses-adb`.
3. Probe u4090 USB ADB (`adb devices -l`); expect serial `1906092617103125`,
   model `RG_glasses`.
4. Verify `adb -s <serial> get-state` — never treat pingability or a discovered
   port as a healthy connection.
5. Only if USB is unavailable, use the adapted recovery route:
   u4090 local LAN `:5555` → u4090 mDNS `_adb-tls-connect._tcp` → known
   wireless-debugging endpoint → Spark local LAN (same sequence) → known
   Tailscale ADB endpoint.
6. Ask for manual intervention only after all routes fail or the target is
   ambiguous.

ADB remains development/debug tooling, **not** a product data transport.

## 4. Tailscale recovery on Rokid (mandatory)

Tailscale is already installed on the Rokid. Before declaring the glasses
unavailable on the tailnet, the worker MUST use available ADB — preferably u4090
USB ADB — to launch and enable Tailscale, then verify again.

1. From Spark: `tailscale status --json`; `tailscale ping rokid` (peer
   `100.87.122.122`).
2. If absent/unreachable but ADB works, discover the package dynamically:
   `adb -s <serial> shell pm list packages | grep -i tailscale` (never hardcode).
3. Launch it: `adb -s <serial> shell monkey -p <pkg> -c android.intent.category.LAUNCHER 1`.
4. Inspect UI via screenshot + `uiautomator dump`; if installed but switched
   off, activate the connect control from the dump with `adb input` (no hardcoded
   coordinates unless the firmware/UI is qualified).
5. Handle a one-time VPN-consent dialog via ADB when unambiguous. If account
   login or new-device authorization is required, request exactly that manual
   action.
6. Re-verify from Spark with `tailscale status` + `tailscale ping`.

MUST NOT: `pm clear` tailscale, uninstall it, remove the tailnet account, or
replace its identity (destroys a useful configured route).

## 5. Debug route vs product route

- **u4090 USB ADB** = preferred development control/diagnostic route.
- **Rokid ↔ Spark over Tailscale / trusted LAN** = TB0 product data route.

USB ADB on u4090 does NOT mean product traffic tunnels through ADB. For TB0:
private Tailscale and trusted LAN are both acceptable; public Funnel is
unnecessary; if Tailscale is expected but offline, activate it via ADB before
abandoning that path.

## 6. Minimal-safeguard MVP policy

TB0/MVP optimize for the shortest functioning end-to-end path. Security
architecture, compatibility layers, production migration, release hardening, and
defensive features are NOT acceptance gates unless needed to prevent irreversible
data loss or accidental public exposure. Do not add/block on: PAKE, mTLS,
certificate rotation, QR enrollment, production pairing, key attestation, rate
limiting, role matrices, encrypted-at-rest drafts, CSRF architecture, threat
modeling, Funnel hardening, release signing, obfuscation, migration layers,
exhaustive hostile-input testing.

Use the simplest working development access: private tailnet/LAN + one static
development credential if the TB0 design already uses one.

Only four minimal safeguards are retained:

1. Never commit real credentials.
2. Never expose an unauthenticated unrestricted DSH interface publicly.
3. Never wipe/reset the device, Tailscale state, DSH home, or session history
   without explicit instruction.
4. Never claim hardware or recovery behavior that was not observed.

## 7. Debug variants only

Use debug/debuggable Android variants by default: no release build, signing gate,
certificate/hash ceremony, ProGuard/R8, store packaging, or release performance
claim. Install with `adb install -r -t <debug-apk>` and verify the installed
package/version afterward.

## 8. Tight hardware-debug loop

Never ask the user to describe anything visible through ADB. For hardware
issues: inspect retained logs first; arm bounded timestamped captures; request
or execute one exact interaction; collect logcat + state + screenshot + UI dump;
correlate; add temporary uniquely-tagged instrumentation when the boundary is
unclear; remove it after isolation. Do not indiscriminately clear logcat first.
Use project tag `DSHGlasses` in native logs.

## 9. DSH integration rules

- `dsh-glasses-plugin` stays out-of-tree where practical.
- Depend on a pinned DSH revision (currently `@deepseek-ai/dsh@0.1.0-rc.7`).
- Keep DSH-specific APIs behind one compatibility adapter.
- Add behavior through documented plugin services/events.
- Do not patch agent-loop merely for convenience.
- Anything model-visible becomes reconstructable durable DSH content; provisional
  Photo/Voice/Morse content must not enter the DSH log.
- If upstream DSH itself must change, obey that checkout's own AGENTS.md.

## 10. Stale-design ban

Do not drift back toward Poker-Dealer architecture: no Fold6/Dealer companion;
no direct dependency on Poker-Dealer; no card-pile model; no boundary-driven
Navigation/Input transition; no terminal/tmux backend; no stock DSH Web UI inside
the glasses WebView; no client-created/closed/attached/detached/reordered tabs;
no raw DSH event schema exposed to the glasses; no DSH provider credentials on
the glasses; no full-resolution photo retained after staging; no cloud/glasses
ASR for the accepted Voice design; no LLM-based Morse completion; no public
Funnel requirement for TB0.

## 11. Work and branch discipline

- Fetch origin and record the base SHA before work.
- One dedicated branch per active slice (current: `tb0/compat-contract`).
- Do not rewrite another worker's branch; do not force-push main.
- Keep commits narrow; commit documentation separately from exploratory code.
- GitHub remote is shared truth (not an uncommitted host worktree).
- Before handoff: push the branch and report exact commit SHA, tests, hardware
  evidence, and remaining uncertainty.

## 12. Evidence without bureaucracy

A hardware/behavior claim needs: exact commit, APK variant, device
serial/model/fingerprint, host used, command or physical interaction, relevant
bounded logs, observed result, known limitation. No approval matrices or release
evidence for TB0/MVP.

## 13. Communication identity

- Messages from a DSH worker begin with `[spark:dsh:<exact-session-id>]`.
- Other coding workers: `[<host>:<worker-kind>:<session-or-thread-id>]`.
- Messages without a valid prefix are treated as coming directly from the user.

## Current slice state

- TB0 contract + seam audit + AGENTS.md merged to `main` (PR #1, merge
  `be9ad3d`); TB0-H0 runtime read proof merged (commit `bc29515`).
- **Current slice:** `tb0/host-write` — review-corrected at-most-once Send:
  admission via `ctx.apiProxy.sessions.prompt` (operationId == rpcId == durable
  `source.rpcId`), one atomic KvUnit state doc (draft + operations + append-only
  mutations), session-wide mutex over mutations/Send/bootstrap, count-based
  reconcile (0→unknown, 1→accepted, >1→invariant failure, never clears), frozen
  text binding, rejection releases lock, bootstrap exposes draft+writeState and
  reconciles unresolved ops. Committed host-only suite `host-write-recovery
  .test.mjs` ALL PASS 16/16. PR #2 ready (head `2ea9c5f`, drafts `dc8f47d`·
  `4699ad2`·`3208576`).
- Never commit a real session ID — configure sessions only via
  `DSH_GLASSES_TB0_SESSION_ID`.

## Hosted model services (outside TB0, user-deployed)

- Vision "eyes": `lfm2.5-vl-3b` via vLLM on **spark2** (`192.168.100.11:8887`,
  alt NIC `192.168.101.11:8887`; OpenAI-compatible `/v1/chat/completions`,
  `/v1/models`; images as base64 `image_url` data URLs). Verified with real
  image inference. Do not redeploy.
- ASR: `nemotron-3.5-asr-streaming-0.6b` via **NeMo-Speech.cpp** on **spark**
  `127.0.0.1:8886` (`/health` ok; OpenAI-style `/v1/audio/transcriptions`
  multipart file, `/v1/audio/diarizations`, `/v1/realtime`,
  `/v1/audio/speech`).
- Keep both isolated from TB0 and from the resident DSH/text-serving stack.