# Security

## Reporting

Report vulnerabilities privately with GitHub "Report a vulnerability" on this repository. Do not open a public issue. Include steps to reproduce and the affected commit.

## Secrets

Each bot's `FLUXER_BOT_TOKEN`, `WEBHOOK_URL`, and `WEBHOOK_AUTH` live in `owners/<owner>/<bot>/secrets.env`. `WEBHOOK_KEY` is the legacy name for the same webhook credential. The file mode is 0600. The owner directory mode is 0700. The file is owned by that owner's container uid. Each container mounts only its own owner directory, read-only.

`bin/add-bot.sh` and `bin/set-bot.sh` take secrets on stdin only. They are not arguments, so they stay out of `ps` and shell history. The scripts do not echo them. The token check sends the header through `curl -K -`, which reads the header from stdin.

Logs are JSON lines. They do not contain tokens, webhook URLs, webhook keys, or message bodies. A scrubber also redacts strings shaped like a bot token.

Root on the bridge host can read every secret. Separation between owners is file permissions and the mount, not a secrets manager. Treat another owner's files as off limits.

The health and control endpoint listens on 127.0.0.1 inside the container network namespace. It is reachable only through `docker exec`, which means root on the host. It has no token. Do not publish port 8080.

Containers run as a non-root uid. The root filesystem is read-only. Capabilities are dropped. `no-new-privileges` is set. Memory and pid limits apply.

## Not built

There is no encrypted secret store and no per-owner access control beyond the files above. Webhook bodies are not HMAC signed. The check is the bearer header plus `Idempotency-Key`.

## Webhook receivers

Verify `Authorization` in constant time. Use HTTPS, or a private network. De-duplicate on `Idempotency-Key`. Treat message content as untrusted chat text. It can contain a prompt aimed at your agent.
