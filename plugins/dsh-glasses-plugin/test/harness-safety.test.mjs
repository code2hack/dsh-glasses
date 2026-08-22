// Focused self-test for the disposable-runtime harness's shared-host process
// safety (requested by the T27-02 review): PID-reuse fencing + never touching
// stranger processes. Node builtins only; no DSH boot required.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import {
  registerOwnedChild,
  unregisterOwnedChild,
  isOwnedChild,
  ownsProcessWithIdentity,
  stopOwnedProcess,
  assertPortSpawnable,
  processStartTicks,
} from "./disposable-runtime.mjs";

function spawnSleeper() {
  // A node process that stays alive until signaled.
  return spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" });
}

function alive(proc) {
  try { process.kill(proc.pid, 0); return true; } catch { return false; }
}

// 1) Owned child -> cleanup terminates it, and only it.
{
  const child = spawnSleeper();
  registerOwnedChild(child.pid, { port: 0 });
  assert.equal(isOwnedChild(child.pid), true);
  assert.equal(ownsProcessWithIdentity(child.pid), true);
  await stopOwnedProcess(child.pid, 0);
  for (let i = 0; i < 50 && alive(child); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(child), false, "owned child must be terminated by stopOwnedProcess");
  await new Promise((r) => setTimeout(r, 0));
  console.log("[harness-safety] owned child terminated: PASS");
}

// 2) Reused/non-owned PID fence: register a live process under a STALE identity
//    (simulates PID reuse after our child exited) -> fence refuses to signal it.
{
  const victim = spawnSleeper();
  const realStart = processStartTicks(victim.pid);
  assert.ok(realStart !== null && realStart > 0, "proc start ticks readable");
  registerOwnedChild(victim.pid, { port: 0, start: realStart + 999999 }); // stale/foreign identity
  assert.equal(ownsProcessWithIdentity(victim.pid), false, "identity mismatch must fence the signal");
  await stopOwnedProcess(victim.pid, 0); // must NOT signal (would be a reused/foreign pid)
  assert.equal(alive(victim), true, "victim survived the stale-identity fence");
  unregisterOwnedChild(victim.pid);
  victim.kill("SIGKILL");
  console.log("[harness-safety] reused-PID fence refuses stale-identity signal: PASS");
}

// 3) Unregistered pid -> stopOwnedProcess never signals it.
{
  const stranger = spawnSleeper();
  await stopOwnedProcess(stranger.pid, 0); // not registered -> no-op
  assert.equal(alive(stranger), true, "unregistered stranger must be untouched");
  stranger.kill("SIGKILL");
  console.log("[harness-safety] stopOwnedProcess refuses unregistered pid: PASS");
}

// 3b) Registered child with NO recorded start-time identity -> fail closed:
//     the fence never signals it (a reused PID would otherwise be killed).
{
  const victim = spawnSleeper();
  registerOwnedChild(victim.pid, { port: 0, start: null }); // explicit no-identity
  assert.equal(ownsProcessWithIdentity(victim.pid), false, "null identity must fail closed");
  await stopOwnedProcess(victim.pid, 0); // must NOT signal
  assert.equal(alive(victim), true, "null-identity child survived (fail closed)");
  unregisterOwnedChild(victim.pid);
  victim.kill("SIGKILL");
  console.log("[harness-safety] null/no-identity registered child fails closed: PASS");
}

// 4) Stranger PROCESS occupying the port -> assertPortSpawnable fails
//    test-port-in-use and the stranger survives (the old killPortOwner defect
//    would have killed it). Note: a same-process socket is legitimately
//    attributed to the test process and ignored by assertPortSpawnable.
{
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  // A separate process owns the port after the probe is gone.
  const stranger = spawn(process.execPath, ["-e", `net=require('net');net.createServer().listen(${port},'127.0.0.1',()=>{});setInterval(()=>{},1000)`], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    const any = await new Promise((r) => {
      const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); r(true); });
      s.on("error", () => r(false));
    });
    if (any) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  let threw = false;
  try { await assertPortSpawnable(port, { timeoutMs: 2000 }); } catch (e) {
    threw = true;
    assert.match(String(e.message), /test-port-in-use/);
  }
  assert.equal(threw, true, "stranger-process-held port must fail deterministically");
  await stopOwnedProcess(stranger.pid, port); // stranger is NOT a registered child
  assert.equal(stranger.exitCode, null, "stranger port owner must survive");
  stranger.kill("SIGKILL");
  console.log("[harness-safety] stranger port owner fails loudly and survives: PASS");
}

console.log("harness-safety.test.mjs: PASS");
