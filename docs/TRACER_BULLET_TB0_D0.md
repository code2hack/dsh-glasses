# TRACER_BULLET_TB0_D0 — reproducible disposable development runtime

**Status:** implementation ready for runtime qualification.  
**Base:** `0db1c426e2ec2b8e397d96f5f637c8c5c756cf7e`.  
**Branch:** `tb0/repro-dev-runtime`.  
**Golden manual replay:** `docs/dev/tb0-d0-golden-replay-2026-08-19.md`.

## 1. Goal

Replace the manual C0 disposable-host setup with one reproducible, ownership-safe
runtime command while leaving resident DSH/model services untouched:

```text
empty DSH_HOME
→ generated web profile + settings + a0-toolfree preset
→ current repo plugin mirrored and content-verified
→ workspace created from an absolute existing path
→ session-tb0-disposable self-seeded
→ fresh a0-toolfree session created
→ loopback-only DSH rc.7 launched
→ narrow glasses proxy launched
→ machine-readable provisioning state emitted
```

D0 is development infrastructure only. It does not add product controls or change
C0 semantics.

## 2. Canonical commands

From the repository root:

```bash
HOME_D0=/tmp/dsh-glasses-d0-e2e

node dev/d0-runtime.mjs up \
  --home "$HOME_D0" \
  --dsh-port 3196 \
  --proxy-port 3202

node dev/d0-runtime.mjs status --home "$HOME_D0"
node dev/d0-runtime.mjs down   --home "$HOME_D0"
```

`up` stdout is one JSON provisioning document. Progress goes to stderr. The JSON
contains the endpoint, fresh session id, ephemeral dev bearer, owned PIDs/logs,
workspace id, source commit, and plugin content digest.

`status` never prints the bearer; it reads the mode-0600 state file and proves:

- the recorded DSH/proxy PIDs still have the same Linux process start-ticks;
- authenticated direct bootstrap is 200;
- authenticated proxy bootstrap is 200 for the same fresh session;
- `/api/*` through the narrow proxy is 403;
- current repository head still equals the runtime's recorded head;
- current plugin `lib/` digest still equals the runtime's recorded digest.

`down` SIGTERMs only matching recorded process identities, escalates only those
same identities if needed, and preserves the entire disposable home and logs.
It never deletes an existing DSH home or kills an arbitrary port owner.

## 3. Empty-home and version rules

- `up` accepts only an absent/empty absolute `DSH_HOME`; a non-empty path is a
  hard error. There is no wipe/reset/reuse flag.
- DSH is pinned to `@deepseek-ai/dsh@0.1.0-rc.7`; the controller resolves the
  package from the actual `dsh` binary and rejects another version.
- pnpm is pinned to `11.22.0`.
- provider model must be present in `GET <vllm-base>/models` before DSH starts.
- DSH binds `127.0.0.1`; only the committed narrow proxy binds the LAN/tailnet
  surface.

## 4. Generated runtime files

Templates under `dev/d0-runtime/` materialize:

```text
<home>/profiles/web/package.json
<home>/profiles/web/cordis.yml
<home>/profiles/web/cordis.patch.yml
<home>/profiles/web/pnpm-workspace.yaml
<home>/settings.yaml
<home>/.agent-presets/a0-toolfree/preset.yml
<home>/.agent-presets/a0-toolfree/agent.cordis.yml
```

The settings contain only `tb0vllm`; no resident `ds4` provider/credential is
copied into the disposable home.

### Plugin freshness strategy

Golden replay proved pnpm `file:` installs the plugin as a physical snapshot.
D0 deliberately keeps that package topology (so Node/peer resolution stays the
same as the proven environment), then on every `up`:

1. replaces the installed package's entire `lib/` with the current repo `lib/`;
2. replaces installed `package.json` with current repo `package.json`;
3. hashes source/installed trees and requires exact equality;
4. requires `projection.js` to be present.

This is a deterministic refresh-on-up mirror, not a hot symlink. It removes the
stale-new-file failure without changing runtime module-resolution semantics.

## 5. Session/bootstrap contract

`up` mints before DSH launch:

- one ephemeral dev bearer;
- one fresh `session-<uuid>` used by the glasses plugin;
- fixed fixture id `session-tb0-disposable` for the host-write recovery suite.

After the DSH API becomes reachable it:

1. `workspace.create({path:<absolute realpath>})`;
2. creates `session-tb0-disposable` with preset `minimal`;
3. creates the fresh glasses session with `a0-toolfree`;
4. waits for both durable `session.jsonl.zstd` files;
5. waits for authenticated `/glasses/v1/bootstrap` on the fresh session.

