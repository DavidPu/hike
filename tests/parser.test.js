import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDirectionsUrl,
  parseLatLng,
  parseDataBlocks,
  extractUrls,
  isShortLink,
  normalizeUrlString,
  hasFullCoordinates,
  describeSource,
} from '../lib/parser.js';

/** The real link the app was specced against, captured from maps.app.goo.gl on 2026-11-06. */
const REAL =
  'https://www.google.com/maps/dir/Black+Mountain+Backpack+Camp,+Montebello+Rd,+Los+Altos,+CA+94022/Los+Gatos+Library,+219+E+Main+St,+Los+Gatos,+CA+95030/@37.2446911,-122.1129273,20047m/am=t/data=!3m1!1e3!4m14!4m13!1m5!1m1!1s0x808fb1f56dd4b3ff:0xb38f6c4f64242502!2m2!1d-122.1540561!2d37.3185923!1m5!1m1!1s0x808e343394a0fcb1:0xf50ac3c8e44a0fe1!2m2!1d-121.9431403!2d37.2405404!3e2?entry=tts&g_ep=EgoyMDI2MTEwMy4wIPu8ASoASAFQAw%3D%3D&skid=6479fea3-d6c1-48c4-ab16-2b156e649cd7';

test('real shared link: two stops, exact coordinates, names and mode', () => {
  const r = parseDirectionsUrl(REAL);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.kind, 'directions');
  assert.equal(r.waypoints.length, 2);

  const [start, end] = r.waypoints;
  assert.equal(start.role, 'start');
  assert.equal(end.role, 'end');
  assert.equal(start.name, 'Black Mountain Backpack Camp, Montebello Rd, Los Altos, CA 94022');
  assert.equal(start.lat, 37.3185923);
  assert.equal(start.lng, -122.1540561, '!1d is longitude, !2d is latitude — do not swap them');
  assert.equal(end.lat, 37.2405404);
  assert.equal(end.lng, -121.9431403);
  assert.equal(start.precision, 'exact');
  assert.equal(start.placeId, '0x808fb1f56dd4b3ff:0xb38f6c4f64242502');
  assert.equal(r.travelMode, 'walking', '!3e2 is walking');
  assert.equal(r.needsGeocode, false, 'coordinates came from the data block');
  assert.equal(hasFullCoordinates(r), true);
});

test('the @ viewport centre is never treated as a stop', () => {
  const r = parseDirectionsUrl(REAL);
  assert.deepEqual(r.viewport, { lat: 37.2446911, lng: -122.1129273, zoom: 20047 });
  assert.equal(r.waypoints.some((wp) => wp.lat === 37.2446911), false);
  assert.equal(r.waypoints.some((wp) => (wp.name || '').includes('data=')), false);
  assert.equal(r.waypoints.some((wp) => (wp.name || '').includes('am=t')), false);
});

test('api=1 share links use origin/destination/waypoints', () => {
  const r = parseDirectionsUrl(
    'https://www.google.com/maps/dir/?api=1&origin=37.3185923,-122.1540561&destination=37.2405404,-121.9431403&waypoints=37.28,-122.05|37.26,-121.99&travelmode=cycling',
  );
  assert.equal(r.ok, true);
  assert.equal(r.waypoints.length, 4);
  assert.deepEqual(r.waypoints.map((w) => w.role), ['start', 'waypoint', 'waypoint', 'end']);
  assert.equal(r.waypoints[1].lat, 37.28);
  assert.equal(r.travelMode, 'cycling');
  assert.equal(r.travelModeSource, 'query');
});

test('query parameters win over path segments', () => {
  const r = parseDirectionsUrl('https://www.google.com/maps/dir/Somewhere/Else/?origin=One&destination=Two');
  assert.deepEqual(r.waypoints.map((w) => w.name), ['One', 'Two']);
});

test('query waypoints accept both | and ; separators', () => {
  const pipe = parseDirectionsUrl('https://www.google.com/maps/dir/?api=1&origin=A&destination=B&waypoints=X|Y');
  const semi = parseDirectionsUrl('https://www.google.com/maps/dir/?api=1&origin=A&destination=B&waypoints=X;Y');
  assert.equal(pipe.waypoints.length, 4);
  assert.equal(semi.waypoints.length, 4);
});

