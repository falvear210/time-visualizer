#!/usr/bin/env bash
# kiosk-tv — turn the kiosk's HDMI-CEC TV on or off from the Pi.
# -----------------------------------------------------------------------------
# Two callers:
#   - the fleet-tracker command channel (`kiosk-report-ip`, from the
#     analytics.alvear.cl repo) when the TV on/TV off button is pressed on
#     https://analytics.alvear.cl/fleet.php
#   - the optional on/off schedule in /etc/cron.d/kiosk-tv
#
# The Pi keeps running either way — only the panel sleeps.
#
# Needs /dev/cec0, so run as root (both callers above do).
#
#   kiosk-tv on       wake the TV, make the Pi the active source
#   kiosk-tv off      put the TV into standby
#   kiosk-tv status   print the TV's CEC power status
#
# Install:  sudo install -Dm755 kiosk-tv.sh /usr/local/bin/kiosk-tv
#
# Prefers libCEC's `cec-client` (apt: cec-utils). Falls back to the kernel
# `cec-ctl` (apt: v4l-utils) on images that don't package libCEC.
set -euo pipefail

have() { command -v "$1" >/dev/null 2>&1; }

no_tool() {
  echo "kiosk-tv: no CEC tool found — 'sudo apt install cec-utils' (or v4l-utils)" >&2
  exit 1
}

tv_on() {
  if have cec-client; then
    printf 'on 0\n'  | cec-client -s -d 1
    printf 'as\n'    | cec-client -s -d 1   # become the active source (input switch)
  elif have cec-ctl; then
    cec-ctl -s --playback >/dev/null
    cec-ctl -s --to 0 --image-view-on >/dev/null
  else
    no_tool
  fi
}

tv_off() {
  if have cec-client; then
    printf 'standby 0\n' | cec-client -s -d 1
  elif have cec-ctl; then
    cec-ctl -s --playback >/dev/null
    cec-ctl -s --to 0 --standby >/dev/null
  else
    no_tool
  fi
}

tv_status() {
  if have cec-client; then
    printf 'pow 0\n' | cec-client -s -d 1
  elif have cec-ctl; then
    cec-ctl -s --to 0 --give-device-power-status --timeout 2000
  else
    no_tool
  fi
}

case "${1:-}" in
  on)     logger -t kiosk-tv "TV on";  tv_on ;;
  off)    logger -t kiosk-tv "TV off"; tv_off ;;
  status) tv_status ;;
  *)      echo "usage: kiosk-tv {on|off|status}" >&2; exit 2 ;;
esac
