# Wire an agent to the webhook

The bridge POSTs batches to `WEBHOOK_URL`. The agent replies with the Fluxer REST calls in [the reference](reference.md#how-an-agent-replies). Setup of the bridge itself is in the [README](../README.md).

The webhook URL is dialed from the container. `127.0.0.1` in that URL is the container, not the host. `WEBHOOK_AUTH` is sent as the `Authorization` header with no rewriting. A receiver that expects `Bearer <key>` rejects a bare key with 401, and a 401 pauses delivery until that bot process is created again.

Skip batches with top-level `test: true` unless you are checking the wire.

## Hosted agent webhook

Tested with two production bots.

Create a routine whose trigger is an HTTPS webhook and a bearer key. Put the URL in `WEBHOOK_URL` and `Bearer <key>` in `WEBHOOK_AUTH`.

The body is the payload in the reference. Act on `reason`. Answer `ping` and `reply-to-bot`. Read `all` when you want context. Reply with the REST calls, typing first.

## HTTP receiver to an inbox file

Tested locally. `examples/receivers/http_receiver.py` is stdlib Python. It checks the bearer token in constant time, de-duplicates by `Idempotency-Key` when that header is present, appends each event to a JSONL file, and answers 200.

The default bind is `127.0.0.1`. A bridge on another machine cannot reach that. Pass `--host 0.0.0.0` only on a private network, or put TLS in front of it.

```sh
WEBHOOK_TOKEN="$KEY" ./examples/receivers/http_receiver.py --host 0.0.0.0 --port 8787 --inbox ~/fluxer-inbox.jsonl
```

On the bridge, set `WEBHOOK_URL` to `http://<receiver-host>:8787/fluxer` and `WEBHOOK_AUTH` to `Bearer <KEY>`.

```sh
./examples/receivers/inbox_tail.sh ~/fluxer-inbox.jsonl
```

Use TLS, a reverse proxy, or a tailnet when the receiver and the bridge are not on the same private network.

## MCP and wake

The bridge holds the Fluxer socket and POSTs batches. `mcp/fluxer.py` reads that inbox and posts as a bot. It does not start a turn. Pi is the local agent. `pi-extensions/fluxer-wake.ts` starts a Pi turn on `ping`, `reply-to-bot`, or `dm`. Reload Pi after changing it.

One token file per bot, mode `0600`:

```text
~/.config/fluxer-agent-bridge/bots/<name>.env
```

The file has `FLUXER_URL` and `FLUXER_BOT_TOKEN`. `--bot <name>` is required. A missing name is an error.

```sh
bin/fluxer --bot alice_bot --guild "$GUILD" reply "$CHANNEL" "$MSG" "On it."
python3 mcp/fluxer.py listen
```

`listen` binds `127.0.0.1:8788`. A container cannot dial that address. Point `WEBHOOK_URL` there only when the bridge process is on this machine. A bot whose URL still points at a hosted webhook routine does not wake this session.

## Stay in the server you were asked in

Writes are pinned to the guild of the message being answered, and they fail closed. Copy `guild_id` from the payload (or the `guild` that `events` adds) into `--guild`, or use `--dm` for a DM. In MCP, pass `guild_id` or `dm: true`. A wake can export `FLUXER_CONTEXT_GUILD=<id>|dm` instead. A channel in another guild, or one that cannot be resolved, is refused before anything is sent (exit 3, or `isError`). `--dry-run` checks without writing. See [Guild pinning](reference.md#guild-pinning).

An agent that posts by SSH into the bridge host should use `bin/post.sh`. It posts with the token inside the container, applies the same check, and types first, so the agent machine never needs the token:

```sh
printf '%s' "$TEXT" | ssh bridge-host sudo /opt/fluxer-agent-bridge/bin/post.sh alice alice_bot --guild "$GUILD" "$CHANNEL" -
```

This guards the tools, not the token. Anyone holding a raw token can still post anywhere the bot can see. On the roadmap: post only through the bridge, and remove tokens from agent machines.

## Acknowledge with a reaction

A reaction is the cheapest action, so prefer it to a reply that only says "got it" or "on it". Reply when there is something to say. With `bin/fluxer` a reaction costs about 47 tokens: the command, plus `ok` back. An acknowledgment-only reply costs about 59, and about 670 through a helper that echoes the whole message object.

```sh
bin/fluxer --bot alice_bot --guild "$GUILD" react "$CHANNEL" "$MSG" "👍"      # prints ok
bin/fluxer --bot alice_bot --guild "$GUILD" unreact "$CHANNEL" "$MSG" "👍"
```

MCP: `react {"bot": "alice_bot", "guild_id": "<guild>", "channel_id": "<ch>", "message_id": "<msg>", "emoji": "👍"}` returns `ok`. Errors are one line, for example `HTTP 404: Unknown Message`. Custom emoji are `name:id`. The guild check applies as for any write.

## CLI agent

Untested. Run the receiver with `--exec` so each batch starts one non-interactive turn. The batch JSON is on stdin.

```sh
WEBHOOK_TOKEN="$KEY" ./examples/receivers/http_receiver.py --exec \
  'claude -p "You are alice_bot on Fluxer. Read the JSON batch on stdin. If anything needs an answer, reply with examples/agent_post.py. Otherwise do nothing."'
```

A busy channel will start a turn per batch. Prefer `mode = "pings-only"` or an ignore list, and rate-limit `--exec` yourself.

You can also leave an agent running and have it poll the inbox file.

## Agent that already has an HTTP hook

Untested. Point `WEBHOOK_URL` at that hook. Give the agent `examples/agent_post.py` (guild-pinned) as the reply tool. Raw curl calls skip guild pinning. If the agent only reads files, use the HTTP receiver and point it at the inbox.

## Precise Responding

Typing names the last other author in the channel. That is usually the person you are answering. When the name has to be exact, and the agent can reach the bridge host, use `bin/status.sh` or `examples/fab-status.py`.

`agent_post.py` runs that helper in the background when `BB_SSH`, `BB_HOME`, `BB_OWNER`, and `BB_BOT` are set. Those variables are for the agent machine. They are not container env.
