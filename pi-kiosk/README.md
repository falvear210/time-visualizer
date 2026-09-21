# Raspberry Pi kiosk setup

Turns a Raspberry Pi into an always-on kiosk showing the Math Office
dashboard, and reports the Pi's IP to a small fleet tracker so you can find
it to SSH in later without knowing its address ahead of time.

Two independent pieces:

- **Kiosk display** (`kiosk.sh`, `kiosk.service`) — boots straight into
  Chromium full-screen on `/math/`.
- **Fleet tracker** (`report-ip.service`, `report-ip.timer` here; the script
  and server live in `~/code/analytics.alvear.cl`) — the Pi phones home with
  its IP every minute and `https://analytics.alvear.cl/fleet.php` shows
  every Pi that's checked in, so you can SSH to a kiosk without knowing its
  address ahead of time. The dashboard's check-in reply doubles as a command
  channel: **TV on / TV off** (HDMI-CEC, §5), reboot, poweroff.

The kiosk display piece has been run end to end on real hardware (a 3B+,
2025); the Pi 5 caveats in section 1 are from documented differences, not yet
a second on-device run. The fleet check-in server is deployed and live on
server3.

> **Note (2026-09):** the original fleet tracker in this folder
> (`report-ip.sh`, `server/rpis.php`, `server/nginx-snippet.conf`) pointed at
> `fernando.alvear.cl/rpis/` and has been **retired** — that path is gone.
> The receiver + dashboard now ship with the `analytics.alvear.cl` project.
> Section 4 below is the current procedure.

## 1. Flash the SD card

Use **Raspberry Pi Imager**. For a 3B+ with 1GB RAM, pick **Raspberry Pi OS
Lite (64-bit)** — no desktop environment, since we're only ever running one
full-screen browser window. In the Imager's advanced options (gear icon),
set hostname, enable SSH, and set the Wi-Fi/locale so it's reachable
headless from first boot.

Give each Pi a distinct hostname (e.g. `pi-mathoffice`, `pi-mathoffice2`) —
it shows up in the fleet dashboard.

### Pi 5 notes

The tested path is the same on a Pi 5, with a few hardware caveats:

- **OS:** still **Raspberry Pi OS Lite (64-bit)** (Bookworm). A Pi 5 has the
  RAM to spare for the full desktop, but a single full-screen browser doesn't
  need it, and Lite keeps this the tested config. Chromium is packaged as
  `chromium` on Bookworm — `kiosk.sh` already checks for both names.
- **Power:** use the official **27 W USB-C PD** supply. On an underpowered
  supply the Pi 5 logs undervoltage warnings and down-clocks, which shows up
  as a sluggish kiosk.
- **Cooling:** for 24/7 use fit the active cooler (or a case with a fan). The
  nightly reboot in the reliability section matters more on a hot SoC.
- **Video:** micro-HDMI, same as Pi 4 — use the port nearest the USB-C jack
  (HDMI0). `kiosk.sh` already forces `--force-device-scale-factor=1`, which is
  still needed on the Pi 5's KMS driver.
- **Boot media:** SD is fine. If this Pi has an NVMe HAT, flashing to the SSD
  instead is a durability win for a device that runs for years, but nothing
  in this setup depends on it.

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
  matchbox-window-manager fonts-liberation2 fonts-noto-color-emoji cec-utils
```

(On Raspberry Pi OS Bookworm the package may just be called `chromium`
instead of `chromium-browser` — `kiosk.sh` checks for both. If `cec-utils`
isn't available on your image, install `v4l-utils` instead — `kiosk-tv`
falls back to its `cec-ctl`.)

`cec-utils` is for turning the TV on and off over HDMI-CEC (§5).

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

The check-in receiver (`fleet-report.php`) and dashboard (`fleet.php`) ship
with the **`analytics.alvear.cl`** project and are already deployed on
server3 — there is **no per-site server setup** and nothing to configure in
this repo. The Pi only needs to run the check-in script on a timer.

- **Dashboard:** `https://analytics.alvear.cl/fleet.php?key=<FLEET_VIEW_SECRET>`
  once (sets a `fleet_key` cookie; later visits need no `?key=`).
