#!/usr/bin/env bash
# Syncs the site to sluhtime.alvear.cl over SSH. Only ships what the site
# actually needs at runtime -- build scripts, server helpers, and git
# metadata stay local.
#
# NOTE the exclusion is data/source/, not data/. data/ itself IS shipped:
# it holds the CSVs the dashboards fetch at runtime (birthdays, breaks),
# shared by /math/ and /mcl/. Only data/source/ -- the bulky build inputs
# (.ics, .geojson, .xlsx) that csv_to_data.py and build_world_map.py read
# -- stays local. Put new build inputs in data/source/, not data/. The one
# exception is school-events-catalog.json, which the editor's event page
# lists from.
#
# math-next/ (the dashboard redesign + its design mockups) and editor/ ARE
# shipped, so coworkers can look at them. The editor's deployed copy is a
# read-only preview (editor/preview-mode.js): only editor/server.py, run
# locally, can save. server.py itself stays local.
#
# The site lives on its own subdomain (rather than a subfolder of
# static.alvear.cl) so the host can run PHP for it -- see server/README.md.
# The old static.alvear.cl/sluh-time-visualizer/ URL 301-redirects here;
# that redirect is server/nginx-redirect.conf, pasted into the
# static.alvear.cl vhost by hand (one-time, not shipped by this script).
set -euo pipefail

REMOTE_USER="root"
REMOTE_HOST="server3.alvear.cl"
REMOTE_PATH="/var/www/sluhtime.alvear.cl/htdocs/"
SSH_KEY="$HOME/.ssh/id_rsa"

cd "$(dirname "$0")"

# bumped on every deploy so the kiosk's version-poll (see math-office.js)
# notices and reloads itself within a minute, with no manual intervention.
date +%s > version.txt

rsync -avz --delete \
  -e "ssh -i $SSH_KEY" \
  --exclude ".git/" \
  --exclude ".gitignore" \
  --exclude ".claude/" \
  --exclude ".DS_Store" \
  --exclude "README.md" \
  --include "data/source/" \
  --include "data/source/school-events-catalog.json" \
  --exclude "data/source/*" \
  --exclude "scripts/" \
  --exclude "api/build-scriptable.py" \
  --exclude "pi-kiosk/" \
  --exclude "editor/server.py" \
  --exclude "__pycache__/" \
  --exclude "server/" \
  --exclude "deploy.sh" \
  --exclude "build-icons.py" \
  --exclude ".stats-data.json" \
  --exclude ".stats-key.txt" \
  ./ "$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH"

echo "Deployed to $REMOTE_HOST:$REMOTE_PATH"

# --- stats endpoint one-time setup -----------------------------------------
# stats.php (see it, and stats.js, for what's collected) needs two dotfiles
# next to it that rsync deliberately leaves alone:
#   .stats-key.txt    the dashboard view key -- generated here on first deploy
#   .stats-data.json  the collected counters -- created by stats.php on first hit
# Both must be owned by the web-server user so php-fpm can read/write them;
# rsync runs as root, so we fix that here every deploy. Non-fatal: a hiccup
# here shouldn't mark the whole deploy as failed.
ssh -i "$SSH_KEY" "$REMOTE_USER@$REMOTE_HOST" "
  cd '$REMOTE_PATH' || exit 1
  if [ ! -f .stats-key.txt ]; then
    openssl rand -hex 24 > .stats-key.txt
    echo '>>> Generated stats dashboard key:'
    cat .stats-key.txt
    echo '>>> Open https://sluhtime.alvear.cl/stats.php?key=THATKEY once to save it as a cookie.'
  fi
  touch .stats-data.json
  chown www-data:www-data .stats-key.txt .stats-data.json
  chmod 640 .stats-key.txt
  chmod 664 .stats-data.json
" || echo "warning: stats setup step failed -- see server/README.md"
