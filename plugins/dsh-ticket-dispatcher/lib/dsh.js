import { createUserMessage } from "@deepseek-ai/dsh-llm";

/**
 * Optional agent-factory setup that joins each created/resumed Ticket Lead
 * session to the deployment's configured default agent preset when one is
 * composed. This is the supported seam for exposing model-plane capabilities
 * (including the native `subagent_codex` tool) to admitted DSH agents; a
 * deployment without `dsh-agent-presets` is untouched, and a broken preset
 * rolls the agent creation back (surfaced as an admission failure).
 */
export async function composeWithDefaultPreset(agentCtx) {
  // The agent-loop factory treats the setup() return value as a rollback
  // scope and calls `?.commit()` on it; mount() alone returns the composed
  // preset record, so wrap it in the expected `{ commit, rollback }` handle.
  // The mount is awaited so a broken composition rejects setup and rolls the
  // agent creation back instead of publishing a half-composed session.
  const presets = agentCtx?.get?.("agentPresets");
  if (presets) await presets.mount(agentCtx);
  return { commit() {}, rollback() {} };
}

export function createDshAdapter(ctx) {
  const handles = new Map();
  const agentOf = (binding) => handles.get(binding.sessionId)?.agent;
  return {
    isLive(binding) {
      return handles.has(binding.sessionId);
    },
    /**
     * Supported DSH lifecycle signal: `true` only while the bound agent is
     * actively running a turn (`agent.status === "running"`). This is the
     * "live/progressing" state the watchdog must not wake.
     */
    isProgressing(binding) {
      return agentOf(binding)?.status === "running";
    },
    /**
     * Quiescent state: the bound agent is loaded this process and idle
     * (`agent.status === "idle"`), i.e. it has no running turn even though its
     * Ticket is unfinished. The watchdog wakes this same session.
     */
    isQuiescent(binding) {
      return handles.has(binding.sessionId) && agentOf(binding)?.status === "idle";
    },
    async createAgent(binding) {
      const selection = ctx.get("agentDefaultModel").currentSelection();
      const handle = await ctx.get("agents").create({
        sessionId: binding.sessionId,
        meta: { cwd: binding.worktree },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: composeWithDefaultPreset,
      });
      handles.set(binding.sessionId, handle);
      await ctx.get("sessions").flush(handle.agent.session);
    },
    async resumeAgent(binding) {
      const selection = ctx.get("agentDefaultModel").currentSelection();
      const handle = await ctx.get("agents").resume({
        resumeSessionId: binding.sessionId,
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: composeWithDefaultPreset,
      });
      handles.set(binding.sessionId, handle);
    },
    async disposeAgent(binding) {
      await handles.get(binding.sessionId)?.dispose();
      handles.delete(binding.sessionId);
    },
    async wakeAgent(binding, message = binding.bootstrapPrompt) {
      const handle = handles.get(binding.sessionId);
      if (!handle) throw new Error(`agent handle unavailable: ${binding.sessionId}`);
      handle.agent.followup(createUserMessage({
        content: [{ type: "text", text: message }],
        source: { kind: "user" },
      }));
    },
  };
}
