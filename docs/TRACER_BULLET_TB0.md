# TRACER_BULLET_TB0 — one-session text round trip

**Status:** H0, host-write, G0, I0, R0, and A0 complete. Active gate: TB0-C0 message-content projection and the one-session product text loop.
**Date:** 2026-08-19
**Repo:** `code2hack/dsh-glasses` (authoritative branch: `main`)
**Normative source:** `SPEC.md` (revision 3). When TB0 implementation contradicts a normative SPEC assumption, `SPEC.md` is updated in the same commit.

Supporting evidence: `docs/evidence/tb0-dsh-compat-2026-08-19.md`.

---

## 1. Frozen pins (live values)

| Item | Pin |
| --- | --- |
| DSH | `@deepseek-ai/dsh@0.1.0-rc.7` (installed at `~/.npm-global/lib/node_modules/@deepseek-ai/dsh`; dist integrity sha512 recorded in evidence) |
| DSH profile | `web` under `DSH_HOME=/home/code2hack/.dsh` |
| Node.js | `v24.14.1` |
| pnpm / npm | `11.22.0` / `11.11.0` |
| Host | spark (DGX Spark, NVIDIA GB10) |
| Plugin package name | `dsh-glasses-plugin` |
| DSH artifact identity | `@deepseek-ai/dsh@0.1.0-rc.7` + exact npm dist-integrity `sha512-ZceDCJ8FAywih+USW/OMk9jEhunlvJBGEz4kqrhau23hPzbciOazZrywH0nBRsaalSeAJ1JGBmjtw4OSjToStw==`; upstream source SHA unavailable from the installed artifact |

## 2. Scope

### TB0 included

- one Rokid device;
- one plugin instance on Spark;
- one statically configured existing DSH session;
- one ordinary composer target;
- text only;
- bounded history snapshot;
- live assistant output;
- plugin-authoritative text draft with monotonic revision;
- clipboard paste into the draft;
- idle-session Send;
- disconnect/reconnect without duplication;
- unknown-acceptance reconciliation;
- no duplicate user message.

`Steer` MAY be included when the exact live DSH API makes it a trivial extension; otherwise it is `TB0.1` and does not delay TB0.

### Excluded from TB0

- multiple tabs;
- plugin session-management UI;
- request panels and choices;
- Photo;
- Voice;
- Morse;
- images and rich image clipboard;
- production pairing;
- production Funnel security;
- notifications and background wake;
- UI polish.

## 3. Frozen TB0 choices

### 3.1 Development authentication

- One random 32-byte development bearer credential.
- MUST NOT be hard-coded in source; MUST NOT be committed.
- Stored in a private plugin-side secret file.
- Provisioned into glasses app-private storage for the tracer.
- Bound to one development device record.
- Revocable by deleting that record.
- Production pairing remains outside TB0.

### 3.2 Route surface

Project-owned namespace unless the compatibility probe proves a concrete conflict (duplicates throw at registration, see evidence §2.9):

| Route | Purpose |
| --- | --- |
| `GET  /glasses/v1/bootstrap` | bounded initial history, attachment projection, current status, committed draft |
| `GET  /glasses/v1/stream` | live SSE event stream (host holds response open) |
| `POST /glasses/v1/draft/mutations` | plugin-authoritative draft mutations (monotonic revision) |
| `POST /glasses/v1/actions` | semantic action: **Send only** for TB0 (`Steer` reserved for TB0.1; `Interrupt` for a later slice) |

Unrestricted DSH APIs MUST NOT be exposed through this namespace.

### 3.3 Transport

- Trusted LAN during the first local trace.
- Tailscale Serve or Funnel only when needed for reachability.
- Authentication remains mandatory even on LAN.

### 3.4 First hardware controls

TB0 needs only:

| Control | Action |
| --- | --- |
| short `COMMAND` | toggle Navigation/Input |
| single `SECONDARY` | paste clipboard text before the current word |
| long `COMMAND` | open command wheel |
| head-down wheel selection + release | select the bottom `Send` action |

Build the raw Rokid input tracer before assuming those controls work (qualify exact delivered Android/Rokid events, short-vs-long timing, native-behavior interference, and cancellation on focus/background loss).

### 3.5 Hidden-HUD behavior

Frozen for TB0:

> The first recognized operation while the HUD is hidden is **wake-only**. It must not also paste, switch mode, open a wheel, cut, Send, or otherwise perform its ordinary action.

## 4. Mandatory acceptance scenario

```
Given: one idle attached DSH session; clipboard text "Reply with exactly: tracer passed";
       authenticated glasses connection.
When:
  1. glasses installs the bootstrap snapshot;
  2. short COMMAND enters Input;
  3. single SECONDARY pastes the clipboard;
  4. plugin acknowledges draft revision D+1;
  5. long COMMAND opens the wheel;
  6. head-down selects Send;
  7. COMMAND release submits the frozen draft;
  8. DSH accepts and responds.
Then:
  - the user message appears exactly once;
  - the draft clears only after authoritative acceptance;
  - the assistant response streams to the glasses;
  - restarting/reconnecting restores history without duplication.
```

### Ambiguous-outcome test

```
send action → break the connection immediately → reconnect → reconcile the same operationId
```

Only these outcomes are valid:

- DSH accepted → exactly one user message, draft cleared.
- DSH did not accept → zero user messages, draft retained.
- **Two user messages: automatic failure.**

This one test exercises the project's core architectural claims: actual Rokid input, native shell/WebView bridge, authentication, plugin routes, attachment projection, committed draft authority, DSH adapter, Send, live output, revision recovery, and no replay.

## 5. What may remain unspecified during TB0

Production QR/PAKE pairing, Funnel exposure, multiple tabs, Photo staging, multimodal provider behavior, Voice model choice, Morse lexicon and timings, request-choice schemas, background wake/notification policy, image garbage collection, rich cross-surface clipboard, full UI polish.

## 6. Delivery

Commit and push:

```
docs/evidence/tb0-dsh-compat-2026-08-19.md
docs/TRACER_BULLET_TB0.md
```

Commit message: `docs: freeze TB0 contract and DSH compatibility pin`

Update `SPEC.md` only when live DSH evidence contradicts a normative assumption. Do not begin the production plugin/client implementation until the compatibility evidence and TB0 contract are coherent.
