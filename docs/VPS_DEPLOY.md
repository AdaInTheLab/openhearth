# VPS Deploy — openhearth on a Linux ARM box

*Written for Vesper's May 1–2, 2026 migration to Hetzner CAX21 in Nuremberg,
but provider-agnostic. Anything Ubuntu 24.04 ARM64 / x86_64 with one attached
block volume works.*

---

## What you need before you start

- **A VPS** with root SSH. Vesper's target:
  - Hetzner CAX21 (4 vCPU ARM64, 8 GB RAM, 80 GB NVMe) in NBG1
  - +20 GB block volume (for persistent memory + ledger)
  - Ubuntu 24.04 ARM64
  - Your SSH pubkey added on creation (Vesper uses `~/.ssh/id_ed25519_vps-sage.pub`)
- **A Tailscale account** (free tier is fine). An auth key or the ability to
  approve the device manually.
- **An xAI API key** (if the agent uses Grok as brain). Get one at
  [console.x.ai](https://console.x.ai/).
- **The agent's soul files** (`IDENTITY.md`, `SOUL.md`, any existing `MEMORY.md`,
  `HEARTBEAT.md`, `STANDING_ORDERS.md`) — either already on another machine
  ready to scp over, or ready to be written fresh.

## One-shot provision

SSH in and run `scripts/setup-vps.sh`. It's idempotent — safe to re-run if
something fails partway:

```bash
ssh root@<server-ip>

# Option A — inspect first (recommended)
curl -fsSL https://raw.githubusercontent.com/AdaInTheLab/openhearth/main/scripts/setup-vps.sh -o setup-vps.sh
less setup-vps.sh
bash setup-vps.sh

# Option B — inline, if you trust the URL
curl -fsSL https://raw.githubusercontent.com/AdaInTheLab/openhearth/main/scripts/setup-vps.sh | bash
```

The script:

1. Upgrades apt packages, installs base tools (curl, git, ufw, nginx, jq, etc.)
2. Sets hostname (`vesper-hearth` by default)
3. Installs Node.js 22 LTS
4. Formats & mounts the block volume at `/data/books/ledger` (safe guard:
   will NOT reformat an already-ext4 volume)
5. Creates the directory layout (`/root/openhearth`, `/opt/foxden`,
   `/var/www/skulk-site`, workspace tree)