- **Both secrets** are in `~/code/analytics.alvear.cl/server/fleet-config.php`.
  The Pi gets `FLEET_REPORT_SECRET`; you type `FLEET_VIEW_SECRET` into the
  dashboard.

### Per-Pi side

The Pis have no repo checkout — everything is copied from your Mac. From
`~/code`, scp all five files to the Pi (swap `<user>@<pi>` for the real target,
e.g. `falvear@pi-mathoffice`):

```bash
scp analytics.alvear.cl/scripts/report-ip.sh \
    time-visualizer/pi-kiosk/kiosk-tv.sh \
    time-visualizer/pi-kiosk/kiosk-tv.cron \
    time-visualizer/pi-kiosk/report-ip.service \
    time-visualizer/pi-kiosk/report-ip.timer \
    <user>@<pi>:/tmp/
```

Then, on the Pi:

```bash
# 1. This Pi's check-in secret + label — FIRST-TIME SETUP ONLY.
#    Skip this whole block on a Pi that already checks in (see warning below).
sudo install -d -m700 /etc/kiosk
printf '%s' 'PASTE_FLEET_REPORT_SECRET' | sudo tee /etc/kiosk/report-secret >/dev/null
sudo chmod 600 /etc/kiosk/report-secret
echo 'Math Office Kiosk 2' | sudo tee /etc/kiosk/label >/dev/null

# 2. Scripts + the CEC tool (both scripts run as root from the timer)
sudo install -Dm755 /tmp/report-ip.sh /usr/local/bin/kiosk-report-ip
sudo install -Dm755 /tmp/kiosk-tv.sh  /usr/local/bin/kiosk-tv
sudo apt install -y cec-utils          # or v4l-utils on images without it

# 3. Check-in timer, every minute
sudo cp /tmp/report-ip.service /tmp/report-ip.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now report-ip.timer

# 4. Optional: automatic TV on/off schedule (§5)
sudo install -m644 /tmp/kiosk-tv.cron /etc/cron.d/kiosk-tv
```

> **Never run step 1 on a Pi that already checks in.** The real
> `FLEET_REPORT_SECRET` is the 63-hex-char value in
> `analytics.alvear.cl/server/fleet-config.php` (`grep FLEET_REPORT_SECRET` it
> on your Mac). Writing the literal `PASTE_FLEET_REPORT_SECRET` — or leaving any
> placeholder — overwrites a working secret, and every check-in then 403s
> (`curl: (22) ... error: 403` in the journal). To recover: put the real hex
> value back and `sudo systemctl start report-ip.service`.

The timer runs as **root**, which is what lets the check-in act on the
dashboard's TV-power / reboot / poweroff buttons (§5). Don't move it to a user
crontab.

**Adding TV power to a Pi that's already on the fleet** (e.g. an existing
kiosk): do the scp above, then only steps 2–4 — step 1 is already done and must
be left alone.

Check it worked:

```bash
sudo systemctl start report-ip.service   # fire one check-in immediately
sudo journalctl -u report-ip.service -n 20
```

...then load the dashboard — the Pi should appear with an online dot, its
hostname, label, LAN IP (to SSH into) and public IP. Blank/wrong secret is a
403; a non-IP `local_ip` (no network yet) is a 400.

## 5. TV power (HDMI-CEC)

Turn the TV on and off from the Pi over the HDMI cable — the Pi keeps running,
only the panel sleeps. The `kiosk-tv` helper and `cec-utils` are installed in
§4 (step 2); this section is the TV-side setup and the two ways to trigger it.

**Enable CEC on the TV.** It's off by default and hidden under a brand name —
*Anynet+* (Samsung), *Bravia Sync* (Sony), *SimpLink* (LG), *Viera Link*
(Panasonic), *EasyLink* (Philips). The HDMI port label (`HDMI3`, `eARC`, …)
doesn't matter; CEC is on every port.

