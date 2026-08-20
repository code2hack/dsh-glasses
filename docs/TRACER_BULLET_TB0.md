# TRACER_BULLET_TB0 — one-session text round trip

**Status:** COMPLETE. H0, host-write, G0, I0, R0, A0, C0, D0, D1, and **TB0-M0 ADB-only MVP acceptance** are merged on `main`; M0 merged in PR #13 at `f92a866f2e46c769cd28b90c2260213795430ac2`. Physical input qualification (P0) was eliminated from the MVP by code2hack on 2026-08-19.  
**Date:** 2026-08-20  
**Repo:** `code2hack/dsh-glasses` (authoritative branch: `main`)  
**Normative source:** `SPEC.md` revision 3 for product behavior. The MVP scope below may defer normative physical-input behavior without claiming that behavior implemented or qualified.

TB0 is now a historical acceptance/reference document. New implementation work is planned as GitHub Milestones and Tickets under `docs/WORKFLOW.md`; do not encode a new "current slice" here or in `AGENTS.md`.

Supporting compatibility evidence: `docs/evidence/tb0-dsh-compat-2026-08-19.md`.

---

## 1. Frozen pins

| Item | Pin |
| --- | --- |
| DSH | `@deepseek-ai/dsh@0.1.0-rc.7` |
| Disposable runtime | `dev/d0-runtime.mjs` |
| Rokid debug helper | `dev/d1-rokid-debug.mjs` |
| Plugin package | `dsh-glasses-plugin` |
| Rokid target | `Rokid/glasses/glasses:12/SKQ1.240613.001/1.23.009-20260725-150201:user/release-keys` |
| Product data route | Rokid ↔ Spark over private LAN/Tailscale; ADB is debug/control only |

## 2. TB0 MVP scope

### Included

- one Rokid device;
- one plugin instance on Spark;
- one attached DSH session;
- one ordinary composer target;
- text only;
- bounded history snapshot;
- live assistant output;
- plugin-authoritative text draft with monotonic revision;
- clipboard paste into the draft;
- idle-session Send;
- disconnect/reconnect without duplication;
- unknown-acceptance reconciliation already qualified in R0/C0/D0;
- reproducible disposable host runtime (D0);
- reproducible Rokid debug provisioning/clipboard/CDP control (D1);
- final real-device acceptance driven through ADB-accessible synthetic semantic controls (M0).

### Excluded from TB0 MVP

- **physical COMMAND/PRIMARY/SECONDARY/head-motion qualification**;
- physical-input mapping implementation or hardware-exclusivity claims;
- multiple tabs;
- plugin session-management UI;
- request panels and choices;
- Photo;
- Voice;
- Morse;
- images and rich image clipboard;
- Steer/Interrupt;
- production pairing/enrollment;
- production Funnel security;
- notifications/background wake;
- release-build qualification;
- full UI polish.

P0 physical qualification is recorded as eliminated in
`docs/TRACER_BULLET_TB0_P0.md`. The abandoned P0 branch may retain
observation-only tracer work for future investigation, but none of it is an MVP
gate.

## 3. Frozen TB0 choices

### 3.1 Development authentication

- One ephemeral development bearer per disposable D0 runtime.
- MUST NOT be hard-coded or committed.
- D1 receives provisioning JSON over stdin so the bearer is not exposed in argv.
- Production pairing remains outside TB0.

### 3.2 Route surface

Project-owned glasses namespace:

| Route | Purpose |
| --- | --- |
| `GET /glasses/v1/bootstrap` | bounded initial history, attachment projection, status, committed draft |
| `GET /glasses/v1/stream` | live SSE event stream |
| `POST /glasses/v1/draft/mutations` | plugin-authoritative draft mutations |
| `POST /glasses/v1/actions` | semantic action; Send is the TB0 action |

The narrow glasses proxy MUST NOT expose unrestricted DSH `/api/*` routes.

### 3.3 Transport

- DSH itself is loopback-only in the disposable runtime.
- The narrow glasses proxy is the only LAN/tailnet-facing TB0 surface.
- Authentication is mandatory even on private transport.

### 3.4 MVP interaction verification is ADB-only

The original TB0 contract required real Rokid physical controls. That requirement
is superseded for the MVP by code2hack's 2026-08-19 scope decision.

