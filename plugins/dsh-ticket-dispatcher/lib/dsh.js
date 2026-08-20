import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { continuePrompt } from "./core.js";

function textMessage(text) {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

/**
 * DSH lifecycle adapter over the supported `ctx.agents` service. The watchdog
 * grounds its liveness decisions on the real agent handle's `status`
 * (`'idle' | 'running'`, mirrored by `agent/status` events) — not on wall-clock
 * inactivity heuristics. Only the project adapter touches DSH internals.
 */
export function createDshAdapter(ctx, { sessionLogReader } = {}) {
  const handles = new Map();
  return {
    isLive(binding) {
      return handles.has(binding.sessionId);
    },
    /** Supported lifecycle signal: the live handle's current agent status, or null when not live. */
    agentStatus(binding) {
      return handles.get(binding.sessionId)?.agent?.status ?? null;
    },
    async createAgent(binding) {
      const selection = ctx.get("agentDefaultModel").currentSelection();
      try {
        const handle = await ctx.get("agents").create({
          sessionId: binding.sessionId,
          meta: { cwd: binding.worktree },
          agentOptions: { provider: selection.provider, model: selection.model },
        });
        handles.set(binding.sessionId, handle);
        await ctx.get("sessions").flush(handle.agent.session);
      } catch (error) {
        // A crashed admission can leave an orphan persisted log under the
        // deterministic id (DSH refuses to `create` over existing on-disk log).
        // The pair name IS the durable identity, so the recovery is to RESUME
        // that exact session — never a replacement id and never a failed claim.
        if (!/already has a persisted log|id collision|already registered/i.test(String(error?.message ?? error))) throw error;
        // Identity-reality gate: only resume a persisted session that belongs to
        // THIS binding's worktree; a foreign orphan is a real failure.
        if (sessionLogReader) {
          const log = await sessionLogReader(binding).catch(() => null);
          if (log !== null && !log.includes(binding.worktree)) throw error;
        }
        handles.delete(binding.sessionId);
        await this.resumeAgent(binding);
      }
    },
    async resumeAgent(binding) {
      const selection = ctx.get("agentDefaultModel").currentSelection();
      const handle = await ctx.get("agents").resume({
        resumeSessionId: binding.sessionId,
        agentOptions: { provider: selection.provider, model: selection.model },
      });
      handles.set(binding.sessionId, handle);
    },
    async disposeAgent(binding) {
      await handles.get(binding.sessionId)?.dispose();
      handles.delete(binding.sessionId);
    },
    async wakeAgent(binding) {
      const handle = handles.get(binding.sessionId);
      if (!handle) throw new Error(`agent handle unavailable: ${binding.sessionId}`);
      handle.agent.followup(textMessage(binding.bootstrapPrompt));
    },
    /** Minimal watchdog continuation for the SAME bound session; no replacement identity. */
    async continueAgent(binding) {
      const handle = handles.get(binding.sessionId);
      if (!handle) throw new Error(`agent handle unavailable: ${binding.sessionId}`);
      handle.agent.followup(textMessage(continuePrompt(binding)));
    },
  };
}

export { continuePrompt };
