# TB0-C0 disposable runtime — read-only reproducibility audit

Date: 2026-08-19. Branch: merged `main` `2f2683926941547a56d5e55dfd399601bea4dc78`.
Scope: record every manual step required to recreate the disposable C0 runtime
from an **empty temporary `DSH_HOME`**, identify every prerequisite NOT captured
in Git, and name the smallest seams a future reproducible-development-runtime
slice must automate. **Read-only**: no automation is implemented or redesigned
here.

Auditor: spark DSH worker. Hosts: spark (DGX GB10, aarch64 — DSH runtime),
u4090 (x86-64 — Android build/ADB), Rokid `1906092617103125` (`RG-glasses`),
spark2 `192.168.100.11:8887` (keyless vLLM vision/text sidecar, user-deployed,
not to be redeployed).

## 1. Target environment (end state)

- Disposable DSH instance on spark, `DSH_HOME=/tmp/dsh-tb0-home`,
  `--profile web`, web port (3190 legacy / 3192 C0), `@deepseek-ai/dsh@0.1.0-rc.7`.
- Plugin `dsh-glasses-plugin` (repo `plugins/dsh-glasses-plugin`) installed as an
  npm `file:` copy under `<DSH_HOME>/profiles/web/node_modules/dsh-glasses-plugin`,
  bound at apply-time to `DSH_GLASSES_TB0_SESSION_ID` and guarded by
  `DSH_GLASSES_TB0_TOKEN` (dev bearer).
- Provider `tb0vllm` (openai-completions, `http://192.168.100.11:8887/v1`,
  model `lfm2.5-vl-3b`) as `agent-default-model`; dummy key env
  `TB0VLLM_API_KEY=dev-keyless-a0`; tool-less agent preset `a0-toolfree`.
- Rokid WebView app (debug APK, `0.1.0-g0`, this C0 product code) provisioned
  with base `http://100.92.81.33:3200`, the dev bearer, and one C0 session.

## 2. Manual steps (exact commands / file writes)

### 2.1 Fresh disposable home + profile with the plugin

The profile directory was created in earlier slices; the exact creation command
is **not in Git**. Recreating from an empty temp home requires, at minimum:

```bash
export DSH_HOME=<empty temp dir, e.g. /tmp/dsh-tb0-home>
mkdir -p "$DSH_HOME/profiles/web"
# profile package.json: dependencies { "@deepseek-ai/schemastery": "^3.18.1",
#   "dsh-glasses-plugin": "file:/<repo>/plugins/dsh-glasses-plugin" }
#   and a cordis.yml pointing at plugin bundles. (NOT captured in Git —
#   candidate seam: a committable profile template.)
(cd "$DSH_HOME/profiles/web" && npm install)   # installs the file: copy (local, no network)
```

The npm `file:` install COPIES the plugin (not a link). Because it snapshots at
install time, a later source change that adds NEW files (e.g. `projection.js`)
is NOT reflected in the installed copy. In this slice the pre-C0 copy lacked
`projection.js`; the round fixed it by copying the repo lib over the installed
copy:

```bash
cp -f <repo>/plugins/dsh-glasses-plugin/lib/index.js     "$DSH_HOME/profiles/web/node_modules/dsh-glasses-plugin/lib/"
cp -f <repo>/plugins/dsh-glasses-plugin/lib/projection.js "$DSH_HOME/profiles/web/node_modules/dsh-glasses-plugin/lib/"
```

Seam: refresh-on-build / link-mount of the plugin into the profile.

### 2.2 Provider configuration — `<DSH_HOME>/settings.yaml` (NOT in Git)

```yaml
llm-pi-ai:
  providers:
    ds4:            # resident-shape example only; never required for C0
      api: openai-responses
      apiKeyEnv: DS4_API_KEY
      baseURL: http://192.168.1.9:8888/v1   # resident; NOT to be used by C0
      models: [...]
    tb0vllm:
      apiKeyEnv: TB0VLLM_API_KEY            # pi-ai requires a key even for keyless vLLM
      api: openai-completions
      baseURL: http://192.168.100.11:8887/v1
      models:
        - id: lfm2.5-vl-3b
          name: LFM2.5-VL-3B
          contextWindow: 32768
          maxTokens: 4096
agent-default-model:
  provider: tb0vllm
  model: lfm2.5-vl-3b                      # NOTE: must NOT set reasoningEffort — lfm2.5-vl-3b
                                           # rejects it (UNSUPPORTED_REASONING_EFFORT)
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
permission:
  defaultPreset: danger-full-access
agent-presets:
  default: standard
webserver:
  host: 0.0.0.0
  port: 3192
```

