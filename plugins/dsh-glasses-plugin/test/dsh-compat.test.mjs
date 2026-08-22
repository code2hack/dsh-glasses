// Executable DSH compatibility contract for dsh-glasses M1 (Ticket #27).
//
// Fails closed if the runtime referenced by DSH_BIN is not exactly the
// committed supported @deepseek-ai/dsh revision, if its npm dist integrity
// drifts from the pin, or if any required M1 read-side seam is missing or has
// an incompatible shape. The committed pin is plugins/dsh-glasses-plugin/
// dsh-compat.json; the installed runtime referenced by DSH_BIN is the object
// of qualification (never "whatever dsh happens to be on PATH").
//
// This is the static/ABI gate. Live runtime proof of the same seams runs in
// test/dsh-adapter-runtime.test.mjs and test/m1-narrow-edge.test.mjs against a
// disposable rc.2 instance. storage/apiProxy are deliberately NOT in the M1
// ABI (they belong to the dormant TB0/M3 write path).
//
// Usage:
//   DSH_BIN=/home/code2hack/.npm-global/bin/dsh \
//     node plugins/dsh-glasses-plugin/test/dsh-compat.test.mjs

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

const PIN = JSON.parse(
  readFileSync(new URL("../dsh-compat.json", import.meta.url), "utf8"),
);
if (PIN.schemaVersion !== 1 || PIN.package !== "@deepseek-ai/dsh") {
  console.error("dsh-compat: unexpected pin shape in dsh-compat.json");
  process.exit(2);
}

const results = [];
const ok = (name, detail) => { results.push([name, "PASS", detail || ""]); console.log(`✓ ${name}${detail ? " — " + detail : ""}`); };
const fail = (name, detail) => { results.push([name, "FAIL", detail || ""]); console.log(`✗ ${name}: ${detail || ""}`); };

function which(command) {
  try {
    const out = execFileSync("which", [command], { encoding: "utf8" }).trim();
    return out || null;
  } catch {
    return null;
  }
}

async function findInstalledPackage(binPath, expectedName) {
  let current = dirname(binPath);
  for (let i = 0; i < 16; i += 1) {
    const pkgPath = join(current, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.name === expectedName) return { root: current, pkg };
      } catch { /* keep walking */ }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

async function installedIntegrity(pkgRoot) {
  // 1) The package's own package.json may carry _integrity when npm stored it.
  try {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
    if (typeof pkg._integrity === "string" && pkg._integrity) return pkg._integrity;
  } catch {}
  // 2) node_modules/.package-lock.json beside or above the package root.
  for (const candidate of [join(pkgRoot, "node_modules/.package-lock.json"), join(pkgRoot, "..", ".package-lock.json")]) {
    if (!existsSync(candidate)) continue;
    try {
      const lock = JSON.parse(readFileSync(candidate, "utf8"));
      const packages = lock?.packages ?? {};
      for (const entry of Object.values(packages)) {
        if (entry?.name === PIN.package && entry?.integrity) return entry.integrity;
      }
    } catch {}
  }
  return null;
}

function registryIntegrity() {
  // Allowed by the M1 contract: the dist-integrity leg may consult the npm
  // registry during qualification; the pin itself is committed.
  try {
    const out = execFileSync("npm", ["view", `${PIN.package}@${PIN.version}`, "dist.integrity"], { encoding: "utf8" });
    return out.trim();
  } catch (error) {
    return `(registry-unavailable: ${String(error?.stderr || error?.message || error).trim().slice(0, 120)})`;
  }
}

function normalizeWhitespace(value) {
  return String(value).replace(/\s+/g, "");
}

function seamSearchDir(pkgRoot, marker, relDirs) {
  // Search a seam's shared type declaration area for a shape marker.
  for (const dir of relDirs) {
    const target = join(pkgRoot, dir);
    if (!existsSync(target)) continue;
    // Walk *.d.ts under target recursively (bounded).
    const stack = [target];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
          try {
            const content = readFileSync(full, "utf8");
            if (normalizeWhitespace(content).includes(normalizeWhitespace(marker))) return { file: full };
          } catch {}
        }
      }
    }
  }
  return null;
}

const SEAMS = [
  { seam: "webServer.register", pkg: "dsh-host-webserver", marker: "register(route:WebRoute):()=>void" },
  { seam: "sessionQuery.listSessions", pkg: "dsh-session-query", marker: "listSessions(signal?:AbortSignal):Promise<SessionRecord[]>" },
  { seam: "sessionQuery.readSession", pkg: "dsh-session-query", marker: "readSession(sessionId:SessionId):Promise<SessionLogSnapshot>" },
  // Signature-shaped on purpose: a materially incompatible session/event
  // callback (or a mere accidental text occurrence) must fail AC6, not pass
  // because the string "'session/event'" still exists somewhere.
  { seam: "context.session/event", pkg: "dsh-session", marker: "'session/event'(this:Scoped<Session>,session:Session,event:SessionEvent):void" },
  { seam: "agents.get", pkg: "dsh-agent", marker: "get(id:SessionId):Agent|undefined" },
];

