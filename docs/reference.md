# Bridge reference

Facts for an operator who already has a bot online. Setup is in the [README](../README.md).

## What Fluxer shows

The bridge does not send `offline`. Fluxer marks a dropped session offline after about 5 seconds.

| Bridge state | Fluxer shows |
|---|---|
| Connected, webhook delivering | online, plus the idle text or the current activity line |
| No webhook URL, or `hold = true` | the configured status, usually online, with a note such as `webhook not configured` or `webhook held`. Activity text is hidden |
| Webhook failing for 3 rounds, or the outbox over 80% of `outbox_max` | idle, plus `webhook down, N queued` or `webhook backlog N` |
| Webhook HTTP 4xx other than 408 or 429, or a plugin disabled after 20 handler errors | dnd, plus the reason. Delivery stays paused until that bot process is created again |
| Process, container, host, or network down | offline |

Activity text is a Reading, Responding, or Responded line. It is shown only when there is no degradation and no note. Health text wins.

A 4xx pause is in memory. `bin/reload.sh` sends SIGHUP. SIGHUP restarts a bot only when the raw bytes of `bot.toml` or `secrets.env` changed. An unchanged reload does not clear the pause. Touch one of those files, or restart the container.

Docker's health check marks the container unhealthy. It does not restart it. The process exits, and `restart: unless-stopped` brings it back, only when the event loop stalls for 30 seconds or a bot that is not `failed` stays unready for 5 minutes. A bad token sets `failed`. The watchdog does not recycle that state.

## Scripts

Run these with sudo on the bridge host. Settings come from `bridge.env`.

| Script | Effect |
|---|---|
| `add-bot.sh <owner> <bot>` | Create or update a bot. `KEY=VALUE` lines on stdin. Allowed keys are `FLUXER_BOT_TOKEN`, `WEBHOOK_URL`, `WEBHOOK_AUTH`, and legacy `WEBHOOK_KEY`. Omitted keys are kept. Unknown keys are ignored |
| `set-bot.sh` | Same program as `add-bot.sh` |
| `list-bots.sh [owner]` | Docker health and per-bot status. No secrets |
| `reload.sh <owner>` | SIGHUP to PID 1 through `docker exec`. Restarts a bot only when its config hash changed |
| `status.sh <owner> <bot> …` | Drive activity status. See below |
| `test-webhook.sh <owner> <bot>` | One synthetic POST from `cli.js`. Not a live batch, and nothing is posted in Fluxer |
| `drill-reconnect.sh <owner>` | Drop the gateway socket with no close frame. Expect `RESUMED` |
| `remove-bot.sh <owner> <bot>` | Move that bot's directory to `backup/` and send SIGHUP. The `owners.conf` row and the container stay |
| `render-compose.sh` | Rewrite `compose.yml` from `owners.conf` |

`bridge.env` sets `FLUXER_INSTANCE`. Optional `BB_PREFIX` defaults to `fab`, so the container is `fab-<owner>`. Optional `BB_IMAGE` defaults to `fluxer-agent-bridge:local`.

Do not signal these containers with `docker kill -s`. Docker then treats them as manually stopped, and `restart: unless-stopped` will not revive them. `reload.sh` and `drill-reconnect.sh` signal PID 1 through `docker exec`.

`status.sh` talks to the container loopback through `docker exec`. There is no host listener and no token.

```sh
sudo bin/status.sh OWNER BOT responding USER_OR_NICK [CHANNEL_ID] [MESSAGE_ID] [ISSUED_AT_MS]
sudo bin/status.sh <owner> <bot> idle
sudo bin/status.sh <owner> <bot> show
```

Pass `-` for a positional value you want to skip. A nick with spaces splits on the shell. A command for a message that was already answered, or issued before the latest Responded, is ignored.

Full counters are on the loopback health endpoint.

```sh
sudo docker exec fab-<owner> wget -qO- 127.0.0.1:8080/healthz
```

Logs are JSON lines. They do not contain tokens, webhook URLs, webhook keys, or message bodies.

```sh
sudo docker logs -f --since 10m fab-<owner>
```

## Host files

```text
bridge.env                      sourced by bin/*.sh and copied into compose.yml
owners.conf                     lines are "<owner> <uid>". Comments start with #
owners/<owner>/<bot>/bot.toml   mode 0640. No secrets
owners/<owner>/<bot>/secrets.env mode 0600
state/<owner>/                  writable mount at /state
backup/                         previous secrets and removed bot directories
```

`add-bot.sh` assigns the next uid at or above 10001. It does not create a host account. Compose sets `user` to that uid. The image `USER 10001` is only the build default.

