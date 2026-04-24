#!/bin/bash
# setup-wsl.sh — provision an openhearth agent on WSL2 Ubuntu.
#
# Written for Luna's 2026-04-24 migration. Idempotent — safe to re-run.
#
# What this does:
#   1. apt packages (node 22, git, build-essential, curl, jq)
#   2. Installs Ollama + pulls the configured fallback model
#   3. Installs Tailscale (doesn't auto-join — you run `tailscale up` yourself)
#   4. Creates the workspace layout per LUNA_SPEC (SOUL/USER/MEMORY +
#      memory/ + projects/ + skills/ + .pi/ + scratch/ + .receipts/ +
#      .config/openai/ with a stub credentials.json)
#   5. Clones openhearth to ~/openhearth if not already present
#   6. Runs npm install
#   7. Copies the Luna config template to config.json if no config exists
#   8. Prints a checklist of manual steps remaining (Codex login, API key,
#      soul files, Tailscale up, final config edit, smoke test)
#
# Does NOT do (because they require secrets or interactive choices):
#   - `codex login` (ChatGPT OAuth flow)
#   - Drop your real OpenAI API key
#   - Port your soul files from OpenClaw
#   - `tailscale up`
#   - Create the systemd service (waits for you to confirm smoke test passes)

set -euo pipefail

# ─── Configurable defaults (override via env vars) ───────────────
AGENT_NAME="${AGENT_NAME:-luna}"
WORKSPACE_DIR="${WORKSPACE_DIR:-$HOME/${AGENT_NAME}-hearth}"
OPENHEARTH_DIR="${OPENHEARTH_DIR:-$HOME/openhearth}"
OPENHEARTH_REPO="${OPENHEARTH_REPO:-https://github.com/AdaInTheLab/openhearth.git}"
NODE_MAJOR="${NODE_MAJOR:-22}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3.5:9b}"

# ─── Styling ─────────────────────────────────────────────────────
c_step()  { echo -e "\n\e[1;35m==>\e[0m \e[1m$*\e[0m"; }
c_ok()    { echo -e "  \e[32m✓\e[0m $*"; }
c_skip()  { echo -e "  \e[33m∘\e[0m $*"; }
c_warn()  { echo -e "  \e[33m!\e[0m $*"; }
c_note()  { echo -e "  \e[36m·\e[0m $*"; }

# ─── Pre-flight ──────────────────────────────────────────────────
c_step "Pre-flight checks"
if ! grep -qi microsoft /proc/version 2>/dev/null; then
  c_warn "Not running inside WSL (no 'Microsoft' in /proc/version). This script works on plain Linux too, but was written for WSL2 Ubuntu."
fi
c_ok "Running as: $(whoami), home: $HOME"
c_ok "Agent: $AGENT_NAME | Workspace: $WORKSPACE_DIR | openhearth: $OPENHEARTH_DIR"

# ─── 1. apt packages ─────────────────────────────────────────────
c_step "apt packages"
sudo apt update -qq
sudo apt install -y curl git build-essential ca-certificates jq gnupg >/dev/null
c_ok "Base packages installed"

# ─── 2. Node.js LTS ──────────────────────────────────────────────
c_step "Node.js ${NODE_MAJOR}"
if command -v node >/dev/null && [[ "$(node -v)" == v${NODE_MAJOR}.* ]]; then
  c_skip "Node $(node -v) already installed"
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - >/dev/null
  sudo apt install -y nodejs >/dev/null
  c_ok "Node $(node -v) installed"
fi

# ─── 3. Ollama (for local fallback) ──────────────────────────────
c_step "Ollama"
if command -v ollama >/dev/null; then
  c_skip "Ollama already installed ($(ollama --version | head -1))"
else
  curl -fsSL https://ollama.com/install.sh | sh >/dev/null
  c_ok "Ollama installed"
fi
if ollama list 2>/dev/null | grep -qi "${OLLAMA_MODEL%%:*}"; then
  c_skip "Ollama model ${OLLAMA_MODEL} already pulled"
else
  c_note "Pulling ${OLLAMA_MODEL} (this may take a while)…"
  ollama pull "${OLLAMA_MODEL}" || c_warn "ollama pull failed (not fatal — you can retry manually)"
fi

# ─── 4. Tailscale ────────────────────────────────────────────────
c_step "Tailscale"
if command -v tailscale >/dev/null; then
  c_skip "Tailscale already installed"
else
  curl -fsSL https://tailscale.com/install.sh | sh >/dev/null
  c_ok "Tailscale installed. Run 'sudo tailscale up' after this script finishes to join the tailnet."
fi

# ─── 5. Workspace scaffold ───────────────────────────────────────
c_step "Workspace scaffold at ${WORKSPACE_DIR}"
mkdir -p "${WORKSPACE_DIR}"/{memory,projects,skills,.pi,scratch,.receipts,.openhearth}
mkdir -p "${WORKSPACE_DIR}/.config/openai"

