#!/usr/bin/env bash
# Launches Chromium in kiosk mode pointed at the Math Office dashboard, and
# disables screen blanking so the TV never goes dark. Invoked as the X
# session command by kiosk.service (via startx).
set -euo pipefail

DASHBOARD_URL="https://sluhtime.alvear.cl/math/"

xset s off
xset s noblank
xset -dpms

# Bare X has no window manager, so nothing honors Chromium's --kiosk
# fullscreen request -- the window just sticks to its default startup size
# instead of covering the real screen. matchbox is a minimal WM whose only
# job here is to grant that fullscreen request.
matchbox-window-manager -use_titlebar no &

CHROMIUM_BIN="$(command -v chromium-browser || command -v chromium)"

# On real Pi hardware Chromium sometimes auto-detects a 2x device scale
# factor from the GPU driver, which doubles every element's size and only
# lets half the layout fit on screen. Force it back to 1x.
#
# --remote-debugging-port lets you swap what's on screen over SSH (e.g. to
# temporarily show something else) via curl instead of simulating keyboard
# input, which kiosk mode + a minimal window manager don't handle reliably.
# It only binds to localhost by default, so it's SSH-only, not exposed on
# the network. See the "Remote control" section of README.md.
exec "$CHROMIUM_BIN" \
  --kiosk \
  --remote-debugging-port=9222 \
  --remote-allow-origins=* \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=TranslateUI \
  --overscroll-history-navigation=0 \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 \
  --force-device-scale-factor=1 \
  "$DASHBOARD_URL"
