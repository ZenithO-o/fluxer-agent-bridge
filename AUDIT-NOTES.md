# Audit notes: fluxer-agent-bridge vs. the private deployment

This file is the private-to-public cut memo from 2026-10-19. It is not a setup guide. Start at README.md.

This repo was cut on 2026-10-19 from the privately deployed `bot-bridge` (forward-all mode, ignore list, extra events,
activity-status). These notes list what was left out, scrubbed or changed, so the owner can audit before going public.

## Left out entirely
* Real owner/bot folders and seeds (`owners/`, `owners-seed/`), `owners.conf`, generated `compose.yml`, `state/`, `backup/`.
* All `secrets.env` files, bot tokens and webhook URLs/keys. None were ever in the source tree; the scanners confirm (below).
* The private design doc (it covers the deployment's hosts, people and history). Its protocol findings went into
  README "Fluxer gotchas", reworded generically.
* Built output (`image/dist`) and `node_modules` (git-ignored).
* Deployment-only box tools: the private posting script and the `fx-status` helper. Generic versions were rewritten as
  `examples/agent_post.py` and `examples/fab-status.py`.

## Scrubbed / generalized
| Was | Now |
|---|---|
| Hardcoded instance URL in `config.ts`, `add-bot.sh`, `render-compose.sh`, `presence-check.py` | `FLUXER_INSTANCE` in `bridge.env` (placeholder `https://your-fluxer.example`; scripts refuse the placeholder). `presence-check.py` reads `FLUXER_URL` from an env file and takes `--guild` |
| Fixed install path `/opt/bot-bridge` in every script | `bin/_lib.sh`: `BB_HOME` (default: the checkout), sourced `bridge.env` |
| Container names `bot-bridge-<owner>`, image `bot-bridge:1.0` | `fab-<owner>` (`BB_PREFIX`), image `fluxer-agent-bridge:local` (`BB_IMAGE`) |
| Host names, LAN IPs, ssh user in comments/examples | removed; examples use `your-host`, `user@bridge-host`, `BB_SSH` |
| Real guild/channel/user/app snowflakes in tests | fake ids `1000000000000000xx`; names → `alice`, `bob`, `my_bot`, `other_bot`, "Example Guild" |
| Agent/platform names in comments and the idle text ("Relaying to …") | generic ("the agent's inbox"); default idle text `Relaying` |
| Webhook host of the deployment | not referenced anywhere |
| Payload `source: "bot-bridge"`, `User-Agent: bot-bridge/1.0`, patch marker, package name | `fluxer-agent-bridge` (**receivers that match `source == "bot-bridge"` would need updating if pointed at this build**) |

## Behavior changes vs. the deployed code
* **Presence rate cap fixed.** The deployed build allows up to 20 updates/min (gap 2 s). Fluxer documents 5 presence
  updates per 20 s, so under sustained activity that could exceed the limit. This repo adds a hard cap of **4 per 20 s**
  (even for forced updates) and lowers the default `max_updates_per_minute` to 12 (max 15). A unit test covers it.
  *Recommend backporting this to the deployment.*
* Template `reading_seconds` is 120 (the code default). The deployment's template and one deployed bot config currently use 3.
* `include_dms` comment no longer assumes DMs are disabled.
* Tests: 18 (one new presence-cap test). Test fixtures use fake ids.

## Added
README (architecture mermaid, quick start, config reference, payload schema, replying, recipes with tested/untested
labels, Fluxer gotchas), LICENSE (MIT, **owner to confirm**), SECURITY.md, `.gitignore`, `bridge.env.example`,
`owners.conf.example`, `examples/bot.toml`, `examples/secrets.env.example`, `examples/receivers/http_receiver.py` +
`inbox_tail.sh`, GitHub Actions CI (npm ci, typecheck, tests, shell/python syntax, docker build).
`examples/bot.toml` was a byte copy of `templates/bot.toml` and was removed so there is one config to read.

## Scans (run before the first commit and on the final history)
* gitleaks 8.21.2: `detect --no-git` on the working tree (incl. node_modules) and `detect --log-opts=--all` on the git history: **no leaks found**.
* ripgrep sweep for host names, LAN/VPS IPs, ssh user, instance domain, agent/platform names, people's names, box paths,
  the deployment's snowflake prefix, and the webhook host: no hits outside this file and the `ZenithO-o` repo/author identity.

## For the owner to decide
* License (MIT assumed), the copyright line ("Zenith (ZenithO-o)"), project/container naming (`fluxer-agent-bridge`, `fab-`).
* Whether to keep the author identity `Zenith <ZenithO-o@users.noreply.github.com>` on public commits.
* Whether to backport the presence-cap fix and the generic `bridge.env` layout to the private deployment.
