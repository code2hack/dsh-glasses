import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const emptyState = () => ({ schemaVersion: 1, tickets: {} });

export function createStateStore(path) {
  return {
    async load() {
      try {
        const state = JSON.parse(await readFile(path, "utf8"));
        if (state.schemaVersion !== 1 || typeof state.tickets !== "object") throw new Error(`unsupported dispatcher state: ${path}`);
        return state;
      } catch (error) {
        if (error.code === "ENOENT") return emptyState();
        throw error;
      }
    },
    async save(state) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    },
    async lock(fn) {
      await mkdir(dirname(path), { recursive: true });
      const lockPath = `${path}.lock`;
      let handle;
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const pid = Number.parseInt(await readFile(lockPath, "utf8").catch(() => ""), 10);
        let live = Number.isInteger(pid);
        if (live) try { process.kill(pid, 0); } catch (probe) { live = probe.code === "EPERM"; }
        if (live) throw new Error(`dispatcher reconcile already running: ${lockPath}`);
        await rm(lockPath, { force: true });
        handle = await open(lockPath, "wx", 0o600);
      }
      try {
        await handle.writeFile(`${process.pid}\n`);
        return await fn();
      } finally {
        await handle.close();
        await rm(lockPath, { force: true });
      }
    },
  };
}
