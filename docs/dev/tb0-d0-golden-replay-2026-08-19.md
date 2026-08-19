### `profiles/web/package.json`
```
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "@deepseek-ai/schemastery": "^3.18.1",
    "dsh-glasses-plugin": "file:/home/code2hack/Projects/glasses/dsh-glasses/plugins/dsh-glasses-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ]
    }
  }
}
```

### `profiles/web/cordis.yml`
```
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```

### `profiles/web/cordis.patch.yml`
```
- insert:
    - id: dsh-glasses-plugin
      name: dsh-glasses-plugin
```

### `profiles/web/pnpm-workspace.yaml`
```
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
```

### `settings.yaml`
```
llm-pi-ai:
  providers:
    tb0vllm:
      displayName: TB0 vLLM (LFM2.5-VL-3B)
      apiKeyEnv: TB0VLLM_API_KEY
      api: openai-completions
      baseURL: http://192.168.100.11:8887/v1
      models:
        - id: lfm2.5-vl-3b
          name: LFM2.5-VL-3B
          contextWindow: 32768
          maxTokens: 4096
agent-default-model:
  provider: tb0vllm
  model: lfm2.5-vl-3b
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
permission:
  defaultPreset: danger-full-access
agent-presets:
  default: standard
webserver:
  host: 127.0.0.1
  port: 3194
```

### `.agent-presets/a0-toolfree/preset.yml`
```
name: A0 Tool-Free
description: Tool-less agent for TB0-A0 assistant-output qualification.
order: 9
```

### `.agent-presets/a0-toolfree/agent.cordis.yml`
```
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a helpful software engineer assistant.
    complete: true
    includeRuntimeContext: false
```


- Install command: `pnpm install` (pnpm v11.22.0, `nodeLinker: hoisted`) in `profiles/web`.
- Installed plugin: **physical COPY** at `node_modules/dsh-glasses-plugin` (not a symlink/junction).
- Resolved path: `/tmp/dsh-glasses-d0-golden/profiles/web/node_modules/dsh-glasses-plugin`.
- `npm ls dsh-glasses-plugin` -> `ELSPROBLEMS invalid: dsh-glasses-plugin@0.0.1-tb0` (npm cannot read the pnpm-workspace profile; expected).
- Authoritative view: `pnpm ls dsh-glasses-plugin` (from `profiles/web`) -> `dsh-glasses-plugin@0.0.1-tb0` file:../.../plugins/dsh-glasses-plugin.



## Sanitized runtime file shapes
### `profiles/web/package.json`
```
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "@deepseek-ai/schemastery": "^3.18.1",
    "dsh-glasses-plugin": "file:/home/code2hack/Projects/glasses/dsh-glasses/plugins/dsh-glasses-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ]
    }
  }
}
```

### `profiles/web/cordis.yml`
```
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```

### `profiles/web/cordis.patch.yml`
```
- insert:
    - id: dsh-glasses-plugin
      name: dsh-glasses-plugin
```

### `profiles/web/pnpm-workspace.yaml`
```
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
```

### `settings.yaml`
```
llm-pi-ai:
  providers:
    tb0vllm:
      displayName: TB0 vLLM (LFM2.5-VL-3B)
      apiKeyEnv: TB0VLLM_API_KEY
      api: openai-completions
      baseURL: http://192.168.100.11:8887/v1
      models:
        - id: lfm2.5-vl-3b
          name: LFM2.5-VL-3B
          contextWindow: 32768
          maxTokens: 4096
agent-default-model:
  provider: tb0vllm
  model: lfm2.5-vl-3b
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
permission:
  defaultPreset: danger-full-access
agent-presets:
  default: standard
webserver:
  host: 127.0.0.1
  port: 3194
```

### `.agent-presets/a0-toolfree/preset.yml`
```
name: A0 Tool-Free
description: Tool-less agent for TB0-A0 assistant-output qualification.
order: 9
```

### `.agent-presets/a0-toolfree/agent.cordis.yml`
```
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a helpful software engineer assistant.
    complete: true
    includeRuntimeContext: false
```

## Plugin install facts
- Install command: `pnpm install` (pnpm v11.22.0, `nodeLinker: hoisted`) in `profiles/web`.
- Installed plugin: **physical COPY** at `node_modules/dsh-glasses-plugin` (not a symlink/junction).
- Resolved path: `/tmp/dsh-glasses-d0-golden/profiles/web/node_modules/dsh-glasses-plugin`.
- `npm ls dsh-glasses-plugin` -> `ELSPROBLEMS invalid: dsh-glasses-plugin@0.0.1-tb0` (npm cannot read a pnpm-workspace profile; expected false-negative).
- Authoritative view from `profiles/web`: `pnpm ls dsh-glasses-plugin` -> `dsh-glasses-plugin@0.0.1-tb0` `file:../.../plugins/dsh-glasses-plugin`.
## Deviations found vs docs/dev/tb0-c0-reproducibility-audit-2026-08-19.md
1. **Package manager**: the audit §2.1 says `npm install`; the working profile and the golden both use **pnpm** (pnpm-workspace.yaml, nodeLinker hoisted). `npm ls` is a false-negative (ELSPROBLEMS).
2. **Workspace precondition omitted**: an empty DSH_HOME has NO workspaces; `session.create` requires an existing `workspaceId`. The audit §2.6 hardcoded `605d159f-…` (state of the PRIOR home, not reproducible). Golden: `workspace.create` with an **absolute** existing `path` -> workspaceId `c0c47d6c-…`.
3. **webserver binding**: audit  said host 0.0.0.0:3190; golden (per D0 directive) used **127.0.0.1:3194** (loopback-only; port differs only to avoid colliding with the live disposable :3192).
4. **Durable session storage path**: sessions are stored under `$DSH_HOME/sessions/<workspace-encoded-path>/<sid>/session.jsonl.zstd`, NOT in the workspace dir (the workspace dir stays empty).
5. **Replay incident**: the first golden instance died silently shortly after the long SSE stream (no trace in log; candidate: stream-close path). Durable state survived; relaunch + bootstrap reconciled the op to **accepted** (draft rev 2 empty/unlocked) -> restart-recovery reproduced. Root cause not isolated (flagged for D0).
6. **Provider block**: golden settings contain ONLY `tb0vllm`; the prior home's `ds4` provider block is not needed for C0 (kept out; no resident credential in the golden).

## End state
- Golden instance left running on 127.0.0.1:3194 (loopback; disposable home above) for D0 inspection.
- Product route restored: :3200 -> 127.0.0.1:3192 (live disposable).
- No resident DSH touched; no Rokid rebuild performed.