Prerequisites NOT captured in Git: this file, the `ds4` resident entry, onboarding
version. Seam: a committable `settings.yaml.template` + an env-scoped overlay.

### 2.3 Dummy keyless-provider env

`TB0VLLM_API_KEY=dev-keyless-a0` must be exported in the instance environment
(the `pi-ai` credential resolver refuses the route otherwise). vLLM is keyless
and ignores the dummy bearer.

### 2.4 Tool-less preset `a0-toolfree` (NOT in Git)

`<DSH_HOME>/.agent-presets/a0-toolfree/preset.yml` (`name: A0 Tool-Free`, `order: 9`)
and `agent.cordis.yml` (persona-only, `complete: true`, `includeRuntimeContext:
false` — no tool groups). Required because the stock `standard` agent sends
`tool_choice:"auto"`, which the deployed vLLM (no `--enable-auto-tool-choice`)
rejects; with no tool schemas the adapter omits `tools`. Seam: a committable user
preset template + a `session.create` helper.

### 2.5 Instance launch environment

```bash
export DSH_HOME=/tmp/dsh-tb0-home
export DSH_GLASSES_TB0_SESSION_ID=<configured session id>   # prov from #2.6
export DSH_GLASSES_TB0_TOKEN=<dev-a0-…40-char dev bearer>   # minted; never committed
export TB0VLLM_API_KEY=dev-keyless-a0
node <npm-global>/bin/dsh --profile web --port 3192
```

(stored at runtime in `/tmp/a0-launch.sh`; not in Git.)

### 2.6 Fresh session + seed-session requirement

Sessions are created over the running instance's harness API; `session.create`
**accepts an explicit `sessionId`**:

```bash
curl -X POST http://127.0.0.1:3192/api/session.create -H 'Content-Type: application/json' \
 -d '{"type":"client-request","rpcId":"x","method":"session.create",
      "payload":{"workspaceId":"605d159f-622d-4411-9df3-63d5277ba7fa",
                 "agentPreset":"a0-toolfree","sessionId":"<desired id>"}}'
```

- The **host-write recovery suite** requires the literal session
  `session-tb0-disposable` to exist before the plugin boots (it reads
  `sessionQuery.readSession(sid)` on bootstrap; `readSession` throws
  `SESSION_QUERY_SESSION_NOT_FOUND` otherwise). Seed it up front with the same
  call. (Prerequisite not captured in Git; candidate seam: the suite could create
  its own session first, or the harness/plugin could tolerate a missing session.)
- C0 runs use a fresh disposable session id (created via the same call; record
  only `<disposable-session-id>` in evidence).

### 2.7 Narrow proxy / endpoint topology

The disposable web server binds loopback (`127.0.0.1:3192`); the Rokid cannot
reach it directly, so a narrow proxy is needed:

```bash
GLASSES_UPSTREAM=http://127.0.0.1:3192 GLASSES_PROXY_HOST=0.0.0.0 GLASSES_PROXY_PORT=3200 \
  node dev/glasses-dev-proxy.mjs        # from the repo (committed; narrow /glasses/v1/* passthrough)
```

Lost-downstream-response leg additionally uses the committed R0 delay fixture:

```bash
R0_MARKER=/tmp/c0-r0-marker.log node dev/r0-delay-proxy.mjs 3210 20000 http://127.0.0.1:3192
```

### 2.8 Host-write recovery-suite prerequisites

```bash
DSH_HOME=/tmp/dsh-tb0-home PORT=3195 node plugins/dsh-glasses-plugin/test/host-write-recovery.test.mjs
```

- `DSH_HOME` must be the disposable home (the suite reads `process.env.DSH_HOME`;
  a worker shell may carry the resident `DSH_HOME=/home/code2hack/.dsh`, which
  boots the resident profile without the plugin and must be overridden).
- `PORT` override avoids the long-running disposable instance.
- `session-tb0-disposable` must be pre-seeded (see 2.6).

### 2.9 Rokid provisioning (Android)

- Build the debug APK on u4090 (`apps/glasses-android`, Gradle 8.7 + AGP 8.5.2,
  `ANDROID_HOME=/opt/android-sdk`), `adb install -r -t`.
