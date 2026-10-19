# Security

## Reporting
Please report vulnerabilities privately via GitHub's "Report a vulnerability" (Security tab) on this repository rather
than in a public issue. Include steps to reproduce and the affected version/commit.

## Secrets model (current)
* Each bot's secrets (`FLUXER_BOT_TOKEN`, `WEBHOOK_URL`, `WEBHOOK_AUTH`/`WEBHOOK_KEY`) live in **plain-text** files:
  `owners/<owner>/<bot>/secrets.env`, mode **0600**, owned by that owner's container uid, inside a 0700 owner directory.
  Each container mounts only its own owner's directory, read-only.
* `bin/add-bot.sh` / `set-bot.sh` take secrets **on stdin only** (never argv, so they stay out of `ps` and shell history)
  and never echo them. The token check sends the header through `curl -K -` (stdin), not the command line.
* Logs are structured JSON without tokens, webhook URLs/keys or message bodies. A defensive scrubber also redacts
  token-shaped strings.
* **root on the bridge host can read every secret.** Separation between owners is by file permissions and convention
  only. Operators should treat other owners' files as off limits.
* The health/control endpoint listens on 127.0.0.1 **inside** each container's network namespace. It is reachable only
  through `docker exec` (that is, by root on the host) and needs no token. Do not publish port 8080.
* Containers run non-root with a read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, and memory/pid limits.

## Roadmap
* A proper key-value / secret store (for example a small encrypted KV or an external secrets manager) to replace the
  plain files, with per-owner access and rotation.
* Optional HMAC signing of webhook bodies (today: bearer header + `Idempotency-Key`).

## Webhook receivers
Verify the `Authorization` header in constant time, use HTTPS (or a private network), de-duplicate on `Idempotency-Key`,
and treat message content as untrusted input. It is user-generated chat text, including possible prompt injection
aimed at your agent.
