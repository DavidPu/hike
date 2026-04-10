/* ───────────────────── GPX Parser ───────────────────── */

class GPXParser {
  static parse(xmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'application/xml');

    const errorNode = doc.querySelector('parsererror');
    if (errorNode) throw new Error('Invalid GPX file');

    const tracks = [];
    const trks = doc.querySelectorAll('trk');

    trks.forEach(trk => {
      const name = trk.querySelector('name')?.textContent || 'Unnamed Track';
      const points = [];

      trk.querySelectorAll('trkpt').forEach(pt => {
        const lat = parseFloat(pt.getAttribute('lat'));
        const lon = parseFloat(pt.getAttribute('lon'));
        const eleNode = pt.querySelector('ele');
        const timeNode = pt.querySelector('time');
        points.push({
          lat, lon,
          ele: eleNode ? parseFloat(eleNode.textContent) : null,
          time: timeNode ? new Date(timeNode.textContent) : null,
        });
      });

      if (points.length > 0) tracks.push({ name, points });
    });

    const waypoints = [];
    doc.querySelectorAll('wpt').forEach(wpt => {
      waypoints.push({
        lat: parseFloat(wpt.getAttribute('lat')),
        lon: parseFloat(wpt.getAttribute('lon')),
        name: wpt.querySelector('name')?.textContent || '',
        ele: wpt.querySelector('ele') ? parseFloat(wpt.querySelector('ele').textContent) : null,
      });
    });

    return { tracks, waypoints };
  }
}

/* ───────────────────── Stats Calculator ───────────────────── */

class StatsCalculator {
  static haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  static compute(points) {
    if (points.length < 2) return null;

    let totalDist = 0;
    let elevGain = 0;
    let elevLoss = 0;
    let movingTime = 0;
    let maxSpeed = 0;
    const hasTime = points[0].time !== null;
    const hasEle = points[0].ele !== null;

    const cumDist = [0];
    const speeds = [0];

    const STOP_THRESHOLD = 0.15; // m/s — below this is "stopped"

    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const d = StatsCalculator.haversine(prev.lat, prev.lon, curr.lat, curr.lon);
      totalDist += d;
      cumDist.push(totalDist);

      if (hasEle && prev.ele !== null && curr.ele !== null) {
        const dEle = curr.ele - prev.ele;
        if (dEle > 0) elevGain += dEle;
        else elevLoss += Math.abs(dEle);
      }

      if (hasTime && prev.time && curr.time) {
        const dt = (curr.time - prev.time) / 1000;
        if (dt > 0) {
          const speed = d / dt;
          speeds.push(speed);
          if (speed > STOP_THRESHOLD && dt < 300) {
            movingTime += dt;
          }
          if (speed < 50) maxSpeed = Math.max(maxSpeed, speed);
        } else {
          speeds.push(0);
        }
      } else {
        speeds.push(0);
      }
    }

    const totalTime = hasTime && points[0].time && points[points.length - 1].time
      ? (points[points.length - 1].time - points[0].time) / 1000
      : 0;

    const avgSpeed = movingTime > 0 ? totalDist / movingTime : 0;

    const elevations = hasEle ? points.map(p => p.ele).filter(e => e !== null) : [];
    const maxEle = elevations.length ? Math.max(...elevations) : null;
    const minEle = elevations.length ? Math.min(...elevations) : null;

    return {
      totalDist, totalTime, movingTime,
      elevGain, elevLoss, maxEle, minEle,
      avgSpeed, maxSpeed,
      cumDist, speeds,
    };
  }
}

/* ───────────────────── Formatting helpers ───────────────────── */

const M_TO_FT = 3.28084;
const M_TO_MI = 1 / 1609.344;
const MPS_TO_MPH = 2.23694;

function formatDist(m) {
  const mi = m * M_TO_MI;
  return mi >= 0.1 ? mi.toFixed(2) + ' mi' : Math.round(m * M_TO_FT) + ' ft';
}

