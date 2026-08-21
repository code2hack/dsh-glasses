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

- <durable repository evidence paths required for planning/progress/review records>

<!-- Protocol reminder:
     - Ticket Dispatcher creates one persistent named DSH session only.
     - Before first production edits, DSH MUST obtain a detailed ordered
       implementation/validation plan + to-do list. Ask ChatGPT first. Only if
       ChatGPT is unavailable may DSH ask fresh native Codex. DSH may self-plan
       only when BOTH ChatGPT and Codex are unavailable.
     - After EVERY completed to-do item, DSH MUST report completion to the helper
       chain: ChatGPT first; Codex only if ChatGPT is unavailable or that unresolved
       chain has already escalated after three unsuccessful ChatGPT loops; both
       unavailable -> record and continue.
     - DSH NEVER requests ChatGPT and Codex in parallel for the same workflow step.
     - For a hard problem or final review, ChatGPT is always first-line. Codex is
       escalation only when ChatGPT is unavailable or the same problem/review chain
       remains unresolved after three complete ChatGPT loops.
     - If ChatGPT PASSes final exact-head review, DO NOT summon Codex.
     - Codex invocations are fresh/ephemeral and must not modify the Ticket worktree.
     - If the required helper path is unavailable, DSH may continue independently,
       but known valid blocking findings and all non-review acceptance gates remain. -->

## Out of scope

- <important nearby behavior intentionally excluded>
