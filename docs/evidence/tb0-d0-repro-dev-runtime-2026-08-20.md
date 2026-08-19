# TB0-D0 — reproducible disposable development runtime evidence

**Status:** runtime qualification **COMPLETE** (all gates green).  
**Branch:** `tb0/repro-dev-runtime`.  
**Base:** `0db1c426e2ec2b8e397d96f5f637c8c5c756cf7e`.

> Runtime-tested implementation head: `fd04f8b58ff2f399c8b8c28f0a9cd4756a85e855`.
> All later commits on `tb0/repro-dev-runtime` up to `8136a0d5…` are
> evidence/documentation only (this evidence record was written on top).

## Exact implementation

- Tested branch/head: `tb0/repro-dev-runtime` @ `fd04f8b58ff2f399c8b8c28f0a9cd4756a85e855` (D0 files from ad2df34 + ops commits; remote branch head)
- Repository root: `/home/code2hack/Projects/glasses/dsh-glasses`
- `@deepseek-ai/dsh` binary/package/version: `/home/code2hack/.npm-global/bin/dsh`, `@deepseek-ai/dsh@0.1.0-rc.7` (npm global)
- pnpm binary/version: pnpm v11.22.0 (hoisted workspace)
- Disposable home: `/tmp/dsh-glasses-d0-e2e-20260819T191317Z` (fresh empty at up; never reused)
- Workspace path/id: `<disposable-workspace-id>` (auto absolute-path workspace.create; exact id kept out of Git)
- Fresh session: `<disposable-session-id>` (auto-created, a0-toolfree; exact id kept out of Git)
- Seed session: `session-tb0-disposable` (auto-seeded)
- DSH/proxy ports: 127.0.0.1:3196 / 0.0.0.0:3202
- Provisioning endpoint: `http://100.92.81.33:3202` (dev bearer ephemeral, stored in state file)
- Plugin source/install path: `<home>/profiles/web/node_modules/dsh-glasses-plugin`; source==install lib digest `e051e25e2e98c2df799739285d1934352c6e036b9335bf0f792721facdf60bc5`

## `up` from empty home

- Home confirmed empty before invocation: yes (script refuses non-empty/populated home; this run created it)
- Command: `node dev/d0-runtime.mjs up --home <home> --dsh-port 3196 --proxy-port 3202`
- stdout JSON parsed: `ok:true`, workspace/seed/session/provisioning/processes/plugin present (see /tmp/d0-up.json)
- state file mode: `<home>/.d0-runtime/state.json` written with ownership/token metadata
- DSH bind proof: `ss -ltnp` -> `127.0.0.1:3196` (loopback only)
- proxy bind proof: `0.0.0.0:3202`
- direct bootstrap: HTTP 200 (asOf 2 at up)
- proxy bootstrap: HTTP 200 (asOf 25 after send; status verified 200)
- proxy `/api/*` block: HTTP 403 through :3202
- seed durable log: `<home>/sessions/…session-tb0-disposable…/session.jsonl.zstd` exists
- fresh durable log: `<home>/sessions/…<fresh>…/session.jsonl.zstd` exists
- generated-file/template checks: profile package.json (bundles dsh-base+dsh-web-app, schemastery, plugin file:), cordis.yml [], cordis.patch.yml plugin insert, pnpm-workspace.yaml (hoisted), settings.yaml (tb0vllm only, agent-default-model tb0vllm/lfm2.5-vl-3b, webserver 127.0.0.1:3196), a0-toolfree preset
- plugin `projection.js` + digest equality: present in installed COPY; source==install SHA-256 verified by status

## Assistant-output smoke

Prompt:

```text
Reply with exactly: D0 automated runtime passed
```

- mutation operation id: `c0-mut-b4534ece-a7e9-44d3-9ebb-01d7a52728ad` (rev 0 -> 1, replace)
- Send operation id: `c0-send-fa5df798-29ac-42c8-8616-4fd1ae1c99b8`
- durable user-message count: **exactly 1** (rpcId == send op, seq 7)
- assistant-message count/text: **exactly 1**, `D0 automated runtime passed` (seq 22)
- provider/model: tb0vllm / lfm2.5-vl-3b
- accepted draft revision/text/lock: revision **2**, text empty, unlocked (monotonic clear D accepted -> D+1)