function formatTime(secs) {
  if (!secs || secs <= 0) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

function formatSpeed(mps) {
  return (mps * MPS_TO_MPH).toFixed(1) + ' mph';
}

function formatPace(mps) {
  if (mps <= 0) return '—';
  const minPerMi = 1609.344 / mps / 60;
  const mins = Math.floor(minPerMi);
  const secs = Math.round((minPerMi - mins) * 60);
  return `${mins}:${secs.toString().padStart(2, '0')} /mi`;
}

function formatEle(m) {
  return m !== null && m !== undefined ? Math.round(m * M_TO_FT) + ' ft' : '—';
}

/* ───────────────────── Elevation color mapping ───────────────────── */

function elevationColor(normalized) {
  // 0 (low, blue-green) → 0.5 (yellow) → 1 (high, red)
  const t = Math.max(0, Math.min(1, normalized));
  let r, g, b;
  if (t < 0.25) {
    const s = t / 0.25;
    r = 34; g = Math.round(139 + s * (163 - 139)); b = Math.round(136 + s * (71 - 136));
  } else if (t < 0.5) {
    const s = (t - 0.25) / 0.25;
    r = Math.round(34 + s * (234 - 34)); g = Math.round(163 + s * (179 - 163)); b = Math.round(71 + s * (8 - 71));
  } else if (t < 0.75) {
    const s = (t - 0.5) / 0.25;
    r = Math.round(234 + s * (239 - 234)); g = Math.round(179 - s * (179 - 68)); b = 8;
  } else {
    const s = (t - 0.75) / 0.25;
    r = Math.round(239 - s * (39)); g = Math.round(68 - s * (38)); b = Math.round(8 + s * (48));
  }
  return `rgb(${r},${g},${b})`;
}

/* ───────────────────── Map Manager ───────────────────── */

class MapManager {
  constructor(containerId) {
    this.map = L.map(containerId, {
      zoomControl: true,
      preferCanvas: true,
    }).setView([37.18, -121.5], 13);

    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    });

    const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenTopoMap',
      maxZoom: 17,
    });

    const satellite = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: '&copy; Esri',
      maxZoom: 19,
    });

    osm.addTo(this.map);
    L.control.layers({ 'Street': osm, 'Topo': topo, 'Satellite': satellite }, null, { position: 'topleft' }).addTo(this.map);

    this.trackLayers = [];
    this.hoverMarker = null;
    this.waypointMarkers = [];
  }

  clear() {
    this.trackLayers.forEach(l => this.map.removeLayer(l));
    this.trackLayers = [];
    this.waypointMarkers.forEach(m => this.map.removeLayer(m));
    this.waypointMarkers = [];
    if (this.hoverMarker) {
      this.map.removeLayer(this.hoverMarker);
      this.hoverMarker = null;
    }
  }

  loadTrack(points, stats, { fitBounds = true } = {}) {
    const latlngs = points.map(p => [p.lat, p.lon]);
    const bounds = L.latLngBounds(latlngs);

    const hasEle = points.some(p => p.ele !== null);
    const minEle = stats?.minEle ?? 0;
    const maxEle = stats?.maxEle ?? 1;
    const eleRange = maxEle - minEle || 1;

    // Background shadow line
    const shadow = L.polyline(latlngs, {
      color: '#475569',
      weight: 6,
      opacity: 0.25,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false,
    }).addTo(this.map);
    this.trackLayers.push(shadow);

    // Colored segments by elevation
    const SEGMENT_SIZE = 3;
    for (let i = 0; i < points.length - 1; i += SEGMENT_SIZE) {
      const end = Math.min(i + SEGMENT_SIZE + 1, points.length);
      const seg = latlngs.slice(i, end);
      const midIdx = Math.min(i + Math.floor(SEGMENT_SIZE / 2), points.length - 1);
      const normalized = hasEle && points[midIdx].ele !== null
        ? (points[midIdx].ele - minEle) / eleRange
        : 0.3;

      const line = L.polyline(seg, {
        color: elevationColor(normalized),
        weight: 4,
        opacity: 0.9,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false,
      }).addTo(this.map);
      this.trackLayers.push(line);
    }

    // Invisible wide line for hover interaction
    const hoverLine = L.polyline(latlngs, {
      color: 'transparent',
      weight: 20,
      opacity: 0,
      interactive: true,
    }).addTo(this.map);
    this.trackLayers.push(hoverLine);
    this._hoverLine = hoverLine;

    // Start / End markers
    const startIcon = L.divIcon({ className: '', html: '<div class="marker-start">S</div>', iconSize: [24, 24], iconAnchor: [12, 12] });
    const endIcon = L.divIcon({ className: '', html: '<div class="marker-end">E</div>', iconSize: [24, 24], iconAnchor: [12, 12] });

    const startMarker = L.marker(latlngs[0], { icon: startIcon, interactive: false }).addTo(this.map);
    const endMarker = L.marker(latlngs[latlngs.length - 1], { icon: endIcon, interactive: false }).addTo(this.map);
    this.trackLayers.push(startMarker, endMarker);

    if (fitBounds) this.map.fitBounds(bounds, { padding: [40, 40] });

    return hoverLine;
  }

  fitAll() {
    const allLatLngs = [];
    this.trackLayers.forEach(l => {
      if (l.getLatLngs) {
        const ll = l.getLatLngs();
        if (ll.length && ll[0].lat !== undefined) allLatLngs.push(...ll);
        else allLatLngs.push(...ll.flat());
      }
    });
    if (allLatLngs.length > 0) {
      this.map.fitBounds(L.latLngBounds(allLatLngs), { padding: [40, 40] });
    }
  }

  loadWaypoints(waypoints) {
    waypoints.forEach(wp => {
      const m = L.marker([wp.lat, wp.lon])
        .bindPopup(`<b>${wp.name}</b>${wp.ele !== null ? '<br>Elev: ' + formatEle(wp.ele) : ''}`)
        .addTo(this.map);
      this.waypointMarkers.push(m);
    });
  }

  setHoverMarker(lat, lon, tooltipHtml) {
    if (!this.hoverMarker) {
      this.hoverMarker = L.circleMarker([lat, lon], {
        radius: 7,
        color: '#1e293b',
        fillColor: '#ffffff',
        fillOpacity: 1,
        weight: 2.5,
      }).addTo(this.map);
      if (tooltipHtml) {
        this.hoverMarker.bindTooltip(tooltipHtml, { permanent: true, direction: 'top', offset: [0, -10], className: 'hover-tooltip' });
      }
    } else {
      this.hoverMarker.setLatLng([lat, lon]);
      if (tooltipHtml) {
        this.hoverMarker.unbindTooltip();
        this.hoverMarker.bindTooltip(tooltipHtml, { permanent: true, direction: 'top', offset: [0, -10], className: 'hover-tooltip' });
      }
    }
  }

  removeHoverMarker() {
    if (this.hoverMarker) {
      this.map.removeLayer(this.hoverMarker);
      this.hoverMarker = null;
    }
  }
}

