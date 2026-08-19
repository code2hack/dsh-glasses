# dsh-glasses implementation instructions

> **0. Worker Heartbeat Integrity Protocol (WHIP) — read and obey BEFORE
> anything else.** These rules persist across rounds, context compaction, and
> fresh sessions; silence is never permission to stop. If this project is
> reopened in a new session, re-read this section first.
>
> 1. **W — Work the todo.** Continue the highest-priority in-progress item every
>    round; update the todo list before and after each round.
> 2. **H — Heartbeat, never stop.** There is no voluntary end while the mission
>    is open. Keep a poller/recorder alive; every round re-checks the ChatGPT
>    thread FIRST and acts on any new reply.
> 3. **I — Inspect state.** The workspace, tool results, durable session state,
>    the origin branch, and the ChatGPT thread are authoritative — inspect,
>    never assume. The remote branch is the review authority.
> 4. **P — Progress + proof.** Make concrete, verified progress each round and
>    record evidence (exact head, logs, durable/op correlation, diagnostics)
>    before claiming completion.
> 5. **P — Poll the reply.** After ANY blocking ask to ChatGPT: poll ~30 s
>    (back off to ≤60 s while doing productive nonconflicting work), never rely
>    on event notifications alone, and act on the reply before anything else. A
>    usage-limit / "Internal Server Error" placeholder is NOT a reply — retry at
>    the next-lower thinking effort (Pro → xhigh → high → medium → low) per §17
>    until it lands. Don't send duplicates unless new evidence changes the
>    problem.
>
> Legitimate endings ONLY: (a) an explicit stop/pause/handoff from code2hack;
> (b) a genuine blocker escalated once while the session and poller stay alive;
> (c) absolute completion — the program's final acceptance is merged, no pending
> directive, and no unreplied blocking ask. Every other round ends with a short
> status naming the next round's first action and a living todo.

Mandatory entry point for every implementation session. MVP-biased and lean: this
file is operational, not production process.

## 1. Read order and authority

Read before changing code: `AGENTS.md` (start at §0 WHIP) → `SPEC.md` →
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
- One dedicated branch per active slice (current: `tb0/repro-dev-runtime`).
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

## 13. ChatGPT and worker responsibility split

ChatGPT is the primary owner of project planning, implementation design,
production-code changes, code review, and merge decisions. The worker is the
primary executor for builds, tests, server/device operation, evidence capture,
and debugging.

The worker MAY make small, evidence-driven debug fixes and temporary
instrumentation needed to isolate or verify a defect, but MUST NOT independently
redesign the architecture, change accepted product behavior, or expand scope.
Nontrivial implementation changes must be sent to ChatGPT for planning/coding or
review before merge.

If the worker cannot confidently fix a bug, it MUST send ChatGPT a compact bug
report containing:

- exact branch and commit;
- host, device, build variant, and relevant runtime versions;
- minimal reproduction steps;
- expected and actual behavior;
- bounded tracer/log evidence and the exact timestamps involved;
- current hypothesis and attempted fixes;
- the smallest concrete question or patch request.

The primary debugging methods are dedicated tracers, structured instrumentation,
and logs. A screenshot is supporting evidence, not a substitute for traces or
logs. For a visual defect, collect the screenshot together with UI hierarchy,
lifecycle/input logs, network state, and other relevant machine-observable facts.

## 14. Mandatory ChatGPT polling and non-stop rule

Whenever a worker sends ChatGPT a question, bug report, code-review request, or
other blocking request, it MUST start a timer-driven polling heartbeat for the
reply. Event-driven notification MAY supplement polling but MUST NOT be the only
mechanism.

Default behavior:

- poll approximately every 30 seconds while blocked;
- polling MAY back off to at most 60 seconds while productive nonconflicting work
  continues;
- continue all independent tests, evidence collection, and diagnosis between
  polls;
- after a reply arrives, acknowledge it and apply or test it promptly;
- do not send duplicate questions unless new evidence materially changes the
  problem.

Silence, a lost event, a tool timeout, or an unavailable reply is not permission
to stop. Without an explicit instruction from **code2hack** to stop, pause, or
hand off, the worker MUST NOT voluntarily end the task or terminate its working
session. If fully blocked, keep the session alive, preserve state, continue the
heartbeat, and investigate alternate evidence paths.

## 15. Autonomous server and real-hardware operation

The worker MUST fully operate server and real-Rokid testing/debugging itself.
This includes SSH, builds, installs, launches, process control, permissions,
network/Tailscale recovery, ADB input, logcat, system-state collection,
UIAutomator dumps, screenshots, service health checks, disposable-service
restarts, and evidence recording.

Do not ask code2hack to tap controls, read or describe the display, run terminal
commands, collect logs, restart services, toggle Tailscale, reinstall the APK, or
perform another device/server action while any verified ADB route to the Rokid is
available. Use u4090 USB ADB first, then the documented fallback routes.

The only ordinary escalation threshold is that the Rokid is unavailable through
all verified ADB routes after the recovery procedure in this file. If ADB is
healthy but an exact physical interaction cannot be automated, record that item
as not yet hardware-qualified and continue every other available test; do not
interrupt code2hack unless code2hack explicitly requests or offers a manual
interaction.

## 16. Communication identity

- Messages from a DSH worker begin with `[spark:dsh:<exact-session-id>]`.
- Other coding workers: `[<host>:<worker-kind>:<session-or-thread-id>]`.
- Messages without a valid prefix are treated as coming directly from the user.

## 17. ChatGPT thinking-effort policy

- **Usage-limit fallback (mandatory):** when a ChatGPT reply is blocked by a
  usage limit at a given thinking effort (e.g. "You've hit your limit"), do NOT
  keep polling/re-sending at that same limited effort. Retry the same pending
  request at the next-lower thinking effort (Pro → xhigh → high → medium → low)
  until the thread accepts it.
- **Effort by request type:**
  - Implementation requests (and any runtime/execution ask) → always use
    **xhigh**, whether or not "Pro" is available.
  - Planning and fixing hard bugs → **Pro** is acceptable, and is the only case
    where Pro should be chosen.
- These rules also govern which thinking-effort state the worker selects in the
  thread before sending, and which effort it retries at after a limit.

## Current slice state

- TB0-I0 merged in PR #7.
- TB0-R0 merged in PR #8.
- TB0-A0 merged in PR #9.
- TB0-C0 merged in PR #10 (one-session product text loop, accepted 2026-08-19).
- Active slice: `tb0/repro-dev-runtime` (TB0-D0, reproducible disposable runtime).
- Base merge: `0db1c426e2ec2b8e397d96f5f637c8c5c756cf7e`.
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
