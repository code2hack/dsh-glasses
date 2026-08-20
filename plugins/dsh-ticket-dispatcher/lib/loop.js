import { setTimeout as sleep } from "node:timers/promises";

export async function runReconcileLoop({ reconcile, emit, intervalMs, maxPasses, signal, wait = sleep }) {
  let passes = 0;
  while (!signal?.aborted && (maxPasses === 0 || passes < maxPasses)) {
    emit(await reconcile());
    passes++;
    if (signal?.aborted || maxPasses > 0 && passes >= maxPasses) break;
    try {
      await wait(intervalMs, undefined, { signal });
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    }
  }
  return passes;
}
