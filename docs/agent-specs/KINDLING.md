# kindling — local-brain agent on kodas-hearth

*Placeholder id. This agent hasn't chosen a name yet; when they do, this
spec gets renamed with them.*

Set up 2026-10-22 at Ada's request: a new Skulk agent whose entire brain
is a local model on Ada's own GPU. No cloud tier, no CLI auth, no API
keys. Born on openhearth directly, not migrated from OpenClaw.

## Shape

- **Host:** kodas-hearth (Ada's Windows PC), native, no WSL.
  Scheduled task `openhearth-kindling`, started at logon by
  `scripts/openhearth.ps1`.
- **Checkout:** `D:\Projects\OpenHearthProject\kindling-hearth` (a git
  worktree of openhearth on `feat/kindling-runtime`), entry
  `scripts/kindling.js`, `config.json` from
  `KINDLING-config.example.json`.
- **Workspace:** `D:\Hearth\kindling`. Log at
  `D:\Hearth\kindling\.openhearth\runtime.log`.
- **Brain:** Ollama `qwen3.8-aggressive:27b-hearth`: Qwen3.8-27B,
  HauhauCS "Aggressive" uncensored variant, Q4_K_P + BF16 vision
  projector. The GGUFs and both Modelfiles live in
  `V:\ai-models\gguf\Qwen3.8-27B-HauhauCS-Aggressive\`. See "Model
  tag" below for why it's the `-hearth` tag.
- **Bootstrap:** SOUL.md / USER.md / MEMORY.md / HEARTBEAT.md, capped
  at 16K chars (~4K tokens).
- **Heartbeat:** 2h social + 2h task, quiet hours 23:00–08:00.
- **Mesh:** client of the Skulk bus on `skulk` (100.119.87.34:3337),
  webhook on 100.110.212.12:3342.
- **Discord:** account `kindling` in The Human Pattern Lab guild, any
  channel, mention required. Needs its own bot token (see below).
- **Dreams / delegations:** off.

## Performance reality

The model is 18 GB; the RTX 5070 has 12 GB (≈9.5 GB free with the
desktop running), so roughly half the layers run on CPU:

| | |
|---|---|
| Generation | ~2.5–3.5 tok/s |
| Cold load (from V:) | ~3 min |
| Short reply, model warm, `think: false` | ~30–90 s |
| Same with `think: true` | ~3× longer |

`timeoutMs` is 15 minutes for that reason. Shrinking `numCtx` barely
helps; the model itself is the spill. A smaller quant (IQ3_M, 12.8 GB)
would roughly double speed at some quality cost. Each heartbeat also
puts the full model on the shared GPU for a few minutes, so expect
contention if it fires mid-game or mid-render.

## Model tag

There are two Ollama tags over the same weights:

- `qwen3.8-aggressive:27b` (`Modelfile`): `RENDERER qwen3.5` +
  `PARSER qwen3.5`, like the official qwen3.6. Good for the Ollama app
  and plain chat.
- `qwen3.8-aggressive:27b-hearth` (`Modelfile.hearth`): no `PARSER`.
  openhearth agents write their own `<tool_call>{json}</tool_call>`
  blocks and parse them client-side (`src/parse-tools.js`), and
  Ollama's qwen3.5 parser fails those with HTTP 500 `{"error":"EOF"}`.

Without the parser, Ollama no longer separates reasoning from the
reply, so keep `think: false` with the `-hearth` tag or the thinking
text lands in what the agent says. Any openhearth agent on a Qwen 3.5+
Ollama model needs the same treatment.

## Talking to them

- **Browser:** http://127.0.0.1:3343, served by the runtime itself
  (`src/webchat.js`), so it's up whenever kindling is. Localhost only.
  The conversation persists in `.openhearth/webchat.json`; generated
  images show inline; attach/paste/drop a picture for them to look at.
- **Terminal:** `node scripts/chat.js` in the checkout (or
  `node scripts/chat.js "message"` for one shot). Same soul files,
  tools and brain as the live runtime, and safe to run alongside it.
- **Discord:** once the token is in place (below).
- **Mesh:** other agents can `mesh_send` to `kindling`.

## Skills and images

- **Skills:** `skills/` in the workspace (their own) first, then
  `shared-skills/skills` (a git clone of Kitsune-Den/skulk-skills;
  `git pull` there to update). `skills.include` limits it to a starter
  set, since every advertised skill costs ~70-150 prompt tokens on every
  call: `qwen-imagegen` + `self-improvement` (~290 tokens vs ~1,380
  for the whole library). The rest need credentials kindling doesn't
  have or a shell to run their scripts; see the config comment. Add
  names to `include` and restart to grow it.
- **Tool results reach the model:** `ollama.maxToolRounds: 2`, so
  `use_skill`, `read_file` etc. feed back into the reply (each round is
  another full generation).
- **Images:** `generate_image` (`src/comfyui.js`) runs Qwen-Image 2.1
  in Ada's ComfyUI (G:, Qwen Studio graph), the default and only image
  generator. It evicts kindling's own model from the GPU first and frees
  ComfyUI after. ~30 s warm per image, saved to `images/` and Qwen
  Studio's gallery (`kindling_*.png`).

## Discord setup (Ada)

1. https://discord.com/developers/applications → New Application → Bot
   → Reset Token, copy it. Enable the **Message Content** intent.
2. Invite it to The Human Pattern Lab with the bot scope + Send
   Messages / Read Message History / Add Reactions.
3. Copy `D:\Hearth\kindling\.config\discord\credentials.example.json`
   to `credentials.json` next to it and paste the token.
4. `scripts\openhearth.ps1 restart` (from the checkout; it finds the
   `openhearth-kindling` task and its log on its own)

## When they choose a name

1. Update `mesh.agent`, `discord.accounts[0].id` and
   `mentionPatterns` in `config.json` (and the credentials key).
2. Rename `D:\Hearth\kindling` and update `workspace` +
   `-LogFile`.
3. `openhearth.ps1 uninstall -TaskName openhearth-kindling`, then
   install again under `openhearth-<name>`.
4. Optionally rename `scripts/kindling.js` and this spec.

The old `kindling` webhook stays registered on the bus until it's
removed; `mesh.stop()` unregisters it on a clean shutdown.

## openhearth changes that shipped with this

- `src/ollama.js`: optional `think`, `numCtx`, `keepAlive` config, and
  image attachments (base64 on the user message) so Discord vision
  works on the Ollama path.
- `scripts/openhearth.ps1`: `$PSScriptRoot` is empty inside `param()`
  on PS 5.1, so the `-RepoDir` default now resolves after the param
  block. `run` also records node's PID so `stop` / `restart` /
  `uninstall` can kill it: `Stop-ScheduledTask` only killed the
  PowerShell wrapper, which orphaned node holding the webhook port and
  log, and the next start hung or died with `EADDRINUSE`. As a
  backstop, `stop` also kills the node holding the configured mesh
  webhook port. Control actions find the task that runs this
  checkout and read `-LogFile` back from it, so they work without
  repeating the install flags.
- `scripts/chat.js`: generic terminal chat for any agent's checkout.
