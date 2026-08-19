# TB0-A0 — Durable assistant-output qualification (real LFM, disposable DSH)

Date: 2026-08-19. Branch: `tb0/assistant-output` (base merge `87a0968`).

## Summary

One prompt RPC through the ordinary DSH `session.prompt` path produced:

- exactly one durable `user/message` (`source.kind=user`, `source.rpcId=a0-assistant-<fresh-suffix>`);
- exactly one durable, nonempty `assistant/message` — joined text `TB0 assistant passed`;
- the assistant event observed once live through the authenticated `/glasses/v1/stream` SSE (seq 21), and reconstructed in `/glasses/v1/bootstrap` after a plugin-instance restart.

This qualifies the DSH assistant-output transport end-to-end on a fresh disposable session.

## Environment

| Item | Value |
| --- | --- |
| Host | spark (DGX GB10), disposable DSH instance only — resident `:3080`/`:pm2` untouched |
| DSH | `@deepseek-ai/dsh@0.1.0-rc.7` (`/home/code2hack/.npm-global/.../dsh/package.json`), profile `web` |
| Disposable instance | `DSH_HOME=/tmp/dsh-tb0-home`, web port `3192`, plugin generation `mt0745v5-03359f54` / `mt0768pt-3769bf00` (post-restart) |
| Provider | `tb0vllm` (api `openai-completions`, baseURL `http://192.168.100.11:8887/v1`) — keyless local route, **no secrets** |
| Model | `lfm2.5-vl-3b` (the model ID returned by `/v1/models`; used here as a text completion model) |
| Agent preset | `a0-toolfree` (custom tool-less preset; see "Provider-side findings") |
| Fresh session | `<disposable-session-id>` (created empty; boot events seq 0-3 only before the prompt) |
| Prompt RPC id | `a0-assistant-58958804` (fresh suffix) |
| Prompt | `Reply with exactly: TB0 assistant passed` |

## Flow

1. Created an empty disposable session via the harness `session.create` (agentPreset `a0-toolfree`).
2. Bound the glasses plugin to it: `DSH_GLASSES_TB0_SESSION_ID=<disposable-session-id>`, dev bearer token (40-char, never committed).
3. Verified `GET /v1/models` → `{id:"lfm2.5-vl-3b"}` and a direct `/v1/chat/completions` text request returned `TB0 assistant passed`.
4. Opened authenticated `POST /glasses/v1/stream` **before** the prompt.
5. Mutation (`a0-mut-<suffix>`, draft rev 0→1) set the durable draft to the prompt text.
6. `POST /glasses/v1/actions` `{kind:"send", operationId:"a0-assistant-<suffix>", draftRevision:1}` → the plugin called `ctx.apiProxy.sessions.prompt({rpcId: operationId, ...})`; the session returned idle; the plugin settled the operation **accepted** and cleared the draft (rev →2).

## Durable log (sanitized, session `<disposable-session-id>`)

Complete turn sequence (monotonic seq):

```
0  permission/preset
1  sandbox/mode
2  approval/policy
3  session/end-seed
4  agent/inbox/spliced
5  turn/start
6  agent/inbox/spliced
7  step/start
8  user/message          content=[{type:text, text:"Reply with exactly: TB0 assistant passed"}]
                         source={kind:user, rpcId:"a0-assistant-58958804"}
9  session/title
10 request/header        header.config={provider:"tb0vllm", model:"lfm2.5-vl-3b", maxTokens:4096}
11 request/context       {provider:"tb0vllm", model:"lfm2.5-vl-3b", contextWindow:32768}
12 session/title-llm-request
13 assistant/chunk       chunk={type:"block-start", index:0, blockType:"text"}
14-17 assistant/chunk    (text deltas; assembled below)
18 assistant/chunk       chunk={type:"block-end", index:0, block:{type:"text", text:"TB0 assistant passed"}}
19 assistant/chunk       chunk={type:"usage", usage:{inputTokens:30, outputTokens:5}}
20 assistant/chunk       chunk={type:"finish", reason:{kind:"stop"},
                         replayState.response={kind:"pi-ai", version:2, api:"openai-completions",
                         provider:"tb0vllm", model:"lfm2.5-vl-3b", responseId:"chatcmpl-9ae98a50ac59ef90", stopReason:"stop"}}
21 assistant/message     data.turn=1 data.step=1
                         data.message={role:"assistant",
                           content:[{type:"text", text:"TB0 assistant passed"}],
                           source:{kind:"model", provider:"tb0vllm", model:"lfm2.5-vl-3b",
                             replayState:{response:{...}, blocks:[{type:"text"}]}},
                           id:"35b8424e-aeed-46b0-81f4-f055ab55cdc3"}
                         data.usage={inputTokens:30, outputTokens:5}
                         sourceEventSeqs=[13,14,15,16,17,18,19,20]
                         surfaceOp:"append"
22 step/end              {turn:1, step:1}
23 turn/end
24 session/title
```

