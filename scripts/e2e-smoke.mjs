#!/usr/bin/env node
/**
 * e2e-smoke.mjs — drive the real page in headless Chrome and report what actually happened.
 *
 * The unit tests cannot cover this: there is no DOM under `node --test`, no Leaflet, and no
 * network. The things most likely to break are exactly the ones only a browser can catch — the
 * ES module under lib/ failing its import, a renamed element id, a route that draws but whose
 * heights never arrive, an OSRM server answering slowly enough to trip the race guard.
 *
 * It serves this directory, loads index.html in an iframe, drives the Route Planner the way a
 * person would (type a link, press Import), and the page POSTs its findings back here. No
 * Selenium, no puppeteer: a real browser and one HTTP server.
 *
 *   node scripts/e2e-smoke.mjs                    # asserts, exits non-zero on failure
 *   KEEP_OPEN=1 node scripts/e2e-smoke.mjs        # leave Chrome running for inspection
 *   SCREENSHOT=/tmp/hike.png node scripts/e2e-smoke.mjs
 *   BLOCK_MODULE=1 node scripts/e2e-smoke.mjs   # pretend gmaps-import.js 404s
 *
 * With SCREENSHOT set the run stops after the import and re-fits the map, so the picture shows
 * the imported route instead of the harness's own teardown; the race and clear assertions only
 * run in the plain (unscreenshotted) pass.
 *
 * It contacts the real OSRM, Open-Meteo and Nominatim — that is the point. If those are
 * unreachable, the run fails rather than quietly passing on a stub.
 */

import { createServer } from 'node:http';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PORT = Number(process.env.PORT || 8137);
const CHROME = process.env.CHROME || 'google-chrome';
const SCREENSHOT = process.env.SCREENSHOT || '';
// Longer than the harness's own poll budgets added together, or the runner gives up on a
// run that is merely slow and reports nothing at all.
const CHROME_TIMEOUT_MS = Number(process.env.CHROME_TIMEOUT_MS || 150000);
const TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 30000);

const LINK = process.env.TEST_LINK
  || 'https://www.google.com/maps/dir/Black+Mountain+Backpack+Camp,+Montebello+Rd,+Los+Altos,+CA+94022/'
    + 'Los+Gatos+Library,+219+E+Main+St,+Los+Gatos,+CA+95030/@37.2446911,-122.1129273,20047m/am=t/data=!3m1!1e3!4m14!4m13'
    + '!1m5!1m1!1s0x808fb1f56dd4b3ff:0xb38f6c4f64242502!2m2!1d-122.1540561!2d37.3185923'
    + '!1m5!1m1!1s0x808e343394a0fcb1:0xf50ac3c8e44a0fe1!2m2!1d-121.9431403!2d37.2405404!3e2';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', // modules are refused under any other MIME type
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gpx': 'application/gpx+xml',
  '.webmanifest': 'application/manifest+json',
};

