# Raspberry Pi kiosk setup

Turns a Raspberry Pi into an always-on kiosk showing the Math Office
dashboard, and reports the Pi's IP to a small fleet tracker so you can find
it to SSH in later without knowing its address ahead of time.

Two independent pieces:

- **Kiosk display** (`kiosk.sh`, `kiosk.service`) — boots straight into
  Chromium full-screen on `math-office.html`.
- **Fleet tracker** (`report-ip.sh`, `report-ip.service`, `report-ip.timer`,
  `server/rpis.php`) — the Pi phones home with its IP every 2 minutes; a PHP
  page on your own site shows every Pi that's checked in.

None of this has been tested on real hardware — it's built from documented,
standard patterns (systemd + `startx`, since Raspberry Pi OS Lite has no
display manager), but the on-device steps below need to actually be run on a
Pi to confirm they work end to end.

## 1. Flash the SD card

Use **Raspberry Pi Imager**. For a 3B+ with 1GB RAM, pick **Raspberry Pi OS
Lite (64-bit)** — no desktop environment, since we're only ever running one
full-screen browser window. In the Imager's advanced options (gear icon),
set hostname, enable SSH, and set the Wi-Fi/locale so it's reachable
headless from first boot.

Give each Pi a distinct hostname (e.g. `pi-mathoffice`) — it shows up in the
fleet dashboard.

## 2. Install packages

```bash
sudo apt update
sudo apt install -y --no-install-recommends xserver-xorg x11-xserver-utils xinit chromium-browser curl
```

(On Raspberry Pi OS Bookworm the package may just be called `chromium`
instead of `chromium-browser` — `kiosk.sh` checks for both.)

## 3. Set up the kiosk display

```bash
sudo cp kiosk.sh /usr/local/bin/kiosk.sh
sudo chmod +x /usr/local/bin/kiosk.sh
sudo cp kiosk.service /etc/systemd/system/kiosk.service
sudo systemctl daemon-reload
sudo systemctl enable --now kiosk.service
```

Edit `DASHBOARD_URL` at the top of `kiosk.sh` first if it should point
somewhere other than the SLUH Math Office dashboard.

`kiosk.service` runs `startx` as the `pi` user directly from systemd (no
desktop autologin needed) and restarts Chromium if it ever crashes. If
`systemctl status kiosk` shows it failing to grab the display (a known rough
edge on some OS versions — errors like "Failed to open /dev/tty0" or PAM
issues), the fallback is the older autologin approach:

1. `sudo raspi-config` → **System Options → Boot / Auto Login → Console
   Autologin**.
2. Append to `~/.bash_profile` on the `pi` user:
   ```bash
   if [ -z "$DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
     startx -- -nocursor
   fi
   ```
3. Create `~/.xinitrc`:
   ```sh
   #!/bin/sh
   exec /usr/local/bin/kiosk.sh
   ```
4. `sudo systemctl disable kiosk.service` (don't run both).

### Reliability extras

Nightly reboot keeps a kiosk that runs 24/7 healthy over months:

```bash
echo "0 3 * * * root /sbin/reboot" | sudo tee /etc/cron.d/kiosk-reboot
```

## 4. Set up the fleet tracker (find-my-Pi)

### Server side (once, not per-Pi)

This assumes nginx via WordOps (`wo`), not Apache — the earlier `.htaccess`
approach doesn't apply here since nginx never reads `.htaccess` files at all.

1. Confirm `fernando.alvear.cl` already has PHP wired up: run
   `wo site info fernando.alvear.cl` (or `cat /etc/nginx/sites-available/fernando.alvear.cl`
   and look for an `include common/php*.conf;` line). If it's a plain
   `html`-type WordOps site with no PHP, `rpis.php` will get served back as
   plain text instead of executing — which would leak your secrets straight
   out of the source. Enable PHP for the site first if it's missing (the
   exact `wo site update` flag for adding PHP has changed across WordOps
   versions, so check `wo site update --help` on your box for the current
   one, e.g. something like `wo site update fernando.alvear.cl --php`).
2. Pick two long random secrets — e.g. run `openssl rand -hex 24` twice, one
   for reporting and one for viewing.
3. Edit `server/rpis.php`, replacing `REPORT_SECRET` and `VIEW_SECRET` with
   those values.
4. Upload `server/rpis.php` to your site, e.g. into a `rpis/` subfolder of
   `fernando.alvear.cl`'s webroot. No `chmod +x` needed — PHP files just
   need to be readable by the web server; php-fpm is what executes them,
   not the file's execute bit (that's only for scripts the OS itself runs
   directly, like `kiosk.sh` or `report-ip.sh` below).
5. Add the block from `server/nginx-snippet.conf` to that site's nginx vhost
   (`/etc/nginx/sites-available/fernando.alvear.cl` under WordOps), adjusting
   the path if you didn't use a `rpis/` subfolder, then
   `sudo nginx -t && sudo systemctl reload nginx`.
6. Visit `https://fernando.alvear.cl/rpis/rpis.php` in a browser and check
   view-source — if you see raw `<?php` text instead of an HTML page or the
   key prompt, PHP isn't executing for that path; go back to step 1.
7. Visit `https://fernando.alvear.cl/rpis/rpis.php?key=<your VIEW_SECRET>`
   once — it sets a cookie so you won't need `?key=` on later visits from
   the same browser.
8. Confirm the deny rule actually works:
   `curl -i https://fernando.alvear.cl/rpis/rpis_data.json` should come back
   403 or 404, never the raw JSON.
9. Make sure the `rpis/` directory is writable by the web server user (it
   creates `rpis_data.json` there on first report) — under WordOps that's
   usually the `www-data` user, matching whatever owns the rest of the
   site's files.

### Per-Pi side

```bash
sudo mkdir -p /etc/kiosk
echo "<your REPORT_SECRET>" | sudo tee /etc/kiosk/report-secret >/dev/null
sudo chmod 600 /etc/kiosk/report-secret
cp label.example /tmp/label && sudo mv /tmp/label /etc/kiosk/label
sudo nano /etc/kiosk/label   # give this specific Pi a human-readable name

sudo cp report-ip.sh /usr/local/bin/report-ip.sh
sudo chmod +x /usr/local/bin/report-ip.sh
sudo cp report-ip.service report-ip.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now report-ip.timer
```

Before that, edit `REPORT_URL` at the top of `report-ip.sh` to match wherever
you actually uploaded `rpis.php`.

Check it worked:

```bash
sudo systemctl start report-ip.service   # fire one report immediately
sudo journalctl -u report-ip.service -n 20
```

...then load the dashboard URL — the Pi should appear with a green dot,
its hostname, label, and local IP to SSH into.

## Notes

- The "local IP" reported is whatever `hostname -I` returns first — fine for
  a Pi with a single active NIC (the normal kiosk case). If a Pi ever has
  both Ethernet and Wi-Fi up at once, double check which IP comes back.
- The dashboard only tells you IPs *within the Pi's own LAN*. If a kiosk is
  at a different physical site than you are, you'll still need to be on
  that site's network (or VPN'd into it) to actually SSH to the reported
  address — this tool solves "which IP is it," not "how do I reach that
  network."