// The committed machine-readable pin is authoritative. The executable seam set
// MUST match PIN.requiredReadSeams exactly; any drift fails closed so the
// durable ABI cannot silently separate from the executable ABI.
function seamSetsEqual(declaredNames, executableNames) {
  const a = [...declaredNames].sort();
  const b = [...executableNames].sort();
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

let exitCode = 0;
try {
  // The committed machine-readable pin is authoritative: the executable seam
  // set must match PIN.requiredReadSeams exactly, before any runtime probe.
  const declaredSeams = Array.isArray(PIN.requiredReadSeams) ? PIN.requiredReadSeams : null;
  const executableSeams = SEAMS.map((s) => s.seam);
  if (!declaredSeams || !seamSetsEqual(declaredSeams, executableSeams)) {
    fail("dsh-compat.seamset-authority", `declared ${JSON.stringify(declaredSeams)} != executable ${JSON.stringify(executableSeams)}`);
    exitCode = 1;
  } else {
    ok("dsh-compat.seamset-authority", `${SEAMS.length} required read seams exactly match dsh-compat.json.requiredReadSeams`);
  }

  const rawBin = process.env.DSH_BIN || which("dsh");
  if (!rawBin) { fail("dsh-compat.runtime", "DSH_BIN not set and `dsh` not on PATH"); exitCode = 2; }
  else {
    const binPath = await realpath(rawBin);
    const installed = await findInstalledPackage(binPath, PIN.package);
    if (!installed) {
      fail("dsh-compat.runtime", `DSH_BIN ${rawBin} -> ${binPath} does not resolve to an installed ${PIN.package} package`);
      exitCode = 1;
    } else {
      ok("dsh-compat.runtime", `${binPath} resolves to ${installed.root}`);

      if (installed.pkg.version !== PIN.version) {
        fail("dsh-compat.version", `installed ${installed.pkg.version} !== pinned ${PIN.version}`);
        exitCode = 1;
      } else {
        ok("dsh-compat.version", installed.pkg.version);
      }

      const localIntegrity = await installedIntegrity(installed.root);
      const observedIntegrity = localIntegrity || registryIntegrity();
      if (!observedIntegrity || observedIntegrity.startsWith("(registry-unavailable")) {
        fail("dsh-compat.integrity", `no local integrity and registry unavailable for ${PIN.package}@${installed.pkg.version}`);
        exitCode = 1;
      } else if (observedIntegrity !== PIN.npmDistIntegrity) {
        fail("dsh-compat.integrity", `observed ${observedIntegrity} !== pinned ${PIN.npmDistIntegrity}`);
        exitCode = 1;
      } else {
        ok("dsh-compat.integrity", observedIntegrity.slice(0, 16) + "…" + (localIntegrity ? " (local metadata)" : " (registry)"));
      }

      // Resolve the seam packages relative to the qualified DSH tree.
      const pkgNodeModules = [
        join(installed.root, "node_modules", "@deepseek-ai"),
        join(installed.root, "..", "@deepseek-ai"),
        join(dirname(installed.root), "@deepseek-ai"),
      ].filter((d) => existsSync(d));

      for (const { seam, pkg, marker } of SEAMS) {
        let where = null;
        for (const dir of pkgNodeModules) {
          const subRoot = join(dir, pkg);
          if (!existsSync(subRoot)) continue;
          const hit = seamSearchDir(subRoot, marker, [join("lib", "types"), "lib", "types"]);
          if (hit) { where = `${pkg}/${hit.file.replace(subRoot + "/", "")}`; break; }
        }
        if (!where) {
          fail("dsh-compat.seam." + seam, `shape marker not found under ${pkg} in the qualified DSH tree`);
          exitCode = 1;
        } else {
          ok("dsh-compat.seam." + seam, where);
        }
      }

      // Cheap negative self-check: prove the seam-set drift guard really fails
      // closed rather than being a no-op. A super-set of the pin's seam list
      // must be rejected as drift.
      const drifted = seamSetsEqual([...PIN.requiredReadSeams, "storage.open"], executableSeams);
      if (drifted) {
        fail("dsh-compat.selfcheck.seamset-drift-detected", "drift guard failed to reject a drifted seam set");
        exitCode = 1;
      } else {
        ok("dsh-compat.selfcheck.seamset-drift-detected", "a super-set of requiredReadSeams is rejected by the authority guard");
      }

      console.log("dsh-compat.scope: storage/apiProxy NOT in M1 required ABI (TB0/M3 write path) — informational");
    }
  }
} catch (error) {
  fail("dsh-compat.fatal", String(error?.stack || error));
  exitCode = 2;
}

console.log("\n=== dsh-compat SUMMARY ===");
for (const [n, r] of results) console.log(`${r} ${n}`);
const failed = results.filter(([, r]) => r === "FAIL");
if (failed.length) { console.log(`FAILED: ${failed.length}`); process.exit(1); }
console.log(`ALL PASS (${results.length} checks)`);
process.exit(0);