test('legacy saddr/daddr/dirflg links', () => {
  const cases = [
    ['https://maps.google.com/maps?saddr=Berkeley&daddr=Oakland&dirflg=d', 'driving'],
    ['https://maps.google.com/maps?saddr=Berkeley&daddr=Oakland&dirflg=w', 'walking'],
    ['https://maps.google.com/maps?saddr=Berkeley&daddr=Oakland&dirflg=b', 'cycling'],
    ['https://maps.google.com/maps?saddr=Berkeley&daddr=Oakland&dirflg=r', 'transit'],
  ];
  for (const [url, mode] of cases) {
    const r = parseDirectionsUrl(url);
    assert.equal(r.ok, true, url);
    assert.deepEqual(r.waypoints.map((w) => w.name), ['Berkeley', 'Oakland'], url);
    assert.equal(r.travelMode, mode, url);
  }
});

test('coordinates written directly in the path', () => {
  const r = parseDirectionsUrl('https://www.google.com/maps/dir/37.3185923,-122.1540561/37.2405404,-121.9431403/');
  assert.equal(r.ok, true);
  assert.equal(r.waypoints[0].lat, 37.3185923);
  assert.equal(r.waypoints[1].lng, -121.9431403);
  assert.equal(r.needsGeocode, false);
});

test('/u/0/ account prefix and trailing zoom segment are handled', () => {
  const r = parseDirectionsUrl('https://www.google.com/maps/u/0/dir/40.7580,-73.9855/40.7484,-73.9857/40.6892,-74.0445/data=!4m2!3m1');
  assert.equal(r.waypoints.length, 3, 'Times Square, Empire State, Statue of Liberty');
  assert.equal(r.waypoints[1].lat, 40.7484);
});

test('single place link yields one waypoint, not a route', () => {
  const r = parseDirectionsUrl('https://www.google.com/maps/place/1600+Amphitheatre+Parkway,+Mountain+View,+CA/@37.4224,-122.0848,17z/data=!3m1!4b1!4m5!3m4!1s0x808fb99b9e9d5f37:0xb508eb115b7c24d2!8m2!3d37.4224!4d-122.0848');
  assert.equal(r.kind, 'place');
  assert.equal(r.waypoints.length, 1);
  assert.ok(r.warnings.some((w) => /single place/i.test(w)));
});

test('short links are flagged for resolution instead of failing', () => {
  assert.equal(isShortLink('https://maps.app.goo.gl/b6gTmohyKRhPR77X7'), true);
  const r = parseDirectionsUrl('https://maps.app.goo.gl/b6gTmohyKRhPR77X7');
  assert.equal(r.needsResolution, true);
  assert.equal(r.kind, 'shortlink');
  assert.equal(r.ok, false);
});

test('non-Google hosts are refused', () => {
  const r = parseDirectionsUrl('https://example.com/maps/dir/A/B');
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /not a Google Maps link/);
});

test('a link with no stops explains what is missing', () => {
  const r = parseDirectionsUrl('https://www.google.com/maps/');
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /No origin or destination/);
});

test('garbage input is reported, not thrown', () => {
  for (const input of ['', '   ', 'not a url', 'https://', null, undefined, {}]) {
    const r = parseDirectionsUrl(input);
    assert.equal(r.ok, false, String(input));
    assert.ok(r.errors.length > 0);
  }
});

test('URLs are extracted from surrounding prose', () => {
  const text = `Hey! Here's the route https://www.google.com/maps/dir/?api=1&origin=A&destination=B — let me know!`;
  const urls = extractUrls(text);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /origin=A&destination=B$/);
  const r = parseDirectionsUrl(text);
  assert.equal(r.ok, true);
});

test('normalizeUrlString fixes common paste damage', () => {
  assert.equal(normalizeUrlString('maps.app.goo.gl/abc'), 'https://maps.app.goo.gl/abc');
  assert.equal(normalizeUrlString('<https://a.com/x>'), 'https://a.com/x');
  assert.equal(normalizeUrlString('https://a.com/x&y=1&amp;z=2'), 'https://a.com/x&y=1&z=2');
  assert.equal(normalizeUrlString('https://a.com/x.'), 'https://a.com/x');
  assert.equal(normalizeUrlString('   '), null);
});

