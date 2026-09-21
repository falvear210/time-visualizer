<?php
declare(strict_types=1);

/*
 * Usage stats for the SLUH Time Visualizer.
 *
 *   POST  -> a page beacon coming in (see stats.js). Bumps counters, no output.
 *   GET   -> the dashboard, behind a view key.
 *
 * Everything lives in two dotfiles next to this script (nginx/WordOps
 * denies dotfiles by default, so neither is web-reachable):
 *
 *   .stats-data.json   the aggregated counters (this script creates it)
 *   .stats-key.txt     one line: the dashboard view key
 *
 * `deploy.sh` creates .stats-key.txt on first deploy (and prints the
 * generated key) and keeps both files owned by the web-server user. It also
 * rsync-excludes both so a deploy never clobbers the collected data.
 *
 * Design notes:
 *  - Counters only. We never keep a row per hit, so the file stays tiny
 *    and there's nothing per-visit to leak.
 *  - "Unique browsers" = distinct random ids from stats.js, kept per day
 *    for a rolling 120-day window. No IP, no cookie, no fingerprint.
 *  - All dates/hours are America/Chicago, matching the rest of the site.
 */

const DATA_FILE = __DIR__ . '/.stats-data.json';
const KEY_FILE  = __DIR__ . '/.stats-key.txt';
const VIEW_COOKIE = 'tv_stats_key';

const TZ = 'America/Chicago';
const RETAIN_DAYS = 120;          // how many days of per-day detail to keep
const MAX_VIDS_PER_DAY = 5000;    // abuse guard on the per-day id list

const PAGES = ['index', 'math-office'];
const TABS  = ['progress', 'continuous', 'weekly', 'current', 'dashboard'];
const THEMES = ['light', 'dark'];
const DEVICES = ['desktop', 'mobile'];

// --------------------------------------------------------------------------
// storage
// --------------------------------------------------------------------------

function blank_data(string $today): array {
    return [
        'start'        => $today,
        'updated'      => time(),
        'total'        => 0,
        'new_browsers' => 0,
        'pages'        => array_fill_keys(PAGES, 0),
        'tabs'         => array_fill_keys(TABS, 0),
        'themes'       => array_fill_keys(THEMES, 0),
        'devices'      => array_fill_keys(DEVICES, 0),
        'filter'       => ['on' => 0, 'off' => 0],
        'hourly'       => array_fill(0, 24, 0),
        'weekday'      => array_fill(0, 7, 0),  // 0 = Sunday
        'daily'        => [],                    // "YYYY-MM-DD" => {hits, vids:[]}
    ];
}

function load_data(string $today): array {
    if (!is_file(DATA_FILE)) return blank_data($today);
    $raw = @file_get_contents(DATA_FILE);
    $data = $raw !== false && $raw !== '' ? json_decode($raw, true) : null;
    if (!is_array($data)) return blank_data($today);
    // be forgiving about a partially-shaped file
    return array_replace_recursive(blank_data($today), $data);
}

function save_data(array $data): bool {
    $fh = @fopen(DATA_FILE, 'c+');
    if (!$fh) return false;
    $ok = false;
    if (flock($fh, LOCK_EX)) {
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
        fflush($fh);
        flock($fh, LOCK_UN);
        $ok = true;
    }
    fclose($fh);
    return $ok;
}

function prune_daily(array $data): array {
    if (count($data['daily']) > RETAIN_DAYS) {
        ksort($data['daily']);
        $data['daily'] = array_slice($data['daily'], -RETAIN_DAYS, null, true);
    }
    return $data;
}

// --------------------------------------------------------------------------
// POST: a beacon coming in
// --------------------------------------------------------------------------

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    http_response_code(204); // beacon ignores the body; say nothing

    $now = new DateTime('now', new DateTimeZone(TZ));
    $today = $now->format('Y-m-d');

    $page = (string)($_POST['page'] ?? '');
    if (!in_array($page, PAGES, true)) return;

    $vid = preg_replace('/[^a-z0-9]/', '', strtolower((string)($_POST['v'] ?? '')));
    $vid = substr((string)$vid, 0, 32);

    $tab    = strtolower((string)($_POST['tab'] ?? ''));
    $theme  = (string)($_POST['theme'] ?? '');
    $device = (string)($_POST['device'] ?? '');
    $isNew  = ($_POST['nu'] ?? '') === '1';
    $filter = ($_POST['filter'] ?? '') === '1';

    $data = load_data($today);

    $data['total']++;
    $data['pages'][$page]++;
    $data['hourly'][(int)$now->format('G')]++;
    $data['weekday'][(int)$now->format('w')]++;
    $data['filter'][$filter ? 'on' : 'off']++;
    if ($isNew) $data['new_browsers']++;
    if ($page === 'index' && in_array($tab, TABS, true)) $data['tabs'][$tab]++;
    if (in_array($theme, THEMES, true))   $data['themes'][$theme]++;
    if (in_array($device, DEVICES, true)) $data['devices'][$device]++;

    if (!isset($data['daily'][$today])) $data['daily'][$today] = ['hits' => 0, 'vids' => []];
    $data['daily'][$today]['hits']++;
    if ($vid !== '' &&
        !in_array($vid, $data['daily'][$today]['vids'], true) &&
        count($data['daily'][$today]['vids']) < MAX_VIDS_PER_DAY) {
        $data['daily'][$today]['vids'][] = $vid;
    }

    $data['updated'] = time();
    save_data(prune_daily($data));
    return;
}

