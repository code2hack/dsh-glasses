# TRACER_BULLET_TB0_M0 — ADB-only MVP acceptance

**Status:** PASS — acceptance complete; pending merge.  
**Base:** `97dbec9f759efd4581dbb19c355aa5328f45793b` (D1 merge).  
**Branch:** `tb0/adb-only-mvp-acceptance`.

## 1. Goal

Prove the implemented TB0 one-session text loop end to end on the real Rokid
without requiring any human physical operation.

M0 is an acceptance slice, not a new product-feature slice. It reuses the merged
C0/D0/D1 implementation and exercises the semantic-control layer through ADB
and the D1 debug bridge. It does not qualify Rokid physical controls.

## 2. MVP scope boundary

Included:

- one Rokid debug APK;
- one fresh disposable D0 runtime from an empty `DSH_HOME`;
- one D1-provisioned attached session;
- text-only history and live assistant output;
- plugin-authoritative draft;
- clipboard paste;
- idle Send;
- exactly-once durable user admission;
- assistant response projection;
- restart/reconnect reconstruction;
- hidden-HUD wake-only regression;
- narrow proxy security boundary;
- all interaction driving through ADB-accessible synthetic controls.

Excluded / not claimed:

- physical COMMAND/PRIMARY/SECONDARY/head qualification;
- any physical-input mapping implementation;
- Photo, Voice, Morse, tabs, request panels, Steer/Interrupt;
- production enrollment/pairing/security;
- release build behavior.

## 3. Synthetic-control policy

The canonical M0 driver is `dev/d1-rokid-debug.mjs control`, which calls
`GlassesBridge.debugSemanticControl` and therefore produces
`source=SYNTHETIC_DEBUG_CONTROL` provenance.

`adb input` or `sendevent` may be used only when a diagnostic boundary requires
it. Such events remain `SYNTHETIC_ADB` / `SYNTHETIC_SENDEVENT` and never count
as hardware qualification.

No M0 result may be phrased as proof that a physical Rokid button/touch/gesture
works.

## 4. Canonical clean-room run

Use a new disposable home and unused ports. Do not touch resident DSH/model
services.

1. From current branch, run `node --check` on D0/D1 helpers.
2. Start a fresh D0 runtime with `dev/d0-runtime.mjs up`.
3. Require D0 `status` healthy, direct/proxy bootstrap 200, proxy `/api` 403,
   source+installed plugin digests matching.
4. Build/install the current debug APK on the Rokid.
5. Pipe D0 provisioning JSON over SSH stdin into
   `node dev/d1-rokid-debug.mjs provision --stdin`.
6. Require `streamVerified=true`, `identityFailure=null`, token not emitted.
7. Seed clipboard through D1 with exactly:

   ```text
   Reply with exactly: M0 ADB-only MVP passed
   ```

8. Drive the ordinary product flow through synthetic semantic controls:

   ```text
   COMMAND_SHORT
   SECONDARY_SHORT
   COMMAND_LONG
   DOWN
   COMMAND_RELEASE
   ```

   This is a semantic-layer verification only; it is not a physical-control
   claim.
9. Require exactly one durable user/message for that Send operation and exactly
   one assistant/message whose text is exactly `M0 ADB-only MVP passed`.
10. Require accepted draft clear to the next monotonic revision, empty and
    unlocked.
11. Restart the Android app, run D1 `state`, and require the same attached
    session/history reconstructs with no duplicate user/assistant messages.
12. Run D0 `status` again and require healthy.

## 5. Hidden-HUD wake-only regression

Using synthetic semantic controls only:

1. put the app in a known visible Navigation state;
2. issue `SECONDARY_DOUBLE` to hide the HUD;
3. issue one recognized non-destructive control such as `RIGHT`;
4. require that first control only wakes the HUD and does not also dispatch its
   ordinary handler;
5. issue `RIGHT` again and require that it reaches the ordinary control handler
   rather than being wake-consumed again.

For C0 Navigation specifically, word-motion semantics are outside the implemented
C0 surface. Therefore step 5 is evidenced by the ordinary Navigation branch
(`action='Navigation word motion is outside C0'`), not by a cursor-position
change. This is consistent with the C0 source and does not expand M0 into a new
navigation-feature gate.

Record before/after D1 state snapshots. Provenance remains
`SYNTHETIC_DEBUG_CONTROL`.

## 6. Acceptance gates

M0 passes only if all are true:

- D0 empty-home `up/status/down` remains healthy and ownership-safe;
- D1 provisioning is token-private and `streamVerified=true`;
- current debug APK installs and exposes the expected C0 page;
- clipboard body is not emitted by tooling;
- synthetic text flow produces exactly one durable user message;
- assistant response is exactly `M0 ADB-only MVP passed`;
- draft clears only after accepted Send;
- restart/reconnect reconstructs exactly once;
- hidden-HUD first recognized control is wake-only and the next recognized
  control reaches its ordinary handler;
- helper-created ADB forwards are removed;
- no resident services are modified;
- no physical-hardware qualification is claimed.

Prior accepted C0/D0/D1 evidence does not need to be exhaustively rerun; M0 is a
single clean-room product acceptance pass over the merged seams.

## 7. Evidence

See:

```text
docs/evidence/tb0-m0-adb-only-mvp-acceptance-2026-08-20.md
```

Record exact branch/head, D0 home/ports, APK identity, sanitized session identity,
provision result, synthetic control sequence/provenance, durable user/assistant
counts, response text, draft revision transition, reconnect result, hidden-HUD
state transition, D0 final status, forward hygiene, and any failure.

Never commit the D0 bearer or a real disposable session ID.