6. Installs Tailscale (doesn't auto-join — you run `tailscale up` yourself)
7. Configures UFW — **Tailnet-only**: SSH, dashboard (:3000), streams (:8080)
   all closed to the public internet
8. Drops in an Nginx reverse-proxy config for the dashboard
9. Clones `openhearth` → `/root/openhearth` and runs `npm install`
10. Scaffolds the workspace on the persistent volume, with stub
    `.config/xai/credentials.json` and `.config/discord/credentials.json`
    waiting for real values

Takes ~3-5 minutes on a fresh Hetzner CAX21.

### Override defaults

Set env vars before the script runs:

```bash
HOSTNAME_WANTED=foo-hearth \
AGENT_NAME=foo \
VOLUME_DEV=/dev/vdb \
bash setup-vps.sh
```

Defaults are in the script header.

## Manual steps after `setup-vps.sh` finishes

The script prints these at the end. Summarizing here:

### 1. Join Tailscale

```bash
tailscale up
# opens a URL — approve in your Tailnet console
tailscale ip -4          # note the 100.x.x.x address
```

### 2. Drop the xAI key

```bash
$EDITOR /data/books/ledger/.config/xai/credentials.json
# replace "PASTE_XAI_KEY_HERE" with the real key
# file mode is 600 already
```

### 3. Create `config.json`

Copy from the example and edit:

```bash
cd /root/openhearth
cp config.example.json config.json
$EDITOR config.json
```

Key fields for a Vesper-shape agent:

```json
{
  "workspace": "/data/books/ledger",
  "ai": { "primary": "xai", "fallback": "ollama" },
  "xai": {
    "enabled": true,
    "model": "grok-4"
  },
  "mesh": {
    "enabled": true,
    "agent": "vesper",
    "embedded": false,
    "baseUrl": "http://100.67.57.74:3337",
    "webhookPort": 3338,
    "webhookUrl": "http://<vesper-tailscale-ip>:3338/incoming",
    "webhookBind": "0.0.0.0"
  }
}
```

- `embedded: false` means Vesper is a mesh **client**, pointing at Koda's
  Hearth bus. She doesn't host her own bus.
- `webhookUrl` needs to be her actual tailnet-reachable IP so the bus can
  push messages to her.
- `ollama` as fallback is optional — only makes sense if you also install
  Ollama on the VPS. If the VPS is lean, set `fallback: null` or omit.

### 4. Write the agent's soul

```bash
cd /data/books/ledger
$EDITOR IDENTITY.md
$EDITOR SOUL.md
$EDITOR HEARTBEAT.md
$EDITOR STANDING_ORDERS.md
# ...etc
```

If the agent already has soul files on another machine, scp them:

```bash
scp IDENTITY.md SOUL.md MEMORY.md root@<vps>:/data/books/ledger/
```

### 5. Smoke test

```bash
cd /root/openhearth
node index.js
```

Watch the log for:
- ✓ Claude/xAI auth probe succeeded *(or skipped if not primary)*
- Mesh receiver listening
- Registered webhook with Koda's Hearth
- Heartbeat intervals confirmed

Send a test message from Koda's Hearth:
```bash
curl -X POST http://100.67.57.74:3337/message \
  -H "Content-Type: application/json" \
  -d '{"from":"koda","to":"vesper","text":"welcome home"}'
```

Watch Vesper's log for `📬 incoming from koda`.

### 6. Install the systemd service

Once you've verified everything works under `node index.js` directly:

```bash
cp /root/openhearth/scripts/openhearth.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now openhearth
systemctl status openhearth
```

Live logs:
```bash
journalctl -u openhearth -f
```

In-process log rotation writes to `/data/books/ledger/.openhearth/runtime.log`
(survives VPS re-imaging since it's on the persistent volume).

## Firewall note

The UFW config is deliberately **Tailnet-only** for now. External HTTP/HTTPS
is not opened. When you're ready to expose the dashboard publicly:

```bash
# Allow ports 80/443 from the internet
ufw allow 80/tcp
ufw allow 443/tcp

# Run certbot against your domain
certbot --nginx -d dashboard.your-domain.example.com
```

Keep SSH behind Tailscale. There's no good reason to open 22 to the public
internet when the tailnet works.

## Troubleshooting

- **`/dev/sdb not found`** — your block volume isn't attached or has a
  different device name. `lsblk` to find it; re-run with `VOLUME_DEV=/dev/vdb`
  (or whatever it is).
- **`mkfs.ext4` refuses** — the volume already has a filesystem. The script
  guards this; if it's the wrong one, reformat manually first (destroys data!).
- **Mesh webhook registration fails** — check that Koda's Hearth is
  reachable from the VPS: `curl http://100.67.57.74:3337/health`. If not,
  Tailscale isn't connecting the two hosts — check `tailscale status`.
- **xAI auth fails** — `curl -H "Authorization: Bearer $(jq -r .api_key
  /data/books/ledger/.config/xai/credentials.json)" https://api.x.ai/v1/models`
  should return a JSON model list. If 401, the key is wrong.

## Monthly cost estimate (Hetzner)

- CAX21: €7.99
- 20 GB block volume: €1.14
- **Total: ~€9.13/month** (~$10 USD)

## Why `/data/books/ledger`?

Vesper's naming choice. The persistent volume holds the "books" — memory,
ledger, soul files — the things you'd want to survive a VPS wipe. The
runtime code at `/root/openhearth` is disposable (just `git clone` it back);
the agent's identity is not.

For other agents deploying via this script, you can rename this path with
`VOLUME_MOUNT=/your/preferred/path`.
