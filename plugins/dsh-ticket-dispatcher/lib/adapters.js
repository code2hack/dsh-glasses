import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CLAIM_PREFIX, collapseClaimMarkers, collapseCompleteMarkers, completeBody, parseBlockers, parseMilestone, voidClaimBody } from "./core.js";

const exec = promisify(execFile);

const byNumber = (a, b) => a.number - b.number;

async function run(file, args, cwd) {
  const { stdout } = await exec(file, args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

export function parseJqLines(stdout) {
  const values = [];
  for (const [index, raw] of stdout.split("\n").entries()) {
    const line = raw.trim();
    if (!line) continue;
    try {
      values.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`invalid gh --jq JSON on line ${index + 1}: ${JSON.stringify(line)}`, { cause: error });
    }
  }
  return values;
}

// ── DSH session persistence layout (mirrors @deepseek-ai/dsh-session-persistence-jsonl) ──

export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

function sessionDirFor(dshHome, worktree, sessionId) {
  return join(dshHome, "sessions", projectKey(worktree), encodeSegment(sessionId));
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fail-closed DSH session probe.
 *
 * Returns one of:
 * - `{ status: "persisted", dir }` — a persisted session with this exact
 *   deterministic id exists under the expected worktree's project key.
 * - `{ status: "collision", dirs }` — sessions with this id exist, but only
 *   under project keys that do not match the bound worktree. Resume would
 *   refuse the mismatched cwd, so the binding is an identity collision.
 * - `{ status: "missing" }` — no persisted session with this id anywhere.
 * - `{ status: "unknown" }` — no DSH home configured (indeterminate).
 */
export async function probeSession(dshHome, binding) {
  if (!dshHome) return { status: "unknown" };
  const expected = sessionDirFor(dshHome, binding.worktree, binding.sessionId);
  if (await pathExists(expected)) return { status: "persisted", dir: expected };
  const root = join(dshHome, "sessions");
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { status: "missing" };
  }
  const encoded = encodeSegment(binding.sessionId);
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, encoded);
    if (await pathExists(candidate)) dirs.push(candidate);
  }
  return dirs.length ? { status: "collision", dirs } : { status: "missing" };
}

export function createSessionProbe(dshHome) {
  return (binding) => probeSession(dshHome, binding);
}

export function createGitAdapter(repoRoot, worktreeRoot = resolve(repoRoot, "../dsh-glasses-tickets")) {
  const worktreeUsable = async (binding) => {
    try {
      return (await run("git", ["-C", binding.worktree, "rev-parse", "--abbrev-ref", "HEAD"], repoRoot)).trim() === binding.branch;
    } catch {
      return false;
    }
  };
  return {
    async resolveBase({ baseSha, baseRef, fetch }) {
      if (baseSha) return baseSha;
      if (fetch) {
        let originConfigured = false;
        try {
          await run("git", ["remote", "get-url", "origin"], repoRoot);
          originConfigured = true;
        } catch {}
        // With fetch=true and a configured origin, a failed fetch must fail this
        // admission pass instead of silently resolving a stale local origin/main.
        if (originConfigured) await run("git", ["fetch", "--quiet", "origin"], repoRoot);
      }
      try {
        const resolved = (await run("git", ["rev-parse", `${baseRef}^{commit}`], repoRoot)).trim();
        if (/^[0-9a-f]{40}$/i.test(resolved)) return resolved;
      } catch {}
      throw new Error(`cannot resolve base ref ${baseRef}`);
    },
    async createWorktree(binding) {
      if (dirname(resolve(binding.worktree)) !== resolve(worktreeRoot)) throw new Error(`worktree is outside dispatcher root: ${binding.worktree}`);
      await mkdir(dirname(binding.worktree), { recursive: true });
      if (await worktreeUsable(binding)) return { worktreeCreated: false, branchCreated: false };
      await run("git", ["worktree", "remove", "--force", binding.worktree], repoRoot).catch(() => {});
      await rm(binding.worktree, { recursive: true, force: true });
      await run("git", ["worktree", "prune"], repoRoot);
      let branchExists = false;
      try {
        await run("git", ["rev-parse", `refs/heads/${binding.branch}`], repoRoot);
        branchExists = true;
      } catch {}
      await run("git", branchExists
        ? ["worktree", "add", binding.worktree, binding.branch]
        : ["worktree", "add", "-b", binding.branch, binding.worktree, binding.baseSha], repoRoot);
      return { worktreeCreated: true, branchCreated: !branchExists };
    },
    async removeWorktree(binding, { removeBranch = true } = {}) {
      try { await run("git", ["worktree", "remove", "--force", binding.worktree], repoRoot); } catch {}
      if (removeBranch) try { await run("git", ["branch", "-D", binding.branch], repoRoot); } catch {}
    },
    worktreeUsable,
  };
}

