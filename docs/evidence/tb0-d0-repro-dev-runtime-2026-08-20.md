# TB0-D0 — reproducible disposable development runtime evidence

**Status:** runtime qualification pending.  
**Branch:** `tb0/repro-dev-runtime`.  
**Base:** `0db1c426e2ec2b8e397d96f5f637c8c5c756cf7e`.

## Exact implementation

- Tested branch/head:
- Repository root:
- `@deepseek-ai/dsh` binary/package/version:
- pnpm binary/version:
- Disposable home:
- Workspace path/id: `<workspace-id>`
- Fresh session: `<disposable-session-id>`
- Seed session: `session-tb0-disposable`
- DSH/proxy ports:
- Provisioning endpoint:
- Plugin source/install path and SHA-256 digests:

## `up` from empty home

- Home confirmed empty before invocation:
- Command:
- stdout JSON parsed:
- state file mode:
- DSH bind proof:
- proxy bind proof:
- direct bootstrap:
- proxy bootstrap:
- proxy `/api/*` block:
- seed durable log:
- fresh durable log:
- generated-file/template checks:
- plugin `projection.js` + digest equality:

## Assistant-output smoke

Prompt:

```text
Reply with exactly: D0 automated runtime passed
```

- mutation operation id:
- Send operation id:
- durable user-message count:
- assistant-message count/text:
- provider/model:
- accepted draft revision/text/lock:

## `status`

- command:
- `ok`:
- DSH PID/start-ticks identity:
- proxy PID/start-ticks identity:
- direct/proxy/bootstrap statuses:
- proxy `/api` status:
- `repoMatches`:
- `pluginMatches`:

## Long-SSE survival

- stream open UTC/monotonic:
- heartbeat count/duration:
- stream close UTC/monotonic:
- 10-second post-close process proof:
- post-close `status`:
- DSH log tail/errors:

## `down`

- command:
- DSH termination action:
- proxy termination action:
- ports closed:
- home/state/logs preserved:
- second-down result:

## Clean-home host-write suite

- command: `node dev/d0-host-write-recovery.mjs`
- wrapper-created home:
- seed session automatic:
- suite scenarios passed:
- final `ALL PASS`:
- preserved-home path:

## Remaining gaps

- clipboard seed fixture / Rokid provisioning helper: D1;
- physical function/touch/head-wheel semantics: unqualified;
- unexplained golden SSE death: must be absent in D0 acceptance or reported as blocker;
- product features beyond merged C0: outside D0.

## Verdict

Pending.
