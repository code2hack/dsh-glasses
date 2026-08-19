# TB0-M0 — ADB-only MVP acceptance evidence

**Status:** pending execution.  
**Branch:** `tb0/adb-only-mvp-acceptance`.  
**Base:** `97dbec9f759efd4581dbb19c355aa5328f45793b`.

## Exact tested artifacts

- Branch/head:
- D0 runtime head/home/ports:
- Debug APK path/size/version:
- Build host:
- ADB serial/model/fingerprint:
- D1 helper Node version:

## D0 clean-room runtime

- empty home:
- `up` result:
- direct bootstrap:
- proxy bootstrap:
- proxy `/api`:
- `status` before device flow:
- source/installed plugin digests:

## D1 provisioning

- provisioning transport: SSH stdin
- bearer absent from argv/stdout/stderr:
- streamVerified:
- identityFailure:
- endpoint/session match:
- helper-created forward cleanup:

## Clipboard

Input:

```text
Reply with exactly: M0 ADB-only MVP passed
```

- characters/bytes:
- host SHA-256:
- app-observed SHA-256:
- exact match:
- clipboard body emitted by tooling:

## Synthetic product flow

Controls:

```text
COMMAND_SHORT
SECONDARY_SHORT
COMMAND_LONG
DOWN
COMMAND_RELEASE
```

- provenance: `SYNTHETIC_DEBUG_CONTROL`
- native debug-control trace rows:
- before state:
- after COMMAND_SHORT:
- after SECONDARY_SHORT:
- after COMMAND_LONG:
- after DOWN:
- after COMMAND_RELEASE:

## Durable result

- Send operation id: `<sanitized>`
- durable user/message count:
- assistant/message count:
- assistant text:
- provider/model:
- draft revision transition:
- final draft text/lock:

## Restart / reconnect

- app restart result:
- D1 state after restart:
- user/message count after restart:
- assistant/message count after restart:
- duplicate detected:

## Hidden-HUD wake-only

- known starting state:
- `SECONDARY_DOUBLE` result:
- first `RIGHT` result (wake-only):
- second `RIGHT` result (ordinary movement):
- provenance:

## Final health / hygiene

- D0 final `status`:
- helper-created ADB forwards remaining:
- resident services modified:
- physical-hardware qualification claimed: **NO**

## Verdict

Pending.
