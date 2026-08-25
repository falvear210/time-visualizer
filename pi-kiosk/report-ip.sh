#!/usr/bin/env bash
# Reports this Pi's hostname/local IP to the central rpis.php dashboard so it
# can be found for SSH without walking up to the physical device. Run on a
# timer via report-ip.timer.
set -euo pipefail

REPORT_URL="https://fernando.alvear.cl/rpis/rpis.php"
SECRET_FILE="/etc/kiosk/report-secret"
LABEL_FILE="/etc/kiosk/label"

if [[ ! -f "$SECRET_FILE" ]]; then
  echo "report-ip: missing $SECRET_FILE -- see pi-kiosk/README.md" >&2
  exit 1
fi
SECRET="$(<"$SECRET_FILE")"

HOSTNAME="$(hostname)"
LABEL="$HOSTNAME"
[[ -f "$LABEL_FILE" ]] && LABEL="$(<"$LABEL_FILE")"

# /etc/machine-id is stable across reboots and unique per SD card image, so
# it survives a hostname change and won't collide if two Pis are cloned from
# the same image and later renamed.
DEVICE_ID="$(cut -c1-16 /etc/machine-id 2>/dev/null || echo "$HOSTNAME")"

LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ -z "$LOCAL_IP" ]]; then
  echo "report-ip: could not determine local IP (no network yet?)" >&2
  exit 1
fi

curl -fsS -m 10 \
  --data-urlencode "secret=$SECRET" \
  --data-urlencode "device_id=$DEVICE_ID" \
  --data-urlencode "hostname=$HOSTNAME" \
  --data-urlencode "label=$LABEL" \
  --data-urlencode "local_ip=$LOCAL_IP" \
  "$REPORT_URL" > /dev/null
