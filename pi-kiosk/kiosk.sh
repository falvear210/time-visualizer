#!/usr/bin/env bash
# Launches Chromium in kiosk mode pointed at the Math Office dashboard, and
# disables screen blanking so the TV never goes dark. Invoked as the X
# session command by kiosk.service (via startx).
set -euo pipefail

DASHBOARD_URL="https://static.alvear.cl/sluh-time-visualizer/math-office.html"

xset s off
xset s noblank
xset -dpms

CHROMIUM_BIN="$(command -v chromium-browser || command -v chromium)"

exec "$CHROMIUM_BIN" \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=TranslateUI \
  --overscroll-history-navigation=0 \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 \
  "$DASHBOARD_URL"