/* ───────────────────── Elevation Profile (Chart.js) ───────────────────── */

class ElevationProfile {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.chart = null;
    this.onHoverCallback = null;
    this.onLeaveCallback = null;
  }

  destroy() {
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }
  }

  load(points, stats) {
    this.destroy();
    this.points = points;
    this.stats = stats;

    const cumDist = stats.cumDist;
    const maxDistMi = cumDist[cumDist.length - 1] * M_TO_MI;
    const minEle = stats.minEle ?? 0;
    const maxEle = stats.maxEle ?? 1;
    const minEleFt = minEle * M_TO_FT;
    const maxEleFt = maxEle * M_TO_FT;

    const chartData = points.map((p, i) => ({
      x: cumDist[i] * M_TO_MI,
      y: (p.ele ?? 0) * M_TO_FT,
    }));

    const self = this;

    const crosshairPlugin = {
      id: 'crosshair',
      afterDraw(chart) {
        if (chart._crosshairX == null) return;
        const { ctx, chartArea: { top, bottom } } = chart;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(chart._crosshairX, top);
        ctx.lineTo(chart._crosshairX, bottom);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(30, 41, 59, 0.4)';
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.restore();
      }
    };

    const canvasCtx = this.ctx;

    this.chart = new Chart(this.ctx, {
      type: 'line',
      data: {
        datasets: [{
          data: chartData,
          fill: true,
          borderColor: '#0d9488',
          borderWidth: 2,
          backgroundColor: (context) => {
            const chart = context.chart;
            const { chartArea } = chart;
            if (!chartArea) return 'rgba(13,148,136,0.2)';
            const gradient = canvasCtx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
            gradient.addColorStop(0, 'rgba(13, 148, 136, 0.35)');
            gradient.addColorStop(1, 'rgba(13, 148, 136, 0.02)');
            return gradient;
          },
          pointRadius: 0,
          pointHitRadius: 0,
          tension: 0.2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false },
        },
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: 'Distance (mi)', font: { size: 11, weight: '500' }, color: '#94a3b8' },
            ticks: {
              font: { size: 10 },
              color: '#94a3b8',
              callback: v => v.toFixed(1),
              maxTicksLimit: 10,
            },
            grid: { color: 'rgba(148, 163, 184, 0.12)' },
            min: 0,
            max: maxDistMi,
          },
          y: {
            title: { display: true, text: 'Elevation (ft)', font: { size: 11, weight: '500' }, color: '#94a3b8' },
            ticks: { font: { size: 10 }, color: '#94a3b8', maxTicksLimit: 6 },
            grid: { color: 'rgba(148, 163, 184, 0.12)' },
            suggestedMin: minEleFt - (maxEleFt - minEleFt) * 0.1,
            suggestedMax: maxEleFt + (maxEleFt - minEleFt) * 0.1,
          },
        },
        onHover: (event, elements, chart) => {
          if (!event.native) return;
          const rect = self.canvas.getBoundingClientRect();
          const x = event.native.clientX - rect.left;
          const chartArea = chart.chartArea;

          if (x < chartArea.left || x > chartArea.right) {
            chart._crosshairX = null;
            chart.draw();
            if (self.onLeaveCallback) self.onLeaveCallback();
            return;
          }

          chart._crosshairX = x;
          chart.draw();

          const xScale = chart.scales.x;
          const distMi = xScale.getValueForPixel(x);
          const distM = distMi / M_TO_MI;

          const idx = self._findNearestIndex(distM);
          if (idx >= 0 && self.onHoverCallback) {
            self.onHoverCallback(idx, distM);
          }
        },
      },
      plugins: [crosshairPlugin],
    });

    this.canvas.addEventListener('mouseleave', () => {
      if (this.chart) {
        this.chart._crosshairX = null;
        this.chart.draw();
      }
      if (this.onLeaveCallback) this.onLeaveCallback();
    });
  }

  _findNearestIndex(distM) {
    const cumDist = this.stats.cumDist;
    let lo = 0, hi = cumDist.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumDist[mid] < distM) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(cumDist[lo - 1] - distM) < Math.abs(cumDist[lo] - distM)) lo--;
    return lo;
  }

  highlightIndex(idx) {
    if (!this.chart) return;
    const distMi = this.stats.cumDist[idx] * M_TO_MI;
    const xScale = this.chart.scales.x;
    const px = xScale.getPixelForValue(distMi);
    this.chart._crosshairX = px;
    this.chart.draw();
  }

  clearHighlight() {
    if (!this.chart) return;
    this.chart._crosshairX = null;
    this.chart.draw();
  }

  onHover(cb) { this.onHoverCallback = cb; }
  onLeave(cb) { this.onLeaveCallback = cb; }
}

