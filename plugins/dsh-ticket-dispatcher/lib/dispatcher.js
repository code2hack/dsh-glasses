import { randomUUID } from "node:crypto";
import { bindingNames, bootstrapPrompt, classify, stableReport } from "./core.js";

export function createDispatcher({ github, git, dsh, stateStore, repoRoot, worktreeRoot, baseSha, maxActive, resources = {}, sessionProbe = async () => undefined, uuid = randomUUID }) {
  async function snapshot(state) {
    const tickets = await github.listTickets();
    const claims = await github.listClaims(tickets.map((ticket) => ticket.number));
    for (const claim of claims) {
      const key = String(claim.number);
      const local = state.tickets[key];
      if (!local || local.status === "failed" || local.status === "publishing" && local.sessionId === claim.sessionId) state.tickets[key] = claim;
    }
    for (const binding of Object.values(state.tickets)) {
      if (!["claimed", "running"].includes(binding.status)) continue;
      binding.validWorktree = await git.worktreeExists(binding);
      binding.sessionPersisted = await sessionProbe(binding);
    }
    return { tickets, view: classify(tickets, state.tickets, maxActive) };
  }

  async function status() {
    const state = await stateStore.load();
    const { view } = await snapshot(state);
    return stableReport(view, resources);
  }

  async function reconcile() {
    return stateStore.lock(async () => {
      const state = await stateStore.load();
      const { tickets, view } = await snapshot(state);
      const byNumber = new Map(tickets.map((ticket) => [ticket.number, ticket]));
      for (const binding of Object.values(state.tickets)) {
        if (["claimed", "running"].includes(binding.status) && byNumber.get(binding.number)?.state === "CLOSED") await dsh.disposeAgent(binding).catch(() => {});
      }

      for (const candidate of view.admitted) {
        const ticket = byNumber.get(candidate.number);
        const names = bindingNames({ number: ticket.number, baseSha, repoRoot, worktreeRoot });
        const binding = {
          number: ticket.number,
          status: "publishing",
          sessionId: `session-${uuid()}`,
          ...names,
          baseSha,
          bootstrapPrompt: bootstrapPrompt({ ...ticket, ...names, baseSha }),
        };
        let worktreeCreated = false;
        let agentCreated = false;
        let published = false;
        try {
          await git.createWorktree(binding);
          worktreeCreated = true;
          await dsh.createAgent(binding);
          agentCreated = true;
          binding.status = "publishing";
          state.tickets[String(ticket.number)] = binding;
          await stateStore.save(state);
          await github.writeClaim(binding);
          published = true;
          binding.status = "claimed";
        } catch (error) {
          if (agentCreated) await dsh.disposeAgent(binding).catch(() => {});
          if (worktreeCreated) await git.removeWorktree(binding).catch(() => {});
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

      const final = await snapshot(state);
      await stateStore.save(state);
      return stableReport(final.view, resources);
    });
  }

  return { reconcile, status };
}
