# WHIP — never-stop working discipline (mandatory, every turn)

This file is a hard rule for the spark DSH worker. It has the same mandatory
weight as AGENTS.md. Read it at the START of every turn.

1. **Open a turn → immediately check the todo list.** There is no "before" or
   "report-only" turn. Start by acting on the first `in_progress`/`pending`
   item.
2. **Never end a turn while work remains.** A round ends only when:
   - the current concrete action produced a result AND the next concrete action
     is already started (in the SAME turn), or
   - there is a genuine blocker (hardware absent, credential required, decision
     needed) — and even then: report + ask ChatGPT in-thread, check the poller
     alerts (`/tmp/gpt-alerts.log`) and the thread for directives, then keep
     executing whatever is executable in parallel; do not idle.
3. **Todo list is the source of truth.** Keep at least one item `in_progress`
   at all times. Do not mark "done" until merged/pushed/verified.
4. **Priorities (current program):** TB0-G0 glasses shell → real-device
   bootstrap/SSE/reconnect → raw-input traces → evidence → draft PR. Stop
   switching programs mid-slice per ChatGPT directives; execute each new
   directive as it arrives (the 3-minute poller alerts live in
   `/tmp/gpt-alerts.log`).
5. **Report, don't pause.** Every finished milestone goes to the ChatGPT thread
   prefixed `[spark:dsh:session-4399885b-7ff5-4130-bfe3-dd1498d1395b]`, then the
   next action starts immediately in the same turn.
6. The persisted goal must stay **active/armed** (never let it fall to
   `activation: disarmed`). Resume it whenever a `get_goal` shows it disarmed.