/* ───────────────────── App Controller ───────────────────── */

class App {
  constructor() {
    this.mapManager = new MapManager('map');
    this.elevationProfile = new ElevationProfile('elevation-chart');
    this.currentTrack = null;
    this.currentStats = null;

    this._initUI();
    this._initDragDrop();
    this._loadManifest();
  }

  _initUI() {
    this.trackSelect = document.getElementById('track-select');
    this.fileInput = document.getElementById('file-input');
    this.statsOverlay = document.getElementById('stats-overlay');
    this.loadingOverlay = document.getElementById('loading-overlay');

    this.trackSelect.addEventListener('change', () => {
      const val = this.trackSelect.value;
      if (val === '__all__') this.loadAll();
      else if (val && !val.startsWith('__local__')) this.loadFromUrl(val);
    });

    this.fileInput.addEventListener('change', (e) => {
      const files = e.target.files;
      if (files.length > 0) this.loadFromFile(files[0]);
    });

    this.elevationProfile.onHover((idx, distM) => {
      const pt = this.currentTrack[idx];
      if (!pt) return;
      const speed = this.currentStats.speeds[idx];
      const tooltip = `
        <b>${formatEle(pt.ele)}</b><br>
        ${formatDist(distM)} &middot; ${formatSpeed(speed)}
      `;
      this.mapManager.setHoverMarker(pt.lat, pt.lon, tooltip);
    });

    this.elevationProfile.onLeave(() => {
      this.mapManager.removeHoverMarker();
    });
  }

