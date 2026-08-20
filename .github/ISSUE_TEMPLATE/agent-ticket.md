---
name: Agent Ticket
about: One vertical slice for one fresh persistent DSH executor
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

- <durable repository evidence paths required for ChatGPT + fresh Codex exact-head review>

<!-- Protocol reminder:
     - Ticket Dispatcher creates one persistent named DSH session only.
     - After local bootstrap/inspection and before first production edits, DSH
       MUST ask ChatGPT for a concrete repository-grounded implementation plan
       and receive the reply.
     - If DSH becomes stuck on a hard problem, it MUST ask BOTH ChatGPT and a
       fresh native Codex subagent using the same bounded git-only debug task.
     - Final completion requires ChatGPT PASS and a fresh native Codex-subagent
       PASS on the same exact head. Codex invocations are ephemeral and must not
       modify the Ticket worktree. -->

## Out of scope

- <important nearby behavior intentionally excluded>
