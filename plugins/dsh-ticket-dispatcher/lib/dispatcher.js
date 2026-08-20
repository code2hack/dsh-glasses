import { randomUUID } from "node:crypto";
import {
  DEFAULT_CODEX_THINKING,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  bindingNames,
  bootstrapPrompt,
  classify,
  derivePairNames,
  parseMilestone,
  stableReport,
} from "./core.js";

function createFixtureCodexAdapter() {
  const threadOf = (name) => ({ threadId: `thread-${name}`, threadName: name, firstPrompt: name, status: "idle", turns: [] });
  return {
    async createThread({ name }) { return threadOf(name); },
    async readThread({ threadId, name }) {
      if (threadId) return { threadId, threadName: null, status: "idle", turns: [] };
      if (name) return threadOf(name);
      throw new Error("codex readThread requires threadId or name");
    },
    async sendMessage({ threadId, input }) { return { threadId, status: "completed" }; },
    async deleteThread() {},
  };
}

/** Provider defaults are protocol-v2 runtime settings; no dispatcher Codex profile/model override. */
const RUNTIME_DEFAULTS = () => ({ heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS, codexThinking: DEFAULT_CODEX_THINKING });

export function createDispatcher({
  github,
  git,
  dsh,
  stateStore,
  repoRoot,
  worktreeRoot,
  baseSha = "",
  baseRef = "origin/main",
  fetch = true,
  maxActive,
  resources = {},
  sessionProbe = async () => undefined,
  sessionLogReader = async () => null,
  bootstrapMarker = (sessionId) => `You are DSH session ${sessionId}`,
  uuid = randomUUID,
  now = Date.now,
  project = "dsh-glasses",
  codex = createFixtureCodexAdapter(),
  codexThinking = DEFAULT_CODEX_THINKING,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  wakeAgents = false,
}) {
  const runtime = { heartbeatIntervalMs, codexThinking };

  async function refreshState(state) {
    const tickets = await github.listTickets();
    const byNumber = new Map(tickets.map((ticket) => [ticket.number, ticket]));
    const markers = await github.listClaims(tickets.map((ticket) => ticket.number));
    for (const marker of markers) {
      const key = String(marker.number);
      const local = state.tickets[key];
      if (marker.status === "void") {
        if (!local || local.sessionId === marker.sessionId) state.tickets[key] = { ...local, ...marker, status: "failed" };
      } else if (local?.sessionId === marker.sessionId && ["claimed", "running", "voiding", "completed"].includes(local.status)) {
        state.tickets[key] = { ...marker, ...local };
      } else {
        state.tickets[key] = marker;
      }
    }
    for (const binding of Object.values(state.tickets)) {
      if (!["claimed", "running"].includes(binding.status)) continue;
      const ticket = byNumber.get(binding.number);
      binding.validWorktree = await git.worktreeUsable(binding);
      binding.sessionPersisted = await sessionProbe(binding);
      binding.live = dsh.isLive?.(binding) === true;
      if (!binding.bootstrapPrompt && ticket) binding.bootstrapPrompt = bootstrapPrompt({ ...ticket, ...binding });
      if (ticket && !binding.dshName && !binding.codexName && !binding.milestone) {
        try {
          const milestone = parseMilestone(ticket.body ?? "");
          binding.milestone = milestone;
          binding.dshName = derivePairNames({ project, milestone, number: binding.number }).dshName;
          binding.codexName = derivePairNames({ project, milestone, number: binding.number }).codexName;
        } catch {
          // Legacy claims may predate the naming contract; keep them alive unnamed.
        }
      }
    }
    const view = classify(tickets, state.tickets, maxActive);
    view.invalid = Object.values(state.tickets)
      .filter((binding) => ["failed", "voiding"].includes(binding.status) && binding.reason)
      .map(({ number, reason }) => ({ number, reason }));
    return { tickets, view };
  }

  async function status() {
    const state = await stateStore.load();
    const { view } = await refreshState(state);
    return stableReport(view, resources, runtime);
  }

  async function retireClosed(state, byNumber) {
    for (const binding of Object.values(state.tickets)) {
      if (!["claimed", "running"].includes(binding.status)) continue;
      if (byNumber.get(binding.number)?.state === "CLOSED") {
        await dsh.disposeAgent(binding).catch(() => {});
        binding.status = "completed";
        binding.completedReason = "closed";
      }
    }
  }

  async function invalidate(state, binding, reason, publication) {
    await dsh.disposeAgent(binding).catch(() => {});
    if (publication?.worktreeCreated) await git.removeWorktree(binding, { removeBranch: publication.branchCreated }).catch(() => {});
    try {
      await github.voidClaim(binding, reason);
      state.tickets[String(binding.number)] = { ...binding, status: "failed", live: false, reason };
    } catch {
      state.tickets[String(binding.number)] = { ...binding, status: "voiding", live: false, reason: "void-failed", pendingReason: reason };
    }
  }

  /** Reconstruct the SAME persistent Codex thread; only create when it is genuinely gone. */
  async function reconstructCodexThread(binding) {
    if (!binding.codexName) return;
    if (!binding.codex) binding.codex = {};
    binding.codex.thinkingEffort ??= codexThinking;
    try {
      const existing = await codex.readThread(
        binding.codex.threadId ? { threadId: binding.codex.threadId, name: binding.codexName } : { name: binding.codexName },
      );
      if (existing?.threadId) {
        binding.codex.threadId = existing.threadId;
        return;
      }
    } catch {}
    const created = await codex.createThread({
      cwd: binding.worktree,
      name: binding.codexName,
      thinkingEffort: binding.codex.thinkingEffort,
    });
    binding.codex.threadId = created.threadId;
    binding.codex.firstPrompt = created.firstPrompt ?? binding.codexName;
    binding.recovered = binding.recovered === undefined ? "codex" : `${binding.recovered}+codex`;
  }

  async function reconcile() {
    return stateStore.lock(async () => {
      const state = await stateStore.load();
      const { tickets, view } = await refreshState(state);
      const byNumber = new Map(tickets.map((ticket) => [ticket.number, ticket]));
      const closeoutNumbers = new Set((await (github.listCloseouts?.(tickets.map((ticket) => ticket.number)) ?? [])).map((marker) => marker.number));

      // Drain pending tombstone publications.
      for (const binding of Object.values(state.tickets)) {
        if (binding.status !== "voiding") continue;
        try {
          await github.voidClaim(binding, binding.pendingReason);
          state.tickets[String(binding.number)] = { ...binding, status: "failed", reason: binding.pendingReason, pendingReason: undefined };
        } catch {}
      }

      // Closed Tickets retire their pair; they are never re-woken.
      await retireClosed(state, byNumber);

      let resolutionError = null;

      // Watchdog: reconstruct/restore and supervise every unfinished pair.
      for (const binding of view.running) {
        if (closeoutNumbers.has(binding.number)) {
          await dsh.disposeAgent(binding).catch(() => {});
          binding.status = "completed";
          binding.completedReason = "closeout";
          continue;
        }
        if (binding.live) {
          const status = dsh.agentStatus?.(binding);
          if (status !== "running") {
            // idle (quiesced) but unfinished: resume the SAME session with a minimal continuation.
            if (wakeAgents && dsh.continueAgent && (!binding.lastWakeAt || now() - binding.lastWakeAt >= heartbeatIntervalMs)) {
              try {
                await dsh.continueAgent(binding);
                binding.lastWakeAt = now();
                binding.watchdog = true;
              } catch (error) {
                binding.wakeError = error instanceof Error ? error.message : String(error);
              }
            }
          } else {
            binding.progress = true;
            binding.lastProgressAt = now();
          }
          continue;
        }
        // Not live: reconstruct the same pair (restart), never a replacement identity.
        if (binding.sessionPersisted === false) {
          await invalidate(state, binding, "stale-session");
          continue;
        }
        // Identity-reality gate: the persisted session must belong to THIS
        // binding's worktree; a foreign orphan (crash of a different candidate)
        // is stale rather than resumable. Its exact admitted base is preserved
        // (binding.baseSha), never silently re-resolved.
        const log = await sessionLogReader(binding).catch(() => null);
        if (log !== null && !log.includes(binding.worktree)) {
          await invalidate(state, binding, "stale-session");
          continue;
        }
        let publication;
        try {
          if (!binding.validWorktree) {
            publication = await git.createWorktree(binding);
            binding.validWorktree = true;
            binding.recovered = "worktree";
          }
          await reconstructCodexThread(binding);
          await dsh.resumeAgent(binding);
          binding.status = "running";
          binding.live = true;
        } catch {
          await invalidate(state, binding, "invalid-claim", publication);
          continue;
        }
        // A crash after wake must not duplicate the bootstrap: only wake when
        // the persisted log does not already contain the bootstrap sentinel.
        const bootstrapped = log != null && log.includes(bootstrapMarker(binding.sessionId));
        if (wakeAgents && dsh.wakeAgent && !bootstrapped) {
          try {
            await dsh.wakeAgent(binding);
            binding.lastWakeAt = now();
          } catch (error) {
            binding.wakeError = error instanceof Error ? error.message : String(error);
          }
        }
      }

      let resolvedBase;
      if (view.admitted.length) try {
        resolvedBase = baseSha || await git.resolveBase({ baseRef, fetch });
        if (!/^[0-9a-f]{40}$/i.test(resolvedBase)) throw new Error("base did not resolve to an exact 40-character SHA");
      } catch (error) {
        resolutionError = error instanceof Error ? error.message : String(error);
      }

      if (resolvedBase) for (const candidate of view.admitted) {
        const ticket = byNumber.get(candidate.number);
        let milestone;
        try {
          milestone = (ticket.milestone && String(ticket.milestone).trim()) || parseMilestone(ticket.body ?? "");
          derivePairNames({ project, milestone, number: ticket.number });
        } catch {
          state.tickets[String(ticket.number)] = { number: ticket.number, status: "failed", reason: "milestone-malformed" };
          await stateStore.save(state).catch(() => {});
          continue;
        }
        const pair = derivePairNames({ project, milestone, number: ticket.number });
        // The DSH session IS the name: DSH requires agent id === session id and
        // there is no separate display name, so the deterministic pair name is
        // the durable session identity (reconstructable, never a throwaway uuid).
        const binding = {
          number: ticket.number,
          milestone,
          status: "publishing",
          dshName: pair.dshName,
          codexName: pair.codexName,
          sessionId: pair.dshName,
          ...bindingNames({ number: ticket.number, baseSha: resolvedBase, repoRoot, worktreeRoot }),
          baseSha: resolvedBase,
          codex: { thinkingEffort: codexThinking },
          bootstrapPrompt: bootstrapPrompt({ ...ticket, ...pair, sessionId: pair.dshName, baseSha: resolvedBase, codexThreadId: undefined }),
        };
        let publication;
        let agentCreated = false;
        let codexCreated = null;
        let existing = null;
        let published = false;
        const verifyIdleSeed = (thread) => {
          if ((thread?.firstPrompt ?? binding.codexName) !== binding.codexName) {
            throw new Error(`codex seed first prompt mismatch: expected "${binding.codexName}"`);
          }
          const userTurns = (thread?.turns ?? []).filter((entry) => (entry.items ?? []).some((item) => item.type === "userMessage")).length;
          if (userTurns !== 1) throw new Error(`codex seed must have exactly one user turn (found ${userTurns})`);
          if (thread?.status && !["idle", "done", "completed", "ready", "waiting"].includes(thread.status)) {
            throw new Error(`codex seed not idle before claim publication (status=${thread.status})`);
          }
        };
        try {
          publication = await git.createWorktree(binding);
          await dsh.createAgent(binding);
          agentCreated = true;
          // Idempotent pairing: a real same-name persistent thread already exists
          // (leftover from a readmission/restart) MUST be reused, never duplicated.
          try { existing = await codex.readThread({ name: binding.codexName }); } catch {}
          if (existing?.threadId) {
            binding.codex.threadId = existing.threadId;
            binding.codex.firstPrompt = existing.firstPrompt ?? binding.codexName;
            binding.reusedThread = true;
          } else {
            codexCreated = await codex.createThread({ cwd: binding.worktree, name: binding.codexName, thinkingEffort: codexThinking });
            binding.codex.threadId = codexCreated.threadId;
            binding.codex.firstPrompt = codexCreated.firstPrompt ?? binding.codexName;
          }
          verifyIdleSeed(existing ?? codexCreated);
          binding.bootstrapPrompt = bootstrapPrompt({ ...ticket, ...binding, codexThreadId: binding.codex.threadId });
          state.tickets[String(ticket.number)] = binding;
          await stateStore.save(state);
          await github.writeClaim(binding);
          published = true;
          binding.status = "claimed";
          binding.live = true;
        } catch (error) {
          if (codexCreated?.threadId && !existing?.threadId) await codex.deleteThread(codexCreated.threadId).catch(() => {});
          if (agentCreated) await dsh.disposeAgent(binding).catch(() => {});
          if (publication?.worktreeCreated) await git.removeWorktree(binding, { removeBranch: publication.branchCreated }).catch(() => {});
          state.tickets[String(ticket.number)] = {
            number: ticket.number,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
          await stateStore.save(state).catch(() => {});
        }
        if (published && wakeAgents && dsh.wakeAgent) {
          try {
            await dsh.wakeAgent(binding);
            binding.lastWakeAt = now();
          } catch (error) {
            binding.wakeError = error instanceof Error ? error.message : String(error);
          }
        }
      }

      const final = await refreshState(state);
      final.view.resolutionError = resolutionError;
      await stateStore.save(state);
      return stableReport(final.view, resources, runtime);
    });
  }

  return { reconcile, status };
}

export { RUNTIME_DEFAULTS };
