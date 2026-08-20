import { randomUUID } from "node:crypto";
import { bindingNames, bootstrapPrompt, classify, stableReport } from "./core.js";

export function createDispatcher({ github, git, dsh, stateStore, repoRoot, worktreeRoot, baseSha = "", baseRef = "origin/main", fetch = true, maxActive, resources = {}, sessionProbe = async () => undefined, uuid = randomUUID }) {
  async function refreshState(state) {
    const tickets = await github.listTickets();
    const byNumber = new Map(tickets.map((ticket) => [ticket.number, ticket]));
    const markers = await github.listClaims(tickets.map((ticket) => ticket.number));
    for (const marker of markers) {
      const key = String(marker.number);
      const local = state.tickets[key];
      if (marker.status === "void") {
        if (!local || local.sessionId === marker.sessionId) state.tickets[key] = { ...local, ...marker, status: "failed" };
      } else if (local?.sessionId === marker.sessionId && ["claimed", "running", "voiding"].includes(local.status)) {
        state.tickets[key] = { ...marker, ...local };
      } else {
        state.tickets[key] = marker;
      }
    }
    for (const binding of Object.values(state.tickets)) {
      if (!["claimed", "running"].includes(binding.status)) continue;
      const ticket = byNumber.get(binding.number);
      if (!binding.bootstrapPrompt && ticket) binding.bootstrapPrompt = bootstrapPrompt({ ...ticket, ...binding });
      binding.validWorktree = await git.worktreeUsable(binding);
      binding.sessionPersisted = await sessionProbe(binding);
      binding.live = dsh.isLive?.(binding) === true;
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
    return stableReport(view, resources);
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

  async function reconcile() {
    return stateStore.lock(async () => {
      const state = await stateStore.load();
      const { tickets, view } = await refreshState(state);
      const byNumber = new Map(tickets.map((ticket) => [ticket.number, ticket]));
      let resolutionError = null;

      for (const binding of Object.values(state.tickets)) {
        if (binding.status !== "voiding") continue;
        try {
          await github.voidClaim(binding, binding.pendingReason);
          state.tickets[String(binding.number)] = { ...binding, status: "failed", reason: binding.pendingReason, pendingReason: undefined };
        } catch {}
      }

      for (const binding of Object.values(state.tickets)) {
        if (["claimed", "running"].includes(binding.status) && byNumber.get(binding.number)?.state === "CLOSED") await dsh.disposeAgent(binding).catch(() => {});
      }

      for (const binding of view.running) {
        if (binding.live) continue;
        if (binding.sessionPersisted === false) {
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
          await dsh.resumeAgent(binding);
          binding.status = "running";
          binding.live = true;
        } catch {
          await invalidate(state, binding, "invalid-claim", publication);
          continue;
        }
        if (dsh.wakeAgent) try {
          await dsh.wakeAgent(binding);
        } catch (error) {
          binding.wakeError = error instanceof Error ? error.message : String(error);
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
        const names = bindingNames({ number: ticket.number, baseSha: resolvedBase, repoRoot, worktreeRoot });
        const binding = {
          number: ticket.number,
          status: "publishing",
          sessionId: `session-${uuid()}`,
          ...names,
          baseSha: resolvedBase,
          bootstrapPrompt: bootstrapPrompt({ ...ticket, ...names, baseSha: resolvedBase }),
        };
        let publication;
        let agentCreated = false;
        let published = false;
        try {
          publication = await git.createWorktree(binding);
          await dsh.createAgent(binding);
          agentCreated = true;
          state.tickets[String(ticket.number)] = binding;
          await stateStore.save(state);
          await github.writeClaim(binding);
          published = true;
          binding.status = "claimed";
          binding.live = true;
        } catch (error) {
          if (agentCreated) await dsh.disposeAgent(binding).catch(() => {});
          if (publication?.worktreeCreated) await git.removeWorktree(binding, { removeBranch: publication.branchCreated }).catch(() => {});
          state.tickets[String(ticket.number)] = {
            number: ticket.number,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
          await stateStore.save(state).catch(() => {});
        }
        if (published && dsh.wakeAgent) try {
          await dsh.wakeAgent(binding);
        } catch (error) {
          binding.wakeError = error instanceof Error ? error.message : String(error);
        }
      }

      const final = await refreshState(state);
      final.view.resolutionError = resolutionError;
      await stateStore.save(state);
      return stableReport(final.view, resources);
    });
  }

  return { reconcile, status };
}
