# M1 (#27) — TB0 artifact preservation & quarantine evidence

Date: 2026-08-22 (ticket #27, Milestone M1)
Branch: `workflow/ticket-27`

```text
BASE               = e770e4d39b0df32ce7ee5d8cb7f5c914463fca94  (admitted base)
VERIFIED_CODE_HEAD = e88548b0aa37f9fb3573688267307b13f925a8d5  (verified production-code head)
```

This evidence record (`docs/evidence/m1-27-tb0-quarantine-2026-08-22.md`) was
ADDED afterward on `workflow/ticket-27`, so it is intentionally NOT part of the
protected/unchanged set. The checks below use base-relative paths and an
exclusion for this record so they are reproducible at any present or future
branch state.

## Intent

The M1 model promotes the proven TB0 one-session read path into the normative
M1 attachment/snapshot model. The TB0 write slice is NOT removed: it is kept
verbatim and rendered **dormant** — present in source, reachable by no ordinary
M1 path. Historical TB0 evidence and dev tooling remain untouched. This
document is the durable record of that preservation/quarantine.

## 1. Historical TB0 files are untouched

Exact diff verification versus the admitted base. All commands are reproducible
and must yield empty output / rc=0:

```bash
BASE=e770e4d39b0df32ce7ee5d8cb7f5c914463fca94
VERIFIED_CODE_HEAD=e88548b0aa37f9fb3573688267307b13f925a8d5

# The two explicitly protected files:
git diff --exit-code "$BASE" HEAD -- \
  docs/evidence/tb0-dsh-compat-2026-08-19.md \
  dev/d0-runtime.mjs \
  dev/d0-host-write-recovery.mjs
# -> empty / rc=0

# ALL records that already existed under docs/evidence/ at BASE are unchanged
# (operates on the base file set, so later M1 evidence additions are ignored
# by construction — robust at any future final head):
git ls-tree -r -z --name-only "$BASE" docs/evidence/ \
  | xargs -0 git diff --exit-code "$BASE" HEAD --
# -> empty / rc=0

# Historical check BEFORE this evidence record was added:
git diff --name-only "$BASE" "$VERIFIED_CODE_HEAD" -- docs/evidence/
# -> empty
```

In particular:
- No record that existed under `docs/evidence/` at BASE was modified. New M1
  evidence records (this quarantine record and any later M1 acceptance
  records) are additions only; the base-file-set command above ignores them by
  construction and remains reproducible at any final head.
- `docs/evidence/tb0-dsh-compat-2026-08-19.md` — unchanged.
- `dev/d0-runtime.mjs` — unchanged.
- `dev/d0-host-write-recovery.mjs` — still committed, unchanged.

## 2. Dormant TB0 write/SSE source is preserved (present, unreachable)

The following historical functions remain defined in
`apps/glasses-android/app/src/main/assets/app.js` (each `def:1` verified):

```text
applySnapshot  recoverSnapshot      onSseLine      onStreamState
startSend      pasteClipboard       performPendingMutation
performPendingSend  scheduleMutationRetry  scheduleSendRetry
resumePendingOperations  enterSessionMismatch
```

M1 quarantining relies on three guards, all proven by the committed real-DOM
suite (`apps/glasses-android/test/m1-render.test.mjs`, 30/30) and the
real-rc.2 narrow-edge suite (`test/m1-narrow-edge.test.mjs`, 11/11):

1. `M1_READ_ONLY = true` short-circuits `handleSemanticControl` before any TB0
   write control (`startSend`, `pasteClipboard`, wheel) is reachable; mode never
   enters `input`, composer stays hidden.
2. `init()` publishes bounded M1 no-ops for the native SSE callbacks
   (`glassesOnLine`/`glassesOnStream`), so the legacy
   `onSseLine -> recoverSnapshot -> applySnapshot` chain has no externally
   reachable entry in M1 (proven: invoking the callbacks mutates zero state).
3. `fetchSnapshot()` is transport-only for HTTP-200; every snapshot-data
   decision belongs to `stageSnapshot()`, so TB0's destructive
   `enterSessionMismatch` clear cannot bypass atomic rejection.

Static invocation-site analysis (reproducible with `grep`): all call sites of
the dormant write/stream functions live inside functions unreachable from
`run -> stageAndInstall -> installSnapshot`; `openStream()` has zero call
sites; the only HTTP request in an installed M1 runtime is
`/glasses/v1/bootstrap`.

## 3. C0 reducer coverage is preserved

The pure client reducer (`apps/glasses-android/app/src/main/assets/c0-core.js`)
and its unit suite (`apps/glasses-android/test/c0-core.test.mjs`) remain
committed and green (PASS) on the evidence head — the TB0 reducer behavior is
not deleted by M1.

## 4. Scope wording

Per the 2026-08-22 ChatGPT review of T27-09, the autonomous no-device chain is
accurately described as:

```text
real pinned rc.2 DSH + worktree plugin
  -> real dev/glasses-dev-proxy.mjs
  -> authenticated canonical bootstrap
  -> production snapshot-core.js staging
  -> production c0-core.js / index.html / app.js DOM runtime
     with the Android native bridge as a deliberate SYNTHETIC boundary
     (supplied the actual proxy-captured response)
```

jsdom provides the DOM boundary; it does not perform Android-native HTTP
transport. Both statements are host-only, deterministic-fixture claims; no
device/hardware behavior is implied.

## 5. Supporting commands (reproducible)

```bash
DSH_BIN=/home/code2hack/.npm-global/bin/dsh node apps/glasses-android/test/c0-core.test.mjs
node apps/glasses-android/test/snapshot-core.test.mjs
node apps/glasses-android/test/m1-render.test.mjs
DSH_BIN=/home/code2hack/.npm-global/bin/dsh node test/m1-narrow-edge.test.mjs
# all PASS on the evidence head
```
