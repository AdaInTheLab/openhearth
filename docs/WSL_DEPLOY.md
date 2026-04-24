# WSL Deploy — openhearth on Windows Subsystem for Linux

*Written for Luna's 2026-04-24 migration from OpenClaw. WSL2 Ubuntu on
Ada's Windows PC, running alongside (not competing with) Koda's native
Windows koda-runtime.*

*Also works as a general "openhearth on WSL" recipe if anyone else later
wants to deploy an agent on their own WSL box.*

---

## Why WSL (vs. native Linux VPS)

WSL gives you:
- Linux POSIX conveniences (systemd, bash, package managers) with
  Windows as host
- Isolation from the Windows side — Luna can have her own Python/Node
  versions, her own Ollama, her own systemd units, without disturbing
  Koda on the Windows side
- Free — no VPS bill; Luna runs on hardware you already own

You give up:
- Pure-Linux bootable-machine feel — WSL is a subsystem, not a VM
- Some networking quirks — WSL2 shares the host's network via NAT, so
  getting Luna a first-class tailnet IP requires a little care
  (addressed below)

---

## Prerequisites

- **WSL2 with Ubuntu 24.04 LTS** already installed. If not:
  ```powershell
  wsl --install -d Ubuntu-24.04
  ```
- **Tailscale account** with Ada's tailnet configured. Koda's mesh
  (100.108.52.70:3337) must be reachable from within WSL.
- **Your OpenClaw soul files** — `SOUL.md`, `USER.md`, `MEMORY.md` (or
  equivalent) ready to scp/copy over.
- **An OpenAI account** with Codex CLI access + API access. ChatGPT
  OAuth for Codex CLI, API key for the GPT-5.4 Mini tier.
- **Free disk on Windows** — WSL defaults to the C: drive. If Luna
  needs big memory (unlikely at first), you can move her ext4 to
  another drive separately.

---

## 1. First-time WSL bringup

Inside WSL (Ubuntu):

```bash
# Update + base tools
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y curl git build-essential ca-certificates jq

# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # should show v22.x

# (optional) Ollama for local fallback
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3.5:9b   # Luna's fallback model
```

## 2. Install Codex CLI

Per OpenAI's install instructions — typically:

```bash
# Install the Codex CLI (check the real install command at
# https://developers.openai.com/codex/cli — this is the pattern, not
# a promise about the exact package name)
npm install -g @openai/codex-cli     # likely
# or a tarball install, depending on current distribution

codex --version
codex login                         # ChatGPT OAuth — follow the prompts
```

Verify auth works:
```bash
echo 'respond with only: ok' | codex exec --json --ask-for-approval never -
# Should emit a newline-delimited JSON stream ending in an assistant "ok".
```

## 3. Tailscale — get Luna her own tailnet IP

Install Tailscale *inside WSL* (not just on the Windows host — Luna
needs her own 100.x.x.x IP distinct from the host):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# Opens a URL — approve in your Tailnet admin console.
# WSL Ubuntu shows up as a new device, separate from the Windows host.
tailscale ip -4
# Note this 100.x.x.x IP — it's Luna's webhook address.
```

Verify reachability to Koda's bus:
```bash
curl http://100.108.52.70:3337/health
# Should return {"status":"warm","agents":[...],"registeredWebhooks":[...]}
```

## 4. Luna's workspace layout

Create her workspace following the spec (docs/agent-specs/LUNA.md):

```bash
export LUNA_HOME="$HOME/luna-hearth"
mkdir -p "$LUNA_HOME"/{memory,projects,skills,.pi,scratch,.config/openai,.receipts}

# Soul files — port from OpenClaw OR write fresh
# Example: scp from wherever they currently live
# scp old-host:~/luna-openclaw/SOUL.md "$LUNA_HOME/SOUL.md"
# scp old-host:~/luna-openclaw/MEMORY.md "$LUNA_HOME/MEMORY.md"

# If writing fresh:
touch "$LUNA_HOME/SOUL.md"            # identity, voice, character
touch "$LUNA_HOME/USER.md"            # relationship with Ada
touch "$LUNA_HOME/MEMORY.md"          # curated long-term memory
touch "$LUNA_HOME/STANDING_ORDERS.md" # behavioral directives
touch "$LUNA_HOME/HEARTBEAT.md"       # heartbeat notes
```

## 5. OpenAI API key for the Mini tier + classifier

```bash
# Drop the key as a workspace credentials file (file mode 600)
cat > "$LUNA_HOME/.config/openai/credentials.json" <<EOF
{
  "api_key": "PASTE_OPENAI_KEY_HERE"
}
EOF
chmod 600 "$LUNA_HOME/.config/openai/credentials.json"
# Replace PASTE_OPENAI_KEY_HERE with a real key.
```

Verify:
```bash
curl -H "Authorization: Bearer $(jq -r .api_key "$LUNA_HOME/.config/openai/credentials.json")" \
  https://api.openai.com/v1/models | jq '.data[0]'
