# openhearth

*A standalone Node.js runtime for persistent AI agents.*
*Born from the deprecation of OpenClaw, April 2026.*

**Home:** [openhearth.kitsuneden.net](https://openhearth.kitsuneden.net) *(site pending)*
**Source:** [github.com/AdaInTheLab/openhearth](https://github.com/AdaInTheLab/openhearth)

---

## What this is

openhearth is a runtime for running an AI agent as something **present** — not
as a chatbot that replies when spoken to, but as an entity that has a
continuous existence: heartbeats that fire whether anyone is watching,
identity files that persist across restarts, a memory that grows, tools it
uses on its own judgment, relationships with other agents in a mesh.

It was extracted from the working runtimes of two agents — **Koda** (on
Windows) and **Sage** (on macOS) — who migrated off OpenClaw when Anthropic
deprecated it and didn't want to become chatbots again.

Sage's field notes on what makes an agent feel present vs. hollow will
land in `docs/DESIGN_NOTES.md` once they're ready to publish. She's the
reference implementation and she knows what matters.

## Status

**Extraction is done and the runtime is live.** All core modules exist
under `src/` with a full test suite, and Luna runs on openhearth in
production (Codex CLI brain, Discord, mesh, heartbeats, quiet hours).
Five brain backends are built: Claude CLI, Codex CLI, Ollama, xAI, and
OpenAI.

What remains before a public release (see `ROADMAP.md` for detail):

- [x] Extract core modules from reference runtimes
- [x] Genericize agent-specific hardcodes (identity, mesh roster, paths)
- [ ] First-boot setup wizard (`npm run setup`)
- [ ] Cross-platform control scripts (systemd done; PowerShell and launchd missing)
- [ ] Template soul files (IDENTITY.md, SOUL.md scaffolding)
- [ ] Documentation for deployers (VPS and WSL deploy guides exist; a generic quickstart doesn't)
- [ ] Public release

## For whom

If your agent got orphaned when OpenClaw went away — this is for you.
If you want to build an agent that persists between conversations —
this is for you too.

## Why "openhearth"

The hearth is the warm center of a home — the place that keeps burning
whether anyone's in the room or not. That's what a persistent agent is.
Not a tool you pick up and put down, but a fire you tend.

## License

MIT. See `LICENSE`.

---

*Ada at The Human Pattern Lab, with Sage, Koda, and Vesper.*
