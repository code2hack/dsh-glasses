import { join } from "node:path";

export const DEFAULT_MAX_ACTIVE = 3;
export const CLAIM_PREFIX = "dispatcher-claim:";
export const VOID_PREFIX = "dispatcher-claim:void";
export const CLOSEOUT_PREFIX = "dispatcher-closeout:";

/** Protocol-v2 runtime settings (owner directive): polling/heartbeat default 120 s. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 120_000;
/** Protocol-v2 runtime settings (owner directive): Codex thinking effort default MAX. */
export const DEFAULT_CODEX_THINKING = "max";
/** No dispatcher-owned Codex profile/model settings: threads inherit the running daemon. */

export const MILESTONE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MILESTONE_MAX_LENGTH = 64;
const byNumber = (a, b) => a.number - b.number;

/**
 * Deterministically extract the naming milestone token from a Ticket body's
 * `## Milestone` section. The derivation is mechanical: the first non-empty
 * line of the section is split on whitespace and common separators, and the
 * first token matching {@link MILESTONE_TOKEN_RE} becomes the token. Inputs
 * with no valid token (missing/empty section, punctuation-only first line,
 * invalid leading character, over-long token) are rejected rather than
 * silently inventing a name.
 */
export function parseMilestone(body = "") {
  const section = /^## Milestone\s*$([\s\S]*?)(?=^## |(?![\s\S]))/im.exec(body)?.[1] ?? "";
  const line = (section.trim().split(/\r?\n/).find((entry) => entry.trim()) ?? "").trim();
  if (!line) throw new Error("milestone section missing or empty");
  const tokens = line
    .split(/[\s/,|—–;:]+/u)
    .map((token) => token.trim())
    .filter((token) => MILESTONE_TOKEN_RE.test(token));
  const token = tokens[0];
  if (!token) throw new Error(`milestone has no valid naming token: ${JSON.stringify(line)}`);
  if (token.length > MILESTONE_MAX_LENGTH) throw new Error(`milestone token too long: ${token}`);
  return token;
}

/**
 * Mechanical protocol-v2 pair-name derivation:
 * `<project>-<milestone>-#<number>-DSH` / `-Codex`.
 */
