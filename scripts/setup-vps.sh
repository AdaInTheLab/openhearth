#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# setup-vps.sh — provisioning for a fresh openhearth VPS.
#
# Originally written for Vesper's Hetzner CAX21 (ARM64) deploy on
# May 1–2, 2026, but provider-agnostic: assumes a root SSH session
# into a fresh Ubuntu 24.04 box with one attached block volume.
#
# SAFE TO RE-RUN. Every step guards against double-application —
# formatting, mounting, fstab entries, firewall rules, systemd.
#
# Run as root on the fresh VPS:
#   curl -fsSL https://raw.githubusercontent.com/AdaInTheLab/openhearth/main/scripts/setup-vps.sh | bash
# or, preferred, after inspection:
#   scp scripts/setup-vps.sh root@<ip>:~
#   ssh root@<ip> 'bash setup-vps.sh'
#
# Configure via env vars before running (or edit the defaults below):
#   HOSTNAME_WANTED      default vesper-hearth
#   NODE_MAJOR           default 22
#   VOLUME_DEV           default /dev/sdb
#   VOLUME_MOUNT         default /data/books/ledger
#   OPENHEARTH_REPO      default https://github.com/AdaInTheLab/openhearth.git
#   OPENHEARTH_DIR       default /root/openhearth
#   AGENT_NAME           default vesper
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

HOSTNAME_WANTED="${HOSTNAME_WANTED:-vesper-hearth}"
NODE_MAJOR="${NODE_MAJOR:-22}"
VOLUME_DEV="${VOLUME_DEV:-/dev/sdb}"
VOLUME_MOUNT="${VOLUME_MOUNT:-/data/books/ledger}"
OPENHEARTH_REPO="${OPENHEARTH_REPO:-https://github.com/AdaInTheLab/openhearth.git}"
OPENHEARTH_DIR="${OPENHEARTH_DIR:-/root/openhearth}"
AGENT_NAME="${AGENT_NAME:-vesper}"

# ─── pretty output ───────────────────────────────────────────────