// --------------------------------------------------------------------------
// GET: the dashboard
// --------------------------------------------------------------------------

$expectedKey = is_file(KEY_FILE) ? trim((string)file_get_contents(KEY_FILE)) : '';

if ($expectedKey === '') {
    http_response_code(503);
    header('Content-Type: text/plain');
    echo "Stats dashboard not configured.\n\n";
    echo "Create " . KEY_FILE . " with a secret line in it, e.g.\n";
    echo "  openssl rand -hex 24 > " . KEY_FILE . "\n";
    echo "(deploy.sh does this for you on the next deploy.)\n";
    exit;
}

$providedKey = (string)($_GET['key'] ?? ($_COOKIE[VIEW_COOKIE] ?? ''));

if (!hash_equals($expectedKey, $providedKey)) {
    http_response_code(403);
    header('Content-Type: text/html; charset=utf-8');
    echo '<!doctype html><meta charset="utf-8"><title>Stats</title>';
    echo '<meta name="robots" content="noindex">';
    echo '<body style="font:16px/1.5 -apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">';
    echo '<form method="get" style="max-width:20rem;margin:15vh auto;text-align:center">';
    echo '<p>SLUH Time Visualizer — usage stats</p>';
    echo '<input type="password" name="key" autofocus autocomplete="off" placeholder="view key" ';
    echo 'style="padding:.5rem;width:100%;box-sizing:border-box">';
    echo '<button style="margin-top:.6rem;padding:.5rem 1rem">View</button>';
    echo '</form>';
    exit;
}

// good key -- remember it so ?key= isn't needed next time
setcookie(VIEW_COOKIE, $providedKey, [
    'expires'  => time() + 30 * 24 * 3600,
    'path'     => '/',
    'secure'   => !empty($_SERVER['HTTPS']),
    'httponly' => true,
    'samesite' => 'Lax',
]);

$now = new DateTime('now', new DateTimeZone(TZ));
$today = $now->format('Y-m-d');
$data = prune_daily(load_data($today));

// ---- derive the numbers the dashboard shows -------------------------------

$daily = $data['daily'];
ksort($daily);

/** distinct ids across the last $n calendar days (today back) */
$uniqueOver = function (int $n) use ($daily, $now): int {
    $seen = [];
    for ($i = 0; $i < $n; $i++) {
        $d = (clone $now)->modify("-$i day")->format('Y-m-d');
        foreach ($daily[$d]['vids'] ?? [] as $v) $seen[$v] = true;
    }
    return count($seen);
};
$hitsOver = function (int $n) use ($daily, $now): int {
    $sum = 0;
    for ($i = 0; $i < $n; $i++) {
        $d = (clone $now)->modify("-$i day")->format('Y-m-d');
        $sum += $daily[$d]['hits'] ?? 0;
    }
    return $sum;
};

$uniqueAll = [];
foreach ($daily as $d) foreach ($d['vids'] ?? [] as $v) $uniqueAll[$v] = true;
$uniqueAll = count($uniqueAll);

$collectDays = max(1, (new DateTime($data['start']))->diff($now)->days + 1);

// last 30 days as (label, hits, uniques) for the bar strip
$strip = [];
for ($i = 29; $i >= 0; $i--) {
    $dt = (clone $now)->modify("-$i day");
    $d = $dt->format('Y-m-d');
    $strip[] = [
        'dow'  => $dt->format('D'),
        'day'  => $dt->format('j'),
        'date' => $dt->format('M j, Y'),
        'hits' => $daily[$d]['hits'] ?? 0,
        'uniq' => count($daily[$d]['vids'] ?? []),
    ];
}

function h($s): string { return htmlspecialchars((string)$s, ENT_QUOTES); }

