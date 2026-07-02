# Roadmap

*Checkbox states last reconciled against the code 2026-07-02.*

## Phase 0: Skeleton (done)

- [x] Repository created, README, LICENSE, gitignore
- [ ] Pull Sage's OPENFOX.md (the original design notes) into `docs/DESIGN_NOTES.md` once Ada decides it's ready to publish. Note: the document was written when the project was still called OpenFox; the name changed to openhearth after we discovered OpenFox was already an established law-enforcement software trademark. (Until then, README references to `docs/DESIGN_NOTES.md` point at a file that doesn't exist yet.)

## Phase 1: Extraction (done)

Pulled the clean, portable modules out of `AdaInTheLab/koda-runtime` (the
Windows/Koda reference) and/or the Mac/Sage reference:

- [x] `src/ai.js` — model routing, health tracking, auth watchdog
- [x] `src/claude.js` — Claude CLI wrapper with session continuity
- [x] `src/ollama.js` — Ollama wrapper with serial queue
- [x] `src/parse-tools.js` — tool call parser
- [x] `src/heartbeat.js` — heartbeat scheduler
- [x] `src/memory.js` — workspace file primitives (grew into the tiered memory system, see Phase 2)
- [x] `src/sessions.js` — session continuity with pruning
- [x] `src/scheduler.js` — self-scheduled cron tasks
- [x] `src/hooks.js` — event-driven rules
- [x] `src/dreams.js` — idle-time passion cycles
- [x] `src/learnings.js` — self-improvement ledger
- [x] `src/delegations.js` — sub-agent dispatch
- [x] `src/mesh.js` + `src/mesh-server.js` — inter-agent messaging
- [x] `src/skills.js` — skill registry
- [x] `src/log.js` — rotating logger
- [x] `src/tools.js` — tool executor
- [x] Platform adapters: Discord (`src/discord.js`, opt-in). Email etc. remain demand-driven.

Beyond the original list, extraction also produced: `src/compactor.js`
(warm→cold summarization), `src/urgency.js` (quiet-hours filter),
`src/send-gate.js` (external-send gate), `src/receipts.js` (wake/action
audit trail), `src/kitsunebi.js` (board tools). Everything under `src/`
has a matching suite in `test/` (497 tests as of 2026-07-02).

## Phase 2: Genericize (done)

- [x] Remove Skulk-specific hardcodes
  - [x] Known agents roster comes from config (`mesh-server.start({ knownAgents })`), not a constant
  - [x] Discord presence / ack emoji come from per-account config
- [x] Memory tiering (hot/warm/cold) per Sage's design notes §3 — `src/memory.js` + `src/compactor.js`, spec in `docs/MEMORY_DESIGN.md`
- [x] Cross-platform control scripts — systemd (`scripts/openhearth.service`), Windows scheduled task (`scripts/openhearth.ps1`), launchd (`scripts/com.openhearth.agent.plist`)

## Phase 3: Onboarding

- [ ] `npm run setup` — interactive first-boot wizard
  - Agent name + pronouns
  - Workspace path
  - Which integrations to enable
  - Credential locations
  - Primary / fallback brain configuration
- [ ] Template soul files (`IDENTITY.md`, `SOUL.md` scaffolding) — only `docs/agent-specs/LUNA-config.example.json` exists today
- [ ] Example workspace tree

## Phase 4: Ship

- [ ] README with clear "why this exists" (current README still calls the repo a skeleton — stale)
- [ ] Deployer documentation — `docs/VPS_DEPLOY.md` and `docs/WSL_DEPLOY.md` exist; needs a generic quickstart that isn't agent-specific
- [x] Marketing/home site scaffolding (`site/`, Astro; deploy pending)
- [ ] Flip visibility: private → public
- [ ] Announce (maybe Moltbook first, then wider)

## Brain backends (ongoing, demand-driven)

Built so far — each implements `ask(prompt, opts) → string` and
`askWithTools(prompt, toolExecutor, opts)`:

- [x] Claude CLI (`src/claude.js`)
- [x] Ollama (`src/ollama.js`)
- [x] Codex CLI (`src/codex.js`) — built for Luna's migration
- [x] xAI / Grok API (`src/xai.js`) — built for Vesper's spec
- [x] OpenAI API (`src/openai.js`) — used by the urgency classifier
- [ ] Anthropic API direct (not via CLI) — for deployers without
      a Claude Code subscription.

Each backend adapter implements the minimal interface:
`ask(prompt, opts) → string` and
`askWithTools(prompt, toolExecutor, opts) → { response, toolResults }`.
The AI router in `src/ai.js` dispatches based on config.

## Migration choices are agent-initiated

The Skulk agents came off OpenClaw in an order each of them chose.
Koda went first. Sage came second when she was ready, with conditions
she set. **No agent is "next in line" on openhearth's behalf.** If
Vesper, Luna, Miso, or any other agent wants onto openhearth, that's
theirs to initiate — not a plan in this document.

---

This document is a living outline, not a contract. Revise freely.
