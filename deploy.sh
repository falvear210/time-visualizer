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
# read-only preview (editor/preview-mode.js). The same pages at /edit/ are
# the LIVE editor: password-protected, saving through editor/server.py
# running as a service on the server -- see server/editor/README.md and the
# "live editor" steps at the top and bottom of this script.
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
# Every ssh/scp/rsync below shares ONE connection (ControlMaster): server3's
# firewall refuses SSH when too many connections open in a few seconds.
SSH_OPTS=(-i "$SSH_KEY" -o ControlMaster=auto -o ControlPath="/tmp/sluhtime-deploy-%r@%h" -o ControlPersist=60)

cd "$(dirname "$0")"

# bumped on every deploy so the kiosk's version-poll (see math-office.js)
# notices and reloads itself within a minute, with no manual intervention.
date +%s > version.txt

# --- bring back what was saved in the live editor --------------------------
# https://sluhtime.alvear.cl/edit/ (server/editor/) saves straight into these
# files on the server. Before uploading, copy any that are NEWER on the
# server than here, so this deploy doesn't overwrite an online edit (and so
# the edit shows up in git, ready to commit). A file edited here more
# recently (e.g. with the local editor) wins and is uploaded as usual.
EDITABLE_FILES=(
  "math-next/math-teachers-s1.csv"
  "math-next/math-teachers-s2.csv"
  "data/event-filter.json"
  "data/school-events.csv"
  "data/source/school-events-catalog.json"
  "data/source/school_calendar_raw.ics"
)
# one SSH call prints "<mtime> <file>" for each (0 when it's not there yet)
remote_times=$(ssh "${SSH_OPTS[@]}" "$REMOTE_USER@$REMOTE_HOST" "
  cd '$REMOTE_PATH' && for f in ${EDITABLE_FILES[*]}; do
    echo \"\$(stat -c %Y \"\$f\" 2>/dev/null || echo 0) \$f\"
  done")
while read -r remote_m f; do
  local_m=$(stat -f %m "$f" 2>/dev/null || echo 0)
  if [ "$remote_m" -gt "$local_m" ]; then
    scp -p -q "${SSH_OPTS[@]}" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH$f" "$f"
    echo ">>> Pulled $f (saved in the live editor -- commit it)"
  fi
done <<< "$remote_times"

rsync -avz --delete \
  -e "ssh -i $SSH_KEY -o ControlMaster=auto -o ControlPath=/tmp/sluhtime-deploy-%r@%h -o ControlPersist=60" \
  --exclude ".git/" \
  --exclude ".gitignore" \
  --exclude ".claude/" \
  --exclude ".DS_Store" \
  --exclude "README.md" \
  --include "data/source/" \
  --include "data/source/school-events-catalog.json" \
  --include "data/source/school_calendar_raw.ics" \
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
ssh "${SSH_OPTS[@]}" "$REMOTE_USER@$REMOTE_HOST" "
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

# --- live editor (server/editor/README.md) ----------------------------------
# The save service runs as www-data, so it must own the files it rewrites
# (rsync just uploaded them as root). Then ship the service's code -- the
# same editor/server.py used locally, plus the calendar filter it calls --
# to /opt/sluhtime-editor/ and restart it so it runs the new copy. Skipped
# quietly until the one-time setup has installed the service. Non-fatal.
ssh "${SSH_OPTS[@]}" "$REMOTE_USER@$REMOTE_HOST" "
  cd '$REMOTE_PATH' && chown www-data:www-data ${EDITABLE_FILES[*]} 2>/dev/null
  mkdir -p /opt/sluhtime-editor/editor /opt/sluhtime-editor/scripts
" || echo "warning: live editor ownership step failed"
scp -q "${SSH_OPTS[@]}" editor/server.py "$REMOTE_USER@$REMOTE_HOST:/opt/sluhtime-editor/editor/server.py" &&
scp -q "${SSH_OPTS[@]}" scripts/school_events.py "$REMOTE_USER@$REMOTE_HOST:/opt/sluhtime-editor/scripts/school_events.py" &&
ssh "${SSH_OPTS[@]}" "$REMOTE_USER@$REMOTE_HOST" "
  if systemctl list-unit-files sluhtime-editor.service | grep -q sluhtime-editor; then
    systemctl restart sluhtime-editor && echo 'Live editor service restarted'
  fi
" || echo "warning: live editor update failed -- see server/editor/README.md"