MVP acceptance drives the existing semantic-control layer through
`dev/d1-rokid-debug.mjs control`, which calls
`GlassesBridge.debugSemanticControl` and records
`source=SYNTHETIC_DEBUG_CONTROL`.

The canonical synthetic sequence is:

| Synthetic control | Product action exercised |
| --- | --- |
| `COMMAND_SHORT` | toggle Navigation → Input |
| `SECONDARY_SHORT` | paste clipboard before current word |
| `COMMAND_LONG` | open command wheel |
| `DOWN` | move wheel selection to Send |
| `COMMAND_RELEASE` | activate selected Send action |

These events verify application semantics only. They are **not** evidence that
physical Rokid buttons, touchpad gestures, timing classifiers, or head motion are
working or exclusive.

`adb input` / `sendevent` may be used for diagnostics when useful, but remain
`SYNTHETIC_ADB` / `SYNTHETIC_SENDEVENT` and never become hardware claims.

### 3.5 Hidden-HUD behavior

Frozen for TB0:

> The first recognized operation while the HUD is hidden is wake-only. It must
> not also paste, switch mode, open a wheel, cut, Send, or otherwise perform its
> ordinary action.

M0 verifies this with synthetic debug controls. In the implemented C0 Navigation
surface, `RIGHT` word movement itself is outside C0; therefore the regression
checks that the first `RIGHT` is wake-consumed and the second reaches the
ordinary Navigation handler, not that a Navigation cursor physically moves.

## 4. Mandatory M0 acceptance scenario

```text
Given:
  - a genuinely fresh disposable D0 home;
  - one idle attached DSH session;
  - the current debug APK installed on the Rokid;
  - D1 provisioning has streamVerified=true;
  - clipboard text "Reply with exactly: M0 ADB-only MVP passed".

When:
  1. glasses installs the bootstrap snapshot;
  2. SYNTHETIC_DEBUG_CONTROL COMMAND_SHORT enters Input;
  3. SYNTHETIC_DEBUG_CONTROL SECONDARY_SHORT pastes the clipboard;
  4. the plugin acknowledges the next committed draft revision;
  5. SYNTHETIC_DEBUG_CONTROL COMMAND_LONG opens the wheel;
  6. SYNTHETIC_DEBUG_CONTROL DOWN selects Send;
  7. SYNTHETIC_DEBUG_CONTROL COMMAND_RELEASE submits the frozen draft;
  8. DSH accepts and responds;
  9. the Android app is restarted and reconnects.

Then:
  - the user message appears exactly once;
  - the draft clears only after authoritative acceptance;
  - the assistant response is exactly "M0 ADB-only MVP passed";
  - assistant output streams/projects to the glasses;
  - restart/reconnect restores the same history without duplication;
  - D0 status remains healthy;
  - the narrow proxy still blocks `/api/*`;
  - no physical-hardware qualification is claimed.
```

M0 also rechecks the hidden-HUD wake-only rule using
`SECONDARY_DOUBLE` → hidden HUD → first `RIGHT` wake-only → second `RIGHT`
ordinary-handler dispatch.

The detailed M0 matrix is `docs/TRACER_BULLET_TB0_M0.md`.

## 5. Previously qualified architectural invariants

M0 does not need to exhaustively rerun every earlier suite. The following remain
accepted from merged evidence unless the current clean-room run contradicts
them:

- host-write operation IDs and exactly-once/reconciliation behavior;
- R0 unknown-acceptance recovery;
- A0 assistant-output projection;
- C0 one-session product text loop, restart/reconnect, hidden-HUD behavior;
- D0 reproducible host runtime, long-SSE survival, ownership-safe down,
  installed-plugin integrity checks, clean-home host-write 16/16;
- D1 real-Rokid provisioning, clipboard SHA-256 verification, CDP state,
  synthetic semantic controls, and ADB-forward hygiene.

Any regression observed by M0 is a blocker even if an older slice passed.

## 6. What remains unspecified after TB0 MVP

Physical input qualification/mapping, production QR/PAKE pairing, multiple tabs,
Photo staging, Voice runtime, Morse input, request-choice schemas, background
wake/notifications, rich image clipboard, production security, and full UI polish
remain future work.

## 7. M0 evidence

See:

```text
docs/evidence/tb0-m0-adb-only-mvp-acceptance-2026-08-20.md
```

Never commit the disposable bearer or a real disposable session ID. All
synthetic-control evidence must preserve its `SYNTHETIC_*` provenance.