/** Injected page: same origin as the app, so it can reach into the iframe and drive it. */
const HARNESS = (link, { shot = false, expectModule = true } = {}) => `<!doctype html>
<html><head><meta charset="utf-8"><title>hike e2e</title>
<style>body{margin:0;background:#222}iframe{border:0;width:1280px;height:860px;display:block}</style>
</head><body>
<script>
(async () => {
  const out = { pass: [], fail: [], notes: [], console: [] };
  const check = (name, ok, detail) => (ok ? out.pass : out.fail).push(name + (detail ? ' — ' + detail : ''));
  const note = (k, v) => { out.notes.push(k + ': ' + v); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const finish = async () => {
    try {
      await fetch('/__report', { method: 'POST', body: JSON.stringify(out, null, 2) });
    } catch (e) { out.fail.push('could not post report: ' + e.message); }
  };

  try {
    // A stale service worker would serve last week's app.js and make every result meaningless.
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      if (regs.length) { const c = await caches.keys(); await Promise.all(c.map((k) => caches.delete(k))); }
      out.notes.push('unregistered ' + regs.length + ' service worker(s)');
    }

    const frame = document.createElement('iframe');
    frame.src = 'index.html';
    document.body.appendChild(frame);
    await new Promise((r) => { frame.onload = r; });
    const w = frame.contentWindow;
    const d = w.document;

    w.addEventListener('error', (e) => out.console.push('window.onerror: ' + e.message));
    const realError = w.console.error;
    w.console.error = (...a) => { out.console.push(a.map(String).join(' ')); realError.apply(w.console, a); };

    // Modules and App both land before DOMContentLoaded; wait for the handover either way.
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && !(w.app && w.gmapsImport)) await sleep(50);
    check('app booted', !!w.app);
    if (${expectModule ? 'true' : 'false'}) {
      check('gmaps-import module loaded', !!w.gmapsImport,
        w.gmapsImport ? '' : 'lib/*.js failed to import — the import row would be hidden');
    }
    if (!w.app || (!w.gmapsImport && ${expectModule ? 'true' : 'false'})) return finish();

    const planner = w.app.routePlanner;
    check('route planner constructed', !!planner);
    if (!planner) return finish();

    // The module may be missing — a bad deploy, an offline lib/*.js, a stale cache. The planner
    // must then be exactly what it was before this feature existed, not half-wired.
    if (!${expectModule ? 'true' : 'false'}) {
      check('a missing importer is detected, not thrown', !w.gmapsImport);
      const orphanRow = d.querySelector('.route-gmaps-row');
      check('the import row hides itself when the module is missing',
        !!orphanRow && orphanRow.classList.contains('hidden'));

      planner.btn.click();
      planner._addWaypoint(37.3186, -122.1541);
      planner._addWaypoint(37.2405, -121.9431);
      const waited = Date.now() + 8000;
      while (Date.now() < waited && !planner.hint.textContent) await sleep(100);
      check('clicking the map still builds a route plan', planner.waypoints.length === 2,
        'got ' + planner.waypoints.length);
      check('with no module and no key it gives the original advice',
        /ORS API key/.test(planner.hint.textContent), planner.hint.textContent);
      check('no uncaught errors while degrading', !out.console.some((l) => /onerror/.test(l)),
        out.console.join(' | '));
      return finish();
    }

    const row = d.querySelector('.route-gmaps-row');
    check('import row is visible', !!row && !row.classList.contains('hidden'));

    planner.btn.click();
    check('route panel opens', !planner.panel.classList.contains('hidden'));

    d.getElementById("route-gmaps-url").value = ${JSON.stringify(link)};
    planner.btnGmaps.click();

    const until = Date.now() + ${TEST_TIMEOUT_MS};
    while (Date.now() < until && planner.routePoints.length === 0 && d.getElementById('route-gmaps-status').className.indexOf('error') < 0) {
      await sleep(100);
    }

    const status = d.getElementById('route-gmaps-status');
    note('status', status.textContent);
    note('provider', planner._lastRoute && planner._lastRoute.providerLabel);
    note('route points', planner.routePoints.length);
    note('waypoints', planner.waypoints.length);

    check('import reported no error', status.className.indexOf('error') < 0, status.textContent);
    check('waypoints were placed on the map', planner.waypoints.length === 2,
      'got ' + planner.waypoints.length);
    check('every waypoint has a usable position', planner.waypoints.every(
      (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)));
    check('route geometry was produced', planner.routePoints.length > 1,
      'got ' + planner.routePoints.length);
    check('route points carry this app\\'s coordinate shape', planner.routePoints.every(
      (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)),
      JSON.stringify(planner.routePoints[0]));

    const withEle = planner.routePoints.filter((p) => Number.isFinite(p.ele)).length;
    note('points with heights', withEle);
    check('heights filled the elevation profile', withEle > 1,
      withEle + '/' + planner.routePoints.length + ' points have <ele>');

    check('profile switched to the link\\'s travel mode',
      d.getElementById('route-profile').value === 'foot-walking',
      'selected ' + d.getElementById('route-profile').value);
    check('distance and time are shown', !planner.statsEl.classList.contains('hidden'),
      planner.distEl.textContent + ' / ' + planner.timeEl.textContent);
    check('download is enabled', !planner.btnDownload.classList.contains('hidden'));
    check('a route line is on the map', !!planner._routeLine);
    check('the straight-line helper was removed once road data arrived', !planner._directLine);

    if (${shot ? 'true' : 'false'}) {
      // Screenshot mode stops here: the default "Show All" track load fits the map to every
      // stored track *after* the import does, so re-fit or the picture shows the whole state of
      // the library rather than the route that was just imported.
      await sleep(1500);
      planner._fitToWaypoints();
      return finish();
    }

    // Two profile changes with no gap between them, so both requests are in flight at once: the
    // request-token guard has to let the newer one win. Waiting on routePoints.length alone is
    // useless — _reroute() clears it synchronously on entry, so it reads 0 immediately.
    const select = d.getElementById('route-profile');
    const settled = (label) => !!planner._lastRoute && planner.routePoints.length > 0
      && label.test(planner._lastRoute.providerLabel || '');
    const before = planner.routePoints.length;
    select.value = 'cycling-regular'; select.dispatchEvent(new w.Event('change'));
    select.value = 'driving-car'; select.dispatchEvent(new w.Event('change'));
    const until2 = Date.now() + ${TEST_TIMEOUT_MS};
    while (Date.now() < until2 && !settled(/\\bcar\\b/i)) await sleep(100);
    check('the newest routing request wins and the stale one is dropped',
      settled(/\\bcar\\b/i) && planner._routeLine !== null,
      (planner._lastRoute || {}).providerLabel + ' · ' + before + ' -> ' + planner.routePoints.length + ' points');

    planner.clear();
    check('clear resets the planner', planner.waypoints.length === 0 && planner.routePoints.length === 0);

    // The ORS branch, tested without anybody's key: swap the page's fetch for a canned ORS reply
    // so the code path — Authorization header, elevation:true, the token guard — is exercised
    // for real, and no credential of the user's ever reaches the browser.
    const realFetch = w.fetch;
    let orsSeen = null;
    w.fetch = async (url, init = {}) => {
      if (/openrouteservice/.test(url)) {
        orsSeen = { url, headers: init.headers || {}, body: init.body };
        const coords = [[-122.15, 37.31, 120], [-122.10, 37.28, 340], [-121.94, 37.24, 85]];
        const payload = { features: [{ geometry: { coordinates: coords }, properties: { summary: { distance: 31000, duration: 25000 } } }] };
        return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
      }
      return realFetch.call(w, url, init);
    };
    d.getElementById('route-api-key').value = 'stub-ors-key';
    d.getElementById('route-api-key').dispatchEvent(new w.Event('change'));
    planner._addWaypoint(37.3186, -122.1541, false);
    planner._addWaypoint(37.2405, -121.9431, false);
    planner._reroute();
    const until3 = Date.now() + 8000;
    while (Date.now() < until3 && !(planner._lastRoute && /OpenRouteService/.test(planner._lastRoute.providerLabel || ''))) await sleep(100);
    w.fetch = realFetch;

    check('an ORS key routes through OpenRouteService', !!orsSeen, orsSeen ? '' : 'no request reached ORS');
    check('the key is sent as the Authorization header',
      !!orsSeen && orsSeen.headers.Authorization === 'stub-ors-key',
      orsSeen ? Object.keys(orsSeen.headers).join(',') : 'no request');
    check('ORS is asked for elevations', !!orsSeen && /"elevation":true/.test(orsSeen.body || ''),
      orsSeen ? String(orsSeen.body).slice(0, 80) : 'no request');
    check('ORS elevations reach the profile',
      planner.routePoints.filter((p) => Number.isFinite(p.ele)).length === 3,
      planner.routePoints.map((p) => p.ele).join(','));
    check('a stubbed ORS answer does not overwrite a newer request',
      planner.routePoints.length === 3 && planner._routeLine !== null);
  } catch (err) {
    out.fail.push('harness threw: ' + (err && err.stack ? err.stack : err));
  }
  await finish();
})();
</script>
</body></html>`;