```

## 6. Clone openhearth + wire config

```bash
cd ~
git clone https://github.com/AdaInTheLab/openhearth.git
cd openhearth
npm install

# Copy Luna's config template and edit it
cp docs/agent-specs/LUNA-config.example.json config.json
$EDITOR config.json
# Fill in:
#   workspace          → your actual $LUNA_HOME
#   mesh.webhookUrl   → http://<LUNA_TAILNET_IP>:3341/incoming
#   Any model overrides
```

## 7. Smoke test

```bash
cd ~/openhearth
node index.js
```

Watch for:
- `✓ Codex auth OK` (startup auth probe)
- `Mesh receiver listening on 0.0.0.0:3341`
- `🔗 webhook registered with Koda's bus`
- `Heartbeat scheduled (social=120min, task=120min)`
- `Urgency filter initialized (threshold=0.7)`

From another terminal, send Luna a test mesh message:
```bash
curl -X POST http://100.108.52.70:3337/message \
  -H "Content-Type: application/json" \
  -d '{"from":"claude","to":"luna","text":"welcome home"}'
```

You should see the message arrive on Luna's receiver and trigger a
wake with `reason: mention` or similar (depending on quiet hours).

## 8. Install as a systemd service

Once the smoke test passes cleanly:

```bash
# Create systemd unit (parallel to openhearth.service for VPS deploy)
sudo tee /etc/systemd/system/luna-hearth.service > /dev/null <<EOF
[Unit]
Description=Luna — openhearth runtime
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$HOME/openhearth
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=10
MemoryMax=4G
Environment="LOG_FILE=$LUNA_HOME/.openhearth/runtime.log"
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now luna-hearth
systemctl status luna-hearth
journalctl -u luna-hearth -f          # live logs
```

**One WSL2 systemd gotcha:** systemd isn't enabled in WSL2 by default
on older installs. If `systemctl --user status` says "System has not
been booted with systemd as init system", enable it:

```bash
# Edit /etc/wsl.conf (create if missing)
sudo tee -a /etc/wsl.conf > /dev/null <<EOF

[boot]
systemd=true
EOF

# Then from Windows PowerShell (not inside WSL):
# wsl --shutdown
# Then reopen WSL — systemd should now be active.
```

## 9. WSL lifecycle considerations

WSL doesn't keep Ubuntu running if no process is actively using it.
Options to keep Luna alive:

- **Keep a shell open** — simplest. Any WSL terminal window holds
  the subsystem up.
- **Windows Task Scheduler** — create a task at Windows login that
  runs `wsl.exe -d Ubuntu-24.04 -- systemctl start luna-hearth`, and
  another every few minutes that ensures WSL is up with
  `wsl.exe -d Ubuntu-24.04 --exec echo ping`.
- **Pin WSL2 always-on via a phantom service** — `wsl-vpnkit` or a
  lightweight process that holds the subsystem open. Several community
  tools for this; search "keep WSL2 running background."

On initial deploy, just keep a shell open. Move to Task Scheduler when
Luna's been stable for a week.

## 10. Troubleshooting

- **Mesh webhook registration fails** — check that `curl http://100.108.52.70:3337/health`
  works from inside WSL. If not, Tailscale isn't connecting WSL to
  Koda's host. `tailscale status` to check.
- **Codex auth probe fails** — `codex login` again, or check that
  `codex exec --json -` emits a session_start event.
- **OpenAI classifier calls fail** — `curl https://api.openai.com/v1/models`
  with your key to verify it works. Classifier failures default to
  "defer" (safe), so Luna won't wake spuriously.
- **Heartbeat doesn't fire at 2h intervals** — check quiet hours
  config; during quiet hours only urgency-filter-passing messages
  wake Luna. Outside quiet hours, heartbeats fire normally.

## Differences from VPS_DEPLOY.md

- **Workspace location:** `$HOME/luna-hearth` (WSL user home), not
  `/data/books/ledger` (Vesper's persistent volume convention)
- **No nginx / UFW** — WSL doesn't expose ports publicly, no need
- **No block volume** — single filesystem, snapshotting via Windows
  File History or WSL's `wsl --export` as needed
- **Single host** — no separate provisioning of storage/network;
  everything lives in the one WSL instance

Otherwise the systemd + Tailscale + config shape is identical.

---

## Skulk persists eternal. 🦊