`FLUXER_INSTANCE`, the discovered gateway, the REST API, and `WEBHOOK_URL` must be reachable from the container network.

## `bot.toml`

The file `add-bot.sh` copies is `templates/bot.toml`. `[plugins.ignore]` must follow the `webhook-forward` table. The TOML parser attaches it to the previous table.

If `ignored_events` is omitted, the loader defaults to `TYPING_START` only, not `PRESENCE_UPDATE`. The template sets both.

`activity-status` with `typing_means_responding` left on removes `TYPING_START` from the gateway ignore list before login. That override is not written back to `bot.toml`.

```toml
enabled = true
prefix = "!"
presence = { status = "online", text = "Relaying" }
ignored_events = ["TYPING_START", "PRESENCE_UPDATE"]
```

`presence.status` is `online`, `idle`, or `dnd`. `prefix` is for plugin commands. Fluxer has no slash commands.

### `webhook-forward`

```toml
[[plugins]]
use = "webhook-forward"
mode = "all"              # "all" | "pings-and-home" | "pings-only"
home_channels = []
include_dms = true
include_edits = true
include_deletes = true
include_bots = true
include_backfill = true   # default true. Not required in the file
skip_authors = ["self"]
channels = []
skip_channels = []
batch_seconds = 3
max_per_post = 50
max_post_bytes = 524288
outbox_max = 500
backfill_max = 50
everyone_is_ping = false
hold = false
test = false              # true forces test:true on every POST from this plugin
events = ["reactions", "member_join", "member_leave", "thread_create"]

[plugins.ignore]
channels = []
users = []
bots = false
strict = false
```

`mode` applies to messages. `all` forwards every event the bot can see except its own. `pings-and-home` forwards everything in `home_channels` and in DMs, and elsewhere only pings and replies to the bot. `pings-only` forwards only pings and replies. Opt-in `events` do not read `mode`. They are forwarded in every mode, with the bot's own actor skipped and the ignore list applied.

Message `reason`, highest priority first: `ping`, `reply-to-bot`, `dm`, `home`, `all`. `legacy_reason` maps `ping` to `mention`, `reply-to-bot` to `reply`, and `reaction-to-bot` to `reaction`.

`skip_authors` and `skip_channels` are hard drops, including pings. An empty `channels` list means every channel the bot can view. A thread matches its parent. The bot's own messages are never forwarded.

Edits are forwarded only when `content` and `edited_timestamp` are both set. Deletes do not get ping or reply reasons.

The first time a channel is seen, the cursor is set to `last_message_id` and history is not sent. A later fresh identify backfills at most `backfill_max` messages and marks them `backfill: true`. Resume does not backfill.

Role mentions use the role list from the last fresh identify. A role change during a long resumed session is not picked up until the next identify.

| `events` name | Gateway event | Extra fields |
|---|---|---|
| `reaction_add`, `reaction_remove` (alias `reactions`) | `MESSAGE_REACTION_ADD`, `MESSAGE_REACTION_REMOVE`, `MESSAGE_REACTION_REMOVE_ALL`, `MESSAGE_REACTION_REMOVE_EMOJI` | `message_id`, `emoji`, `message_author_id`, `remove_all` |
| `member_join`, `member_leave`, `member_update` (alias `members`) | `GUILD_MEMBER_ADD`, `GUILD_MEMBER_REMOVE`, `GUILD_MEMBER_UPDATE` | `user`, `member` |
| `thread_create`, `thread_update`, `thread_delete` (alias `threads`) | `THREAD_*`, or `CHANNEL_*` with a thread type | `channel`, `thread` |
| `channel_create`, `channel_update`, `channel_delete` (alias `channels`) | `CHANNEL_*` | `channel` |
| `ban_add`, `ban_remove` (alias `bans`) | `GUILD_BAN_ADD`, `GUILD_BAN_REMOVE` | `user` |
| `typing` | `TYPING_START`. Also remove it from `ignored_events` | `author` is who is typing. Off by default |

A reaction on the bot's message gets reason `reaction-to-bot`. Another extra event aimed at the bot gets reason `ping`.

### `activity-status`

```toml
[[plugins]]
use = "activity-status"
reading_seconds = 120
responding_seconds = 120
responded_seconds = 20
min_update_seconds = 2
max_updates_per_minute = 12
typing_means_responding = true
```