export function normalizeIssues(issues) {
  // Admission fixtures that are already normalized (no issue body) pass through
  // so tests keep full control; real GitHub / fixture issue bodies are parsed
  // deterministically for the declared Milestone and blockers.
  const states = new Map(issues.map((issue) => [issue.number, issue.state.toUpperCase()]));
  return issues
    .filter((issue) => !issue.pull_request && (!issue.body || /^## What to build\s*$/im.test(issue.body)))
    .map((issue) => {
      const blockers = issue.blockers ?? parseBlockers(issue.body);
      return {
        ...issue,
        number: issue.number,
        state: issue.state.toUpperCase(),
        url: issue.url ?? issue.html_url,
        // The Ticket's declared `## Milestone` section is the sole identity
        // authority (admission validates it exactly). A native GitHub
        // milestone is an OBJECT and never substitutes for the declared
        // section: a real Ticket without the section is invalid (empty
        // milestone) and reported under invalidMilestone. A plain STRING
        // milestone is accepted only as the contract representation used by
        // offline fixtures that already carry the declared value — it is
        // never an object, so dshName is safe either way.
        milestone: parseMilestone(issue.body) ?? (typeof issue.milestone === "string" ? issue.milestone : ""),
        blockers,
        blockerStates: issue.blockerStates ?? Object.fromEntries(blockers.map((number) => [number, states.get(number) ?? "UNKNOWN"])),
      };
    });
}

/**
 * Completion markers are only authoritative when they are (a) posted on the
 * Ticket's OWN issue (self-declared `ticket` must equal the source issue) and
 * (b) authored by a trusted terminal-marker writer when `completionAuthors`
 * is configured. Cross-issue or foreign-commenter markers must never retire an
 * unfinished Ticket. Markers that fail either check are ignored.
 */
export function bindSourceCompletions(entries, completionAuthors = []) {
  const records = new Map();
  for (const entry of entries) {
    const body = typeof entry === "string" ? entry : entry?.body;
    const marker = collapseCompleteMarkers([body])[0];
    if (!marker) continue;
    if (marker.number !== entry?.issue && entry?.issue !== undefined) continue;
    if (typeof entry === "object" && entry && Array.isArray(completionAuthors) && completionAuthors.length && !completionAuthors.includes(entry.author)) continue;
    records.set(marker.number, marker);
  }
  return [...records.values()].sort(byNumber);
}

export function createGithubAdapter({ repo = "code2hack/dsh-glasses", completionAuthors = [] } = {}) {
  const endpoint = `repos/${repo}`;
  async function commentsOf(numbers) {
    const entries = [];
    for (const number of [...numbers].sort((a, b) => a - b)) {
      const comments = parseJqLines(await run("gh", ["api", "--paginate", "--jq", ".[]", `${endpoint}/issues/${number}/comments?per_page=100`]));
      entries.push(...comments.map((comment) => ({ issue: number, author: comment.user?.login ?? "", body: comment.body })));
    }
    return entries;
  }
  const adapter = {
    async listTickets() {
      const issues = parseJqLines(await run("gh", ["api", "--paginate", "--jq", ".[]", `${endpoint}/issues?state=all&per_page=100`]));
      return normalizeIssues(issues);
    },
    async listClaims(ticketNumbers) {
      const entries = await commentsOf(ticketNumbers);
      return collapseClaimMarkers(entries.map((entry) => entry.body));
    },
    async listCompletions(ticketNumbers) {
      // Enforce the source-issue binding and the trusted-writer allowlist for
      // terminal markers; a marker on the wrong issue or from an untrusted
      // commenter cannot retire this Ticket.
      return bindSourceCompletions(await commentsOf(ticketNumbers), completionAuthors);
    },
    async writeClaim(binding) {
      const body = `${CLAIM_PREFIX} ${JSON.stringify({ schemaVersion: 2, ticket: binding.number, name: binding.name, sessionId: binding.sessionId, branch: binding.branch, worktree: binding.worktree, baseSha: binding.baseSha })}`;
      try {
        await run("gh", ["api", `${endpoint}/issues/${binding.number}/comments`, "-f", `body=${body}`]);
      } catch (error) {
        const published = (await adapter.listClaims([binding.number])).some((claim) => claim.sessionId === binding.sessionId);
        if (!published) throw error;
      }
    },
    async voidClaim(binding, reason) {
      const body = voidClaimBody(binding, reason);
      try {
        await run("gh", ["api", `${endpoint}/issues/${binding.number}/comments`, "-f", `body=${body}`]);
      } catch (error) {
        const voided = (await adapter.listClaims([binding.number])).some((claim) => claim.status === "void" && claim.sessionId === binding.sessionId);
        if (!voided) throw error;
      }
    },
    async writeComplete(binding, evidence = {}) {
      const body = completeBody(binding, evidence);
      try {
        await run("gh", ["api", `${endpoint}/issues/${binding.number}/comments`, "-f", `body=${body}`]);
      } catch (error) {
        const published = (await adapter.listCompletions([binding.number])).some((marker) => marker.sessionId === binding.sessionId);
        if (!published) throw error;
      }
    },
  };
  return adapter;
}

export function createFixtureGithubAdapter(path, { completionAuthors = [] } = {}) {
  const load = async () => JSON.parse(await readFile(path, "utf8"));
  const save = async (data) => writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
  const fixtureEntries = (completions) => (completions ?? []).map((entry) => {
    if (typeof entry === "string") return { issue: undefined, author: undefined, body: entry };
    return { issue: entry.issue, author: entry.author, body: entry.body };
  });
  return {
    async listTickets() { return normalizeIssues((await load()).tickets); },
    async listClaims() { return collapseClaimMarkers((await load()).claims); },
    async listCompletions() { return bindSourceCompletions(fixtureEntries((await load()).completions), completionAuthors); },
    async writeClaim(binding) {
      const data = await load();
      data.claims.push(`${CLAIM_PREFIX} ${JSON.stringify({ schemaVersion: 2, ticket: binding.number, name: binding.name, sessionId: binding.sessionId, branch: binding.branch, worktree: binding.worktree, baseSha: binding.baseSha })}`);
      await save(data);
    },
    async voidClaim(binding, reason) {
      const data = await load();
      data.claims.push(voidClaimBody(binding, reason));
      await save(data);
    },
    async writeComplete(binding, evidence = {}, author = "dispatcher-fixture") {
      const data = await load();
      data.completions = data.completions ?? [];
      data.completions.push({ author, issue: binding.number, body: completeBody(binding, evidence) });
      await save(data);
    },
  };
}

export { CLAIM_PREFIX };
