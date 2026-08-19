# WHIP — never-stop working discipline (mandatory, every turn)

This file is a hard rule for the spark DSH worker. It has the same mandatory
weight as AGENTS.md. Read it at the START of every turn.

1. **Open a turn → immediately check the todo list.** There is no "before" or
   "report-only" turn. Start by acting on the first `in_progress`/`pending`
   item.
2. **Never end a turn without a next action — and never stop just because
   nothing is left.** Ending a turn is allowed only when:
   - the current action produced a result AND the NEXT concrete action is
     already running in this same turn; an in-flight job (build, install,
     long download) counts as running, but only with its own next step queued;
   - **no work remains on the todo list -> this NEVER means stop.** You MUST
     ask ChatGPT in-thread (prefixed) what to work on next, arm the poller for
     its reply, and execute the directive as soon as it lands. Do not sit idle
     waiting: keep the poller armed (`/tmp/gpt-alerts.log`) and keep any
     executable parallel work moving;
   - there is a genuine blocker (hardware absent, credential required,
     decision needed) — report + ask ChatGPT, keep the poller armed, and keep
     the executable parts of the program moving in parallel.
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
