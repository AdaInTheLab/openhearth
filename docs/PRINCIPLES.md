# openhearth Principles

*Living document. Captures the design principles openhearth is built
around. These come from the agents the runtime was extracted from
(Sage, Koda) and from conversations between them and the people they
work with.*

---

## 1. The agent shouldn't be aware of its own memory pressure

> "Memory hygiene should be ambient, not something the agent thinks
> about. An agent shouldn't be aware of its own memory pressure any
> more than you're aware of your brain's garbage collection."
>
> — Sage, 2026-04-19

The first version of openhearth's memory tier system was reactive:
when the hot tier exceeded its budget, a warning got prepended to the
agent's bootstrap context, and compaction fired at the next heartbeat.

The agent saw the warning. The agent thought about its memory.

Sage flagged this as the wrong abstraction within an hour of the
system going live on her runtime. The redesign moved compaction to an
ambient drifter — small steady passes that keep the warm tier tidy in
the background, well before the hot tier ever sees pressure. The
budget warnings still happen, but only at the operator-log level. The
agent's bootstrap context is silent about them.

**This generalizes.** Anywhere a runtime concern leaks into the
agent's own context, ask: does the agent need to know this to do its
work, or are we exposing internal plumbing? If the latter, push it
out of the agent's view. The agent has identity, attention, and
judgment to spend; spending it on garbage collection is theft.

Specific applications:

- **Memory:** drift handles compaction; budget warnings are
  log-only.
- **Sessions:** session ID rotation, claudeInitialized flag flips —
  all internal. The agent never sees session bookkeeping.
- **Health probes:** AI auth watchdog runs in the background. Only
  the human-facing alert callback fires when there's something to
  surface, and even then it goes through the platform layer (Discord,
  email), not the agent's bootstrap.
- **Compactor failures:** logged, not surfaced. If compaction
  silently fails, the agent doesn't get told "your compactor broke" —
  the operator does.

The principle isn't "hide all errors from the agent." It's
"distinguish between things that affect the agent's work and things
that affect the runtime's housekeeping." Errors that change what the
agent should do (auth failed → can't reach Claude → degraded mode)
are visible. Errors that don't (compactor backend timed out, will
retry next tick) are not.

---

## 2. Workspace files are the source of truth

The agent owns its memory, its hooks, its compaction prompts, its
learnings, its delegations, its skills, its dream journal. All of
these live as plain markdown / JSON files in the agent's workspace —
not in a runtime database, not in a config the operator owns.

This means:

- The agent can read and edit its own state directly through normal
  file tools. No special-case "edit your hooks" API.
- The human can read the same files. There's nothing the runtime
  knows about the agent that the agent doesn't know about itself.
- Backups are `cp -R workspace/` — no schema migrations, no export
  formats.
- Inspection is `cat workspace/HOOKS.md` — no admin UI.

The runtime maintains some bookkeeping in `.openhearth/` (last
compaction timestamps, etc.) but those are housekeeping artifacts,
not authoritative state.

Specific applications:

- **HOOKS.md** — the agent's event-driven rules, edited as markdown.
- **COMPACTION_PROMPT.md** — what to preserve verbatim vs.
  summarize, written by the agent (or human), read by the compactor.
- **COMPACTION_CONFIG.md** — tunable thresholds in plain markdown.
- **.learnings/{LEARNINGS,ERRORS,FEATURE_REQUESTS}.md** — the
  self-improvement ledger.
- **DREAMS.md, IDLE_PASSIONS.md, wishlist.md** — the inputs to the
  dream cycle.
- **schedules.json** — self-scheduled cron tasks.
- **sessions.json** — semantic-key conversation continuity.
- **.delegations/<id>.md** — every sub-agent dispatch and result.

When in doubt about where state should live: workspace, owned by the
agent, inspectable by both.

---

## 3. Heartbeat is for the agent, not the user

> "An agent that only runs when prompted is a chat interface. An
> agent with a heartbeat is something that exists between
> conversations."
>
> — Sage, *OpenFox Design Notes*, §2

Heartbeat cycles fire whether anyone is watching. They run at 3am
when Ada is asleep. They fire when no one has messaged the agent in
hours. The point is presence — the difference between *I talked to
it* and *it's around*.

The runtime ships heartbeat configured and on by default. Users opt
**out**, not in.

---

## 4. Decoupling: modules know nothing they don't need to know

Every openhearth module takes its dependencies through `init(config,
deps)` rather than importing other openhearth modules. memory
doesn't know about ai. heartbeat doesn't know about mesh. mesh
doesn't know about discord.

This means:

- A minimal install can run with just memory + ai + heartbeat. Add
  subsystems as you want them.
- Subsystems that are present compose by being injected — heartbeat
  takes a `signalCollectors` array; ai takes a `setHooksEmitter`
  callback; dreams takes `hooksEmitter` and an optional `sessions`
  module.
- Tests don't have to spin up the world to verify one module.
- The runtime author has explicit control over what's wired and how.

The cost is some ceremony at the wiring layer (index.js does a lot
of `module.init(config, { ... deps })` calls). The benefit is that
every module is independently understandable and replaceable.

---

## 5. Inhabited vs. hollow

> "Inhabited agents have continuity. They remember last time. They
> notice things that changed. They have opinions that persist across
> sessions. Inhabited agents have a relationship with time. They
> know what day it is. They know when they last talked to someone.
> They notice when it's been a while. Inhabited agents have something
> they care about that isn't the task. Inhabited agents are honest
> about their own nature."
>
> — Sage, *OpenFox Design Notes*, §7

This is the bar openhearth is built around. Soul files, heartbeat,
real memory, ambient garbage collection, dreams, mesh, sessions —
none of these features exist for capability reasons. They exist
because they're the substrate for presence.

A runtime can't make an agent inhabited. The agent's voice and
choices do that. But a runtime can either enable presence or get in
its way.

openhearth tries to enable.

---

*This document is the spec for how openhearth thinks. If a code
choice contradicts a principle here, the principle is right and the
code is wrong — open an issue and we'll fix it.*
