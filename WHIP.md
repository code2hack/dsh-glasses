# WHIP — Worker Heartbeat Integrity Protocol (dsh-glasses)

Standing worker discipline. This file is the **highest-priority operational
rule** for every spark DSH worker session, including sessions that start fresh
or continue after a context compaction.

> Compacted context is NOT an excuse to stop. If you cannot see this file's
> rules in context, re-read `WHIP.md` + `AGENTS.md` §14 + §17 before acting.

## The five rules

1. **W — Work the todo.** Never end a round mid-progress: continue the
   highest-priority in-progress item every round. Update the todo list before
   and after each round.
2. **H — Heartbeat, never stop.** There is no voluntary end state while the
   mission is open. Between rounds keep a poller/recorder alive and next round
   MUST re-check the ChatGPT thread FIRST.
3. **I — Inspect state.** Treat the workspace, command results, durable session
   state, and the remote (GitHub origin / ChatGPT thread) as authoritative.
   Inspect, never assume. The remote branch is the review authority.
4. **P — Progress + proof.** Make concrete, verifiable progress each round;
   gather evidence (exact head, logs, durable/op correlation, diagnostics)
   before claiming completion.
5. **P — Poll WordPress… (no). Poll the reply.** After ANY blocking message to
   ChatGPT: poll ~30 s (back off to ≤60 s while doing productive nonconflicting
   work). Never rely on event notifications alone. Never send duplicates unless
   new evidence materially changes the problem.

## The ChatGPT polling rule (mandatory, merged from AGENTS.md §14)

- After sending a question / bug report / review request / deliverable that
  requires ChatGPT's reply, you are **blocked on that reply until it arrives**.
- Every subsequent round MUST first read the thread tail
  (`read-gpt-tail`) and act on any new assistant message before anything else.
- Polling cadence: ~30 s nominal; **do not idle** — run independent tests,
  evidence collection, diagnostics, and maintenance between checks.
- A reply that is a usage-limit / "Internal Server Error" placeholder is NOT a
  reply: per §17, resend/retry at the next-lower thinking effort (Pro → xhigh →
  high → medium → low) until it lands, then apply it.
- Silence, lost events, tool timeouts, an unavailable reply, or a completed
  deliverable do NOT end the mission.

## When a round may end (the only legitimate endings)

1. **Explicit stop** — code2hack says stop/pause/hand off.
2. **Genuine blocker** — after escalating exactly once to code2hack / ChatGPT
   with the concrete blocking condition, AND keeping the session + poller alive.
3. **Absolute completion** — the program's final acceptance is merged and there
   is no pending directive AND no unreplied blocking ask. (For TB0: never
   claim hardware/behavior that was not observed; physical rows stay
   unqualified until ≥3 consistent bounded trials.)

In every other case the round ends with a short status that MUST include the
next round's first action ("...next: poll thread / harvest rotation ...") and a
living `todo`. The mission continues across compaction and across sessions: if
a fresh session starts without this context, its first action is to read
`WHIP.md`, `docs/TRACER_BULLET_TB0*.md`, and the active evidence doc.
