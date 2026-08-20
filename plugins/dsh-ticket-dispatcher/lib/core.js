import { join } from "node:path";

export const DEFAULT_MAX_ACTIVE = 3;
export const CLAIM_PREFIX = "dispatcher-claim:";
export const VOID_PREFIX = "dispatcher-claim:void";

const byNumber = (a, b) => a.number - b.number;

export function parseBlockers(body = "") {
  const section = /^## Blocked by\s*$([\s\S]*?)(?=^## |(?![\s\S]))/im.exec(body)?.[1] ?? "";
  if (/^\s*(?:-|\*)?\s*none\s*$/im.test(section)) return [];
  return [...new Set([...section.matchAll(/(?:#|\/(?:issues|pull)\/)(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

export function classify(tickets, bindings = {}, maxActive = DEFAULT_MAX_ACTIVE) {
  const states = new Map(tickets.map((ticket) => [ticket.number, ticket.state]));
  const running = Object.values(bindings)
    .filter((binding) => states.get(binding.number) === "OPEN" && ["claimed", "running"].includes(binding.status))
    .sort(byNumber);
  const ready = [];
  const blocked = [];

  for (const ticket of [...tickets].sort(byNumber)) {
    if (ticket.state !== "OPEN" || ["claimed", "running", "voiding"].includes(bindings[ticket.number]?.status)) continue;
    const blocking = ticket.blockers.filter((number) => (ticket.blockerStates?.[number] ?? states.get(number)) !== "CLOSED");
    if (blocking.length) blocked.push({ number: ticket.number, blocking });
    else ready.push({ number: ticket.number });
  }

  const capacity = Math.max(0, maxActive - running.length);
  return {
    ready,
    running,
    blocked,
    admitted: ready.slice(0, capacity),
    capacityLimited: ready.slice(capacity),
    activeLimit: maxActive,
  };
}

export function bindingNames({ number, baseSha, repoRoot, worktreeRoot }) {
  if (!/^\d+$/.test(String(number)) || !/^[0-9a-f]{40}$/i.test(baseSha)) throw new Error("ticket number and exact 40-character git base SHA are required");
  return {
    branch: `workflow/ticket-${number}`,
    worktree: join(worktreeRoot ?? join(repoRoot, "..", "dsh-glasses-tickets"), `ticket-${number}-${baseSha.slice(0, 12)}`),
  };
}

export function bootstrapPrompt({ number, url, baseSha, branch, worktree }) {
  return `You are the fresh DSH Ticket Lead for Ticket #${number}.\n\nBootstrap exactly as required by AGENTS.md section 3:\n- read AGENTS.md\n- re-read ${url}\n- fetch origin and verify every declared blocker is complete\n- verify exact base SHA ${baseSha}\n- verify branch ${branch}\n- verify dedicated worktree ${worktree}\n\nOwn only Ticket #${number}; durable GitHub state remains authoritative.`;
}

export function claimBody(binding) {
  return `${CLAIM_PREFIX} ${JSON.stringify({ schemaVersion: 1, ticket: binding.number, sessionId: binding.sessionId, branch: binding.branch, worktree: binding.worktree, baseSha: binding.baseSha })}`;
}

export function voidClaimBody(binding, reason) {
  return `${VOID_PREFIX} ${JSON.stringify({ schemaVersion: 1, ticket: binding.number, sessionId: binding.sessionId, reason })}`;
}

export function parseClaim(body = "") {
  if (!body.startsWith(`${CLAIM_PREFIX} `)) return undefined;
  try {
    const value = JSON.parse(body.slice(CLAIM_PREFIX.length + 1));
    if (value.schemaVersion !== 1 || !Number.isInteger(value.ticket) || !value.sessionId || !value.branch || !value.worktree || !value.baseSha) return undefined;
    return { ...value, number: value.ticket, status: "claimed" };
  } catch {
    return undefined;
  }
}

export function parseClaimMarker(body = "") {
  if (body.startsWith(`${VOID_PREFIX} `)) try {
    const value = JSON.parse(body.slice(VOID_PREFIX.length + 1));
    if (value.schemaVersion === 1 && Number.isInteger(value.ticket) && value.sessionId && value.reason) {
      return { number: value.ticket, sessionId: value.sessionId, status: "void", reason: value.reason };
    }
  } catch {}
  return parseClaim(body);
}

export function collapseClaimMarkers(bodies) {
  const records = new Map();
  for (const body of bodies) {
    const marker = parseClaimMarker(body);
    if (!marker) continue;
    const current = records.get(marker.number);
    if (marker.status !== "void" || !current || current.sessionId === marker.sessionId) records.set(marker.number, marker);
  }
  return [...records.values()].sort(byNumber);
}

export function stableReport(view, resources = {}) {
  const binding = (item) => ({
    number: item.number,
    status: item.status,
    sessionId: item.sessionId,
    branch: item.branch,
    worktree: item.worktree,
    baseSha: item.baseSha,
    validWorktree: item.validWorktree,
    sessionPersisted: item.sessionPersisted,
    live: item.live === true,
    recovered: item.recovered,
  });
  return {
    schemaVersion: 1,
    activeLimit: view.activeLimit,
    ready: view.ready.map((item) => item.number),
    running: view.running.map(binding),
    blocked: view.blocked.map((item) => ({ number: item.number, blocking: [...item.blocking] })),
    capacityLimited: view.capacityLimited.map((item) => item.number),
    invalid: [...(view.invalid ?? [])].sort(byNumber).map(({ number, reason }) => ({ number, reason })),
    resolutionError: view.resolutionError ?? null,
    resources: {
      awaitsResource: [...(resources.awaitsResource ?? [])].sort((a, b) => a.number - b.number),
    },
  };
}

export function formatReport(report) {
  const lines = [
    `Ticket Dispatcher: ${report.running.length}/${report.activeLimit} active`,
    `ready: ${report.ready.join(", ") || "-"}`,
    `running: ${report.running.map((x) => `#${x.number}=${x.sessionId}`).join(", ") || "-"}`,
    `blocked: ${report.blocked.map((x) => `#${x.number}<-${x.blocking.join("+")}`).join(", ") || "-"}`,
    `capacity-limited: ${report.capacityLimited.join(", ") || "-"}`,
    `invalid: ${report.invalid.map((x) => `#${x.number}:${x.reason}`).join(", ") || "-"}`,
    `resolution-error: ${report.resolutionError ?? "-"}`,
    `awaits-resource: ${report.resources.awaitsResource.map((x) => `#${x.number}:${x.resource}`).join(", ") || "-"}`,
  ];
  return `${JSON.stringify(report, null, 2)}\n${lines.join("\n")}\n`;
}
