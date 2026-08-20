import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStateStore } from "../lib/state.js";

test("state is atomic, private, schema-versioned, and locked", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatcher-state-"));
  try {
    const path = join(root, "nested/state.json");
    const store = createStateStore(path);
    assert.deepEqual(await store.load(), { schemaVersion: 1, tickets: {} });
    await store.save({ schemaVersion: 1, tickets: { 1: { status: "claimed" } } });
    assert.equal(JSON.parse(await readFile(path, "utf8")).tickets[1].status, "claimed");
    await store.lock(async () => {
      await assert.rejects(store.lock(async () => {}), /already running/);
    });
    await writeFile(`${path}.lock`, "999999999\n");
    await store.lock(async () => {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