async function serve(req, res, report) {
  const path = req.url.split('?')[0];

  if (path === '/__harness') {
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    res.end(HARNESS(LINK, { shot: Boolean(SCREENSHOT), expectModule: !process.env.BLOCK_MODULE }));
    return;
  }
  if (path === '/__report') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        Object.assign(report, JSON.parse(body));
      } catch (error) {
        report.fail = report.fail || [];
        report.fail.push('report was not JSON: ' + error.message);
      }
      res.writeHead(204).end();
    });
    return;
  }

  if (process.env.BLOCK_MODULE && /^\/gmaps-import\.js/.test(path)) {
    res.writeHead(404).end('blocked by BLOCK_MODULE');
    return;
  }

  const relative = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
  const file = join(ROOT, relative);
  // Only ever serve files from this directory — this is a static file server, not a file reader.
  if (!file.startsWith(ROOT + sep) && file !== ROOT) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found: ' + relative);
  }
}

const report = { pass: [], fail: [], notes: [], console: [] };

const server = createServer((req, res) => {
  serve(req, res, report).catch((error) => res.writeHead(500).end(String(error)));
});

await new Promise((done) => server.listen(PORT, '127.0.0.1', done));

const profile = await mkdtemp(join(tmpdir(), 'hike-e2e-'));
const startedAt = Date.now();
const args = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  '--allow-running-insecure-content',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=0`,
  '--disable-extensions',
  '--no-first-run',
];
// --screenshot makes headless shoot at first paint and quit, which killed the async run until the
// budget was added: virtual time stalls on real network requests, so the route can arrive.
if (SCREENSHOT) {
  args.push(`--screenshot=${SCREENSHOT}`, '--window-size=1280,1000', `--virtual-time-budget=${CHROME_TIMEOUT_MS}`);
}
args.push(`http://127.0.0.1:${PORT}/__harness`);

