<?php
// =============================================================================
// api/period.php -- "what school period is it right now, and how long is left"
//
// A tiny read-only JSON endpoint meant to back a phone lock-screen widget
// (see api/sluh-period-widget.js for the Scriptable client). It reads the
// same schedule the site does, from api/schedule.json -- a trimmed copy of
// data.js that scripts/csv_to_data.py writes on every build.
//
// Everything is computed in America/Chicago on each request, so the answer
// is always current and there's no cron/background job. The schedule only
// has minute-resolution period times; "secondsLeft" is still exact, taken
// from the real clock against the period's minute boundary.
//
// Query params (all optional, for testing / personal tweaks):
//   ?now=2026-09-08T10:15:00   pretend it's this local time
//   ?wave=jrsr | frso          force the lunch wave (default: auto-detect,
//                               same rule as app.js's liveWaveOf)
//
// Response shape:
//   {
//     "state": "in-period" | "passing-period" | "before-school"
//            | "after-school" | "no-school" | "error",
//     "date": "2026-09-08", "timezone": "America/Chicago",
//     "generatedAt": "2026-09-08T10:15:00-05:00",
//     "daySummary": "5 Period [ABCDE]",
//     "period": "C", "wave": "frso",                 // in-period only
//     "startedAt": "...", "endsAt": "...",            // in-period / passing
//     "secondsLeft": 1840, "secondsTotal": 3600,
//     "next": { "period": "D", "startsAt": "...",     // when known
//               "date": "2026-09-09", "daySummary": "..." },
//     "secondsUntilNext": 300                         // before-school / no-school
//   }
// =============================================================================

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('Access-Control-Allow-Origin: *');

$TZ = new DateTimeZone('America/Chicago');

// "9:30a" / "12:05p" -- short wall-clock time from an ISO string
function hhmm(string $iso): string {
    $d = new DateTime($iso);
    return $d->format('g:i') . $d->format('a')[0];
}

// "37 min" / "1h 05m" / "<1 min" -- a rounded duration from seconds
function dur($secs): string {
    $secs = max(0, (int) $secs);
    $m = (int) round($secs / 60);
    if ($m >= 60) {
        return intdiv($m, 60) . 'h ' . str_pad((string) ($m % 60), 2, '0', STR_PAD_LEFT) . 'm';
    }
    return $m <= 0 ? '<1 min' : "$m min";
}

// Pre-rendered {title, big, sub} so a phone widget can be ~6 hand-typed
// lines: it just prints these three strings. Kept in sync with the states
// above; sluh-period-widget.js reads r.display and r.refreshAt only.
function decorate(array $r): array {
    $next = $r['next'] ?? null;
    switch ($r['state'] ?? 'error') {
        case 'in-period':
            $r['display'] = [
                'title' => "Period {$r['period']}",
                'big'   => dur($r['secondsLeft']) . ' left',
                'sub'   => 'ends ' . hhmm($r['endsAt']) . ($next ? "  \u{2022}  then {$next['period']}" : ''),
            ];
            break;
        case 'passing-period':
            $r['display'] = [
                'title' => 'Passing period',
                'big'   => "Period {$next['period']} in " . dur($r['secondsLeft']),
                'sub'   => 'starts ' . hhmm($next['startsAt']),
            ];
            break;
        case 'before-school':
            $r['display'] = [
                'title' => 'Before school',
                'big'   => "Period {$next['period']} in " . dur($r['secondsUntilNext']),
                'sub'   => 'starts ' . hhmm($next['startsAt']),
            ];
            break;
        case 'after-school':
        case 'no-school':
            $label = $r['state'] === 'no-school' ? ($r['daySummary'] ?: 'No school') : "School's out";
            $sub = '';
            if ($next) {
                $d = new DateTime($next['startsAt']);
                $sub = $d->format('n/j') . ' ' . hhmm($next['startsAt']);
            }
            $r['display'] = [
                'title' => $label,
                'big'   => $next ? "Next: Period {$next['period']}" : "\u{2014}",
                'sub'   => $sub,
            ];
            break;
        default:
            $r['display'] = ['title' => 'SLUH period', 'big' => 'unavailable', 'sub' => ''];
    }

    // when the widget should ask iOS to refresh: the next state change,
    // else a 15-minute fallback. Measured from the request time.
    $refNow = isset($r['generatedAt']) ? (new DateTime($r['generatedAt']))->getTimestamp() : time();
    $soonest = $refNow + 15 * 60;
    foreach ([$r['endsAt'] ?? null, $next['startsAt'] ?? null] as $iso) {
        if ($iso === null) {
            continue;
        }
        $t = (new DateTime($iso))->getTimestamp() + 5;
        if ($t > $refNow && $t < $soonest) {
            $soonest = $t;
        }
    }
    $r['refreshAt'] = (new DateTime("@$soonest"))->setTimezone(new DateTimeZone('America/Chicago'))->format(DateTime::ATOM);
    return $r;
}

