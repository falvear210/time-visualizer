# Server setup

Files here are **installed on the web host by hand, once** — `deploy.sh`
skips this whole directory. The host is `server3.alvear.cl`, running nginx
via [WordOps](https://wordops.net/) (`wo`), same as the pi-kiosk fleet
tracker.

| file | what it's for |
|---|---|
| `nginx-redirect.conf` | 301 from the old `static.alvear.cl/sluh-time-visualizer/` URL to the new subdomain. Pasted into the **static.alvear.cl** vhost. |
| `legacy-redirect/index.html` | no-nginx-change backstop for the old directory (see comments in the file). |
| `nginx-office-folders.conf` | 301 from the pre-folder dashboard URLs (`/math-office.html`, `/mcl-office.html`) to `/math/` and `/mcl/`. Pasted into the **sluhtime.alvear.cl** vhost. Optional — the redirect stubs still sitting at those paths do the same job in the browser. |
| `nginx-stats.conf` | optional — belt-and-suspenders deny rule for the stats dotfiles. Usually not needed (WordOps already denies dotfiles). |

The **stats endpoint** (`../stats.php` + `../stats.js`) *is* shipped by
`deploy.sh`, and `deploy.sh` also does its one-time setup — see
"[The stats endpoint](#the-stats-endpoint)" below.

---

## Moving the site to `sluhtime.alvear.cl`

The site moved off a subfolder of `static.alvear.cl` and onto its own
subdomain so the host can run **PHP** for it (a plain WordOps `html` site
serves `.php` as text — which would leak source). Do this once:

### 1. DNS

Add an `A` (or `CNAME`) record for `sluhtime.alvear.cl` pointing at the
same place `static.alvear.cl` resolves to. Wait for it to propagate
(`dig +short sluhtime.alvear.cl`).

### 2. Create the PHP site

```bash
wo site create sluhtime.alvear.cl --php83 -le
```

`--php83` makes it a PHP site (check `wo site create --help` on the box for
the exact current flag — it's varied across WordOps versions). `-le` gets a
Let's Encrypt cert. Docroot lands at `/var/www/sluhtime.alvear.cl/htdocs/`.

Confirm PHP actually executes before trusting it with anything:

```bash
echo '<?php echo "php ok\n";' > /var/www/sluhtime.alvear.cl/htdocs/_phptest.php
curl -s https://sluhtime.alvear.cl/_phptest.php   # must print "php ok", not the source
rm /var/www/sluhtime.alvear.cl/htdocs/_phptest.php
```

### 3. Deploy the site

From the repo root, on your laptop:

```bash
./deploy.sh
```

`deploy.sh` already points `REMOTE_PATH` at the new docroot. Then check
<https://sluhtime.alvear.cl/> and <https://sluhtime.alvear.cl/math/>.

### 4. Wire up the old-URL redirect

Paste the contents of `nginx-redirect.conf` into the **static.alvear.cl**
vhost (`/etc/nginx/sites-available/static.alvear.cl`), inside its
`server { ... }` block, then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Check:

```bash
curl -sI https://static.alvear.cl/sluh-time-visualizer/            # 301 -> https://sluhtime.alvear.cl/
curl -sI https://static.alvear.cl/sluh-time-visualizer/math-office.html   # 301 -> .../math-office.html
```

### 5. Clear out the old directory

Once the redirect is confirmed, replace the stale copy of the site with the
one-file backstop (see the comment header in `legacy-redirect/index.html`):

```bash
cd /var/www/static.alvear.cl/htdocs/sluh-time-visualizer/
rm -rf ./*
# then copy legacy-redirect/index.html into this directory
```

### 6. Update the kiosk Pis

`pi-kiosk/kiosk.sh` now points at `https://sluhtime.alvear.cl/math/`.
Re-copy it to each Pi (`sudo cp kiosk.sh /usr/local/bin/kiosk.sh`) and
reboot, or just let the old URL redirect — Chromium follows the 301 fine.

---

## Moving the dashboards into folders

The two wall displays used to be flat files at `/math-office.html` and
`/mcl-office.html`. They now live at `/math/` and `/mcl/`, so every SLUH
Time project can sit at a URL ending in `/`.

Nothing here is required — `deploy.sh` ships a redirect stub at each old
path, so old bookmarks and any kiosk still on the old URL keep working on
their own. Install `nginx-office-folders.conf` only if you want a real 301
(better for search engines, and one less round trip for the kiosks).

It goes in as its own include file — the vhost ends with
`include /var/www/sluhtime.alvear.cl/conf/nginx/*.conf;`, so there is no
vhost to edit and `wo` updates can't clobber it. One command from your
laptop writes it, tests it, reloads nginx and verifies the result; re-running
it just rewrites the same file:

```bash
ssh -i ~/.ssh/id_rsa root@server3.alvear.cl bash -s <<'EOF'
set -e
cat > /var/www/sluhtime.alvear.cl/conf/nginx/office-folders.conf <<'CONF'
# Redirect the old flat dashboard URLs to their new folders.
# Source of truth: server/nginx-office-folders.conf in the time-visualizer repo.
# nginx re-appends the original query string; the URL #hash never leaves the
# browser -- so deep links survive on their own.
location = /math-office.html { return 301 https://sluhtime.alvear.cl/math/; }
location = /mcl-office.html  { return 301 https://sluhtime.alvear.cl/mcl/; }

# Never cache index.html -- the ?v= cache-busters on JS/CSS only work if the
# HTML that references them is always fresh. A stale cached index.html that
# references old ?v= numbers loads new JS against old DOM elements and crashes.
location ~ ^/(math|mcl)/index\.html$ { expires -1; add_header Cache-Control "no-cache, must-revalidate"; }
location = /math/ { expires -1; add_header Cache-Control "no-cache, must-revalidate"; }
location = /mcl/  { expires -1; add_header Cache-Control "no-cache, must-revalidate"; }
location = /      { expires -1; add_header Cache-Control "no-cache, must-revalidate"; }
CONF
nginx -t && systemctl reload nginx
for u in math-office.html mcl-office.html math/ mcl/; do
  printf '%-22s %s\n' "/$u" "$(curl -s -o /dev/null -w '%{http_code}' "https://sluhtime.alvear.cl/$u")"
done
EOF
```

Expect `301`, `301`, `200`, `200`. Without the block the first two answer
`200` instead — that's the redirect stub doing the job in the browser.

Note the old `static.alvear.cl/sluh-time-visualizer/math-office.html` now
takes two hops (to `sluhtime.alvear.cl/math-office.html`, then to
`/math/`). That's fine, and not worth a special-case rule.

---

## The stats endpoint

A tiny, self-hosted usage counter — no third-party analytics.

- **`../stats.js`** — loaded by `index.html` and `/math/`. On each
  page load it `sendBeacon`s a handful of fields to `stats.php`: which page,
  which landing view, light/dark, desktop/mobile, whether the "my periods"
  filter is on, and a random id it keeps in `localStorage` so distinct
  browsers can be counted. **No IP, no cookie, no referrer, no names.**
- **`../stats.php`** — receives those beacons (`POST`, bumps counters) and
  serves the dashboard (`GET`, behind a key). Keeps only aggregates, in two
  dotfiles next to itself:
  - `.stats-key.txt` — the dashboard view key
  - `.stats-data.json` — the counters (rolling 120-day detail)

Both are `rsync --exclude`d, so deploys never touch the collected data.

### Setup — it's automatic

`deploy.sh` runs it on every deploy (over SSH, as root):

- generates `.stats-key.txt` with `openssl rand -hex 24` **the first time**,
  and prints the key — copy it from that deploy's output
- `chown www-data` + sane perms on both dotfiles so php-fpm can read/write

So: run `./deploy.sh`, grab the printed key, then open

```
https://sluhtime.alvear.cl/stats.php?key=THEKEY
```

once — it sets a 30-day cookie, so later visits are just
`https://sluhtime.alvear.cl/stats.php`.

Lost the key? `cat /var/www/sluhtime.alvear.cl/htdocs/.stats-key.txt` on the
server, or `rm` it and re-deploy to roll a new one.

### Check the dotfiles aren't public

```bash
curl -sI https://sluhtime.alvear.cl/.stats-data.json   # expect 403
curl -sI https://sluhtime.alvear.cl/.stats-key.txt     # expect 403
```

WordOps denies dotfiles out of the box, so these should already be 403. If
either returns 200, add `nginx-stats.conf` to the vhost (see that file).
