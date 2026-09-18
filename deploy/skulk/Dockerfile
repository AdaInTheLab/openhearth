# Luna runtime (openhearth) on skulk (KitsuneDen VM 100). Build context = the openhearth checkout.
# Brains: Codex CLI (primary, ChatGPT OAuth in ~/.codex), Claude Code (secondary, ~/.claude), Ollama over tailnet.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client curl ca-certificates tzdata procps psmisc \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @openai/codex @anthropic-ai/claude-code \
 && usermod -l luna -d /home/luna -m node && groupmod -n luna node

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && chown -R luna:luna /app
COPY --chown=luna:luna . .

USER luna
ENV HOME=/home/luna
CMD ["node", "scripts/luna.js"]
