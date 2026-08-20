import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createGitAdapter, parseJqLines } from "../lib/adapters.js";

const exec = promisify(execFile);

async function scratchRepo(t) {
  const root = await mkdtemp(join(tmpdir(), "dispatcher-git-test-"));
  const repo = join(root, "repo");
  await exec("git", ["init", "--quiet", repo]);
  const git = (...args) => exec("git", args, { cwd: repo });
  await git("config", "user.name", "Dispatcher Test");
  await git("config", "user.email", "dispatcher@example.invalid");
  await writeFile(join(repo, "file"), "base\n");
  await git("add", "file");
  await git("commit", "--quiet", "-m", "base");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, repo, git, baseSha: (await git("rev-parse", "HEAD")).stdout.trim() };
}

test("parseJqLines parses one JSON value per paginated jq output line", () => {
  assert.deepEqual(parseJqLines('{"number":1,"state":"open"}\n{"number":2,"state":"closed"}\n'), [
    { number: 1, state: "open" },
    { number: 2, state: "closed" },
  ]);
});

test("parseJqLines accepts empty and whitespace-only output", () => {
  assert.deepEqual(parseJqLines(""), []);
  assert.deepEqual(parseJqLines(" \n\t\n"), []);
});

test("parseJqLines identifies a malformed output line", () => {
  assert.throws(() => parseJqLines('{"ok":true}\nnot-json\n'), /invalid gh --jq JSON on line 2: "not-json"/);
});

test("git adapter reuses an existing branch even when its head differs from the binding base", async (t) => {
  const { root, repo, git, baseSha } = await scratchRepo(t);
  const branch = "workflow/ticket-1";
  await git("branch", branch, baseSha);
  await writeFile(join(repo, "file"), "moved\n");
  await git("commit", "--quiet", "-am", "move base");
  const binding = {
    branch,
    worktree: join(root, "worktrees/ticket-1"),
    baseSha: (await git("rev-parse", "HEAD")).stdout.trim(),
  };
  const adapter = createGitAdapter(repo, join(root, "worktrees"));

  assert.deepEqual(await adapter.createWorktree(binding), { worktreeCreated: true, branchCreated: false });
  assert.equal((await exec("git", ["-C", binding.worktree, "branch", "--show-current"])).stdout.trim(), branch);
  assert.equal((await exec("git", ["-C", binding.worktree, "rev-parse", "HEAD"])).stdout.trim(), baseSha);
  assert.equal(await adapter.worktreeUsable(binding), true);
});

test("git adapter replaces a conflicting dispatcher-owned worktree path", async (t) => {
  const { root, repo, git, baseSha } = await scratchRepo(t);
  const worktree = join(root, "worktrees/ticket-2");
  await git("worktree", "add", "--quiet", "-b", "workflow/wrong", worktree, baseSha);
  const binding = { branch: "workflow/ticket-2", worktree, baseSha };
  const adapter = createGitAdapter(repo, join(root, "worktrees"));

  assert.deepEqual(await adapter.createWorktree(binding), { worktreeCreated: true, branchCreated: true });
  assert.equal((await exec("git", ["-C", worktree, "branch", "--show-current"])).stdout.trim(), binding.branch);
  assert.equal(await adapter.worktreeUsable(binding), true);
  await assert.rejects(adapter.createWorktree({ ...binding, worktree: join(root, "outside") }), /outside dispatcher root/);
});