- App WebView provisioning via the dev form / `GlassesBridge.configure(base,
  token, sessionId)` — base `http://100.92.81.33:3200`, dev bearer, C0 session.
- On this firmware `cmd clipboard` is registered but unimplemented, and
  `service call clipboard` cannot build a ClipData parcel. Clipboard seeding used
  a **throwaway debug fixture APK** (activity that sets the clipboard from an
  intent extra; installed with `adb install -r -t`, used, then uninstalled).
  Seam: a committed seed fixture or a debug JS bridge setter would remove this.
- CDP driving route:
  `adb -s <serial> forward tcp:9333 localabstract:webview_devtools_remote_<pid>`
  then from spark `ssh -L 9333:127.0.0.1:9333 <u4090>` and raw CDP evaluate on
  the `dsh-glasses C0` page. Controls invoked exactly as the native bridge does:
  `window.GlassesBridge.debugSemanticControl(name)` (logcat
  `DSHGlassesBridge: debug-semantic-control … source=SYNTHETIC_DEBUG_CONTROL`).

## 3. Files NOT captured in Git (recreation prerequisites)

| Item | Location | Why missing |
| --- | --- | --- |
| `settings.yaml` (provider + agent-default-model + webserver) | `<DSH_HOME>/settings.yaml` | harness/local config, not a repo file |
| profile `web` package.json + plugin `file:` dep + `node_modules` copy | `<DSH_HOME>/profiles/web/` | npm-installed; plugin is repo-owned |
| refreshed plugin `lib/` copy (projection.js) | profile `node_modules/dsh-glasses-plugin/lib/` | npm snapshots at install; manual refresh |
| `a0-toolfree` preset | `<DSH_HOME>/.agent-presets/a0-toolfree/` | harness user preset |
| dummy key env value | instance env | `TB0VLLM_API_KEY=dev-keyless-a0` |
| dev bearer token | instance env | `<DSH_HOME>` sessions/token minted at runtime |
| explicit session ids | harness store | `session-tb0-disposable` seed + fresh session |
| launch/proxy/clipboard scripts | `/tmp/*` | runtime scripts (proxy itself is committed under `dev/`) |

The only repo-owned runtime scripts are `dev/glasses-dev-proxy.mjs`,
`dev/r0-delay-proxy.mjs`, `dev/i0-capture.sh`, and `dev/r0-delay-proxy-smoke.mjs`.

## 4. Smallest seams for a future reproducible-development-runtime slice

1. **Profile templating + plugin mount**: commit a `web` profile template
   (package.json with the `file:` dep) and replace npm-install-copy with a
   junction/link mount so source additions (`projection.js`) are always live.
2. **Settings overlay**: commit `settings.yaml` with placeholder host/port/model
   and layer a local override for the disposable home.
3. **Preset template**: commit `a0-toolfree` preset files under a templated user
   preset path (copy-on-init).
4. **One-command bootstrap**: a single (future, not implemented here) command
   that: creates an empty `DSH_HOME`, installs the profile, refreshes the plugin,
   writes settings + preset, seeds `session-tb0-disposable`, mints the token,
   launches the disposable + narrow proxy, and reports the session/token for
   Rokid provisioning.
5. **Suite self-seeding**: make `host-write-recovery.test.mjs` create its seed
   session (or tolerate a missing one) so the suite is self-contained.
6. **Clipboard seed fixture**: commit the tiny clip-seeder (activity) as a debug
   module/fixture instead of an ephemeral `/tmp` project.
7. **Rokid provisioning helper**: a committed script for `configure(base, token,
   session)` + CDP control aliases, so evidence runs are reproducible by command
   rather than ad-hoc evaluate snippets.

## 5. Audit result

Every step above is reproducible by hand from an empty temp `DSH_HOME` given the
listed repo files, the two user-deployed services (spark2 vLLM, Android SDK on
u4090), and network/loopback freedom on spark. The gaps are all environmental
prerequisites (settings.yaml, profile install, preset, env vars, token, seed
session) that no Git-tracked artifact fully reproduces today; the seams in §4 are
the smallest automation surface to close them.

Passive recorder: kept armed; u4090 worktree synchronized to merged `main`
`2f2683926941547a56d5e55dfd399601bea4dc78` so the next rotation manifest records
that `repo_head`. Physical function/touch and head-wheel semantics remain
explicitly unqualified.
