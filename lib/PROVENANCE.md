# lib/ — imported code

These modules are copied verbatim from the sibling project **gmaps2gpx**
(<https://github.com/DavidPu/gmaps2gpx>, MIT). They are pure — no DOM, no globals — which is why
they could be lifted straight out:

| file | what it does |
|---|---|
| `parser.js` | any Google Maps URL → stops, travel mode, viewport |
| `shortlink.js` | expands `maps.app.goo.gl` links (needs a network reader; see below) |
| `geocode.js` | place names → coordinates, via Nominatim, throttled to 1 req/s |
| `geo.js` | haversine, bbox, densify, simplify, formatters |
| `polyline.js` | Google encoded-polyline codec |
| `elevation.js` | terrain heights from Open-Meteo / OpenTopoData |
| `routers/osrm.js` | road geometry from public OSRM routers, per travel mode |
| `routers/straight.js` | great-circle fallback, flagged `approximate` |

**Do not edit them here.** They are deliberately unmodified so that a fix landed upstream can be
re-copied with a plain `cp` instead of a three-way merge against a local fork. Their tests came
along too (`tests/parser.test.js`, `tests/geo.test.js`, `tests/elevation.test.js`,
`tests/routers.test.js`) — if you change one of these files, `npm test` will tell you.

Anything specific to this app lives in `../gmaps-import.js`, which is the only file allowed to
know about both these modules and `app.js`.

Two upstream modules were deliberately left behind: `gpx.js` (this app already has `GPXExporter`,
and two GPX writers in one app is how the two files start disagreeing) and
`routers/google.js` + `routers/index.js` (this app's routing goes through ORS/OSRM, not Google's
Directions API). `polyline.js` is kept because `geo.js`'s tests exercise it.
