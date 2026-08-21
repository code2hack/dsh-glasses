import { join } from "node:path";

export const DEFAULT_MAX_ACTIVE = 3;
export const DEFAULT_INTERVAL_MS = 120_000;
export const CLAIM_PREFIX = "dispatcher-claim:";
export const VOID_PREFIX = "dispatcher-claim:void";
export const COMPLETE_PREFIX = "ticket-complete:";

const byNumber = (a, b) => a.number - b.number;

export function parseBlockers(body = "") {
  const section = /^## Blocked by\s*$([\s\S]*?)(?=^## |(?![\s\S]))/im.exec(body)?.[1] ?? "";
  if (/^\s*(?:-|\*)?\s*none\s*$/im.test(section)) return [];
  return [...new Set([...section.matchAll(/(?:#|\/(?:issues|pull)\/)(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

/**
 * Deterministically parse the Ticket's declared `## Milestone`.
 *
 * The value is the first non-empty, non-comment line of the section, trimmed.
 * A valid Milestone is a single safe token (`[A-Za-z0-9][\w.-]*`); anything
 * else is rejected so the exact DSH identity remains mechanically derivable.
 * Missing or malformed input yields `undefined` — the dispatcher reports the
 * Ticket as `invalidMilestone` instead of guessing.
 */
export function parseMilestone(body = "") {
  const section = /^## Milestone\s*$([\s\S]*?)(?=^## |(?![\s\S]))/im.exec(body)?.[1] ?? "";
  const line = section.split(/\r?\n/).map((value) => value.trim()).find((value) => value && !value.startsWith("#") && !value.startsWith("<!--"));
  if (!line || !/^[A-Za-z0-9][\w.-]*$/.test(line)) return undefined;
  return line;
}

/**
 * The exact persistent DSH identity for a Ticket:
 * `<project>-<milestone>-#<ticket>-DSH`.
 */
export function dshName({ project = "dsh-glasses", milestone, number }) {
  if (!project || !/^[A-Za-z0-9][\w.-]*$/.test(String(project))) throw new Error(`invalid project identity: ${project}`);
  if (!milestone || !/^[A-Za-z0-9][\w.-]*$/.test(String(milestone))) throw new Error(`invalid milestone identity: ${milestone}`);
  if (!Number.isInteger(number) || number < 1) throw new Error(`invalid ticket number: ${number}`);
  return `${project}-${milestone}-#${number}-DSH`;
}

export function classify(tickets, bindings = {}, maxActive = DEFAULT_MAX_ACTIVE) {
  const states = new Map(tickets.map((ticket) => [ticket.number, ticket.state]));
  const open = (ticket) => ticket.state === "OPEN";
  const running = Object.values(bindings)
    .filter((binding) => states.get(binding.number) === "OPEN" && ["claimed", "running"].includes(binding.status))
    .sort(byNumber);
  const completed = Object.values(bindings)
    .filter((binding) => binding.status === "complete")
    .sort(byNumber);
  const ready = [];
  const blocked = [];

  for (const ticket of [...tickets].sort(byNumber)) {
    if (!open(ticket) || ["claimed", "running", "voiding", "complete", "collision"].includes(bindings[ticket.number]?.status)) continue;
    const blocking = ticket.blockers.filter((number) => (ticket.blockerStates?.[number] ?? states.get(number)) !== "CLOSED");
    if (blocking.length) blocked.push({ number: ticket.number, blocking });
    else ready.push({ number: ticket.number });
  }

  const capacity = Math.max(0, maxActive - running.length);
  return {
    ready,
    running,
    blocked,
    completed,
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

function reviewerRules() {
  return [
    "Reviewer/helper availability: ChatGPT and the native Codex subagent are best-effort redundant helpers, not hard availability dependencies. A bounded request may be recorded UNAVAILABLE only on objective failure (timeout, rate/quota/usage limit, provider outage, transport/tool failure). A returned technical verdict — UNPASSED, REQUEST_CHANGES, or any blocking finding — is NOT unavailability and must be addressed.",
    "Before the first production edit, after local bootstrap/inspection, make ONE bounded attempt to ask ChatGPT for a concrete repository-grounded implementation and validation plan. Exact endpoint: mcp-chatgpt ; ChatGPT project = dsh-glasses ; ChatGPT session = CTO. If ChatGPT responds, evaluate that plan before coding. If ChatGPT is unavailable after the bounded attempt, record the reason, produce your own repository-grounded plan within durable authority, and proceed. ChatGPT unavailability must not deadlock the Ticket.",
    "If you are stuck on a hard problem after bounded local debugging, construct ONE bounded git-only debug task and attempt it against BOTH ChatGPT (mcp-chatgpt ; ChatGPT project = dsh-glasses ; ChatGPT session = CTO) and a fresh native Codex subagent invocation (`subagent_codex`, or the supported equivalent exposed by the pinned DSH deployment). Use both results if both respond, one if only one responds, and continue independently if neither is available. You must not wait indefinitely on a helper.",
    "Final review: make bounded exact-head review attempts against BOTH ChatGPT (mcp-chatgpt ; ChatGPT project = dsh-glasses ; ChatGPT session = CTO) and a fresh native Codex subagent invocation. Two PASSes are preferred, not mandatory. PASS + UNAVAILABLE, UNAVAILABLE + PASS, or UNAVAILABLE + UNAVAILABLE satisfy the reviewer portion of the completion gate when every non-review acceptance requirement passes and no available reviewer has a blocking finding. Any available reviewer that returns a blocking technical verdict keeps the Ticket open until resolved.",
    "Codex is an on-demand native DSH subagent, NOT a persistent Ticket worker. Every invocation is a fresh one-shot invocation that runs in this Ticket's workspace (cwd = this worktree), receives only the self-contained bounded git-grounded task (never this DSH conversation history), and returns its final result. Codex review/debug tasks must state: inspect/reason/report only; do not modify the Ticket worktree.",
  ];
}

export function bootstrapPrompt({ number, url, milestone, name, baseSha, branch, worktree, project = "dsh-glasses" }) {
  const identity = name ?? dshName({ project, milestone, number });
  const header = `You are the fresh persistent DSH session for Ticket #${number}, identity ${identity}.\n`;
  const context = [
    `- Ticket: ${url}`,
    `- Milestone: ${milestone}`,
    `- DSH identity (this session's name): ${identity}`,
    `- Dedicated branch: ${branch}`,
    `- Dedicated worktree: ${worktree}`,
    `- Admitted base SHA: ${baseSha}`,
    "",
    "Bootstrap, in order:",
    "- read AGENTS.md and docs/WORKFLOW.md at this base;",
    "- re-read the Ticket above and every linked durable authority relevant to it;",
    "- fetch origin and verify every declared blocker is complete; verify this session's identity, branch, worktree, and exact admitted base SHA;",
    "- inspect the relevant current source and tests in this worktree;",
    "- verify the supported native Codex subagent capability (`subagent_codex`, or the supported equivalent exposed by the pinned DSH deployment) is available for later debug/review use, or record a genuine provider/tool unavailability;",
  ].join("\n");
  const protocol = [
    "",
    "Mandatory protocol before and during implementation:",
    ...reviewerRules(),
    "",
    "DSH MUST continue until the Ticket completion gate (AGENTS.md section 8 / docs/WORKFLOW.md section 10) is satisfied. Do not stop merely because ChatGPT or Codex timed out, hit a usage limit, or was otherwise unavailable.",
  ].join("\n");
  const closeout = [
    "",
    "Closeout: after your final candidate is committed/pushed, the PR is prepared, and the required evidence is durable, record the durable closeout on the Ticket. If your Ticket completion gate is satisfied, also post a `ticket-complete:` marker comment on the Ticket issue with JSON {schemaVersion:1, ticket:<number>, sessionId:<identity>, head:<exact head SHA>, pr:<PR url>} so the dispatcher stops waking this session.",
  ].join("\n");
  return `${header}${context}\n${protocol}${closeout}\n`;
}

export function continuationPrompt({ number, name }) {
  return `Continue Ticket #${number} (DSH session ${name}) toward its completion gate. You are not a replacement session and must not restart from scratch. Re-check durable state and the protocol in your lingering bootstrap prompt; apply the reviewer/helper availability fallback and do not wait indefinitely on any helper. Do not stop until TicketComplete.`;
}

export function claimBody(binding) {
  return `${CLAIM_PREFIX} ${JSON.stringify({ schemaVersion: 2, ticket: binding.number, name: binding.name ?? binding.sessionId, sessionId: binding.sessionId, branch: binding.branch, worktree: binding.worktree, baseSha: binding.baseSha })}`;
}

export function voidClaimBody(binding, reason) {
  return `${VOID_PREFIX} ${JSON.stringify({ schemaVersion: 2, ticket: binding.number, name: binding.name ?? binding.sessionId, sessionId: binding.sessionId, reason })}`;
}

export function completeBody(binding, evidence = {}) {
  const head = evidence.head ?? binding.head ?? "";
  const pr = evidence.pr ?? binding.pr ?? "";
  return `${COMPLETE_PREFIX} ${JSON.stringify({ schemaVersion: 1, ticket: binding.number, sessionId: binding.sessionId, head, pr })}`;
}

export function parseClaim(body = "") {
  if (!body.startsWith(`${CLAIM_PREFIX} `)) return undefined;
  try {
    const value = JSON.parse(body.slice(CLAIM_PREFIX.length + 1));
    if (value.schemaVersion !== 1 && value.schemaVersion !== 2) return undefined;
    if (!Number.isInteger(value.ticket) || !value.sessionId || !value.branch || !value.worktree || !value.baseSha) return undefined;
    return { ...value, number: value.ticket, name: value.name ?? value.sessionId, status: "claimed" };
  } catch {
    return undefined;
  }
}

export function parseCompleteMarker(body = "") {
  if (!body.startsWith(`${COMPLETE_PREFIX} `)) return undefined;
  try {
    const value = JSON.parse(body.slice(COMPLETE_PREFIX.length + 1));
    // A completion marker is only authoritative when it names the bound DSH
    // identity AND an exact 40-character head SHA (the machine contract from
    // the accepted CTO design). A malformed marker must not retire a session:
    // it is ignored so the watchdog can keep supervising the binding.
    if (value.schemaVersion !== 1 || !Number.isInteger(value.ticket) || !value.sessionId) return undefined;
    if (typeof value.head !== "string" || !/^[0-9a-f]{40}$/i.test(value.head)) return undefined;
    return { number: value.ticket, sessionId: value.sessionId, head: value.head, pr: typeof value.pr === "string" ? value.pr : "", status: "complete" };
  } catch {
    return undefined;
  }
}

export function parseClaimMarker(body = "") {
  if (body.startsWith(`${VOID_PREFIX} `)) try {
    const value = JSON.parse(body.slice(VOID_PREFIX.length + 1));
    if ((value.schemaVersion === 1 || value.schemaVersion === 2) && Number.isInteger(value.ticket) && value.sessionId && value.reason) {
      return { number: value.ticket, name: value.name ?? value.sessionId, sessionId: value.sessionId, status: "void", reason: value.reason };
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

export function collapseCompleteMarkers(bodies) {
  const records = new Map();
  for (const body of bodies) {
    const marker = parseCompleteMarker(body);
    if (!marker) continue;
    records.set(marker.number, marker);
  }
  return [...records.values()].sort(byNumber);
}

export function stableReport(view, resources = {}, { heartbeatMs = DEFAULT_INTERVAL_MS } = {}) {
  const binding = (item) => ({
    number: item.number,
    status: item.status,
    name: item.name,
    sessionId: item.sessionId,
    branch: item.branch,
    worktree: item.worktree,
    baseSha: item.baseSha,
    validWorktree: item.validWorktree,
    sessionPersisted: item.sessionPersisted,
    live: item.live === true,
    progressing: item.progressing === true,
    recovered: item.recovered,
  });
  return {
    schemaVersion: 2,
    heartbeatMs,
    activeLimit: view.activeLimit,
    ready: view.ready.map((item) => item.number),
    running: view.running.map(binding),
    completed: view.completed.map(binding),
    blocked: view.blocked.map((item) => ({ number: item.number, blocking: [...item.blocking] })),
    capacityLimited: view.capacityLimited.map((item) => item.number),
    invalid: [...(view.invalid ?? [])].sort(byNumber).map(({ number, reason }) => ({ number, reason })),
    invalidMilestone: [...(view.invalidMilestone ?? [])].sort((a, b) => a - b),
    resolutionError: view.resolutionError ?? null,
    resources: {
      awaitsResource: [...(resources.awaitsResource ?? [])].sort((a, b) => a.number - b.number),
    },
  };
}

export function formatReport(report) {
  const lines = [
    `Ticket Dispatcher (heartbeat ${report.heartbeatMs}ms): ${report.running.length}/${report.activeLimit} active`,
    `ready: ${report.ready.join(", ") || "-"}`,
    `running: ${report.running.map((x) => `#${x.number}=${x.name ?? x.sessionId}`).join(", ") || "-"}`,
    `completed: ${report.completed.map((x) => `#${x.number}=${x.name ?? x.sessionId}`).join(", ") || "-"}`,
    `blocked: ${report.blocked.map((x) => `#${x.number}<-${x.blocking.join("+")}`).join(", ") || "-"}`,
    `capacity-limited: ${report.capacityLimited.join(", ") || "-"}`,
    `invalid: ${report.invalid.map((x) => `#${x.number}:${x.reason}`).join(", ") || "-"}`,
    `invalid-milestone: ${report.invalidMilestone.join(", ") || "-"}`,
    `resolution-error: ${report.resolutionError ?? "-"}`,
    `awaits-resource: ${report.resources.awaitsResource.map((x) => `#${x.number}:${x.resource}`).join(", ") || "-"}`,
  ];
  return `${JSON.stringify(report, null, 2)}\n${lines.join("\n")}\n`;
}