**Check it reaches the TV** (as root — the timer runs `kiosk-tv` as root):

```bash
echo 'scan' | sudo cec-client -s -d 1   # should list the TV, not just the Pi
sudo kiosk-tv off      # TV to standby
sudo kiosk-tv on       # wake it, switch input back to the Pi
sudo kiosk-tv status   # CEC power state
```

If `scan` shows only the Pi, CEC isn't enabled on the TV (or on that input). If
`kiosk-tv off` works but `on` doesn't, your TV ignores CEC wake (some do) — the
schedule's morning "on" won't help and you'll need the TV's own *On Timer*, but
the "off" half still works.

Latency note: a dashboard button press is queued and acted on at the Pi's *next*
check-in, so allow up to ~1 min between click and the TV reacting.

### Trigger 1 — buttons on the fleet dashboard

`https://analytics.alvear.cl/fleet.php` has **TV on / TV off** (and Reboot /
Power off) per Pi. A press is queued and the Pi picks it up on its next
check-in (≤ ~1 min). `report-ip.sh` calls `kiosk-tv` for the TV commands, so
just having `/usr/local/bin/kiosk-tv` installed is enough — nothing else to
wire up.

### Trigger 2 — a fixed on/off schedule

`kiosk-tv.cron` (installed in §4 step 4 as `/etc/cron.d/kiosk-tv`) is TV
**off 17:00, on 06:30, Mon–Fri**, `America/Chicago`. To change the times or
timezone, edit `/etc/cron.d/kiosk-tv` in place — cron picks up changes within a
minute, no reload needed.

The buttons and the schedule are independent — run either, or both.

**Check the schedule is live:**

```bash
# 1. The file is installed and readable, root-owned, mode 644
ls -l /etc/cron.d/kiosk-tv && cat /etc/cron.d/kiosk-tv

# 2. cron parsed it — no "bad minute" / parse errors, and it logs each run
journalctl -u cron --since today | grep -i kiosk-tv

# 3. The Pi's clock/timezone is what you think it is (times are CRON_TZ, or
#    system-local if you removed that line)
timedatectl

# 4. Force a run now, without waiting for 17:00
sudo /usr/local/bin/kiosk-tv off   # then `... on`
```

If `journalctl -u cron` shows nothing, cron isn't installed/running
(`sudo apt install -y cron && sudo systemctl enable --now cron`) or the file has
a syntax error — every line needs the `user` field (`root`) between the time
spec and the command, which `/etc/cron.d/*` requires and a normal crontab
doesn't.

After 17:00 or 06:30 passes, confirm it actually fired — `kiosk-tv` logs each
run to syslog with tag `kiosk-tv`, and cron logs the command line it launched:

```bash
journalctl -t kiosk-tv --since today       # "TV off" / "TV on" from the helper
journalctl -u cron --since today | grep kiosk-tv   # the cron line that ran it
```

### If the kiosk comes back at the wrong resolution

A few TVs drop the HDMI hotplug line in standby, so X reconfigures when the TV
wakes. If you hit that, force the mode by adding `video=HDMI-A-1:1920x1080@60D`
to `/boot/firmware/cmdline.txt` (one line, space-separated) and rebooting.

## 6. Choosing a dashboard font

Raspberry Pi OS Lite ships almost no fonts, so the dashboard's font stack
(`-apple-system, "Segoe UI", Roboto, …`) matches nothing on the Pi and
Chromium falls back to a plain face that looks worse than it does on a Mac.
`font-test.html` in this folder is a full-screen card that shows the real
dashboard layout, at the real kiosk sizes, cycling through candidate fonts so
you can judge them on the actual screen.

It's a single self-contained file — five of the candidates (Inter, Source Sans
3, IBM Plex Sans, Public Sans, Figtree) are baked in as `woff2` data URIs and
render identically on the Pi and on your Mac with nothing installed. The rest
are `apt`-installable system fonts; each chip says whether that package is
present on this Pi.

