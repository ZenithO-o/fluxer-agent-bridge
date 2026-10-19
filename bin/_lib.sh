# Shared settings for bin/*.sh (sourced, not executed).
# BB_ is the old private name bot-bridge. The prefix is kept so existing hosts keep working.
# BB_HOME   install dir (default: the checkout this script lives in)
# BB_PREFIX container name prefix (default "fab": containers are fab-<owner>)
# BB_COMPOSE_PROJECT compose project name (default "fluxer-agent-bridge"; keep an existing host's name when upgrading)
# bridge.env (in BB_HOME, not committed) sets FLUXER_INSTANCE=https://your-fluxer.example and optional BB_IMAGE.
BB=${BB_HOME:-$(cd "$(dirname "$0")/.." && pwd)}
[ -f "$BB/bridge.env" ] && . "$BB/bridge.env"
PREFIX=${BB_PREFIX:-fab}
IMAGE=${BB_IMAGE:-fluxer-agent-bridge:local}
PROJECT=${BB_COMPOSE_PROJECT:-fluxer-agent-bridge}
FLUXER_INSTANCE=${FLUXER_INSTANCE:-}
need_instance() {
  case "$FLUXER_INSTANCE" in https://*) ;; *) echo "set FLUXER_INSTANCE=https://... in $BB/bridge.env (see bridge.env.example)" >&2; exit 1;; esac
  [ "$FLUXER_INSTANCE" != "https://your-fluxer.example" ] || { echo "FLUXER_INSTANCE in $BB/bridge.env is still the placeholder" >&2; exit 1; }
}