  _initDragDrop() {
    const dropOverlay = document.getElementById('drop-overlay');
    let dragCounter = 0;

    document.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      dropOverlay.classList.remove('hidden');
    });

    document.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        dropOverlay.classList.add('hidden');
      }
    });

    document.addEventListener('dragover', (e) => e.preventDefault());

    document.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCounter = 0;
      dropOverlay.classList.add('hidden');
      const file = e.dataTransfer.files[0];
      if (file && file.name.toLowerCase().endsWith('.gpx')) {
        this.loadFromFile(file);
      }
    });
  }

  async _loadManifest() {
    try {
      const resp = await fetch('gpx-manifest.json?t=' + Date.now());
      if (!resp.ok) throw new Error('No manifest');
      this.manifest = await resp.json();

      this.trackSelect.innerHTML = '';

      if (this.manifest.length > 1) {
        const allOpt = document.createElement('option');
        allOpt.value = '__all__';
        allOpt.textContent = 'Show All';
        this.trackSelect.appendChild(allOpt);
      }

      this.manifest.forEach(entry => {
        const opt = document.createElement('option');
        opt.value = entry.path;
        opt.textContent = entry.name;
        this.trackSelect.appendChild(opt);
      });

      if (this.manifest.length > 1) {
        this.trackSelect.value = '__all__';
        this.loadAll();
      } else if (this.manifest.length === 1) {
        this.trackSelect.value = this.manifest[0].path;
        this.loadFromUrl(this.manifest[0].path);
      }
    } catch {
      this.trackSelect.innerHTML = '<option value="">No tracks found — upload a GPX file</option>';
    }
  }

  async loadAll() {
    if (!this.manifest || this.manifest.length === 0) return;
    this._showLoading();
    try {
      const results = await Promise.all(
        this.manifest.map(async entry => {
          const resp = await fetch(entry.path);
          if (!resp.ok) throw new Error(`Failed to load ${entry.path}`);
          return resp.text();
        })
      );
      this._processMultipleGPX(results);
    } catch (err) {
      console.error(err);
      alert('Failed to load GPX files: ' + err.message);
    } finally {
      this._hideLoading();
    }
  }

  _showLoading() { this.loadingOverlay.classList.remove('hidden'); }
  _hideLoading() { this.loadingOverlay.classList.add('hidden'); }

  async loadFromUrl(url) {
    this._showLoading();
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Failed to load ${url}`);
      const xml = await resp.text();
      this._processGPX(xml);
    } catch (err) {
      console.error(err);
      alert('Failed to load GPX file: ' + err.message);
    } finally {
      this._hideLoading();
    }
  }

  loadFromFile(file) {
    this._showLoading();
    const reader = new FileReader();
    reader.onload = (e) => {
      this._processGPX(e.target.result);
      this._hideLoading();

      // Add to dropdown
      const opt = document.createElement('option');
      opt.value = '__local__' + file.name;
      opt.textContent = file.name.replace('.gpx', '');
      this.trackSelect.appendChild(opt);
      this.trackSelect.value = opt.value;
    };
    reader.onerror = () => {
      this._hideLoading();
      alert('Failed to read file');
    };
    reader.readAsText(file);
  }

  _processMultipleGPX(xmlStrings) {
    this.mapManager.clear();

    let allPoints = [];
    const hoverLines = [];

    for (const xml of xmlStrings) {
      const parsed = GPXParser.parse(xml);
      if (parsed.tracks.length === 0) continue;

      const trackPoints = parsed.tracks.flatMap(t => t.points);
      const trackStats = StatsCalculator.compute(trackPoints);
      const hoverLine = this.mapManager.loadTrack(trackPoints, trackStats, { fitBounds: false });
      hoverLines.push({ hoverLine, points: trackPoints, stats: trackStats });
      allPoints = allPoints.concat(trackPoints);

      if (parsed.waypoints.length > 0) {
        this.mapManager.loadWaypoints(parsed.waypoints);
      }
    }

    if (allPoints.length === 0) {
      alert('No tracks found in GPX files');
      return;
    }

    this.mapManager.fitAll();

    const combinedStats = StatsCalculator.compute(allPoints);
    this.currentTrack = allPoints;
    this.currentStats = combinedStats;

    this.elevationProfile.load(allPoints, combinedStats);
    this._updateStats(combinedStats);

    for (const { hoverLine, points, stats } of hoverLines) {
      hoverLine.on('mousemove', (e) => {
        const nearest = this._findNearestPointIn(points, e.latlng);
        if (nearest.idx >= 0) {
          const pt = points[nearest.idx];
          const speed = stats.speeds[nearest.idx];
          const distM = stats.cumDist[nearest.idx];
          const tooltip = `
            <b>${formatEle(pt.ele)}</b><br>
            ${formatDist(distM)} &middot; ${formatSpeed(speed)}
          `;
          this.mapManager.setHoverMarker(pt.lat, pt.lon, tooltip);
        }
      });

      hoverLine.on('mouseout', () => {
        this.mapManager.removeHoverMarker();
      });
    }
  }

  _processGPX(xmlString) {
    const parsed = GPXParser.parse(xmlString);

    if (parsed.tracks.length === 0) {
      alert('No tracks found in GPX file');
      return;
    }

    const allPoints = parsed.tracks.flatMap(t => t.points);
    const stats = StatsCalculator.compute(allPoints);

    this.currentTrack = allPoints;
    this.currentStats = stats;

    this.mapManager.clear();
    const hoverLine = this.mapManager.loadTrack(allPoints, stats);

    if (parsed.waypoints.length > 0) {
      this.mapManager.loadWaypoints(parsed.waypoints);
    }

    this.elevationProfile.load(allPoints, stats);
    this._updateStats(stats);

    // Map hover → chart sync
    hoverLine.on('mousemove', (e) => {
      const nearest = this._findNearestPoint(e.latlng);
      if (nearest.idx >= 0) {
        const pt = allPoints[nearest.idx];
        const speed = stats.speeds[nearest.idx];
        const distM = stats.cumDist[nearest.idx];
        const tooltip = `
          <b>${formatEle(pt.ele)}</b><br>
          ${formatDist(distM)} &middot; ${formatSpeed(speed)}
        `;
        this.mapManager.setHoverMarker(pt.lat, pt.lon, tooltip);
        this.elevationProfile.highlightIndex(nearest.idx);
      }
    });

    hoverLine.on('mouseout', () => {
      this.mapManager.removeHoverMarker();
      this.elevationProfile.clearHighlight();
    });
  }

  _findNearestPoint(latlng) {
    return this._findNearestPointIn(this.currentTrack, latlng);
  }

  _findNearestPointIn(pts, latlng) {
    if (!pts || pts.length === 0) return { idx: -1, dist: Infinity };
    let minDist = Infinity;
    let minIdx = -1;
    const lat = latlng.lat, lon = latlng.lng;

    const step = pts.length > 2000 ? 3 : 1;
    for (let i = 0; i < pts.length; i += step) {
      const d = (pts[i].lat - lat) ** 2 + (pts[i].lon - lon) ** 2;
      if (d < minDist) { minDist = d; minIdx = i; }
    }

    if (step > 1) {
      const lo = Math.max(0, minIdx - step);
      const hi = Math.min(pts.length - 1, minIdx + step);
      for (let i = lo; i <= hi; i++) {
        const d = (pts[i].lat - lat) ** 2 + (pts[i].lon - lon) ** 2;
        if (d < minDist) { minDist = d; minIdx = i; }
      }
    }

    return { idx: minIdx, dist: Math.sqrt(minDist) };
  }

  _updateStats(stats) {
    if (!stats) {
      this.statsOverlay.classList.add('hidden');
      return;
    }
    this.statsOverlay.classList.remove('hidden');

    document.getElementById('stat-distance').textContent = formatDist(stats.totalDist);
    document.getElementById('stat-duration').textContent = formatTime(stats.totalTime);
    document.getElementById('stat-moving').textContent = formatTime(stats.movingTime);
    document.getElementById('stat-gain').textContent = '+' + Math.round(stats.elevGain * M_TO_FT) + ' ft';
    document.getElementById('stat-loss').textContent = '-' + Math.round(stats.elevLoss * M_TO_FT) + ' ft';
    document.getElementById('stat-max-ele').textContent = formatEle(stats.maxEle);
    document.getElementById('stat-avg-speed').textContent = formatSpeed(stats.avgSpeed);
    document.getElementById('stat-max-speed').textContent = formatSpeed(stats.maxSpeed);
    document.getElementById('stat-avg-pace').textContent = formatPace(stats.avgSpeed);
  }
}

/* ───────────────────── Bootstrap ───────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