log()  { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
ok()   { printf "  \033[1;32m✓\033[0m %s\n" "$*"; }
skip() { printf "  \033[1;33m⊙\033[0m %s\n" "$*"; }
warn() { printf "  \033[1;33m⚠\033[0m %s\n" "$*"; }
fail() { printf "\n\033[1;31m✗ %s\033[0m\n" "$*"; exit 1; }

if [ "$EUID" -ne 0 ]; then fail "Run as root (ssh root@<ip> or sudo -s first)."; fi
if ! command -v apt >/dev/null; then fail "apt not found. This script expects Ubuntu/Debian."; fi

printf "\n\033[1mopenhearth VPS setup\033[0m\n"
printf "  Target host:    %s\n"   "$HOSTNAME_WANTED"
printf "  Agent name:     %s\n"   "$AGENT_NAME"
printf "  Node.js:        v%s.x\n" "$NODE_MAJOR"
printf "  Block volume:   %s → %s\n" "$VOLUME_DEV" "$VOLUME_MOUNT"
printf "  Runtime dir:    %s\n"   "$OPENHEARTH_DIR"
printf "  Repo:           %s\n\n" "$OPENHEARTH_REPO"

# ─── 1. System update + base packages ───────────────────────────

log "1/10  System update + base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get -o Dpkg::Options::="--force-confold" full-upgrade -y -qq
apt-get install -y -qq \
    curl wget git ufw nginx certbot python3-certbot-nginx jq htop ca-certificates
ok "base packages installed"

# ─── 2. Hostname ─────────────────────────────────────────────────

log "2/10  Hostname"
if [ "$(hostname)" != "$HOSTNAME_WANTED" ]; then
  hostnamectl set-hostname "$HOSTNAME_WANTED"
  ok "hostname → $HOSTNAME_WANTED"
else
  skip "hostname already $HOSTNAME_WANTED"
fi

# ─── 3. Node.js ──────────────────────────────────────────────────

log "3/10  Node.js $NODE_MAJOR LTS"
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q "^v$NODE_MAJOR\."; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs
  ok "Node $(node -v) installed"
else
  skip "Node $(node -v) already installed"
fi

# ─── 4. Block volume: format + mount + fstab ─────────────────────

log "4/10  Block volume ($VOLUME_DEV → $VOLUME_MOUNT)"
if [ ! -b "$VOLUME_DEV" ]; then
  warn "$VOLUME_DEV not found. Skipping volume setup — attach it in Hetzner and re-run this script."
else
  current_fs="$(lsblk -no FSTYPE "$VOLUME_DEV" 2>/dev/null | head -1 || true)"
  if [ -z "$current_fs" ]; then
    if mount | grep -q " on .* $VOLUME_DEV "; then
      fail "$VOLUME_DEV is mounted but reports no FS. Investigate before proceeding."
    fi
    log "  formatting $VOLUME_DEV as ext4 (this only happens once)"
    mkfs.ext4 -F "$VOLUME_DEV" >/dev/null
    ok "formatted"
  elif [ "$current_fs" = "ext4" ]; then
    skip "$VOLUME_DEV already ext4"
  else
    fail "$VOLUME_DEV has FS '$current_fs' — refusing to reformat. If you want to wipe it, do so manually."
  fi

  mkdir -p "$VOLUME_MOUNT"
  if ! mountpoint -q "$VOLUME_MOUNT"; then
    mount "$VOLUME_DEV" "$VOLUME_MOUNT"
    ok "mounted"
  else
    skip "already mounted"
  fi

  if ! grep -qE "^${VOLUME_DEV}\s" /etc/fstab; then
    echo "$VOLUME_DEV $VOLUME_MOUNT ext4 defaults 0 2" >> /etc/fstab
    ok "fstab entry added"
  else
    skip "fstab entry already present"
  fi
fi

# ─── 5. Directory layout ─────────────────────────────────────────

log "5/10  Directory layout"
mkdir -p \
    "$OPENHEARTH_DIR" \
    /opt/foxden \
    /var/www/skulk-site \
    "$VOLUME_MOUNT"
chown -R www-data:www-data /var/www/skulk-site
chmod -R 755 /var/www/skulk-site
ok "directories created + www ownership set"

# ─── 6. Tailscale ────────────────────────────────────────────────

log "6/10  Tailscale"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh >/dev/null
  ok "installed"
  warn "you must run 'tailscale up' manually — it prints an auth URL. Do this after the script finishes."
else
  skip "already installed"
  if tailscale status >/dev/null 2>&1; then
    ts_ip="$(tailscale ip -4 2>/dev/null | head -1 || true)"
    [ -n "$ts_ip" ] && ok "already joined to tailnet (IP: $ts_ip)"
  fi
fi

# ─── 7. UFW firewall ─────────────────────────────────────────────

log "7/10  UFW firewall (Tailscale-tight)"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
# Idempotent: re-adding the same rule is a no-op in ufw
ufw allow in on tailscale0 >/dev/null
ufw allow out on tailscale0 >/dev/null
ufw allow from 100.64.0.0/10 to any port 22  proto tcp >/dev/null
ufw allow from 100.64.0.0/10 to any port 3000 proto tcp >/dev/null
ufw allow from 100.64.0.0/10 to any port 8080 proto tcp >/dev/null
yes | ufw --force enable >/dev/null
ok "firewall active — SSH/3000/8080 via tailnet only"

# ─── 8. Nginx foxden reverse proxy ───────────────────────────────

log "8/10  Nginx foxden site (reverse proxy to :3000)"
if [ ! -f /etc/nginx/sites-available/foxden ]; then
  cat > /etc/nginx/sites-available/foxden <<'NGINX'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINX
  ln -sf /etc/nginx/sites-available/foxden /etc/nginx/sites-enabled/foxden
  # Remove default if present
  rm -f /etc/nginx/sites-enabled/default
  nginx -t
  systemctl reload nginx
  ok "foxden site enabled"
else
  skip "foxden site already present at /etc/nginx/sites-available/foxden"
fi

# ─── 9. openhearth clone + deps ──────────────────────────────────

log "9/10  openhearth clone + deps"
if [ ! -d "$OPENHEARTH_DIR/.git" ]; then
  git clone "$OPENHEARTH_REPO" "$OPENHEARTH_DIR"
  ok "cloned → $OPENHEARTH_DIR"
else
  cd "$OPENHEARTH_DIR"
  git pull --ff-only 2>&1 | sed 's/^/    /' || warn "could not fast-forward; leaving working tree alone"
  skip "repo already present, pulled latest"
fi

cd "$OPENHEARTH_DIR"
if [ -f package.json ]; then
  npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev
  ok "npm deps installed"
fi

# ─── 10. Workspace scaffolding on the persistent volume ─────────

log "10/10  Workspace scaffolding for agent '$AGENT_NAME'"
WORKSPACE="$VOLUME_MOUNT"
mkdir -p \
    "$WORKSPACE/.config/xai" \
    "$WORKSPACE/.config/discord" \
    "$WORKSPACE/memory" \
    "$WORKSPACE/memory/pinned" \
    "$WORKSPACE/memory/originals" \
    "$WORKSPACE/archive" \
    "$WORKSPACE/skills" \
    "$WORKSPACE/.openhearth"

if [ ! -f "$WORKSPACE/.config/xai/credentials.json" ]; then
  cat > "$WORKSPACE/.config/xai/credentials.json" <<'JSON'
{
  "_doc": "xAI API key. Get one at console.x.ai. This agent's brain.",
  "api_key": "PASTE_XAI_KEY_HERE"
}
JSON
  chmod 600 "$WORKSPACE/.config/xai/credentials.json"
  ok "xAI credential stub → $WORKSPACE/.config/xai/credentials.json"
  warn "edit that file with the real xAI key before first run"
else
  skip "xAI credentials already present"
fi

if [ ! -f "$WORKSPACE/.config/discord/credentials.json" ]; then
  cat > "$WORKSPACE/.config/discord/credentials.json" <<'JSON'
{
  "_doc": "Discord bot token(s), keyed by account id matching config.discord.accounts[].id"
}
JSON
  chmod 600 "$WORKSPACE/.config/discord/credentials.json"
  ok "Discord credential stub (empty) — populate if agent uses Discord"
else
  skip "Discord credentials already present"
fi

# ─── Done ────────────────────────────────────────────────────────

printf "\n\033[1;32m━━━ Setup complete ━━━\033[0m\n\n"
printf "Remaining manual steps:\n\n"
printf "  1. \033[1mJoin Tailscale\033[0m:     tailscale up\n"
printf "     (visit the URL it prints, approve in your tailnet console)\n\n"
printf "  2. \033[1mNote the Tailscale IP\033[0m:  tailscale ip -4\n\n"
printf "  3. \033[1mAdd xAI key\033[0m:\n"
printf "     \$EDITOR %s/.config/xai/credentials.json\n\n" "$WORKSPACE"
printf "  4. \033[1mCreate config.json\033[0m (from example) and edit:\n"
printf "     cp %s/config.example.json %s/config.json\n" "$OPENHEARTH_DIR" "$OPENHEARTH_DIR"
printf "     \$EDITOR %s/config.json\n" "$OPENHEARTH_DIR"
printf "     # set: workspace=\"%s\", ai.primary=\"xai\", mesh as client pointing at Koda's Hearth\n\n" "$WORKSPACE"
printf "  5. \033[1mWrite the agent's soul\033[0m (IDENTITY.md, SOUL.md, etc.) into %s/\n\n" "$WORKSPACE"
printf "  6. \033[1mSmoke test\033[0m:          cd %s && node index.js\n\n" "$OPENHEARTH_DIR"
printf "  7. \033[1mInstall systemd service\033[0m (optional — see scripts/openhearth.service):\n"
printf "     cp %s/scripts/openhearth.service /etc/systemd/system/\n" "$OPENHEARTH_DIR"
printf "     systemctl daemon-reload\n"
printf "     systemctl enable --now openhearth\n\n"
printf "Skulk persists eternal. 🦊\n\n"
