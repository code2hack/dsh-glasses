# TB0-D1 — reproducible Rokid debug provisioning evidence

**Status:** runtime qualification pending.  
**Branch:** `tb0/repro-device-debug`.  
**Base:** `6f512aa39c9b1b496b89cd24c305a518997b0c26`.

## Exact tested artifacts

- Branch/head:
- Debug APK path/size/version:
- Build host:
- ADB serial/model/fingerprint:
- D0 runtime head/home/provisioning source:
- D1 helper Node version:

## Host checks

| Check | Result |
| --- | --- |
| `node --check dev/d1-rokid-debug.mjs` | pending |
| Android `:app:assembleDebug` | pending |
| exact debug APK installed | pending |
| debug-only clipboard Activity present | pending |
| release manifest does not contain clipboard Activity | pending |

## Provisioning

- D0 provisioning JSON piped through stdin:
- bearer absent from remote argv:
- helper stdout/stderr bearer scan:
- configure result:
- process restart:
- endpoint equality:
- expected-session equality:
- identityFailure:
- streamVerified:
- selected WebView target title/url:
- ADB forward created/removed:

## Clipboard

Fixed phrase:

```text
D1 clipboard reproducibility passed
```

- Activity launch result:
- debug log row (count only):
- host input characters/bytes:
- host SHA-256:
- app-observed SHA-256:
- exact match:
- stdout/stderr/logcat body-leak scan:

## Synthetic controls

Controls:

```text
COMMAND_SHORT
RIGHT
LEFT
```

Record:

- native `DSHGlassesBridge` log rows:
- provenance exactly `SYNTHETIC_DEBUG_CONTROL`:
- before state:
- after COMMAND_SHORT:
- after RIGHT:
- after LEFT:
- no claim of physical qualification:

## State output

- JSON parse result:
- device identity fields:
- endpoint/session identity:
- mode/HUD/write/draft fields:
- stream/generation/sequence fields:
- bearer absent:
- clipboard body absent:

## Remaining gaps

- physical function-button short/long: unqualified;
- physical one-/two-finger touch/swipe: unqualified;
- final head-wheel semantics: unqualified;
- production enrollment/pairing: outside D1;
- Photo/Voice/Morse/tabs/Steer/Interrupt: outside D1.

## Verdict

Pending.
