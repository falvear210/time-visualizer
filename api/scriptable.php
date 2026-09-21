<?php
// Serves sluh-period.scriptable as a proper download so iOS Safari offers
// "Open in Scriptable" (which imports it as a new script -- no typing, no
// copy/paste). Open https://sluhtime.alvear.cl/api/scriptable.php on the
// phone.  Regenerate the bundle with: python3 api/build-scriptable.py
$path = __DIR__ . '/sluh-period.scriptable';
if (!is_file($path)) {
    http_response_code(404);
    header('Content-Type: text/plain');
    echo "sluh-period.scriptable missing -- run api/build-scriptable.py\n";
    exit;
}
header('Content-Type: application/octet-stream');
header('Content-Disposition: attachment; filename="SLUH Period.scriptable"');
header('Content-Length: ' . filesize($path));
header('Cache-Control: no-store');
readfile($path);