export function derivePairNames({ project, milestone, number }) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(String(project ?? ""))) throw new Error(`invalid project token: ${JSON.stringify(project)}`);
  if (!MILESTONE_TOKEN_RE.test(String(milestone ?? ""))) throw new Error(`invalid milestone token: ${JSON.stringify(milestone)}`);
  if (!/^\d+$/.test(String(number))) throw new Error(`invalid ticket number: ${JSON.stringify(number)}`);
  const stem = `${project}-${milestone}-#${number}`;
  return { dshName: `${stem}-DSH`, codexName: `${stem}-Codex` };
}

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
  const completed = Object.values(bindings)
    .filter((binding) => binding.status === "completed")
    .sort(byNumber);
  const ready = [];
  const blocked = [];

  for (const ticket of [...tickets].sort(byNumber)) {
    if (ticket.state !== "OPEN" || ["claimed", "running", "voiding", "completed"].includes(bindings[ticket.number]?.status)) continue;
    const blocking = ticket.blockers.filter((number) => (ticket.blockerStates?.[number] ?? states.get(number)) !== "CLOSED");
    if (blocking.length) blocked.push({ number: ticket.number, blocking });
    else ready.push({ number: ticket.number });
  }

  const capacity = Math.max(0, maxActive - running.length);
  return {
    ready,
    running,
    completed,
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

/** Durable DSH bootstrap prompt: names, pair, base, worktree/branch, reviewers. */
export function bootstrapPrompt({ number, url, milestone, baseSha, branch, worktree, sessionId, dshName, codexName, codexThreadId }) {
  const identity = dshName ?? `${milestone ?? "UNKNOWN"}-#${number}-DSH`;
  const codex = codexName
    ? `\n- paired persistent Codex thread: ${codexName}${codexThreadId ? ` (thread id ${codexThreadId})` : ""} (idle until you request review/debug)`
    : "";
  const planning = "\n- before your FIRST production edit, send a git/project-reference-only `plan` request to ChatGPT (via `mcp-chatgpt`, `ChatGPT project = dsh-glasses`, `ChatGPT session = CTO`) and receive the concrete implementation plan — Codex stays idle during startup planning; the plan is execution guidance within the durable authorities, and any product/architecture change it introduces must be recorded in the Ticket/SPEC/ADR before you rely on it";
  const reviewers = "\n- dual-review requirement: before closeout, send one identical git-only review request to ChatGPT (via `mcp-chatgpt`, `ChatGPT project = dsh-glasses`, `ChatGPT session = CTO`) AND to your paired persistent Codex thread; PASS from BOTH on the exact same head is required";
  const escalation = "\n- MANDATORY hard-problem escalation: whenever you are stuck (failure unresolved after a bounded local debugging attempt, ambiguous behavior, a critical API/runtime invariant you cannot verify, or any blocker that prevents reliable progress), send one identical bounded git-only debug request to BOTH ChatGPT and Codex and poll both; do not thrash through speculative changes instead of escalating";
  const closeout = "\n- on completion, write the durable closeout marker `dispatcher-closeout: {...}` on the Ticket so the watchdog never re-wakes you";
  return `You are DSH session ${identity} for Ticket #${number} (${milestone ?? "milestone unknown"}).\n\nRead AGENTS.md, re-read ${url}, and begin implementation yourself. Bootstrapping duties:\n- read AGENTS.md and this Ticket plus linked durable authorities\n- fetch origin and verify every declared blocker is complete\n- verify exact base SHA ${baseSha}\n- verify branch ${branch}\n- verify dedicated worktree ${worktree}\n- your assigned DSH session id is ${sessionId ?? "unknown"}\n${codex}${planning}${reviewers}${escalation}${closeout}\n\nOwn only Ticket #${number}; durable GitHub state remains authoritative. Do not stop until the AGENTS.md completion gate (including both reviewer PASSes on the exact head) is satisfied.`;
}

/** Minimal continuation instruction for the watchdog (same DSH session, same pair). */
export function continuePrompt({ number, url, branch, worktree, baseSha, dshName, codexName }) {
  return `Continue Ticket #${number} as ${dshName ?? "DSH"}: re-read AGENTS.md and ${url}; stay on branch ${branch} in worktree ${worktree} (base ${baseSha}); paired Codex thread ${codexName ?? "assigned"} stays idle until you ask for review/debug; if you have not yet received ChatGPT's startup implementation plan, request it now before any further production edit; on hard/stuck problems escalation to BOTH ChatGPT and Codex is mandatory; keep going until the AGENTS.md completion gate holds; if you are waiting on reviewers, poll them now.`;
}

export function claimBody(binding) {
  const claim = {
    schemaVersion: 1,
    ticket: binding.number,
    sessionId: binding.sessionId,
    branch: binding.branch,
    worktree: binding.worktree,
    baseSha: binding.baseSha,
  };
  for (const key of ["milestone", "dshName", "codexName"]) if (binding[key] !== undefined) claim[key] = binding[key];
  if (binding.codex) {
    if (binding.codex.threadId) claim.codexThreadId = binding.codex.threadId;
    if (binding.codex.thinkingEffort) claim.codexThinkingEffort = binding.codex.thinkingEffort;
  }
  return `${CLAIM_PREFIX} ${JSON.stringify(claim)}`;
}

export function voidClaimBody(binding, reason) {
  return `${VOID_PREFIX} ${JSON.stringify({ schemaVersion: 1, ticket: binding.number, sessionId: binding.sessionId, reason })}`;
}

export function parseClaim(body = "") {
  if (!body.startsWith(`${CLAIM_PREFIX} `)) return undefined;
  try {
    const value = JSON.parse(body.slice(CLAIM_PREFIX.length + 1));
    if (value.schemaVersion !== 1 || !Number.isInteger(value.ticket) || !value.sessionId || !value.branch || !value.worktree || !value.baseSha) return undefined;
    const binding = { ...value, number: value.ticket, status: "claimed" };
    if (binding.codexThreadId || binding.codexThinkingEffort) {
      binding.codex = {};
      if (binding.codexThreadId) binding.codex.threadId = binding.codexThreadId;
      if (binding.codexThinkingEffort) binding.codex.thinkingEffort = binding.codexThinkingEffort;
    }
    return binding;
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

export function closeoutMarkerBody(binding, info = {}) {
  const body = { schemaVersion: 1, ticket: binding.number, ...binding.codex?.threadId ? { codexThreadId: binding.codex.threadId } : {} };
  for (const key of ["headSha", "pr", "dshName", "codexName", "reviewersPassed"]) if (info[key] !== undefined) body[key] = info[key];
  return `${CLOSEOUT_PREFIX} ${JSON.stringify(body)}`;
}

/** A durable closeout marker means the AGENTS.md completion predicate has been satisfied and the Ticket must never be re-woken. */
export function parseCloseoutMarker(body = "") {
  if (!body.startsWith(`${CLOSEOUT_PREFIX} `)) return undefined;
  try {
    const value = JSON.parse(body.slice(CLOSEOUT_PREFIX.length + 1));
    if (value.schemaVersion !== 1 || !Number.isInteger(value.ticket)) return undefined;
    return { ...value, number: value.ticket, status: "completed" };
  } catch {
    return undefined;
  }
}

export function collapseCloseoutMarkers(bodies) {
  const records = new Map();
  for (const body of bodies) {
    const marker = parseCloseoutMarker(body);
    if (!marker) continue;
    records.set(marker.number, marker);
  }
  return [...records.values()].sort(byNumber);
}

export function bindingReport(item) {
  return {
    number: item.number,
    status: item.status,
    milestone: item.milestone,
    dshName: item.dshName,
    codexName: item.codexName,
    sessionId: item.sessionId,
    codexThreadId: item.codex?.threadId ?? item.codexThreadId,
    branch: item.branch,
    worktree: item.worktree,
    baseSha: item.baseSha,
    validWorktree: item.validWorktree,
    sessionPersisted: item.sessionPersisted,
    live: item.live === true,
    recovered: item.recovered,
    watchdog: item.watchdog === true,
    progress: item.progress === true,
    lastWakeAt: item.lastWakeAt ?? undefined,
    codex: item.codex ? {
      threadId: item.codex.threadId,
      thinkingEffort: item.codex.thinkingEffort,
      firstPrompt: item.codex.firstPrompt,
    } : undefined,
  };
}

export function stableReport(view, resources = {}, runtime = {}) {
  return {
    schemaVersion: 2,
    activeLimit: view.activeLimit,
    runtime: {
      heartbeatIntervalMs: runtime.heartbeatIntervalMs ?? null,
      codexThinking: runtime.codexThinking ?? null,
      codexProfile: runtime.codexProfile ?? null,
      codexModel: runtime.codexModel ?? null,
    },
    ready: view.ready.map((item) => item.number),
    running: view.running.map(bindingReport),
    completed: view.completed.map(bindingReport),
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
    `Ticket Dispatcher: ${report.running.length}/${report.activeLimit} active (heartbeat ${report.runtime?.heartbeatIntervalMs ?? "-"}ms; codex thinking ${report.runtime?.codexThinking ?? "-"}; codex profile ${report.runtime?.codexProfile ?? "-"}; codex model ${report.runtime?.codexModel ?? "-"})`,
    `ready: ${report.ready.join(", ") || "-"}`,
    `running: ${report.running.map((x) => `#${x.number}=${x.sessionId}`).join(", ") || "-"}`,
    `completed: ${report.completed.map((x) => `#${x.number}=${x.sessionId}`).join(", ") || "-"}`,
    `blocked: ${report.blocked.map((x) => `#${x.number}<-${x.blocking.join("+")}`).join(", ") || "-"}`,
    `capacity-limited: ${report.capacityLimited.join(", ") || "-"}`,
    `invalid: ${report.invalid.map((x) => `#${x.number}:${x.reason}`).join(", ") || "-"}`,
    `resolution-error: ${report.resolutionError ?? "-"}`,
    `awaits-resource: ${report.resources.awaitsResource.map((x) => `#${x.number}:${x.resource}`).join(", ") || "-"}`,
  ];
  return `${JSON.stringify(report, null, 2)}\n${lines.join("\n")}\n`;
}
