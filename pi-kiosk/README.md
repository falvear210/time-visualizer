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

The kiosk display piece has been run end to end on real hardware (a 3B+); the
fleet tracker piece is still untested on-device and built from documented,
standard patterns.

## 1. Flash the SD card

Use **Raspberry Pi Imager**. For a 3B+ with 1GB RAM, pick **Raspberry Pi OS
Lite (64-bit)** — no desktop environment, since we're only ever running one
full-screen browser window. In the Imager's advanced options (gear icon),
set hostname, enable SSH, and set the Wi-Fi/locale so it's reachable
headless from first boot.

Give each Pi a distinct hostname (e.g. `pi-mathoffice`) — it shows up in the
fleet dashboard.

### Enterprise Wi-Fi (username + password networks)

The Imager's Wi-Fi field only handles a plain WPA2-PSK network (a single
shared password). If your network is WPA2/WPA3-**Enterprise** (it asks for a
username *and* a password — common on school/office networks), the Imager
can't configure it headlessly, so the Pi will boot without network access.
Skip the Wi-Fi field in the Imager and connect once with a keyboard + display
plugged into the Pi instead:

1. Log in at the console, then run `sudo nmtui`.
2. Choose **Activate a connection** (to see available networks) or
   **Edit a connection → Add → Wi-Fi** to create one, and select your SSID.
3. Under the connection's **Wi-Fi security** settings, set:
   - **Authentication**: `WPA & WPA2 Enterprise`, then for the method pick
     **PEAP** (the most common option for username/password networks).
   - **CA certificate**: leave blank / `(none)` unless your network admin
     gave you a specific certificate file.
   - **Inner authentication**: leave as `MSCHAPv2`.
   - **Username**: your network username.
   - **Password**: your network password.
   - **User certificate**, **Domain**, and **Private key**: leave all blank
     — those are only needed if the network requires a certificate file
     instead of a password.
4. Activate the connection. Once it's up you can pull the keyboard/display
   and finish everything else over SSH as usual.

## 2. Install packages

```bash
sudo apt update
sudo apt install -y --no-install-recommends xserver-xorg x11-xserver-utils xinit chromium-browser curl \
  matchbox-window-manager fonts-liberation2 fonts-noto-color-emoji
```

(On Raspberry Pi OS Bookworm the package may just be called `chromium`
instead of `chromium-browser` — `kiosk.sh` checks for both.)

`matchbox-window-manager` is a minimal window manager — without one, bare X
has nothing to grant Chromium's `--kiosk` fullscreen request, and the window
sticks to a fraction of the screen instead of covering it. `fonts-liberation2`
and `fonts-noto-color-emoji` give the dashboard a real sans-serif and working
emoji glyphs; Raspberry Pi OS Lite ships with neither, so text renders in a
generic fallback font and emoji show as blank boxes without them.

## 3. Set up the kiosk display

First edit `DASHBOARD_URL` at the top of `kiosk.sh` if it should point
somewhere other than the SLUH Math Office dashboard.

Raspberry Pi OS Lite has no display manager, so something needs to log a user
in at the console and start X. **Console autologin + `.xinitrc` is the path
that actually works** — a `kiosk.service` unit that calls `startx` directly
from systemd was tried first and reliably failed on real hardware in testing
(see the note below), so don't start there.

1. Enable autologin: `sudo raspi-config` → **System Options → Boot / Auto
   Login → Console Autologin** (or non-interactively:
   `sudo raspi-config nonint do_boot_behaviour B2`).
2. Append to `~/.bash_profile`, on whichever user account you set up as the
   login user (Raspberry Pi Imager lets you pick any username now — there's
   no default `pi` account to assume):
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
   (`chmod +x ~/.xinitrc`)
4. Install `kiosk.sh` itself:
   ```bash
   sudo cp kiosk.sh /usr/local/bin/kiosk.sh
   sudo chmod +x /usr/local/bin/kiosk.sh
   ```
5. `sudo reboot` and confirm Chromium comes up full-screen on the dashboard
   with no login prompt visible.

### `kiosk.service` (systemd + `startx`) — documented but broken in testing

`kiosk.service` runs `startx` as a given user directly from systemd, which
looked like a cleaner approach on paper (no desktop autologin needed) and is
still checked into this repo for reference. In testing on a 3B+ it failed two
different ways and was abandoned in favor of the autologin approach above:

- `status=217/USER` — the unit hardcodes `User=pi`/`Group=pi`, which doesn't
  exist if you set a different username in the Imager. Edit those two lines
  in the unit file to match your actual username.
- `status=1/FAILURE`, journal shows `Couldn't get a file descriptor
  referring to the console` — `startx` launched directly by systemd (no real
  login session behind it) can't grab a proper VT. This is the "known rough
  edge" that sends you to the autologin fallback; it was not resolved.

If you want to try it anyway: `sudo cp kiosk.service /etc/systemd/system/kiosk.service && sudo systemctl daemon-reload && sudo systemctl enable --now kiosk.service`,
then `systemctl status kiosk.service` / `sudo journalctl -u kiosk.service -n 50 --no-pager`
to see which of the above you hit. If you do get it working, `sudo systemctl disable kiosk.service`
before switching to (or falling back to) the autologin approach — don't run both.

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
