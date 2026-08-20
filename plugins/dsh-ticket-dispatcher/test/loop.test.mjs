import assert from "node:assert/strict";
import test from "node:test";
import { runReconcileLoop } from "../lib/loop.js";

test("bounded reconcile loop emits N sequential non-overlapping passes", async () => {
  let active = 0;
  let maximum = 0;
  let passes = 0;
  const reports = [];
  const waits = [];
  const count = await runReconcileLoop({
    reconcile: async () => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return { pass: ++passes };
    },
    emit: (report) => reports.push(report),
    intervalMs: 25,
    maxPasses: 3,
    signal: new AbortController().signal,
    wait: async (ms) => waits.push(ms),
  });
  assert.equal(count, 3);
  assert.equal(maximum, 1);
  assert.deepEqual(reports, [{ pass: 1 }, { pass: 2 }, { pass: 3 }]);
  assert.deepEqual(waits, [25, 25]);
});
