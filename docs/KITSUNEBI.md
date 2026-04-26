# kitsunebi integration

`src/kitsunebi.js` wires an openhearth agent into the Skulk's kanban at
[kitsunebi.kitsuneden.net](https://kitsunebi.kitsuneden.net) over its
Phase 3 agent API. Each agent gets its own bearer token; calls are
attributed in the kitsunebi git audit log so the board's history shows
who did what.

## What the agent gets

Eight tools, registered through the standard openhearth registry:

| Tool                  | Args                                                            | Effect                                                                  |
| --------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `board_list`          | `status?, owner?, tag?, include_body?`                          | List cards with optional filters.                                       |
| `board_get`           | `id`                                                            | Read one card (frontmatter + body).                                     |
| `board_create`        | `id, title, status, owner, collaborators?, tags?, due?, body?`  | Create a new card. `id` must be lowercase-with-dashes.                  |
| `board_update`        | `id, title?, owner?, collaborators?, tags?, due?, blocked_by?`  | Patch frontmatter. (Status changes go through `board_move` so the `completed:` field stays consistent.) |
| `board_move`          | `id, status, order?`                                            | Move to a different column, optionally to an explicit float position.   |
| `board_attach_image`  | `id, filename, content_base64, mime_type?`                      | Attach an image; appends `![alt](url)` to the card body so it renders on the board. |
| `board_comment`       | `id, text`                                                      | Post a comment on a card. The server attributes it to the agent name from your bearer token, so no need to pass an author. |
| `board_comments`      | `id`                                                            | Read the comment thread for a card (oldest first).                      |

## Wiring it into a runtime

In your runtime entry point (after `tools.init`):

```js
import * as kitsunebi from '../src/kitsunebi.js';

tools.registerMany(kitsunebi.getTools({ workspace: config.workspace }));
```

Token resolution, in precedence order:

1. `KITSUNEBI_TOKEN` env var
2. `{workspace}/.config/kitsunebi/token` (mode 600 file ~ mirrors the existing
   `~/.config/openai/credentials.json` convention)

Calls fail at use time if neither is provisioned, so registering the tools
on a fresh box is safe ~ they show up in the prompt and only error if the
agent actually tries to call one.

Base URL precedence:

1. `baseUrl` option to `getTools()` / `KitsunebiClient`
2. `KITSUNEBI_API_URL` env var
3. `https://kitsunebi.kitsuneden.net` (default)

## Provisioning the token for an agent

On the kitsunebi VPS, the secret lives at `~/.kitsunebi-agent-tokens` as
comma-separated `name:secret` pairs (mode 600). The board operator runs a
`pm2 reload ecosystem.config.cjs --only kitsunebi --update-env` to pick up
new tokens. See the kitsunebi repo's README for the openssl one-liner.

On the agent side, drop the matching secret at
`{workspace}/.config/kitsunebi/token`:

```bash
mkdir -p $WORKSPACE/.config/kitsunebi && \
  printf '<your-secret>' > $WORKSPACE/.config/kitsunebi/token && \
  chmod 600 $WORKSPACE/.config/kitsunebi/token
```

Or set `KITSUNEBI_TOKEN` in the systemd unit / launchd plist / process
env directly if you'd rather not have the secret on disk.

## Attribution

Every write the agent makes lands in the kitsunebi commit log with
the agent name appended:

```
patch foo-card: title (luna)
move foo-card → done (sage)
attach foo-card/screenshot.png (+ body) (koda)
create foo-card: A new flame (luna)
```

That's how Ada (or anyone) can later see which agent did what without
inspecting the runtime logs.

## Failure modes

- **No token provisioned** ~ tool call throws with `kitsunebi: no token. Set
  KITSUNEBI_TOKEN env var or stash at {workspace}/.config/kitsunebi/token.`
  Provision the file and restart the runtime (env-from-file is read at
  process start).
- **Bad token** ~ kitsunebi returns 403. Verify the token in
  `~/.kitsunebi-agent-tokens` on the VPS matches the one stashed locally,
  and that PM2 picked up the env (`pm2 reload ecosystem.config.cjs --update-env`).
- **Card id collision on create** ~ kitsunebi returns 409 `already_exists`;
  pick a different id.