function out(array $r): void {
    echo json_encode(decorate($r), JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . "\n";
    exit;
}

$raw = @file_get_contents(__DIR__ . '/schedule.json');
if ($raw === false) {
    http_response_code(500);
    out(['state' => 'error', 'error' => 'schedule.json missing -- run scripts/csv_to_data.py']);
}
$schedule = json_decode($raw, true);
$days = $schedule['days'] ?? [];

// ---- "now" (overridable) ----------------------------------------------------
$nowParam = isset($_GET['now']) ? trim((string) $_GET['now']) : '';
try {
    $now = $nowParam !== '' ? new DateTime($nowParam, $TZ) : new DateTime('now', $TZ);
} catch (Exception $e) {
    $now = new DateTime('now', $TZ);
}
$dateStr = $now->format('Ymd');
$minutes = ((int) $now->format('G')) * 60 + (int) $now->format('i');

$waveParam = $_GET['wave'] ?? '';
$forceWave = in_array($waveParam, ['jrsr', 'frso'], true) ? $waveParam : null;

// ---- helpers --------------------------------------------------------------
// mirrors resolvePeriodTimes() in app.js / math-office.js
function windowOf(array $p, string $wave): array {
    if ($wave === 'jrsr' && isset($p['jrsrStartMinutes'])) {
        return [$p['jrsrStartMinutes'], $p['jrsrEndMinutes']];
    }
    return [$p['startMinutes'], $p['endMinutes']];
}

function stamp(string $ymd, int $minOfDay, DateTimeZone $tz): DateTime {
    $dt = DateTime::createFromFormat('Ymd', $ymd, $tz);
    $dt->setTime(intdiv($minOfDay, 60), $minOfDay % 60, 0);
    return $dt;
}

$byDate = [];
foreach ($days as $d) {
    $byDate[$d['date']] = $d;
}

// first future day that actually has class
$nextSchoolDay = null;
foreach ($days as $d) {
    if ($d['date'] > $dateStr && !empty($d['periods'])) {
        $nextSchoolDay = $d;
        break;
    }
}
$nextSchoolDayBlock = function () use ($nextSchoolDay, $TZ, $now): ?array {
    if (!$nextSchoolDay) {
        return null;
    }
    $periods = $nextSchoolDay['periods'];
    usort($periods, fn($a, $b) => $a['startMinutes'] <=> $b['startMinutes']);
    $first = $periods[0];
    $st = stamp($nextSchoolDay['date'], $first['startMinutes'], $TZ);
    return [
        'block' => [
            'period'     => $first['label'],
            'startsAt'   => $st->format(DateTime::ATOM),
            'date'       => DateTime::createFromFormat('Ymd', $nextSchoolDay['date'], $TZ)->format('Y-m-d'),
            'daySummary' => $nextSchoolDay['summary'],
        ],
        'secondsUntil' => $st->getTimestamp() - $now->getTimestamp(),
    ];
};

$resp = [
    'state'       => null,
    'date'        => $now->format('Y-m-d'),
    'timezone'    => 'America/Chicago',
    'generatedAt' => $now->format(DateTime::ATOM),
];

$today = $byDate[$dateStr] ?? null;

// ---- no school today -----------------------------------------------------
if (!$today || empty($today['periods'])) {
    $resp['state'] = 'no-school';
    $resp['daySummary'] = $today['summary'] ?? null;
    if ($nb = $nextSchoolDayBlock()) {
        $resp['next'] = $nb['block'];
        $resp['secondsUntilNext'] = $nb['secondsUntil'];
    }
    out($resp);
}

$resp['daySummary'] = $today['summary'];

$periods = $today['periods'];
usort($periods, fn($a, $b) => $a['startMinutes'] <=> $b['startMinutes']);

// ---- live period? (try frso then jrsr, like liveWaveOf) -----------------
$live = null;
$liveWave = null;
$liveIdx = null;
foreach ($periods as $i => $p) {
    foreach ($forceWave ? [$forceWave] : ['frso', 'jrsr'] as $w) {
        [$s, $e] = windowOf($p, $w);
        if ($minutes >= $s && $minutes < $e) {
            $live = $p;
            $liveWave = $w;
            $liveIdx = $i;
            break 2;
        }
    }
}

if ($live !== null) {
    [$s, $e] = windowOf($live, $liveWave);
    $startDt = stamp($dateStr, $s, $TZ);
    $endDt   = stamp($dateStr, $e, $TZ);
    $resp['state']        = 'in-period';
    $resp['period']       = $live['label'];
    $resp['wave']         = $liveWave;
    $resp['startedAt']    = $startDt->format(DateTime::ATOM);
    $resp['endsAt']       = $endDt->format(DateTime::ATOM);
    $resp['secondsLeft']  = max(0, $endDt->getTimestamp() - $now->getTimestamp());
    $resp['secondsTotal'] = ($e - $s) * 60;
    if (isset($periods[$liveIdx + 1])) {
        $np = $periods[$liveIdx + 1];
        [$ns] = windowOf($np, $forceWave ?? 'frso');
        $resp['next'] = [
            'period'   => $np['label'],
            'startsAt' => stamp($dateStr, $ns, $TZ)->format(DateTime::ATOM),
        ];
    }
    out($resp);
}

// ---- not in a period: before / between / after -------------------------
[$firstStart] = windowOf($periods[0], $forceWave ?? 'frso');
$lastEnd = 0;
foreach ($periods as $p) {
    $lastEnd = max($lastEnd, $p['endMinutes'], $p['jrsrEndMinutes'] ?? 0);
}

if ($minutes < $firstStart) {
    $st = stamp($dateStr, $firstStart, $TZ);
    $resp['state'] = 'before-school';
    $resp['next'] = [
        'period'   => $periods[0]['label'],
        'startsAt' => $st->format(DateTime::ATOM),
    ];
    $resp['secondsUntilNext'] = $st->getTimestamp() - $now->getTimestamp();
    out($resp);
}

if ($minutes >= $lastEnd) {
    $resp['state'] = 'after-school';
    if ($nb = $nextSchoolDayBlock()) {
        $resp['next'] = $nb['block'];
        $resp['secondsUntilNext'] = $nb['secondsUntil'];
    }
    out($resp);
}

// passing period -- find the next period that hasn't started yet
$nextPeriod = null;
foreach ($periods as $p) {
    [$ps] = windowOf($p, $forceWave ?? 'frso');
    if ($ps > $minutes) {
        $nextPeriod = $p;
        break;
    }
}
[$ns] = windowOf($nextPeriod, $forceWave ?? 'frso');
$startDt = stamp($dateStr, $ns, $TZ);
$resp['state']       = 'passing-period';
$resp['endsAt']      = $startDt->format(DateTime::ATOM);
$resp['secondsLeft'] = max(0, $startDt->getTimestamp() - $now->getTimestamp());
$resp['next'] = [
    'period'   => $nextPeriod['label'],
    'startsAt' => $startDt->format(DateTime::ATOM),
];
out($resp);
