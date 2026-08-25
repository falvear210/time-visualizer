<?php
declare(strict_types=1);

// Fleet tracker for kiosk Raspberry Pis. Each Pi POSTs its hostname/local IP
// here on a timer (see ../report-ip.sh); this page shows the latest report
// from every Pi so you can find one to SSH into without walking up to it.
//
// Deploy: upload rpis.php to somewhere like fernando.alvear.cl/rpis/, then
// add the nginx location block in nginx-snippet.conf (see README.md) so
// rpis_data.json can't be fetched directly. No chmod +x needed -- PHP files
// just need to be readable by the web server; php-fpm is what executes
// them, not the file's execute bit.

// ---- config -------------------------------------------------------------
// Change both secrets before deploying, then put REPORT_SECRET in
// /etc/kiosk/report-secret on every Pi (see ../report-ip.sh).
const REPORT_SECRET = 'REPLACE_WITH_A_LONG_RANDOM_STRING_1';
const VIEW_SECRET = 'REPLACE_WITH_A_LONG_RANDOM_STRING_2';

// A Pi stops showing as "online" after this many seconds without a report.
const ONLINE_WINDOW_SECONDS = 5 * 60;

const DATA_FILE = __DIR__ . '/rpis_data.json';
const VIEW_COOKIE = 'rpis_key';

// ---- storage --------------------------------------------------------------

function load_devices(): array {
    if (!file_exists(DATA_FILE)) return [];
    $fh = fopen(DATA_FILE, 'r');
    if (!$fh) return [];
    flock($fh, LOCK_SH);
    $raw = stream_get_contents($fh);
    flock($fh, LOCK_UN);
    fclose($fh);
    $data = json_decode($raw !== false && $raw !== '' ? $raw : '[]', true);
    return is_array($data) ? $data : [];
}

function save_devices(array $devices): void {
    $fh = fopen(DATA_FILE, 'c');
    if (!$fh) return;
    flock($fh, LOCK_EX);
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($devices, JSON_PRETTY_PRINT));
    fflush($fh);
    flock($fh, LOCK_UN);
    fclose($fh);
}

function relative_time(int $seconds): string {
    if ($seconds < 60) return $seconds . 's ago';
    if ($seconds < 3600) return intdiv($seconds, 60) . 'm ago';
    if ($seconds < 86400) return intdiv($seconds, 3600) . 'h ago';
    return intdiv($seconds, 86400) . 'd ago';
}

// ---- ingest: a Pi reporting in (POST) --------------------------------------

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    header('Content-Type: application/json');

    $secret = (string)($_POST['secret'] ?? '');
    if (!hash_equals(REPORT_SECRET, $secret)) {
        http_response_code(403);
        echo json_encode(['error' => 'bad secret']);
        exit;
    }

    $deviceId = trim((string)($_POST['device_id'] ?? ''));
    $hostname = trim((string)($_POST['hostname'] ?? ''));
    $label    = trim((string)($_POST['label'] ?? '')) ?: $hostname;
    $localIp  = trim((string)($_POST['local_ip'] ?? ''));

    if ($deviceId === '' || $hostname === '' || $localIp === '') {
        http_response_code(400);
        echo json_encode(['error' => 'missing fields']);
        exit;
    }

    $devices = load_devices();
    $now = time();
    $devices[$deviceId] = [
        'hostname'   => $hostname,
        'label'      => $label,
        'local_ip'   => $localIp,
        'public_ip'  => $_SERVER['REMOTE_ADDR'] ?? '',
        'first_seen' => $devices[$deviceId]['first_seen'] ?? $now,
        'last_seen'  => $now,
    ];
    save_devices($devices);

    echo json_encode(['ok' => true]);
    exit;
}

// ---- view: the dashboard (GET) ---------------------------------------------

$key = (string)($_GET['key'] ?? ($_COOKIE[VIEW_COOKIE] ?? ''));
if (!hash_equals(VIEW_SECRET, $key)) {
    http_response_code(403);
    ?>
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Raspberry Pi Fleet</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
  <form method="get" style="max-width:320px;margin:4rem auto;">
    <label>Key: <input type="password" name="key" autofocus autocomplete="off"></label>
    <button type="submit">View</button>
  </form>
</body>
</html>
    <?php
    exit;
}

// Remember the key so future visits don't need ?key= in the URL.
setcookie(VIEW_COOKIE, $key, [
    'expires' => time() + 30 * 24 * 3600,
    'path' => '/',
    'secure' => !empty($_SERVER['HTTPS']),
    'httponly' => true,
    'samesite' => 'Lax',
]);

$devices = load_devices();
uasort($devices, fn($a, $b) => $b['last_seen'] <=> $a['last_seen']);
$now = time();
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="20">
<title>Raspberry Pi Fleet</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.4rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
  th, td { text-align: left; padding: 0.5rem 0.7rem; border-bottom: 1px solid #ddd; }
  th { color: #666; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; }
  .online .dot { background:#2e8b57; }
  .offline .dot { background:#bbb; }
  .offline td { color: #999; }
  .empty { color:#999; margin-top:2rem; }
  code { background:#f2f2f2; padding:0.15rem 0.4rem; border-radius:4px; }
</style>
</head>
<body>
<h1>Raspberry Pi Fleet</h1>
<?php if (!$devices): ?>
  <p class="empty">No Pis have reported in yet.</p>
<?php else: ?>
<table>
  <tr><th></th><th>Label</th><th>Hostname</th><th>Local IP</th><th>Public IP</th><th>Last seen</th></tr>
  <?php foreach ($devices as $d):
      $age = $now - (int)$d['last_seen'];
      $online = $age <= ONLINE_WINDOW_SECONDS;
  ?>
  <tr class="<?= $online ? 'online' : 'offline' ?>">
    <td><span class="dot"></span></td>
    <td><?= htmlspecialchars($d['label']) ?></td>
    <td><?= htmlspecialchars($d['hostname']) ?></td>
    <td><code><?= htmlspecialchars($d['local_ip']) ?></code></td>
    <td><code><?= htmlspecialchars($d['public_ip']) ?></code></td>
    <td><?= htmlspecialchars(relative_time($age)) ?></td>
  </tr>
  <?php endforeach; ?>
</table>
<?php endif; ?>
</body>
</html>