No hard-coded workspace id is used.

## 6. Clean-home host-write suite

Canonical D0 invocation:

```bash
node dev/d0-host-write-recovery.mjs
```

It creates a fresh temporary home, runs `d0-runtime up` (thereby creating the
workspace and seed session), ownership-safely downs the bootstrap runtime, then
runs the existing 16-scenario host-write recovery suite against that home.

The legacy suite contains one historical literal `/tmp/dsh-tb0-home` state-file
read. The D0 wrapper produces a temporary sibling copy replacing only that one
path with `${DSH_HOME}` and deletes the generated file afterwards; the checked-in
scenario body is otherwise unchanged. The temporary home is preserved for
inspection.

D0 passes only if this clean-home wrapper reaches the suite's `ALL PASS` without
manual session seeding.

## 7. Runtime acceptance matrix

Use a fresh home, not the golden home and not `/tmp/dsh-tb0-home`.

### A. `up`

Prove:

- stdout parses as JSON with `ok=true`;
- DSH is listening only on `127.0.0.1:<dsh-port>`;
- proxy is listening on the chosen proxy port;
- state file mode is 0600;
- profile/preset/settings match committed templates after substitution;
- installed plugin `lib/` digest equals repo plugin `lib/` digest;
- `projection.js` exists in installed copy;
- workspace path in state is absolute/realpath-resolved;
- seed session and fresh session both have durable logs;
- direct and proxied bootstrap are 200 for the fresh session;
- `/api/*` through proxy is 403.

### B. assistant-output smoke

On the fresh session created by `up`, drive one ordinary plugin draft+Send with:

```text
Reply with exactly: D0 automated runtime passed
```

Require:

- exactly one durable `user/message` for the Send rpcId;
- nonempty durable/projected `assistant/message`;
- provider/model = `tb0vllm` / `lfm2.5-vl-3b`;
- draft accepted clear remains monotonic and unlocked.

This proves the generated settings/preset/provider route, not new product logic.

### C. `status`

While running, require:

```text
ok=true
DSH process alive and identity-matched
proxy process alive and identity-matched
direct bootstrap 200
proxy bootstrap 200
proxy /api 403
repoMatches=true
pluginMatches=true
```

Then make a harmless checkout-only source edit or switch commit only in a scratch
copy if needed to prove the status source-drift field; do not mutate the active
runtime's checkout during normal acceptance.

### D. long-SSE survival regression

The first golden replay saw one unexplained DSH death after a long SSE stream.
Open authenticated `/glasses/v1/stream`, keep it open through at least two
heartbeats, close it cleanly, then wait 10 seconds and run `status` again.

Required: DSH remains alive and `status.ok=true`. If it dies, stop D0 acceptance
and return a hard-bug report with DSH log tail, process exit evidence, stream
open/close timestamps, and exact branch/head. Do not add a supervisor that masks
the death.

### E. `down`

Require:

- only recorded matching DSH/proxy PIDs are terminated;
- ports close;
- home, state, session logs, and process logs remain;
- a second `down` is harmless and reports already-dead identities rather than
  killing another process.

### F. clean-home host-write recovery

```bash
node dev/d0-host-write-recovery.mjs
```

Require existing 16-scenario suite `ALL PASS` from the wrapper-created home, with
no manual workspace/session preparation.

## 8. Explicit non-goals

D0 does not implement:

- clipboard seeder;
- Rokid provisioning/CDP helper (deferred D1);
- physical control qualification;
- Steer/Interrupt;
- tabs;
- Photo/Voice/Morse/images;
- production credentials/pairing;
- automatic DSH crash supervision;
- resident DSH/model changes.

The passive input recorder remains independent and armed.

## 9. Evidence

Fill:

```text
docs/evidence/tb0-d0-repro-dev-runtime-2026-08-20.md
```

Record exact implementation head, generated-home path, versions, process ids,
ports, repo/plugin digests, workspace/session creation results, direct/proxy
checks, assistant-output smoke, long-SSE survival, down ownership proof, and the
clean-home host-write suite result. Never commit the minted bearer or real fresh
session id; replace them with placeholders.

## 10. Merge gate

D0 is merge-ready when one command from an empty home reliably yields a working
C0-compatible disposable runtime, `status` proves it, `down` only stops what it
owns, long-SSE close does not kill DSH, and the host-write suite self-seeds from
a clean home.
