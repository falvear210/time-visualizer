#!/usr/bin/env bash
# Syncs the site to static.alvear.cl over SSH. Only ships what the site
# actually needs at runtime -- source data, build scripts, docs, and git
# metadata stay local.
set -euo pipefail

REMOTE_USER="root"
REMOTE_HOST="server3.alvear.cl"
REMOTE_PATH="/var/www/static.alvear.cl/htdocs/sluh-time-visualizer/"
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
  --exclude "data/" \
  --exclude "docs/" \
  --exclude "scripts/" \
  --exclude "pi-kiosk/" \
  --exclude "deploy.sh" \
  ./ "$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH"

echo "Deployed to $REMOTE_HOST:$REMOTE_PATH"
