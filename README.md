# hike — GPX Trace Viewer

Offline-first GPX viewer: tracks, elevation profiles, photos, POIs, live trace recording, and
route planning. No build step, no framework; deployable to any static host.

## Route planner

Press **Route**, then either:

* **paste a Google Maps directions link** and press Import, or
* click the map to place waypoints by hand.

A pasted link is parsed in the browser — the stops, the travel mode (so the profile dropdown
switches to walking/cycling/driving on its own) and the map region, which biases name lookups
towards the right city. Stops that only have names are geocoded via OpenStreetMap, and
`maps.app.goo.gl` short links are expanded by a public reader. No account, no API key.

Waypoints can be dragged; the route re-routes as you go. **Download GPX** writes `<wpt>` stops,
track points and `<ele>` heights.

### Where the geometry comes from

| | |
|---|---|
| **No key** (default) | Public OpenStreetMap routers — separate pedestrian, bicycle and car graphs, so a walk never comes back as a driving route. Heights from Open-Meteo's 90 m terrain model. |
| **ORS API key** | Snaps the route to trails via OpenRouteService, with elevations in the reply. Free key from [openrouteservice.org](https://openrouteservice.org/dev/#/signup). |

If a public router is down, or no route exists between two points, you get a straight-line
connection drawn **amber and dashed**, with the track named `(approximate)` and a `<desc>` in the
GPX saying so. An estimate is never presented as a route.

Heights are terrain, not measurement: a DEM reads the ground, so tunnels, bridges and valleys
behind ridges disagree with the path you actually took. Untick **Heights** to leave `<ele>` out.

## Development

```
npm test          # 95 unit tests (node --test, no dependencies)
npm run smoke     # drives the real page in headless Chrome against the live routing servers
npm start         # python3 -m http.server 8080
npm run sw        # regenerate the service-worker precache list after adding assets
```

`npm run smoke` is the one to trust before deploying: it boots the real page, types a link into the
import box, presses Import, and asserts that two waypoints appear, geometry arrives, every point
has a height, the download button unlocks, and a second routing request supersedes a first. It
fails rather than stubbing the network, so it needs internet. `BLOCK_MODULE=1 npm run smoke`
re-runs it with the importer missing, to confirm the planner falls back to its pre-feature
behaviour instead of half-wiring itself.

## Layout

```
index.html            one screen
app.js                the app: GPXParser, MapManager, GPXExporter, ElevationProfile,
                      GPXRecorder, RoutePlanner, App   (classic script)
gmaps-import.js       bridge: Google Maps link → waypoints, and waypoints → route
style.css             tokens in :root, everything else reads them
lib/                  imported from gmaps2gpx (MIT) — see lib/PROVENANCE.md
tests/                node --test; lib/ brings its own
scripts/e2e-smoke.mjs headless-Chrome smoke test
sw.js, sw-filelist.js offline support (regenerate with `npm run sw`)
generate-*.py         manifest, photo and elevation asset generators
```

## Licence

MIT. The modules under `lib/` are imported from [gmaps2gpx](https://github.com/DavidPu/gmaps2gpx)
and kept unmodified so upstream fixes can be re-copied with `cp`.
