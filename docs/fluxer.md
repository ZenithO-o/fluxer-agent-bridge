# Fluxer is not Discord

The gateway looks like Discord and is not Discord. Clients written for Discord will not connect. Use Fluxer.js, which this image vendors, or a client written for Fluxer.

The only gateway URL Fluxer accepts here is `wss://<instance>/gateway?v=1&encoding=json`. `v=10` is rejected with close 4012. There are no intents. The identify payload takes `ignored_events` instead. REST is under `/api/v1`.

There are no slash commands, interactions, or components. Plugin commands use the prefix in `bot.toml`, default `!`. Reactions work.

## Resume and close codes

A close code of 1000 destroys the session. RESUME then fails. Fluxer.js 3.3.0 closes with 1000 on reconnect. `image/patches/apply-fluxerjs-ws-close-4000.mjs` changes those reconnect closes to 4000, which can resume. `destroy()` still uses 1000, so a real stop shows the bot offline in about 3 to 5 seconds.

A RESUME within about 60 seconds replays missed events. After a longer gap the bridge identifies again and backfills through REST, up to `backfill_max`.

The heartbeat interval is about 41 seconds. A dropped socket is shown offline after about 5 seconds. Presence updates are limited to 5 per 20 seconds. The bridge caps itself at 4 per 20 seconds.

Fatal closes 4004, 4010, 4011, and 4012 stop that bot until its config hash changes. Other closes reconnect.

## Operators

Never signal these containers with `docker kill -s`. Docker then marks them manually stopped, and `restart: unless-stopped` will not start them after a crash. Use `bin/reload.sh` and `bin/drill-reconnect.sh`.

Resetting a bot token kills every session. The token is `<app_id>.<secret>` and is shown once.

Adding a bot to a community needs Manage Community on that community. A non-public bot can only be added by its owner.

Some instances disable DMs. `include_dms` then has nothing to forward. That is a property of the instance, not of this bridge.