Exact rc.7 assistant-event layout (field locations):

- event sequence: `seq` (top level, e.g. 21)
- event type: `type` = `"assistant/message"`
- assembled message: `data.message` (`role`, `content` blocks, `source`, `usage`)
- message ID: `data.message.id`
- text content: `data.message.content[].text` (block `type:"text"`)
- turn/step: `data.turn`, `data.step`
- provider/model source: `data.message.source.{kind,provider,model}` + `data.message.source.replayState.response.{kind,version,api,provider,model,responseId,stopReason}`
- surface operation: `surfaceOp` = `"append"`
- provenance: `sourceEventSeqs` lists the `assistant/chunk` seqs the message was assembled from (13-20)

## Counts

- `user/message` with `source.rpcId == a0-assistant-58958804`: **1**
- `assistant/message`: **1**
- joined assistant text: **`TB0 assistant passed`**

## SSE (authenticated `/glasses/v1/stream`, opened before the prompt)

Monotonic event order observed live (21 events):

```
4 agent/inbox/spliced → 5 turn/start → 6 agent/inbox/spliced → 7 step/start →
8 user/message → 9 session/title → 10 request/header → 11 request/context →
12 session/title-llm-request → 13..20 assistant/chunk → 21 assistant/message →
22 step/end → 23 turn/end → 24 session/title
```

`assistant/message` count in SSE: **1** (projected as `{seq:21, type:"assistant/message", generation}`).

## Restart reconstruction

- Before restart: bootstrap `asOfSeq=24`, event list includes `assistant/message`, status idle, count 1.
- After instance restart (same `DSH_HOME`/profile/env; generation changed to `mt0768pt-3769bf00`): bootstrap again `asOfSeq=24` with **the same event list including `assistant/message` (count 1)**; status `unavailable` until the next prompt (per-process agent registry resumption).
- A fresh live stream subscribe emits only new events (history replay is the bootstrap contract), so persistence post-restart is established through bootstrap reconstruction rather than stream replay.

## Provider-side findings resolved during this slice (disposable-only changes)

1. **`UNSUPPORTED_REASONING_EFFORT`** — `settings.yaml` declared `agent-default-model.reasoningEffort: low`, which `lfm2.5-vl-3b` does not support. Removed the reasoning-effort override from the disposable `agent-default-model`.
2. **`llm-pi-ai: no credential for provider route "tb0vllm"`** — the DSH provider interface requires an API key even for a keyless local vLLM. Added `apiKeyEnv: TB0VLLM_API_KEY` to the `tb0vllm` provider and exported a dummy development value (`dev-keyless-a0`) at instance launch; the keyless vLLM ignores it (verified a dummy bearer returns 200). No real credential involved.
3. **`INVALID_REQUEST` `"auto" tool choice requires --enable-auto-tool-choice ...`** — the stock `standard` agent sends `tool_choice:"auto"`, which the user-deployed vLLM (started without auto-tool-choice, and NOT to be redeployed) rejects. Client-side resolution: authored a **tool-less agent preset** (`a0-toolfree`, cloned from `minimal` with all tool groups removed) under `$DSH_HOME/.agent-presets/a0-toolfree/`; with no tool schemas the OpenAI-completions adapter sends no `tools`, the vLLM call succeeds, and the assistant output is durable.

These are disposable-runtime changes (`/tmp/dsh-tb0-home/settings.yaml` + `.agent-presets/`); the repo contains only this evidence document.

## Remaining difference vs the desired glasses projection

- The plugin projection currently exposes `{seq, type}` only. The durable `assistant/message` carries full text blocks and model provenance, but **message content is not yet projected** to the glasses. Content projection + chat-history rendering is the next (ChatGPT-owned) code slice boundary (TB0-C0).
- The stock `standard` agent cannot drive this particular vLLM deployment (tool-choice capability); qualification used the companion tool-less preset. If the final TB0 acceptance needs the full coding agent on device, vLLM must be launched with auto-tool-choice or a supported tool-call parser (deployment-side decision).

## Pass boundary

| Criterion | Result |
| --- | --- |
| one prompt RPC → exactly one durable user/message | PASS (rpcId `a0-assistant-58958804`) |
| at least one durable nonempty assistant/message | PASS (`TB0 assistant passed`) |
| assistant event observed live by plugin (SSE) | PASS (seq 21, once) |
| assistant event reconstructed after plugin restart | PASS (bootstrap, count 1, same asOfSeq 24) |

No Rokid rebuild or physical control was performed; the passive physical recorder remains armed.
