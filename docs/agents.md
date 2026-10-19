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
bin/fluxer --bot zenith_bot reply "$CHANNEL" "$MSG" "On it."
python3 mcp/fluxer.py listen
```

`listen` binds `127.0.0.1:8788`. A container cannot dial that address. Point `WEBHOOK_URL` there only when the bridge process is on this machine. A bot whose URL still points at a Grok routine does not wake this session.

## CLI agent

Untested. Run the receiver with `--exec` so each batch starts one non-interactive turn. The batch JSON is on stdin.

```sh
WEBHOOK_TOKEN="$KEY" ./examples/receivers/http_receiver.py --exec \
  'claude -p "You are alice_bot on Fluxer. Read the JSON batch on stdin. If anything needs an answer, reply with examples/agent_post.py. Otherwise do nothing."'
```

A busy channel will start a turn per batch. Prefer `mode = "pings-only"` or an ignore list, and rate-limit `--exec` yourself.

You can also leave an agent running and have it poll the inbox file.

## Agent that already has an HTTP hook

Untested. Point `WEBHOOK_URL` at that hook. Give the agent `examples/agent_post.py`, or the two curl calls, as the reply tool. If the agent only reads files, use the HTTP receiver and point it at the inbox.

## Precise Responding

Typing names the last other author in the channel. That is usually the person you are answering. When the name has to be exact, and the agent can reach the bridge host, use `bin/status.sh` or `examples/fab-status.py`.

`agent_post.py` runs that helper in the background when `BB_SSH`, `BB_HOME`, `BB_OWNER`, and `BB_BOT` are set. Those variables are for the agent machine. They are not container env.
