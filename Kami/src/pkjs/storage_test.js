/**
 * Kami - phone-side storage probe
 *
 * Measures how much text PebbleKit JS localStorage can hold on this phone,
 * which decides how many books Kami can keep. Results go to the log
 * (`pebble logs`) and are saved under kami_storage_result so a later run
 * can show them again.
 *
 * Checks:
 *  1. Persistence - does a value written last launch survive a relaunch?
 *  2. Single value - the largest one string we can store and read back intact.
 *  3. Total - how much we can store across many keys (books will be stored
 *     as several keys, so this is the number that matters most).
 *
 * Every test key is removed afterwards. Sizes are in characters; book text
 * is almost all ASCII, so characters is roughly bytes of book.
 */

var PREFIX = 'kami_probe_';
var MARKER_KEY = 'kami_probe_marker';
var RESULT_KEY = 'kami_storage_result';

var KB = 1024;
var MB = 1024 * KB;
var SINGLE_MAX = 32 * MB;  // stop doubling here
var TOTAL_MAX = 48 * MB;   // stop filling here; far more than we'll need
var BLOCK = 512 * KB;      // per-key size for the total test

function log(msg) {
  console.log('[storage] ' + msg);
}

function fmt(chars) {
  if (chars >= MB) return (chars / MB).toFixed(1) + ' MB';
  return Math.round(chars / KB) + ' KB';
}

function makeString(n) {
  // Vary the content so storage can't cheat by compressing a constant string
  var unit = 'The quick brown fox jumps over the lazy dog 0123456789. ';
  var s = unit;
  while (s.length < n) s += s;
  return s.substring(0, n);
}

// Write then read back; true only if the full value round-trips.
function tryStore(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    return false;
  }
  var back = localStorage.getItem(key);
  return back !== null && back.length === value.length;
}

function cleanup() {
  var keys = [];
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    if (k && k.indexOf(PREFIX) === 0 && k !== MARKER_KEY) keys.push(k);
  }
  for (var j = 0; j < keys.length; j++) localStorage.removeItem(keys[j]);
}

function testSingle() {
  var best = 0;
  var bad = 0;
  for (var n = 64 * KB; n <= SINGLE_MAX; n *= 2) {
    var ok = tryStore(PREFIX + 'single', makeString(n));
    localStorage.removeItem(PREFIX + 'single');
    if (!ok) { bad = n; break; }
    best = n;
  }
  // Narrow the gap to within ~10%
  while (bad && bad - best > best / 10) {
    var mid = Math.floor((best + bad) / 2);
    var ok2 = tryStore(PREFIX + 'single', makeString(mid));
    localStorage.removeItem(PREFIX + 'single');
    if (ok2) best = mid; else bad = mid;
  }
  return { max: best, capped: !bad };
}

function testTotal() {
  var block = makeString(BLOCK);
  var stored = 0;
  var count = 0;
  var start = Date.now();
  while (stored + BLOCK <= TOTAL_MAX) {
    if (!tryStore(PREFIX + 'block_' + count, block)) break;
    stored += BLOCK;
    count++;
  }
  var ms = Date.now() - start;
  var capped = stored + BLOCK > TOTAL_MAX;

  // Read everything back to make sure earlier keys weren't silently evicted
  var intact = 0;
  for (var i = 0; i < count; i++) {
    var v = localStorage.getItem(PREFIX + 'block_' + i);
    if (v !== null && v.length === BLOCK) intact++;
  }
  cleanup();
  return {
    total: intact * BLOCK,
    capped: capped,
    evicted: count - intact,
    writeSpeed: ms > 0 ? stored / (ms / 1000) : 0
  };
}

function run() {
  log('Starting. This can take a while on a phone; keep the app open.');
  var previous = localStorage.getItem(RESULT_KEY);
  if (previous) log('Previous result: ' + previous);

  var marker = localStorage.getItem(MARKER_KEY);
  var persistence = marker ? 'yes (written ' + marker + ')' : 'unknown - first run, relaunch to check';
  localStorage.setItem(MARKER_KEY, new Date().toISOString());

  cleanup();  // leftovers from an interrupted run
  var single = testSingle();
  log('Largest single value: ' + fmt(single.max) + (single.capped ? '+ (test cap)' : ''));
  var total = testTotal();
  log('Total across keys: ' + fmt(total.total) + (total.capped ? '+ (test cap)' : '') +
      ', evicted: ' + total.evicted + ', write speed: ' + fmt(total.writeSpeed) + '/s');
  log('Survives relaunch: ' + persistence);

  var summary = {
    date: new Date().toISOString(),
    userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || 'unknown',
    singleMax: single.max,
    singleCapped: single.capped,
    total: total.total,
    totalCapped: total.capped,
    evicted: total.evicted,
    writeSpeed: Math.round(total.writeSpeed),
    persisted: !!marker
  };
  localStorage.setItem(RESULT_KEY, JSON.stringify(summary));
  log('Done: ' + JSON.stringify(summary));
  return summary;
}

module.exports = { run: run };