| State | Text | Entered | Left |
|---|---|---|---|
| idle | `presence.text`, or `idle_text` if set | start, and after the timeouts | a later state |
| reading | `Reading NICK's message`, `Reading NICK's messages`, or `Reading multiple messages` | webhook accepted a batch with creates or edits | Responding, or `reading_seconds` after the last such batch |
| responding | `Responding to NICK's message` | the bot's own typing, or `status.sh responding` | Responded, or `responding_seconds` |
| responded | `Responded to NICK's message` | the bot's own new message on the gateway | `responded_seconds` |

NICK is the guild nickname, otherwise the global display name, otherwise the username. Typing names the last other author in that channel. `status.sh` can name a user or a message instead.

Presence updates are coalesced. The hard cap is 4 sends per 20 seconds, including forced updates. Fluxer documents a limit of 5 per 20 seconds. Bots without this plugin use a 15 second gap.

### `ping`

Not in the template. Add it only on a bot that should talk in chat.

```toml
[[plugins]]
use = "ping"
```

The command is the bot prefix plus `ping`, default `!ping`. There is no permission check.

## Webhook payload

`POST` to `WEBHOOK_URL`. Headers are `Content-Type: application/json`, `Authorization` set to `WEBHOOK_AUTH`, `Idempotency-Key` set to the first 32 hex characters of a SHA-256 over the `event:id` pairs joined by commas, plus `:test` when the plugin `test` flag is set, and `User-Agent: fluxer-agent-bridge/1.0`. Any 2xx is delivered. Failures retry 5 times, then one round every 1 to 10 minutes.

A 4xx other than 408 or 429 pauses delivery until that bot process is created again.

`WEBHOOK_KEY` without `WEBHOOK_AUTH` is sent as `Authorization: Bearer <key>` and as `X-Automation-Key`.

```json
{
  "source": "fluxer-agent-bridge",
  "schema": 2,
  "owner": "alice",
  "bot": "alice_bot",
  "target": "alice_bot",
  "test": false,
  "dropped_due_to_backlog": 0,
  "messages": [
    {
      "event": "create",
      "id": "100000000000000105",
      "reason": "reply-to-bot",
      "legacy_reason": "reply",
      "channel_id": "100000000000000030",
      "channel_name": "general",
      "parent_channel_id": null,
      "guild_id": "100000000000000010",
      "guild_name": "Example Guild",
      "is_dm": false,
      "author": {
        "id": "100000000000000900",
        "username": "alice",
        "global_name": "Alice",
        "nick": null,
        "display_name": "Alice",
        "bot": false
      },
      "timestamp": "2026-10-19T04:32:00.000Z",
      "edited_timestamp": null,
      "content": "thanks!",
      "attachments": [],
      "reply_to": { "id": "100000000000000100", "author_id": "100000000000000001", "content": "first 500 chars" },
      "reference": { "message_id": "100000000000000100", "channel_id": "100000000000000030" },
      "thread": null
    }
  ]
}
```

`event` is `create`, `edit`, `delete`, or an extra-event name. Non-message events use a synthetic `id` of the form `kind:timestamp:seq` and set `content` to null. `backfill: true` marks a message recovered by REST after a gap. `test: true` on the batch marks a test post. `target` repeats `bot`.

`test-webhook.sh` does not use this plugin path. Its body also sets top-level `synthetic: true`, uses message reason `test`, and sends no `Idempotency-Key`.

Up to 50 items and 512 KiB per POST, about every 3 seconds while the outbox has traffic. The oldest outbox items are dropped past `outbox_max`. `dropped_due_to_backlog` is sent on a later POST and cleared after a 2xx.

## How an agent replies

Use the bot token as `Authorization: Bot <app_id>.<secret>`. The base URL is `https://<instance>/api/v1`.

```sh
curl -sS -X POST -H "Authorization: Bot $TOKEN" -H "Content-Length: 0" \
  "$FLUXER/api/v1/channels/$CHANNEL/typing"
curl -sS -X POST -H "Authorization: Bot $TOKEN" -H "Content-Type: application/json" \
  -d "{\"content\":\"On it!\",\"message_reference\":{\"message_id\":\"$MSG\",\"channel_id\":\"$CHANNEL\"}}" \
  "$FLUXER/api/v1/channels/$CHANNEL/messages"
```

The typing call is what the bridge treats as Responding, unless you use `status.sh`. The bridge then sees the bot's own `MESSAGE_CREATE` and can show Responded.

`examples/agent_post.py` wraps those two calls. It reads `FLUXER_URL` and `FLUXER_BOT_TOKEN` from the environment or from `bot.env`. That URL name is not `FLUXER_INSTANCE`. `FLUXER_INSTANCE` is only the bridge host file.