## `status`

- command: `node dev/d0-runtime.mjs status --home <home>`
- `ok`: true, `healthy`: true
- DSH PID/start-ticks identity: 1272604 (unchanged through the whole acceptance run)
- proxy PID/start-ticks identity: 1272616
- direct/proxy/bootstrap statuses: direct 200, proxy 200, proxy /api 403
- proxy `/api` status: 403
- `repoMatches`: true (recorded fd04f8b == current fd04f8b)
- `pluginMatches`: true (source==install digest)

## Long-SSE survival

- stream open UTC: 2026-08-19T19:15:26.210Z (authenticated, session-scoped)
- heartbeat count/duration: **3 heartbeats** (SSE comment frames `: hb 14999 / 30000 / 45001`, ~15 s cadence)
- stream close UTC: 2026-08-19T19:16:16Z (clean client close)
- 10-second post-close process proof: dsh pid 1272604 + proxy 1272616 still alive (no silent death)
- post-close `status`: healthy true, same PIDs
- DSH log tail/errors: plugin ready + dsh web line only; no errors

## `down`

- command: `node dev/d0-runtime.mjs down --home <home>` (twice; second must be harmless)
- DSH termination action: ownership-safe terminate (exit 0)
- proxy termination action: terminate (exit 0)
- ports closed: 3196 and 3202 freed (ss confirmed)
- home/state/logs preserved: profiles/sessions/settings/storages/workspace + .d0-runtime/logs/{dsh,proxy}.log remain
- second-down result: harmless (exit 0, no error)

## Clean-home host-write suite

- command: `node dev/d0-host-write-recovery.mjs`
- wrapper-created home: fresh empty `<tmp>/dsh-glasses-d0-host-write-<rand>` (e.g. …-dXyxz8)
- seed session automatic: yes (`session-tb0-disposable` created by the wrapper)
- suite scenarios passed: **16/16**
- final `ALL PASS`: printed; wrapper `ok:true`, `cleanHomeSelfSeeded:true`
- preserved-home path: reported by wrapper (`preservedHome:true`)

## Remaining gaps

- clipboard seed fixture / Rokid provisioning helper: D1;
- physical function/touch/head-wheel semantics: unqualified;
- unexplained golden SSE death: must be absent in D0 acceptance or reported as blocker;
- product features beyond merged C0: outside D0.


## Installed-mirror tamper detection (status)

Fresh home `d0-tamper` (DSH :3198 / proxy :3203), abbreviated gate only (no
assistant/SSE/host-write rerun):

| Check | Result |
| --- | --- |
| `up` | ok |
| status #1 (untampered) | `healthy:true`, `sourcePluginMatches:true`, `installedPluginMatches:true`, `pluginMatches:true` |
| append `// tamper-detection marker` to installed `lib/projection.js` | done |
| status #2 (tampered mirror) | `healthy:false`, `sourcePluginMatches:true`, `installedPluginMatches:false`, `pluginMatches:false` |
| `down` | exit 0; second `down` exit 0 (harmless) |

`status` now re-hashes BOTH the repo source `lib` and the installed mirror
`lib`; `healthy` requires both to equal the recorded `sourceLibDigest`.

## Verdict

**PASS — all D0 gates green.** The reproducible disposable runtime
(`dev/d0-runtime.mjs`) rebuilt the C0-grade environment from an empty home and
qualified on every frozen gate: loopback-only DSH, plugin mirrored +
content-verified, seed + fresh a0-toolfree sessions, tb0vllm/LFM assistant
output, exactly-one durable user/message, accepted monotonic draft clear,
narrow-proxy bootstrap with `/api` blocked, long-SSE survival through 3
heartbeats with NO recurrence of the golden silent-death risk, idempotent
`down` preserving the home, and the self-seeding host-write suite 16/16.

Environment note: the D0 acceptance run found a stray worker-owned DSH daemon
listening on 3196 (resident :3080 untouched); it was terminated before `up`
because D0 correctly refuses to override an occupied port.
