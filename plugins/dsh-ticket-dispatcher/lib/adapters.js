import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { CLAIM_PREFIX, claimBody, collapseClaimMarkers, parseBlockers, voidClaimBody } from "./core.js";

const exec = promisify(execFile);

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
      if (fetch) try {
        await run("git", ["remote", "get-url", "origin"], repoRoot);
        await run("git", ["fetch", "--quiet", "origin"], repoRoot).catch(() => {});
      } catch {}
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

function normalizeIssues(issues) {
  const states = new Map(issues.map((issue) => [issue.number, issue.state.toUpperCase()]));
  return issues
    .filter((issue) => !issue.pull_request && /^## What to build\s*$/im.test(issue.body ?? ""))
    .map((issue) => {
      const blockers = parseBlockers(issue.body);
      return {
        number: issue.number,
        state: issue.state.toUpperCase(),
        url: issue.html_url,
        blockers,
        blockerStates: Object.fromEntries(blockers.map((number) => [number, states.get(number) ?? "UNKNOWN"])),
      };
    });
}

export function createGithubAdapter({ repo = "code2hack/dsh-glasses" } = {}) {
  const endpoint = `repos/${repo}`;
  const adapter = {
    async listTickets() {
      const issues = parseJqLines(await run("gh", ["api", "--paginate", "--jq", ".[]", `${endpoint}/issues?state=all&per_page=100`]));
      return normalizeIssues(issues);
    },
    async listClaims(ticketNumbers) {
      const bodies = [];
      for (const number of [...ticketNumbers].sort((a, b) => a - b)) {
        const comments = parseJqLines(await run("gh", ["api", "--paginate", "--jq", ".[]", `${endpoint}/issues/${number}/comments?per_page=100`]));
        bodies.push(...comments.map((comment) => comment.body));
      }
      return collapseClaimMarkers(bodies);
    },
    async writeClaim(binding) {
      const body = claimBody(binding);
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
  };
  return adapter;
}

export function createFixtureGithubAdapter(path) {
  const load = async () => JSON.parse(await readFile(path, "utf8"));
  const save = async (data) => writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
  return {
    async listTickets() { return (await load()).tickets; },
    async listClaims() { return collapseClaimMarkers((await load()).claims); },
    async writeClaim(binding) {
      const data = await load();
      data.claims.push(claimBody(binding));
      await save(data);
    },
    async voidClaim(binding, reason) {
      const data = await load();
      data.claims.push(voidClaimBody(binding, reason));
      await save(data);
    },
  };
}

export function createSessionProbe(dshHome) {
  return async (binding) => {
    if (!dshHome) return undefined;
    const cwdKey = `--${binding.worktree.slice(1).replaceAll("/", "-")}--`;
    try { await stat(`${dshHome}/sessions/${cwdKey}/${binding.sessionId}`); return true; } catch { return false; }
  };
}

export { CLAIM_PREFIX };