/** A percent for display or bar width -- floored, NEVER rounded up, so a bar
 *  can't read as full (or as "100%") until the thing it measures really is.
 *  Same rule as displayPct() in app.js. */
function pct_down(float $value, float $total): int {
    if ($total <= 0) return 0;
    return (int) min(100, floor($value / $total * 100));
}

/** one labelled proportional bar */
function bar_row(string $label, int $value, int $max, string $sub = ''): string {
    $pct = pct_down($value, $max);
    return '<div class="row">'
        . '<div class="row-label">' . h($label) . '</div>'
        . '<div class="track"><div class="fill" style="width:' . $pct . '%"></div></div>'
        . '<div class="row-val">' . number_format($value) . ($sub ? ' <span class="dim">' . h($sub) . '</span>' : '') . '</div>'
        . '</div>';
}

$maxPage = max(1, ...array_values($data['pages']));
$maxTab  = max(1, ...array_values($data['tabs']));
$maxHour = max(1, ...$data['hourly']);
$maxWday = max(1, ...$data['weekday']);
$maxStrip = max(1, ...array_map(fn($x) => $x['hits'], $strip));

$wdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
$filterTotal = max(1, $data['filter']['on'] + $data['filter']['off']);
$themeTotal  = max(1, array_sum($data['themes']));
$deviceTotal = max(1, array_sum($data['devices']));
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="300">
<title>Time Visualizer — Usage</title>
<style>
  :root {
    --accent: #005588;
    --navy: #003366;
    --ink: #222;
    --dim: #777;
    --line: #e5e5e0;
    --track: #eeeeee;
    --panel: #fff;
    --bg: #f7f7f4;
  }
  * { box-sizing: border-box; }
  body {
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: var(--ink); background: var(--bg);
    margin: 0; padding: 2rem 1rem 4rem;
  }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 1.3rem; color: var(--navy); margin: 0 0 .2rem; }
  .meta { color: var(--dim); font-size: .85rem; margin-bottom: 1.6rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: .7rem; margin-bottom: 1.8rem; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: .8rem .9rem; }
  .card .n { font-size: 1.6rem; font-weight: 600; color: var(--navy); }
  .card .k { font-size: .78rem; color: var(--dim); text-transform: uppercase; letter-spacing: .04em; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.1rem; margin-bottom: 1.1rem; }
  section h2 { font-size: .82rem; text-transform: uppercase; letter-spacing: .05em; color: var(--dim); margin: 0 0 .9rem; }
  .row { display: grid; grid-template-columns: 7.5rem 1fr 5.5rem; align-items: center; gap: .6rem; margin: .32rem 0; }
  .row-label { font-size: .9rem; }
  .row-val { font-size: .85rem; text-align: right; font-variant-numeric: tabular-nums; }
  .track { background: var(--track); border-radius: 4px; height: 12px; overflow: hidden; }
  .fill { background: var(--accent); height: 100%; border-radius: 4px; }
  .dim { color: var(--dim); }
  .strip { display: flex; align-items: flex-end; gap: 3px; height: 120px; margin-top: .4rem; }
  .strip .b { flex: 1; background: var(--accent); border-radius: 2px 2px 0 0; min-height: 2px; position: relative; opacity: .85; }
  .strip .b:hover { opacity: 1; }
  .strip-x { display: flex; gap: 3px; margin-top: .3rem; }
  .strip-x span { flex: 1; text-align: center; font-size: .62rem; color: var(--dim); }
  .hours { display: flex; align-items: flex-end; gap: 2px; height: 90px; }
  .hours .b { flex: 1; background: var(--accent); border-radius: 2px 2px 0 0; min-height: 2px; opacity: .85; }
  .hours-x { display: flex; gap: 2px; margin-top: .3rem; }
  .hours-x span { flex: 1; text-align: center; font-size: .58rem; color: var(--dim); }
  .split { display: flex; height: 22px; border-radius: 5px; overflow: hidden; border: 1px solid var(--line); }
  .split > div { display: flex; align-items: center; justify-content: center; font-size: .75rem; color: #fff; white-space: nowrap; }
  .split .a { background: var(--accent); }
  .split .b2 { background: #b9b9ac; }
  .foot { color: var(--dim); font-size: .8rem; text-align: center; margin-top: 1.5rem; }
  @media (max-width: 480px) {
    .row { grid-template-columns: 5.5rem 1fr 4rem; }
    .strip-x span:nth-child(even) { visibility: hidden; }
  }
</style>
</head>
<body>
<div class="wrap">

  <h1>SLUH Time Visualizer — usage</h1>
  <div class="meta">
    collecting since <?= h((new DateTime($data['start']))->format('M j, Y')) ?>
    (<?= number_format($collectDays) ?> days) ·
    last hit <?= h((new DateTime('@' . $data['updated']))->setTimezone(new DateTimeZone(TZ))->format('M j, g:i A')) ?> CT
  </div>

  <div class="cards">
    <div class="card"><div class="n"><?= number_format($data['total']) ?></div><div class="k">total visits</div></div>
    <div class="card"><div class="n"><?= number_format($uniqueAll) ?></div><div class="k">browsers (120d)</div></div>
    <div class="card"><div class="n"><?= number_format($uniqueOver(7)) ?></div><div class="k">browsers · 7d</div></div>
    <div class="card"><div class="n"><?= number_format($hitsOver(7)) ?></div><div class="k">visits · 7d</div></div>
    <div class="card"><div class="n"><?= number_format($data['new_browsers']) ?></div><div class="k">first-time browsers</div></div>
  </div>

  <section>
    <h2>Which page</h2>
    <?= bar_row('Main site', $data['pages']['index'], $maxPage) ?>
    <?= bar_row('Wall display', $data['pages']['math-office'], $maxPage) ?>
  </section>

  <section>
    <h2>Landing view (main site)</h2>
    <?php foreach (TABS as $t): ?>
      <?= bar_row(ucfirst($t), $data['tabs'][$t], $maxTab) ?>
    <?php endforeach; ?>
  </section>

  <section>
    <h2>Visits per day — last 30 days</h2>
    <div class="strip">
      <?php foreach ($strip as $s): ?>
        <div class="b" style="height:<?= pct_down($s['hits'], $maxStrip) ?>%"
             title="<?= h($s['date']) ?>: <?= $s['hits'] ?> visits, <?= $s['uniq'] ?> browsers"></div>
      <?php endforeach; ?>
    </div>
    <div class="strip-x">
      <?php foreach ($strip as $s): ?><span><?= $s['day'] ?></span><?php endforeach; ?>
    </div>
  </section>

  <section>
    <h2>Time of day (CT) · all visits</h2>
    <div class="hours">
      <?php for ($hh = 0; $hh < 24; $hh++): ?>
        <div class="b" style="height:<?= pct_down($data['hourly'][$hh], $maxHour) ?>%"
             title="<?= sprintf('%02d:00', $hh) ?> — <?= number_format($data['hourly'][$hh]) ?>"></div>
      <?php endfor; ?>
    </div>
    <div class="hours-x">
      <?php for ($hh = 0; $hh < 24; $hh++): ?><span><?= $hh % 6 === 0 ? $hh : '' ?></span><?php endfor; ?>
    </div>
  </section>

  <section>
    <h2>Day of week · all visits</h2>
    <?php foreach ($wdayNames as $i => $wn): ?>
      <?= bar_row($wn, $data['weekday'][$i], $maxWday) ?>
    <?php endforeach; ?>
  </section>

  <section>
    <h2>How it's set up</h2>
    <p class="dim" style="margin:.2rem 0 .5rem;font-size:.8rem">"Show only my periods" on — a rough count of configured teachers</p>
    <?php $filterOnPct = pct_down($data['filter']['on'], $filterTotal); ?>
    <div class="split">
      <div class="a" style="width:<?= $filterOnPct ?>%">
        filter on <?= $filterOnPct ?>%
      </div>
      <div class="b2" style="width:<?= 100 - $filterOnPct ?>%"></div>
    </div>
    <p class="dim" style="margin:.9rem 0 .5rem;font-size:.8rem">Theme</p>
    <?php $lightPct = pct_down($data['themes']['light'], $themeTotal); ?>
    <div class="split">
      <div class="a" style="width:<?= $lightPct ?>%">
        light <?= $lightPct ?>%
      </div>
      <div class="b2" style="width:<?= 100 - $lightPct ?>%">
        dark
      </div>
    </div>
    <p class="dim" style="margin:.9rem 0 .5rem;font-size:.8rem">Device (screen size guess)</p>
    <?php $desktopPct = pct_down($data['devices']['desktop'], $deviceTotal); ?>
    <div class="split">
      <div class="a" style="width:<?= $desktopPct ?>%">
        desktop <?= $desktopPct ?>%
      </div>
      <div class="b2" style="width:<?= 100 - $desktopPct ?>%">
        mobile
      </div>
    </div>
  </section>

  <div class="foot">
    auto-refreshes every 5 min · all-time unique browsers: <?= number_format($uniqueAll) ?>
    (last 120 days retained) · no IPs or cookies stored
  </div>

</div>
</body>
</html>