test('parseLatLng: plain, zoom-suffixed and swapped pairs', () => {
  assert.deepEqual(parseLatLng('37.3,-122.1'), { lat: 37.3, lng: -122.1 });
  assert.deepEqual(parseLatLng('@37.3,-122.1,17z'), { lat: 37.3, lng: -122.1 });
  assert.deepEqual(parseLatLng('37.3 -122.1'), { lat: 37.3, lng: -122.1 });
  assert.deepEqual(parseLatLng('-122.1,37.3'), { lat: 37.3, lng: -122.1 }, 'only swapped when lat is impossible');
  assert.deepEqual(parseLatLng('51.5,150.0'), { lat: 51.5, lng: 150 }, 'a valid pair is never swapped');
  assert.equal(parseLatLng('100,200'), null);
  assert.equal(parseLatLng('somewhere'), null);
});

test('parseDataBlocks reads both the place form and the loose !4d!5d form', () => {
  const place = parseDataBlocks('/dir/A/B/data=!4m13!1m5!1m1!1s0x808f:0xb38f!2m2!1d-122.15!2d37.31!3e0');
  assert.deepEqual(place, [{ lat: 37.31, lng: -122.15, placeId: '0x808f:0xb38f', source: 'data' }]);
  const alt = parseDataBlocks('/maps/place/x/data=!4m5!3m4!1s0x1:0x2!8m2!3d37.42!4d-122.08');
  assert.deepEqual(alt, [{ lat: 37.42, lng: -122.08, source: 'data' }]);
  const loose = parseDataBlocks('/maps/dir/x/y/data=!4m2!2m2!1d-122.08!2d37.42');
  assert.deepEqual(loose, [{ lat: 37.42, lng: -122.08, source: 'data' }]);
  assert.deepEqual(parseDataBlocks('/maps/dir/A/B'), []);
});

test('out-of-range embedded coordinates are dropped rather than trusted', () => {
  const blocks = parseDataBlocks('/data=!1m5!1m1!1s0x1:0x2!2m2!1d999!2d37.3');
  assert.deepEqual(blocks, []);
});

test('stop count mismatch warns and still uses what it can', () => {
  const r = parseDirectionsUrl(
    'https://www.google.com/maps/dir/Alpha/Bravo/Gamma/data=!1m5!1m1!1s0x1:0x2!2m2!1d-122.1!2d37.3!1m5!1m1!1s0x3:0x4!2m2!1d-121.9!2d37.2',
  );
  assert.equal(r.waypoints.length, 3);
  assert.ok(r.warnings.some((w) => /could not be matched up/.test(w)));
  assert.equal(r.waypoints[0].lat, 37.3);
  assert.equal(r.waypoints[1].lat, 37.2);
  assert.equal(r.waypoints[2].lat, null);
  assert.equal(r.needsGeocode, true);
});

test('"your location" empty segment is called out', () => {
  const r = parseDirectionsUrl('https://www.google.com/maps/dir//1600+Amphitheatre+Parkway/');
  assert.equal(r.waypoints[0].name, 'Your location');
  assert.ok(r.warnings.some((w) => /your location/i.test(w)));
});

test('mixed !3e modes warn but still pick a mode', () => {
  const r = parseDirectionsUrl('https://www.google.com/maps/dir/A/B/data=!3e0!3e2');
  assert.equal(r.travelMode, 'driving');
  assert.ok(r.warnings.some((w) => /mixes travel modes/.test(w)));
});

test('unknown travel mode token degrades to a warning', () => {
  const r = parseDirectionsUrl('https://www.google.com/maps/dir/?api=1&origin=A&destination=B&travelmode=flying');
  assert.equal(r.travelMode, null);
  assert.ok(r.warnings.some((w) => /Unrecognised travel mode/.test(w)));
});

test('describeSource tells the user where each coordinate came from', () => {
  assert.equal(describeSource({ lat: 1, lng: 2, precision: 'exact' }), 'exact (from link)');
  assert.equal(describeSource({ lat: 1, lng: 2, source: 'path-name+geocoded' }), 'geocoded');
  assert.equal(describeSource({ lat: 1, lng: 2 }), 'from link');
  assert.equal(describeSource({ name: 'X' }), 'needs geocoding');
});

test('percent-encoded names and ampersands survive decoding', () => {
  const r = parseDirectionsUrl('https://www.google.com/maps/dir/Burger+%26+Fries/Hotel%20Beta/');
  assert.equal(r.waypoints[0].name, 'Burger & Fries');
  assert.equal(r.waypoints[1].name, 'Hotel Beta');
});
