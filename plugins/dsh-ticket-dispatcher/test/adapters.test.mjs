import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createFixtureGithubAdapter, createGitAdapter, encodeSegment, normalizeIssues, parseJqLines, probeSession, projectKey, removeOrphanSession } from "../lib/adapters.js";

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

test("resolveBase with fetch=true rejects on a failed configured-origin fetch instead of using a stale origin/main", async (t) => {
  const { root, repo, git, baseSha } = await scratchRepo(t);
  // origin/main is resolvable locally, but stale relative to the configured origin.
  await git("update-ref", "refs/remotes/origin/main", baseSha);
  // An origin IS configured, but its URL is unreachable, so `git fetch origin` must fail.
  await git("remote", "add", "origin", join(root, "does-not-exist"));
  const adapter = createGitAdapter(repo, join(root, "worktrees"));

  await assert.rejects(adapter.resolveBase({ baseRef: "origin/main", fetch: true }), /fetch/i);
  // Explicit fetch=false permits resolving the intentionally local/stale ref.
  assert.equal(await adapter.resolveBase({ baseRef: "origin/main", fetch: false }), baseSha);
});

test("resolveBase with fetch=true returns the fetched remote head, never a stale local origin/main", async (t) => {
  const { root, repo, git, baseSha } = await scratchRepo(t);
  // A reachable remote whose main is ahead of the local stale origin/main.
  const remote = join(root, "remote");
  await exec("git", ["init", "--quiet", "-b", "main", remote]);
  const remoteGit = (...args) => exec("git", args, { cwd: remote });
  await remoteGit("config", "user.name", "Remote");
  await remoteGit("config", "user.email", "remote@example.invalid");
  await writeFile(join(remote, "file"), "remote\n");
  await remoteGit("add", "file");
  await remoteGit("commit", "--quiet", "-m", "fresh remote");
  const remoteHead = (await remoteGit("rev-parse", "HEAD")).stdout.trim();

  await git("update-ref", "refs/remotes/origin/main", baseSha);
  await git("remote", "add", "origin", remote);
  const adapter = createGitAdapter(repo, join(root, "worktrees"));

  assert.notEqual(remoteHead, baseSha);
  // Before any fetch, the local tracking ref is stale: explicit fetch=false keeps it.
  assert.equal(await adapter.resolveBase({ baseRef: "origin/main", fetch: false }), baseSha);
  // With fetch=true the tracking ref is refreshed to the remote head, never stale.
  assert.equal(await adapter.resolveBase({ baseRef: "origin/main", fetch: true }), remoteHead);
});

test("session-dir encoding is exact and lossless for identity segments", () => {
  assert.equal(encodeSegment("dsh-glasses-Bootstrap-#19-DSH"), "dsh-glasses-Bootstrap-~002319-DSH");
  assert.equal(encodeSegment("."), "~002E");
  assert.equal(encodeSegment(".."), "~002E~002E");
  assert.equal(encodeSegment("a b/c:d~e"), "a~0020b~002Fc~003Ad~007Ee");
  assert.equal(encodeSegment("plain-name_1.2-DSH"), "plain-name_1.2-DSH");
  assert.equal(encodeSegment("/"), "~002F");
});

test("projectKey encoding matches the DSH sessions layout contract", () => {
  assert.equal(projectKey("/home/code2hack/Projects/glasses/dsh-glasses-19"), "--home-code2hack-Projects-glasses-dsh-glasses-19--");
  assert.equal(projectKey("/"), "--root--");
  assert.throws(() => projectKey(""), /empty project path/);
  assert.equal(projectKey("/a/b"), "--a-b--");
  assert.match(projectKey("/x/y"), /^--[A-Za-z0-9._-]{1,251}--$/);
});

test("probe reports persisted, missing, collision, and unknown faithfully", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dispatcher-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions");
  const cwdA = join(root, "worktree-a");
  const cwdB = join(root, "worktree-b");
  const sessionId = "dsh-glasses-Bootstrap-#19-DSH";
  const ip = (cwd) => join(sessions, projectKey(cwd), encodeSegment(sessionId));
  await mkdir(dirname(ip(cwdA)), { recursive: true });
  await writeFile(ip(cwdA), "{}");

  const binding = { sessionId, worktree: cwdA };
  assert.equal((await probeSession(root, binding)).status, "persisted");
  assert.equal((await probeSession(void 0, binding)).status, "unknown");

  const other = { sessionId, worktree: cwdB };
  const collided = await probeSession(root, other);
  assert.equal(collided.status, "collision");
  assert.deepEqual(collided.dirs, [ip(cwdA)]);

  await removeOrphanSession(root, other);
  assert.equal((await probeSession(root, other)).status, "missing");
  assert.equal((await probeSession(root, binding)).status, "missing");
});

test("fixture adapter persists completion markers and normalizes Ticket Milestones from issue bodies", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dispatcher-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "fixtures.json");
  const adapter = createFixtureGithubAdapter(path);
  const body = "## Milestone\n\nBootstrap\n\n## What to build\nBuild it\n\n## Blocked by\n- None\n\n## Gate\nautonomous";
  await writeFile(path, JSON.stringify({
    tickets: [{ number: 19, state: "OPEN", pull_request: false, body, html_url: "https://example.test/issues/19", blockerStates: {} }],
    claims: [],
    completions: [],
  }, null, 2));
  const normalized = normalizeIssues(await adapter.listTickets());
  assert.equal(normalized[0].milestone, "Bootstrap");
  assert.deepEqual(normalized[0].blockers, []);
  assert.equal(normalized[0].number, 19);

  const binding = { number: 19, name: "dsh-glasses-Bootstrap-#19-DSH", sessionId: "dsh-glasses-Bootstrap-#19-DSH", branch: "workflow/ticket-19", worktree: "/w/19", baseSha: "a".repeat(40) };
  await adapter.writeComplete(binding, { head: "b".repeat(40), pr: "https://example.test/pr" });
  const markers = await adapter.listCompletions();
  assert.equal(markers[0].number, 19);
  assert.equal(markers[0].head, "b".repeat(40));
});
