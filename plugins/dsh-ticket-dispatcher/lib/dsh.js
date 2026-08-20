import { createUserMessage } from "@deepseek-ai/dsh-llm";

export function createDshAdapter(ctx) {
  const handles = new Map();
  return {
    isLive(binding) {
      return handles.has(binding.sessionId);
    },
    async createAgent(binding) {
      const selection = ctx.get("agentDefaultModel").currentSelection();
      const handle = await ctx.get("agents").create({
        sessionId: binding.sessionId,
        meta: { cwd: binding.worktree },
        agentOptions: { provider: selection.provider, model: selection.model },
      });
      handles.set(binding.sessionId, handle);
      await ctx.get("sessions").flush(handle.agent.session);
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
      handle.agent.followup(createUserMessage({
        content: [{ type: "text", text: binding.bootstrapPrompt }],
        source: { kind: "user" },
      }));
    },
  };
}
