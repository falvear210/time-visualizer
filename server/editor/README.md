# The live editor (sluhtime.alvear.cl/edit/)

The editor pages (teacher rooms and Studium locations, which school events
the dashboards show) can save straight to the live site from
**https://sluhtime.alvear.cl/edit/**, behind a password that only Fernando
has. A save shows on the TVs within a minute (they re-read the data files),
with no deploy.

The public **/editor/** copy stays a read-only preview for coworkers
(`editor/preview-mode.js`).

## How it fits together

```
browser ── https://sluhtime.alvear.cl/edit/...  (nginx asks for the password)
             ├─ pages: htdocs/editor/ (the same files as /editor/)
             └─ /edit/api/...  ──►  sluhtime-editor.service on 127.0.0.1:8421
                                     = editor/server.py with SITE_ROOT=htdocs
                                     writes the data files in htdocs/
```

| file here | installed on server3 as |
|---|---|
| `nginx-editor.conf` | `/var/www/sluhtime.alvear.cl/conf/nginx/editor.conf` |
| `sluhtime-editor.service` | `/etc/systemd/system/sluhtime-editor.service` |
| `editor/server.py`, `scripts/school_events.py` | `/opt/sluhtime-editor/…` (copied by every `deploy.sh`) |
| (password) | `/etc/nginx/htpasswd-sluhtime-editor` (root:www-data, 640) |

The files the editor writes, all owned by www-data:
`math-next/math-teachers-s1.csv` and `-s2.csv`, `data/event-filter.json`,
`data/school-events.csv`, `data/source/school-events-catalog.json`,
`data/source/school_calendar_raw.ics` (nginx refuses to serve the `.ics`).

## Deploys don't overwrite online edits

`deploy.sh` first copies back any of those files that are newer on the
server than on this computer (and says so: "Pulled … commit it"), then
uploads as usual. So after editing online, the next deploy brings the edit
into git. If the same file was edited both online and with the local editor
since the last deploy, the newer one wins.

## Setting or changing the password

The password file starts empty, so nobody can log in until you run this
(it asks for the password twice; it's never stored anywhere else):

```bash
ssh -t root@server3.alvear.cl htpasswd /etc/nginx/htpasswd-sluhtime-editor fernando
```

No reload is needed. Run the same command again to change the password.

## Troubleshooting

```bash
ssh root@server3.alvear.cl systemctl status sluhtime-editor
ssh root@server3.alvear.cl journalctl -u sluhtime-editor -n 50
```

To turn the live editor off: `systemctl disable --now sluhtime-editor` (the
pages then show "Not saved" errors), or delete the nginx file and reload nginx.
