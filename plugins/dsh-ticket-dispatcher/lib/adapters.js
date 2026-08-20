import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { CLAIM_PREFIX, claimBody, parseBlockers, parseClaim } from "./core.js";

const exec = promisify(execFile);

async function run(file, args, cwd) {
  const { stdout } = await exec(file, args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

export function createGitAdapter(repoRoot) {
  return {
    async createWorktree(binding) {
      await mkdir(dirname(binding.worktree), { recursive: true });
      try {
        const head = (await run("git", ["-C", binding.worktree, "rev-parse", "HEAD"], repoRoot)).trim();
        const branch = (await run("git", ["-C", binding.worktree, "branch", "--show-current"], repoRoot)).trim();
        if (head === binding.baseSha && branch === binding.branch) return;
        throw new Error(`refusing non-matching existing worktree: ${binding.worktree}`);
      } catch (error) {
        if (!error.code && error.message.startsWith("refusing")) throw error;
      }
      let branchExists = false;
      try {
        branchExists = (await run("git", ["rev-parse", `refs/heads/${binding.branch}`], repoRoot)).trim() === binding.baseSha;
      } catch {}
      await run("git", branchExists
        ? ["worktree", "add", binding.worktree, binding.branch]
        : ["worktree", "add", "-b", binding.branch, binding.worktree, binding.baseSha], repoRoot);
    },
    async removeWorktree(binding) {
      try { await run("git", ["worktree", "remove", "--force", binding.worktree], repoRoot); } catch {}
      try { await run("git", ["branch", "-D", binding.branch], repoRoot); } catch {}
    },
    async worktreeExists(binding) {
      try { return (await run("git", ["-C", binding.worktree, "rev-parse", "HEAD"], repoRoot)).trim() === binding.baseSha; } catch { return false; }
    },
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
      const pages = JSON.parse(await run("gh", ["api", "--paginate", "--slurp", `${endpoint}/issues?state=all&per_page=100`]));
      return normalizeIssues(pages.flat());
    },
    async listClaims(ticketNumbers) {
      const claims = [];
      for (const number of [...ticketNumbers].sort((a, b) => a - b)) {
        const comments = JSON.parse(await run("gh", ["api", "--paginate", "--slurp", `${endpoint}/issues/${number}/comments?per_page=100`]));
        for (const comment of comments.flat()) {
          const claim = parseClaim(comment.body);
          if (claim) claims.push(claim);
        }
      }
      return claims;
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
  };
  return adapter;
}

export function createFixtureGithubAdapter(path) {
  const load = async () => JSON.parse(await readFile(path, "utf8"));
  const save = async (data) => writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
  return {
    async listTickets() { return (await load()).tickets; },
    async listClaims() { return (await load()).claims.map((claim) => parseClaim(claim)).filter(Boolean); },
    async writeClaim(binding) {
      const data = await load();
      data.claims.push(claimBody(binding));
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
