import { bindingNames, bootstrapPrompt, classify, continuationPrompt, dshName, stableReport } from "./core.js";

function milestoneValid(ticket) {
  return ticket.state !== "OPEN" || Boolean(ticket.milestone);
}

const DURABLE_KEYS = ["number", "status", "name", "sessionId", "branch", "worktree", "baseSha", "milestone", "bootstrapPrompt", "reason", "pendingReason", "error", "completedBy", "head", "recovered"];

/** Strip per-pass runtime signals so durable state holds only the reconstruct-
 * ed Ticket <-> DSH identity and lifecycle status projection. */
function durableProjection(binding) {
  const projection = {};
  for (const key of DURABLE_KEYS) if (binding[key] !== undefined) projection[key] = binding[key];
  return projection;
}

export function createDispatcher({ github, git, dsh, stateStore, repoRoot, worktreeRoot, baseSha = "", baseRef = "origin/main", fetch = true, maxActive, intervalMs = 120_000, resources = {}, sessionProbe = async () => ({ status: "unknown" }), sessionCleanup, uuid = () => `session-${Math.random().toString(16).slice(2)}` }) {
  const reportOptions = { heartbeatMs: intervalMs };

  async function refreshState(state) {
    const tickets = await github.listTickets();
    const byNumber = new Map(tickets.map((ticket) => [ticket.number, ticket]));
    const markers = await github.listClaims(tickets.map((ticket) => ticket.number));
    for (const marker of markers) {
      const key = String(marker.number);
      const local = state.tickets[key];
      if (marker.status === "void") {
        if (!local || local.sessionId === marker.sessionId) state.tickets[key] = durableProjection({ ...local, ...marker, status: "failed" });
      } else if (local?.sessionId === marker.sessionId && ["claimed", "running", "voiding"].includes(local.status)) {
        state.tickets[key] = durableProjection({ ...marker, ...local });
      } else {
        state.tickets[key] = durableProjection(marker);
      }
    }
    const completions = (await github.listCompletions?.(tickets.map((ticket) => ticket.number))) ?? [];
    const completedByTicket = new Map(completions.map((marker) => [marker.number, marker]));

    // Per-pass runtime view. state.tickets stays a clean durable projection;
    // liveness signals (validWorktree, sessionProbe, live, progressing, ...)
    // are computed fresh here and are never written back to durable state.
    const sessions = new Map();
    for (const [key, durable] of Object.entries(state.tickets)) {
      if (!["claimed", "running", "publishing", "voiding", "failed", "complete"].includes(durable.status)) continue;
      const binding = { ...durable };
      const ticket = byNumber.get(binding.number);
      if (!binding.bootstrapPrompt && ticket) binding.bootstrapPrompt = bootstrapPrompt({ ...ticket, ...binding });
      // Failed/voiding bindings are identity tombstones without a worktree;
      // there is nothing to probe or validate until a re-admission retries.
      if (!binding.worktree) {
        binding.validWorktree = false;
        binding.sessionProbe = { status: "unknown" };
        binding.sessionPersisted = false;
        binding.live = false;
        binding.progressing = false;
      } else {
        binding.validWorktree = await git.worktreeUsable(binding);
        binding.sessionProbe = (await sessionProbe(binding)) ?? { status: "unknown" };
      }
      binding.sessionPersisted = binding.sessionProbe.status === "persisted";
      binding.live = dsh.isLive?.(binding) === true;
      binding.progressing = dsh.isProgressing?.(binding) === true;
      const closed = ticket?.state === "CLOSED";
      const completeMarker = completedByTicket.get(binding.number);
      if (closed || (completeMarker && completeMarker.sessionId === binding.sessionId)) {
        binding.status = "complete";
        binding.completedBy = closed ? "closed" : "marker";
      }
      sessions.set(key, binding);
    }

    const classifyTickets = tickets.filter((ticket) => ticket.state !== "OPEN" || milestoneValid(ticket));
    const view = classify(classifyTickets, Object.fromEntries(sessions), maxActive);
    view.invalid = [
      ...(view.invalid ?? []),
      ...Object.values(state.tickets)
        .filter((binding) => ["failed", "voiding"].includes(binding.status) && binding.reason)
        .map(({ number, reason }) => ({ number, reason })),
    ];
    view.invalidMilestone = tickets
      .filter((ticket) => ticket.state === "OPEN" && !milestoneValid(ticket))
      .map((ticket) => ticket.number)
      .sort((a, b) => a - b);
    return { tickets, byNumber, sessions, view };
  }

  async function status() {
    const state = await stateStore.load();
    const { view } = await refreshState(state);
    return stableReport(view, resources, reportOptions);
  }

  async function invalidate(state, binding, reason, publication) {
    await dsh.disposeAgent?.(binding).catch(() => {});
    if (publication?.worktreeCreated) await git.removeWorktree(binding, { removeBranch: publication.branchCreated }).catch(() => {});
    try {
      await github.voidClaim(binding, reason);
      state.tickets[String(binding.number)] = durableProjection({ ...binding, status: "failed", reason, live: undefined });
    } catch {
      state.tickets[String(binding.number)] = durableProjection({ ...binding, status: "voiding", reason: "void-failed", pendingReason: reason });
    }
  }

  async function reconcile() {
    return stateStore.lock(async () => {
      const state = await stateStore.load();
      const { tickets, byNumber, sessions, view } = await refreshState(state);
      let resolutionError = null;

      for (const binding of Object.values(state.tickets)) {
        if (binding.status !== "voiding") continue;
        try {
          await github.voidClaim(binding, binding.pendingReason);
          state.tickets[String(binding.number)] = durableProjection({ ...binding, status: "failed", reason: binding.pendingReason, pendingReason: undefined, live: undefined });
        } catch {}
      }

      // Completed Tickets are retired: dispose any live handle and keep the
      // durable `complete` status so they are never re-woken nor re-counted.
      for (const binding of [...sessions.values()]) {
        if (binding.status !== "complete") continue;
        await dsh.disposeAgent?.(binding).catch(() => {});
        state.tickets[String(binding.number)] = durableProjection({ ...binding, status: "complete", live: false, progressing: false });
      }

      // Watchdog: reconcile every unfinished admitted Ticket's DSH state.
      for (const binding of view.running) {
        if (binding.live) {
          if (binding.progressing) continue; // live/progressing: do nothing
          // Loaded but quiescent while its Ticket is unfinished: wake the
          // SAME bound session with a minimal continuation instruction.
          if (dsh.wakeAgent) {
            try {
              await dsh.wakeAgent(binding, continuationPrompt(binding));
              binding.woke = (binding.woke ?? 0) + 1;
            } catch (error) {
              binding.wakeError = error instanceof Error ? error.message : String(error);
            }
          }
          continue;
        }
        const probe = binding.sessionProbe ?? { status: "unknown" };
        if (probe.status === "collision") {
          // A persisted session for this deterministic id lives only under a
          // different worktree key; resume would refuse the mismatched cwd.
          // Fail closed as an identity collision; re-admission relocates it.
          await invalidate(state, binding, "identity-collision");
          continue;
        }
        if (probe.status === "missing") {
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
          state.tickets[String(binding.number)] = durableProjection({ ...binding, status: "running" });
        } catch {
          await invalidate(state, binding, "invalid-claim", publication);
          continue;
        }
        if (dsh.wakeAgent) {
          try {
            await dsh.wakeAgent(binding, binding.bootstrapPrompt);
            binding.woke = (binding.woke ?? 0) + 1;
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
        // Admitted candidates are milestone-valid (invalid milestone Tickets
        // are excluded by refreshState), so the exact identity is derivable.
        const names = bindingNames({ number: ticket.number, baseSha: resolvedBase, repoRoot, worktreeRoot });
        const name = dshName({ milestone: ticket.milestone, number: ticket.number });
        const binding = {
          number: ticket.number,
          name,
          sessionId: name,
          milestone: ticket.milestone,
          ...names,
          baseSha: resolvedBase,
          bootstrapPrompt: bootstrapPrompt({ ...ticket, ...names, name, baseSha: resolvedBase }),
        };
        let publication;
        let agentCreated = false;
        let published = false;
        try {
          publication = await git.createWorktree(binding);
          // Deterministic ids are shared with the persisted session log. If a
          // persisted session already exists under the expected worktree
          // (crash between session flush and claim publication), resume it
          // instead of colliding. A session left under an older base's
          // worktree key is removed so the same id never collides again.
          const probe = (await sessionProbe(binding)) ?? { status: "unknown" };
          if (probe.status === "persisted") {
            await dsh.resumeAgent(binding);
          } else {
            if (probe.status === "collision") await sessionCleanup?.(binding);
            await dsh.createAgent(binding);
          }
          agentCreated = true;
          state.tickets[String(ticket.number)] = durableProjection({ ...binding, status: "publishing" });
          await stateStore.save(state);
          await github.writeClaim(binding);
          published = true;
          state.tickets[String(ticket.number)] = durableProjection({ ...binding, status: "claimed" });
          binding.status = "claimed";
          binding.live = true;
        } catch (error) {
          if (agentCreated) await dsh.disposeAgent(binding).catch(() => {});
          if (publication?.worktreeCreated) await git.removeWorktree(binding, { removeBranch: publication.branchCreated }).catch(() => {});
          state.tickets[String(ticket.number)] = durableProjection({ number: ticket.number, status: "failed", error: error instanceof Error ? error.message : String(error) });
          await stateStore.save(state).catch(() => {});
        }
        if (published && dsh.wakeAgent) {
          try {
            await dsh.wakeAgent(binding, binding.bootstrapPrompt);
          } catch (error) {
            binding.wakeError = error instanceof Error ? error.message : String(error);
          }
        }
      }

      const final = await refreshState(state);
      final.view.resolutionError = resolutionError;
      await stateStore.save(state);
      return stableReport(final.view, resources, reportOptions);
    });
  }

  return { reconcile, status };
}
