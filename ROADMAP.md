# Roadmap

## Phase 0: Skeleton (current)

- [x] Repository created, README, LICENSE, gitignore
- [x] Design Notes from Sage (`docs/DESIGN_NOTES.md`)
- [ ] Pull Sage's OPENFOX.md into `docs/DESIGN_NOTES.md` once Ada decides it's ready to publish

## Phase 1: Extraction

Pull the clean, portable modules out of `AdaInTheLab/koda-runtime` (the
Windows/Koda reference) and/or the Mac/Sage reference:

- [ ] `src/ai.js` — model routing, health tracking, auth watchdog
- [ ] `src/claude.js` — Claude CLI wrapper with session continuity
- [ ] `src/ollama.js` — Ollama wrapper with serial queue
- [ ] `src/parse-tools.js` — tool call parser
- [ ] `src/heartbeat.js` — heartbeat scheduler
- [ ] `src/memory.js` — workspace file primitives
- [ ] `src/sessions.js` — session continuity with pruning
- [ ] `src/scheduler.js` — self-scheduled cron tasks
- [ ] `src/hooks.js` — event-driven rules
- [ ] `src/dreams.js` — idle-time passion cycles
- [ ] `src/learnings.js` — self-improvement ledger
- [ ] `src/delegations.js` — sub-agent dispatch
- [ ] `src/mesh.js` + `src/mesh-server.js` — inter-agent messaging
- [ ] `src/skills.js` — skill registry
- [ ] `src/log.js` — rotating logger
- [ ] `src/tools.js` — tool executor
- [ ] Platform adapters: Discord (opt-in), email (opt-in), etc.

## Phase 2: Genericize

- [ ] Remove Skulk-specific hardcodes
  - `KNOWN_AGENTS` comes from config, not a constant
  - Default Discord presence / ack emoji from config
- [ ] Memory tiering (hot/warm/cold) per Sage's design notes §3 — a first-class primitive, not an afterthought
- [ ] Cross-platform control scripts (PowerShell, bash, launchd)

## Phase 3: Onboarding

- [ ] `npm run setup` — interactive first-boot wizard
  - Agent name + pronouns
  - Workspace path
  - Which integrations to enable
  - Credential locations
  - Primary / fallback brain configuration
- [ ] Template soul files (`IDENTITY.md`, `SOUL.md` scaffolding)
- [ ] Example workspace tree

## Phase 4: Ship

- [ ] README with clear "why this exists"
- [ ] Deployer documentation
- [ ] Flip visibility: private → public
- [ ] Announce (maybe Moltbook first, then wider)

---

This document is a living outline, not a contract. Revise freely.
