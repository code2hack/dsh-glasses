---
name: Agent Ticket
about: One vertical slice for one persistent Ticket DSH executor
labels: ready-for-agent
---

## Milestone

M1

## What to build

<one observable end-to-end behavior>

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Blocked by

- None

## Gate

`autonomous`

<!-- Or replace with the exact human-required action/decision. -->

## Design sources

- `SPEC.md` §...
- <accepted ADR / approved design artifact, if any>

## Validation

- <required automated checks>
- <required runtime/device checks, if any>

## Evidence

- <durable repository evidence paths required for implementation/review>

<!-- Workflow reminder:
     - Project Supervisor DSH admits one persistent named Ticket DSH per Ticket.
     - Runtime expert identities are supplied by the project owner to the
       Supervisor and propagated into Ticket DSH bootstrap; do not hard-code
       ChatGPT session identifiers or Project Codex thread IDs in Tickets.
     - Before first production edits, Ticket DSH MUST obtain a detailed ordered
       implementation + validation to-do list from ChatGPT first. If ChatGPT is
       objectively unavailable, use the persistent Project Codex thread. Ticket
       DSH may self-plan only if BOTH project experts are unavailable.
     - After every completed to-do item, Ticket DSH MUST checkpoint progress to
       ChatGPT first; Project Codex is second-line escalation only.
     - Never ask ChatGPT and Project Codex concurrently for the same interaction.
     - After three unsuccessful ChatGPT loops for the same unresolved chain,
       escalate that chain to Project Codex instead of starting ChatGPT loop 4.
     - Final review is ChatGPT-first. ChatGPT PASS ends the reviewer gate; Project
       Codex is used only on ChatGPT unavailability or valid three-loop escalation.
     - Project Codex is one project-long persistent thread reached through Codex
       app-server, not `subagent_codex`, and helper requests must be non-mutating.
     - Ticket DSH implements/tests/proves; Supervisor DSH orchestrates; Project
       Codex and ChatGPT provide expert guidance/review. -->

## Out of scope

- <important nearby behavior intentionally excluded>
