#!/usr/bin/env bash
# Snapshot the Docs homepage and the Infrastructure section from the local xrpl-dev-portal
# checkout and publish it to https://xrpl-org.xrpl365.com/ for copy review.
#
#   scripts/deploy-preview.sh
#
# A production `realm build` needs a Redocly plan token, so the snapshot is taken from a running
# `realm develop` and turned into plain static pages (see preview/snapshot.mjs). If nothing is
# serving on $PORT, one is started from $SOURCE and stopped afterwards. Uncommitted edits in
# $SOURCE are included: what you see locally is what reviewers get.
#
# Same shape as the Permission Delegation deploy: upload to a staging dir on the OVH box (ssh
# alias "ovh"), then sudo rsync into the krisapp-owned web root so it never serves a half copy.
set -euo pipefail
cd "$(dirname "$0")/.."

SOURCE=${SOURCE:-$HOME/Projects/xrpl-dev-portal}
PORT=${PORT:-4050}
REMOTE=ovh
DOCROOT=/var/www/xrpl-org
STAGING=/tmp/xrpl-org-deploy
URL=https://xrpl-org.xrpl365.com/
OUT=${TMPDIR:-/tmp}/xrpl-org-preview-dist
LOCAL=http://127.0.0.1:$PORT

# realm needs Node 22+.
if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh"
  nvm use 22 >/dev/null
fi

branch=$(git -C "$SOURCE" rev-parse --abbrev-ref HEAD)
commit=$(git -C "$SOURCE" rev-parse --short HEAD)
edits=""
[ -n "$(git -C "$SOURCE" status --porcelain -- docs @l10n sidebars.yaml redirects.yaml)" ] && edits=" + local edits"
label="$branch @ $commit$edits, $(date -u '+%Y-%m-%d %H:%M') UTC"

started=""
if ! curl -s -o /dev/null "$LOCAL/"; then
  echo "starting realm develop on port $PORT from $SOURCE"
  (cd "$SOURCE" && exec ./node_modules/.bin/realm develop --port "$PORT") >"${TMPDIR:-/tmp}/xrpl-org-realm.log" 2>&1 &
  started=$!
  trap 'kill "$started" 2>/dev/null || true' EXIT
fi

# The dev server answers before its first build finishes; wait until a real page renders.
ready=""
for _ in $(seq 1 180); do
  if [ "$(curl -sL -o /dev/null -w '%{http_code}' "$LOCAL/docs/infrastructure")" = 200 ]; then ready=1; break; fi
  sleep 2
done
[ -n "$ready" ] || { echo "local preview on $LOCAL never served /docs/infrastructure" >&2; exit 1; }

# The snapshot tool drives a headless browser; its one dependency lives in preview/.
[ -d preview/node_modules/playwright ] || npm ci --prefix preview --no-audit --no-fund
SNAPSHOT_LABEL="$label" node preview/snapshot.mjs "$LOCAL" "$OUT"

# Staging is kept between runs so unchanged, content-hashed assets are not re-uploaded.
rsync -az --delete "$OUT/" "$REMOTE:$STAGING/"
ssh "$REMOTE" "sudo rsync -a --delete $STAGING/ $DOCROOT/ && sudo chown -R krisapp:krisapp $DOCROOT"

# Smoke: the root redirects to /docs, and a section page must carry this snapshot's banner.
status=$(curl -sL -o /dev/null -w '%{http_code}' "$URL")
[ "$status" = "200" ] || { echo "deploy smoke failed: HTTP $status from $URL" >&2; exit 1; }
# Fetch first: `curl | grep -q` fails under pipefail when grep exits early and curl gets SIGPIPE.
page=$(curl -s "${URL}docs/infrastructure")
grep -qF "$commit" <<<"$page" \
  || { echo "deploy smoke failed: ${URL}docs/infrastructure does not show $commit" >&2; exit 1; }
echo "deployed: $URL (HTTP $status) - $label"