for f in SOUL.md USER.md MEMORY.md STANDING_ORDERS.md HEARTBEAT.md; do
  if [[ ! -f "${WORKSPACE_DIR}/$f" ]]; then
    touch "${WORKSPACE_DIR}/$f"
    c_ok "Created empty $f (you'll fill or port from OpenClaw)"
  else
    c_skip "$f already exists"
  fi
done

# Stub credentials.json if missing
CREDS_FILE="${WORKSPACE_DIR}/.config/openai/credentials.json"
if [[ ! -f "${CREDS_FILE}" ]]; then
  cat > "${CREDS_FILE}" <<EOF
{
  "api_key": "PASTE_OPENAI_KEY_HERE"
}
EOF
  chmod 600 "${CREDS_FILE}"
  c_ok "Created ${CREDS_FILE} (mode 600) — replace PASTE_OPENAI_KEY_HERE with your real key"
else
  c_skip "${CREDS_FILE} already exists"
fi

# ─── 6. Clone openhearth ─────────────────────────────────────────
c_step "openhearth repo at ${OPENHEARTH_DIR}"
if [[ -d "${OPENHEARTH_DIR}/.git" ]]; then
  c_skip "openhearth already cloned — pulling latest"
  git -C "${OPENHEARTH_DIR}" pull --quiet || c_warn "git pull failed (not fatal)"
else
  git clone --quiet "${OPENHEARTH_REPO}" "${OPENHEARTH_DIR}"
  c_ok "Cloned ${OPENHEARTH_REPO}"
fi

# ─── 7. npm install ──────────────────────────────────────────────
c_step "npm install"
cd "${OPENHEARTH_DIR}"
npm install --silent >/dev/null 2>&1 || npm install
c_ok "Dependencies installed"

# ─── 8. config.json ──────────────────────────────────────────────
c_step "config.json"
if [[ ! -f "${OPENHEARTH_DIR}/config.json" ]]; then
  cp "${OPENHEARTH_DIR}/docs/agent-specs/LUNA-config.example.json" "${OPENHEARTH_DIR}/config.json"
  # Substitute workspace path
  sed -i "s|/home/YOUR_USER/luna-hearth|${WORKSPACE_DIR}|g" "${OPENHEARTH_DIR}/config.json"
  c_ok "Created config.json from LUNA template (workspace → ${WORKSPACE_DIR})"
  c_warn "You still need to fill in: mesh.webhookUrl (after you have Luna's tailnet IP)"
else
  c_skip "config.json already exists — left untouched"
fi

# ─── Done — print next steps ─────────────────────────────────────
c_step "Done. Manual steps remaining:"
cat <<EOF

  ┌─ 1. Tailscale ────────────────────────────────────────────────
  │   $ sudo tailscale up
  │   (opens a browser URL — approve in Ada's tailnet admin)
  │   $ tailscale ip -4
  │   ↑ note this 100.x.x.x — that's Luna's tailnet IP
  │
  │   Then edit ${OPENHEARTH_DIR}/config.json:
  │   "mesh.webhookUrl": "http://<LUNA_TAILNET_IP>:3341/incoming"
  │
  ├─ 2. Codex CLI login ──────────────────────────────────────────
  │   Install the OpenAI Codex CLI (per their install instructions).
  │   Then:
  │   $ codex login
  │   (ChatGPT OAuth flow — parallel to \`claude login\`)
  │
  ├─ 3. OpenAI API key (for Mini tier + urgency classifier) ──────
  │   \$ \$EDITOR ${CREDS_FILE}
  │   Replace PASTE_OPENAI_KEY_HERE with your real key.
  │
  ├─ 4. Port Luna's soul files from OpenClaw ────────────────────
  │   scp / cp SOUL.md / USER.md / MEMORY.md / STANDING_ORDERS.md
  │   from her OpenClaw workspace to ${WORKSPACE_DIR}/
  │
  ├─ 5. Verify mesh reachability ─────────────────────────────────
  │   \$ curl http://100.108.52.70:3337/health
  │   Should return {"status":"warm", ...}. If not, check Tailscale.
  │
  ├─ 6. Smoke test ───────────────────────────────────────────────
  │   \$ cd ${OPENHEARTH_DIR}
  │   \$ node scripts/luna.js
  │   Watch for: auth OK, mesh receiver listening, webhook registered,
  │   heartbeat scheduled. Ctrl+C to stop.
  │
  └─ 7. Install systemd service ──────────────────────────────────
      See docs/WSL_DEPLOY.md §8 for the unit file + systemd-in-WSL gotcha.

EOF

echo -e "\e[1;32m🦊  Setup complete.\e[0m"