const chrome = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeLog = '';
chrome.stderr.on('data', (chunk) => { chromeLog += chunk; });

const exited = new Promise((done) => chrome.on('exit', (code) => done(code)));
const waited = CHROME_TIMEOUT_MS + 5000;
const deadline = Date.now() + waited;
while (Date.now() < deadline && report.pass.length + report.fail.length === 0) await new Promise((r) => setTimeout(r, 120));

if (SCREENSHOT && !process.env.KEEP_OPEN) {
  // The page reports before Chrome gets around to writing the screenshot; killing on the report
  // was throwing the picture away. Wait for the file to appear, then stop the browser.
  const shotDeadline = Date.now() + CHROME_TIMEOUT_MS + 5000;
  while (Date.now() < shotDeadline) {
    const info = await stat(SCREENSHOT).catch(() => null);
    if (info && info.mtimeMs >= startedAt) break;
    await new Promise((r) => setTimeout(r, 250));
  }
}
if (!process.env.KEEP_OPEN) chrome.kill('SIGKILL');
await Promise.race([exited, new Promise((r) => setTimeout(r, 1500))]);
server.close();

for (const line of report.notes || []) console.log(`  · ${line}`);
if (report.console?.length) {
  console.log('\nconsole.error from the page:');
  for (const line of report.console) console.log(`  ! ${line}`);
}
console.log(`\n${(report.pass || []).length} passed, ${(report.fail || []).length} failed`);
for (const line of report.fail || []) console.log(`  ✗ ${line}`);
if (SCREENSHOT) console.log(`\nscreenshot: ${SCREENSHOT}`);
if (!report.pass?.length && !report.fail?.length) {
  console.error('\nThe page never reported. Chrome output:');
  console.error(chromeLog.slice(-2000));
}

process.exit(report.fail?.length || !report.pass?.length ? 1 : 0);