It auto-cycles every 7 s, so it works on a cursor-less screen with no input.
With a keyboard attached: **Space** pause, **← / →** step, **G** toggle an
all-fonts contact sheet.

### Rebuilding it

Only needed if you edit the layout or the candidate list:

```bash
python3 pi-kiosk/build_font_test.py   # reads font-test-src/, writes font-test.html
```

`font-test-src/` holds the template and the raw `woff2` files (latin-subset
variable fonts pulled from Google Fonts).

### Showing it on a kiosk

Copy it over and point the kiosk at it instead of the dashboard, then put the
URL back when you've chosen:

```bash
scp pi-kiosk/font-test.html <pi>:/home/<user>/font-test.html
```

On the Pi, edit `DASHBOARD_URL` at the top of `/usr/local/bin/kiosk.sh` to:

```sh
DASHBOARD_URL="file:///home/<user>/font-test.html"
```

then `sudo reboot`. When you're done, set `DASHBOARD_URL` back to
`https://sluhtime.alvear.cl/math/` and reboot again.

### Applying your choice

- **An embedded font (Inter etc.):** best rendering, identical everywhere.
  Copy that `woff2` from `font-test-src/` into the site, add an `@font-face`
  to `math-office.css`, and put the family first in the `font-family` stack.
- **An `apt` font:** `sudo apt install <the package the chip named>` on each
  Pi, then put that family first in the `math-office.css` stack (keep the
  existing entries after it as the Mac/Windows fallback).

### Making the Pi render text crisply

The dashboard stack is `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
sans-serif` — on a Mac the first entry wins (San Francisco); on the Pi the
first three don't exist, so **Roboto** is used if it's installed. Two things
make small text on the Pi look softer than the same screen driven by a Mac,
and both are fixed on the Pi (not in this repo):

1. **Install the *hinted* Roboto.** The plain `fonts-roboto` metapackage pulls
   the *unhinted* build, which is the blurry one at small sizes:

   ```bash
   sudo apt install -y --no-install-recommends fonts-roboto-hinted \
     || sudo apt install -y --no-install-recommends fonts-roboto
   ```

2. **Turn on hinting + subpixel rendering in fontconfig.** Raspberry Pi OS
   defaults to slight hinting and grayscale antialiasing; this switches on
   full LCD subpixel rendering, which is what closes most of the gap:

   ```bash
   sudo tee /etc/fonts/local.conf >/dev/null <<'EOF'
   <?xml version="1.0"?>
   <!DOCTYPE fontconfig SYSTEM "fonts.dtd">
   <fontconfig>
     <match target="font">
       <edit name="antialias" mode="assign"><bool>true</bool></edit>
       <edit name="hinting"   mode="assign"><bool>true</bool></edit>
       <edit name="hintstyle" mode="assign"><const>hintslight</const></edit>
       <edit name="rgba"      mode="assign"><const>rgb</const></edit>
       <edit name="lcdfilter" mode="assign"><const>lcddefault</const></edit>
     </match>
   </fontconfig>
   EOF
   sudo fc-cache -f
   sudo reboot
   ```

   Chromium reads these through fontconfig at startup, hence the reboot. If
   text ends up with faint colour fringes (some TV panels aren't RGB-ordered)
   set `rgba` to `none`; if it still looks soft, step `hintstyle` up to
   `hintmedium` then `hintfull`.

The small labels/rows on the dashboard were also bumped up a step in
`math-office.css` (2026-09) so they read from across the room — that part
ships with a normal `deploy.sh`.

## Notes

- The "local IP" reported is the source address the Pi uses to reach its
  default gateway (`ip route get`), so it stays correct even if a Pi has both
  Ethernet and Wi-Fi up at once.
- The dashboard only tells you IPs *within the Pi's own LAN*. If a kiosk is
  at a different physical site than you are, you'll still need to be on
  that site's network (or VPN'd into it) to actually SSH to the reported
  address — this tool solves "which IP is it," not "how do I reach that
  network."
