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
    this.photoMarkers = [];
    this._locationMarker = null;
    this._locationCircle = null;
    this._watchId = null;
  }

  initLocateControl() {
    if (!navigator.geolocation) return;

    const LocateControl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: () => {
        const btn = L.DomUtil.create('div', 'leaflet-bar leaflet-control locate-control');
        btn.innerHTML = '<a href="#" title="Show my location" role="button" aria-label="Show my location">'
          + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
          + '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3m10-10h-3M5 12H2"/><circle cx="12" cy="12" r="8"/>'
          + '</svg></a>';
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, 'click', (e) => {
          L.DomEvent.preventDefault(e);
          this._locateUser(true);
        });
        return btn;
      },
    });

    new LocateControl().addTo(this.map);
    this._locateUser(false);
  }

  _locateUser(panTo) {
    const el = this.map.getContainer().querySelector('.locate-control a');

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        const accuracy = pos.coords.accuracy;

        if (!this._locationMarker) {
          this._locationMarker = L.circleMarker([lat, lon], {
            radius: 7,
            color: '#ffffff',
            fillColor: '#3b82f6',
            fillOpacity: 1,
            weight: 3,
          }).addTo(this.map);

          this._locationCircle = L.circle([lat, lon], {
            radius: accuracy,
            color: '#3b82f6',
            fillColor: '#3b82f6',
            fillOpacity: 0.1,
            weight: 1,
            interactive: false,
          }).addTo(this.map);
        } else {
          this._locationMarker.setLatLng([lat, lon]);
          this._locationCircle.setLatLng([lat, lon]);
          this._locationCircle.setRadius(accuracy);
        }

        if (el) el.classList.add('located');
        if (panTo) this.map.setView([lat, lon], Math.max(this.map.getZoom(), 15));
      },
      () => {
        if (panTo) alert('Unable to get your location.');
      },
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 10000 }
    );

    if (this._watchId === null) {
      this._watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const lat = pos.coords.latitude;
          const lon = pos.coords.longitude;
          const accuracy = pos.coords.accuracy;
          if (this._locationMarker) {
            this._locationMarker.setLatLng([lat, lon]);
            this._locationCircle.setLatLng([lat, lon]);
            this._locationCircle.setRadius(accuracy);
          }
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
      );
    }
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

  clearPhotos() {
    this.photoMarkers.forEach(m => this.map.removeLayer(m));
    this.photoMarkers = [];
  }

  loadPhotos(photos, onPhotoClick) {
    this.clearPhotos();
    photos.forEach((photo, i) => {
      const icon = L.divIcon({
        className: 'photo-marker-wrapper',
        html: `<div class="photo-marker"><img src="${photo.thumb}" alt="${photo.name}" loading="lazy"></div>`,
        iconSize: [44, 44],
        iconAnchor: [22, 22],
      });
      const marker = L.marker([photo.lat, photo.lon], { icon })
        .addTo(this.map);
      marker.on('click', () => onPhotoClick(i));
      this.photoMarkers.push(marker);
    });
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

  addPOIMarker(poi, { onEdit, onDelete }) {
    const icon = L.divIcon({
      className: 'poi-marker-wrapper',
      html: '<div class="poi-marker-icon"></div>',
      iconSize: [28, 28],
      iconAnchor: [4, 28],
    });

    const marker = L.marker([poi.lat, poi.lon], { icon }).addTo(this.map);

    const popupHtml = this._poiPopupHtml(poi);
    const popup = L.popup({ className: 'poi-popup', closeButton: true, maxWidth: 280, minWidth: 240 })
      .setContent(popupHtml);
    marker.bindPopup(popup);

    marker.on('popupopen', () => {
      const container = marker.getPopup().getElement();
      if (!container) return;

      const saveBtn = container.querySelector('.poi-btn-save');
      const deleteBtn = container.querySelector('.poi-btn-delete');
      const nameInput = container.querySelector('.poi-name-input');
      const commentInput = container.querySelector('.poi-comment-input');

      if (saveBtn) {
        saveBtn.addEventListener('click', () => {
          const newName = nameInput?.value.trim() || 'Unnamed POI';
          const newComment = commentInput?.value.trim() || '';
          onEdit({ ...poi, name: newName, comment: newComment });
          marker.closePopup();
        });
      }
      if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
          onDelete(poi);
          marker.closePopup();
        });
      }
    });

    poi._marker = marker;
    return marker;
  }

  removePOIMarker(poi) {
    if (poi._marker) {
      this.map.removeLayer(poi._marker);
      poi._marker = null;
    }
  }

  openPOIPopup(poi) {
    if (poi._marker) {
      this.map.setView([poi.lat, poi.lon], this.map.getZoom());
      poi._marker.openPopup();
    }
  }

  updatePOIPopup(poi) {
    if (poi._marker) {
      const popup = poi._marker.getPopup();
      if (popup) popup.setContent(this._poiPopupHtml(poi));
    }
  }

  _poiPopupHtml(poi) {
    return `<div class="poi-form">
      <div class="poi-form-title">Place of Interest</div>
      <div class="field">
        <label>Name</label>
        <input class="poi-name-input" type="text" value="${this._esc(poi.name)}" placeholder="e.g. Scenic viewpoint">
      </div>
      <div class="field">
        <label>Comment</label>
        <textarea class="poi-comment-input" placeholder="Add a note…">${this._esc(poi.comment)}</textarea>
      </div>
      <div class="poi-info">${formatEle(poi.ele)} · ${poi.lat.toFixed(5)}, ${poi.lon.toFixed(5)}</div>
      <div class="poi-form-actions">
        <button class="poi-btn-save">Save</button>
        <button class="poi-btn-delete">Delete</button>
      </div>
    </div>`;
  }

  _esc(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  showNewPOIPopup(latlng, ele, onSave, onCancel) {
    let saved = false;

    const popup = L.popup({ className: 'poi-popup', closeButton: true, maxWidth: 280, minWidth: 240 })
      .setLatLng(latlng)
      .setContent(`<div class="poi-form">
        <div class="poi-form-title">New Place of Interest</div>
        <div class="field">
          <label>Name</label>
          <input class="poi-name-input" type="text" placeholder="e.g. Scenic viewpoint" autofocus>
        </div>
        <div class="field">
          <label>Comment</label>
          <textarea class="poi-comment-input" placeholder="Add a note…"></textarea>
        </div>
        <div class="poi-info">${formatEle(ele)} · ${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}</div>
        <div class="poi-form-actions">
          <button class="poi-btn-save">Add</button>
          <button class="poi-btn-cancel">Cancel</button>
        </div>
      </div>`)
      .openOn(this.map);

    const container = popup.getElement();
    if (container) {
      const nameInput = container.querySelector('.poi-name-input');
      if (nameInput) nameInput.focus();

      container.querySelector('.poi-btn-save')?.addEventListener('click', () => {
        saved = true;
        const name = container.querySelector('.poi-name-input')?.value.trim() || 'Unnamed POI';
        const comment = container.querySelector('.poi-comment-input')?.value.trim() || '';
        this.map.closePopup(popup);
        onSave(name, comment);
      });

      container.querySelector('.poi-btn-cancel')?.addEventListener('click', () => {
        this.map.closePopup(popup);
      });
    }

    this.map.once('popupclose', () => {
      if (!saved) onCancel();
    });

    return popup;
  }
}

/* ───────────────────── GPX Exporter ───────────────────── */

class GPXExporter {
  static export(tracks, pois, trackName) {
    const lines = [
      '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
      '<gpx xmlns="http://www.topografix.com/GPX/1/1" creator="GPX Trace Viewer" version="1.1">',
      '  <metadata>',
      `    <time>${new Date().toISOString()}</time>`,
      '  </metadata>',
    ];

    for (const poi of pois) {
      lines.push(`  <wpt lat="${poi.lat}" lon="${poi.lon}">`);
      if (poi.ele !== null && poi.ele !== undefined) lines.push(`    <ele>${poi.ele}</ele>`);
      lines.push(`    <name>${GPXExporter._xml(poi.name)}</name>`);
      if (poi.comment) lines.push(`    <cmt>${GPXExporter._xml(poi.comment)}</cmt>`);
      lines.push(`    <desc>${GPXExporter._xml(poi.comment || '')}</desc>`);
      lines.push('  </wpt>');
    }

    for (const track of tracks) {
      lines.push('  <trk>');
      lines.push(`    <name>${GPXExporter._xml(trackName || track.name || 'Track')}</name>`);
      lines.push('    <trkseg>');
      for (const pt of track.points) {
        lines.push(`      <trkpt lat="${pt.lat}" lon="${pt.lon}">`);
        if (pt.ele !== null && pt.ele !== undefined) lines.push(`        <ele>${pt.ele}</ele>`);
        if (pt.time) lines.push(`        <time>${pt.time instanceof Date ? pt.time.toISOString() : pt.time}</time>`);
        lines.push('      </trkpt>');
      }
      lines.push('    </trkseg>');
      lines.push('  </trk>');
    }

    lines.push('</gpx>');
    return lines.join('\n');
  }

  static _xml(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  static download(content, filename) {
    const blob = new Blob([content], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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

/* ───────────────────── GPX Recorder ───────────────────── */

class GPXRecorder {
  constructor(map) {
    this.map = map;
    this.points = [];
    this.state = 'idle'; // idle | recording | paused | stopped
    this._watchId = null;
    this._startTime = null;
    this._elapsed = 0;
    this._timerInterval = null;
    this._polyline = null;
    this._latlngs = [];

    this.fab = document.getElementById('rec-fab');
    this.panel = document.getElementById('rec-panel');
    this.btnStart = document.getElementById('rec-start');
    this.btnPause = document.getElementById('rec-pause');
    this.btnResume = document.getElementById('rec-resume');
    this.btnStop = document.getElementById('rec-stop');
    this.btnDownload = document.getElementById('rec-download');
    this.elDist = document.getElementById('rec-distance');
    this.elDur = document.getElementById('rec-duration');
    this.elPts = document.getElementById('rec-points');

    this.fab.addEventListener('click', () => this._togglePanel());
    document.getElementById('rec-panel-close').addEventListener('click', () => this._closePanel());
    this.btnStart.addEventListener('click', () => this.start());
    this.btnPause.addEventListener('click', () => this.pause());
    this.btnResume.addEventListener('click', () => this.resume());
    this.btnStop.addEventListener('click', () => this.stop());
    this.btnDownload.addEventListener('click', () => this.download());
  }

  _togglePanel() {
    if (this.panel.classList.contains('hidden')) {
      this.panel.classList.remove('hidden');
      this.fab.classList.add('hidden');
    } else {
      this._closePanel();
    }
  }

  _closePanel() {
    this.panel.classList.add('hidden');
    this.fab.classList.remove('hidden');
  }

  start() {
    if (!navigator.geolocation) {
      alert('Geolocation is not supported by your browser.');
      return;
    }

    this.points = [];
    this._latlngs = [];
    this._elapsed = 0;
    this._startTime = Date.now();
    this.state = 'recording';

    if (this._polyline) {
      this.map.removeLayer(this._polyline);
      this._polyline = null;
    }
    this._polyline = L.polyline([], {
      color: '#dc2626',
      weight: 4,
      opacity: 0.85,
      dashArray: '8,6',
    }).addTo(this.map);

    this._startWatch();
    this._startTimer();
    this._updateUI();
  }

  pause() {
    this._elapsed += Date.now() - this._startTime;
    this.state = 'paused';
    this._stopWatch();
    this._stopTimer();
    this._updateUI();
  }

  resume() {
    this._startTime = Date.now();
    this.state = 'recording';
    this._startWatch();
    this._startTimer();
    this._updateUI();
  }

  stop() {
    if (this.state === 'recording') {
      this._elapsed += Date.now() - this._startTime;
    }
    this.state = 'stopped';
    this._stopWatch();
    this._stopTimer();
    this.fab.classList.remove('recording');

    if (this._polyline) {
      this._polyline.setStyle({ dashArray: null, opacity: 0.9 });
    }

    this._updateUI();
  }

  download() {
    if (this.points.length === 0) {
      alert('No points recorded.');
      return;
    }

    const tracks = [{ name: 'Recorded Track', points: this.points }];
    const gpx = GPXExporter.export(tracks, [], 'Recorded Track');
    const ts = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    GPXExporter.download(gpx, `recorded_${ts}.gpx`);
  }

  _startWatch() {
    this._watchId = navigator.geolocation.watchPosition(
      (pos) => this._onPosition(pos),
      (err) => console.warn('[Recorder] GPS error:', err.message),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    );
    this.fab.classList.add('recording');
  }

  _stopWatch() {
    if (this._watchId !== null) {
      navigator.geolocation.clearWatch(this._watchId);
      this._watchId = null;
    }
  }

  _startTimer() {
    this._timerInterval = setInterval(() => this._updateStats(), 1000);
  }

  _stopTimer() {
    if (this._timerInterval) {
      clearInterval(this._timerInterval);
      this._timerInterval = null;
    }
  }

  _onPosition(pos) {
    const pt = {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      ele: pos.coords.altitude,
      time: new Date(pos.timestamp),
    };
    this.points.push(pt);
    this._latlngs.push([pt.lat, pt.lon]);

    if (this._polyline) {
      this._polyline.setLatLngs(this._latlngs);
    }

    this._updateStats();
  }

  _totalDist() {
    let dist = 0;
    for (let i = 1; i < this.points.length; i++) {
      dist += StatsCalculator.haversine(
        this.points[i - 1].lat, this.points[i - 1].lon,
        this.points[i].lat, this.points[i].lon
      );
    }
    return dist;
  }

  _getElapsed() {
    let e = this._elapsed;
    if (this.state === 'recording' && this._startTime) {
      e += Date.now() - this._startTime;
    }
    return e / 1000;
  }

  _updateStats() {
    const dist = this._totalDist();
    const secs = this._getElapsed();
    this.elDist.textContent = formatDist(dist);
    this.elDur.textContent = this._fmtDur(secs);
    this.elPts.textContent = this.points.length;
  }

  _fmtDur(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h > 0
      ? `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
      : `${m}:${sec.toString().padStart(2, '0')}`;
  }

  _updateUI() {
    const s = this.state;
    this.btnStart.classList.toggle('hidden', s !== 'idle');
    this.btnPause.classList.toggle('hidden', s !== 'recording');
    this.btnResume.classList.toggle('hidden', s !== 'paused');
    this.btnStop.classList.toggle('hidden', s === 'idle' || s === 'stopped');
    this.btnStop.disabled = false;
    this.btnDownload.classList.toggle('hidden', s !== 'stopped' || this.points.length === 0);
  }
}

/* ───────────────────── Route Planner ───────────────────── */

class RoutePlanner {
  constructor(map, elevationProfile) {
    this.map = map;
    this._elevProfile = elevationProfile;
    this._savedTrack = null;
    this._savedStats = null;
    this.active = false;
    this.waypoints = [];
    this.routePoints = [];
    this._routeLine = null;
    this._directLine = null;

    this.panel = document.getElementById('route-panel');
    this.btn = document.getElementById('btn-route-planner');
    this.wpList = document.getElementById('route-waypoints-list');
    this.hint = document.getElementById('route-hint');
    this.statsEl = document.getElementById('route-stats');
    this.distEl = document.getElementById('route-dist');
    this.timeEl = document.getElementById('route-time');
    this.btnUndo = document.getElementById('route-undo');
    this.btnClear = document.getElementById('route-clear');
    this.btnDownload = document.getElementById('route-download');
    this.profileSelect = document.getElementById('route-profile');
    this.apiKeyInput = document.getElementById('route-api-key');

    const savedKey = localStorage.getItem('ors_api_key');
    if (savedKey) this.apiKeyInput.value = savedKey;

    this.apiKeyInput.addEventListener('change', () => {
      localStorage.setItem('ors_api_key', this.apiKeyInput.value.trim());
    });

    this.btn.addEventListener('click', () => this.toggle());
    document.getElementById('route-panel-close').addEventListener('click', () => this.deactivate());
    this.btnUndo.addEventListener('click', () => this.undo());
    this.btnClear.addEventListener('click', () => this.clear());
    this.btnDownload.addEventListener('click', () => this.download());
    this.profileSelect.addEventListener('change', () => this._reroute());

    this._mapClickHandler = (e) => {
      if (!this.active) return;
      this._addWaypoint(e.latlng.lat, e.latlng.lng);
    };
  }

  toggle() {
    if (this.active) this.deactivate();
    else this.activate();
  }

  activate() {
    this.active = true;
    this.btn.classList.add('active');
    this.panel.classList.remove('hidden');
    document.body.classList.add('route-mode-active');
    this.map.on('click', this._mapClickHandler);

    if (this._elevProfile) {
      this._savedTrack = this._elevProfile.points;
      this._savedStats = this._elevProfile.stats;
    }
    if (this.routePoints.length >= 2) this._showRouteElevation();
  }

  deactivate() {
    this.active = false;
    this.btn.classList.remove('active');
    this.panel.classList.add('hidden');
    document.body.classList.remove('route-mode-active');
    this.map.off('click', this._mapClickHandler);

    if (this._elevProfile && this._savedTrack && this._savedStats) {
      this._elevProfile.load(this._savedTrack, this._savedStats);
      this._savedTrack = null;
      this._savedStats = null;
    }
  }

  _addWaypoint(lat, lon) {
    const idx = this.waypoints.length + 1;
    const icon = L.divIcon({
      className: '',
      html: `<div class="route-marker-icon">${idx}</div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
    const marker = L.marker([lat, lon], { icon, draggable: true }).addTo(this.map);
    const wp = { lat, lon, marker };
    this.waypoints.push(wp);

    marker.on('dragend', () => {
      const pos = marker.getLatLng();
      wp.lat = pos.lat;
      wp.lon = pos.lng;
      this._renderWPList();
      this._reroute();
    });

    this._renderWPList();
    this._reroute();
  }

  _removeWaypoint(index) {
    const wp = this.waypoints[index];
    if (wp) this.map.removeLayer(wp.marker);
    this.waypoints.splice(index, 1);
    this._renumberMarkers();
    this._renderWPList();
    this._reroute();
  }

  undo() {
    if (this.waypoints.length === 0) return;
    this._removeWaypoint(this.waypoints.length - 1);
  }

  clear() {
    this.waypoints.forEach(wp => this.map.removeLayer(wp.marker));
    this.waypoints = [];
    this.routePoints = [];
    this._clearLines();
    this._renderWPList();
    this._updateStats(null);
    this.btnDownload.classList.add('hidden');
    if (this._elevProfile && this._savedTrack && this._savedStats) {
      this._elevProfile.load(this._savedTrack, this._savedStats);
    }
  }

  _renumberMarkers() {
    this.waypoints.forEach((wp, i) => {
      const icon = L.divIcon({
        className: '',
        html: `<div class="route-marker-icon">${i + 1}</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
      wp.marker.setIcon(icon);
    });
  }

  _renderWPList() {
    const n = this.waypoints.length;
    this.btnUndo.disabled = n === 0;
    this.btnClear.disabled = n === 0;
    this.hint.textContent = n === 0
      ? 'Click the map to add waypoints'
      : n === 1 ? 'Click to add more waypoints' : '';
    this.hint.classList.toggle('hidden', n >= 2 && this.routePoints.length > 0);

    this.wpList.innerHTML = this.waypoints.map((wp, i) => `
      <div class="route-wp">
        <div class="route-wp-num">${i + 1}</div>
        <span class="route-wp-coord">${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)}</span>
        <button class="route-wp-del" data-idx="${i}" title="Remove">&times;</button>
      </div>
    `).join('');

    this.wpList.querySelectorAll('.route-wp-del').forEach(btn => {
      btn.addEventListener('click', () => {
        this._removeWaypoint(parseInt(btn.dataset.idx));
      });
    });
  }

  _clearLines() {
    if (this._routeLine) { this.map.removeLayer(this._routeLine); this._routeLine = null; }
    if (this._directLine) { this.map.removeLayer(this._directLine); this._directLine = null; }
  }

  async _reroute() {
    this._clearLines();
    this.routePoints = [];
    this.btnDownload.classList.add('hidden');

    if (this.waypoints.length < 2) {
      this._updateStats(null);
      return;
    }

    const wpLatLngs = this.waypoints.map(wp => [wp.lat, wp.lon]);
    this._directLine = L.polyline(wpLatLngs, {
      color: '#94a3b8',
      weight: 2,
      dashArray: '6,6',
      interactive: false,
    }).addTo(this.map);

    const apiKey = this.apiKeyInput.value.trim();
    if (!apiKey) {
      this._updateStats(null);
      this.hint.textContent = 'Enter ORS API key to snap to trails';
      this.hint.classList.remove('hidden');
      return;
    }

    const profile = this.profileSelect.value;
    const coords = this.waypoints.map(wp => [wp.lon, wp.lat]);

    try {
      const resp = await fetch(`https://api.openrouteservice.org/v2/directions/${profile}/geojson`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': apiKey,
        },
        body: JSON.stringify({ coordinates: coords, elevation: true }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error?.message || `API error ${resp.status}`);
      }

      const data = await resp.json();
      const feature = data.features?.[0];
      if (!feature) throw new Error('No route found');

      const geomCoords = feature.geometry.coordinates;
      this.routePoints = geomCoords.map(c => ({
        lat: c[1], lon: c[0], ele: c[2] ?? null, time: null,
      }));

      const routeLatLngs = this.routePoints.map(p => [p.lat, p.lon]);

      if (this._directLine) { this.map.removeLayer(this._directLine); this._directLine = null; }

      this._routeLine = L.polyline(routeLatLngs, {
        color: '#6366f1',
        weight: 4,
        opacity: 0.85,
      }).addTo(this.map);

      const summary = feature.properties?.summary;
      this._updateStats(summary);
      this.btnDownload.classList.remove('hidden');
      this._showRouteElevation();

    } catch (err) {
      console.error('[RoutePlanner]', err);
      this.hint.textContent = 'Route error: ' + err.message;
      this.hint.classList.remove('hidden');
      this._updateStats(null);
    }
  }

  _showRouteElevation() {
    if (!this._elevProfile || this.routePoints.length < 2) return;
    const stats = StatsCalculator.compute(this.routePoints);
    if (stats) this._elevProfile.load(this.routePoints, stats);
  }

  _updateStats(summary) {
    if (!summary) {
      this.statsEl.classList.add('hidden');
      return;
    }
    this.statsEl.classList.remove('hidden');
    this.distEl.textContent = formatDist(summary.distance);
    this.timeEl.textContent = formatTime(summary.duration);
  }

  download() {
    if (this.routePoints.length === 0) return;
    const tracks = [{ name: 'Planned Route', points: this.routePoints }];
    const gpx = GPXExporter.export(tracks, [], 'Planned Route');
    GPXExporter.download(gpx, 'planned_route.gpx');
  }
}

/* ───────────────────── App Controller ───────────────────── */

class App {
  constructor() {
    this.mapManager = new MapManager('map');
    this.elevationProfile = new ElevationProfile('elevation-chart');
    this.currentTrack = null;
    this.currentStats = null;
    this.parsedTracks = [];
    this.photos = [];
    this.photosVisible = false;
    this.pois = [];
    this.poiMode = false;
    this._poiIdCounter = 0;

    this._initUI();
    this._initPOI();
    this._initLightbox();
    this._initDragDrop();
    this._loadManifest();
    this._loadPhotos();
    this.mapManager.initLocateControl();
    this.recorder = new GPXRecorder(this.mapManager.map);
    this.routePlanner = new RoutePlanner(this.mapManager.map, this.elevationProfile);
  }

  _initUI() {
    this.trackSelect = document.getElementById('track-select');
    this.fileInput = document.getElementById('file-input');
    this.statsOverlay = document.getElementById('stats-overlay');
    this.loadingOverlay = document.getElementById('loading-overlay');

    document.getElementById('stats-toggle').addEventListener('click', () => {
      this.statsOverlay.classList.toggle('collapsed');
    });

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

    document.getElementById('btn-export').addEventListener('click', () => this._exportGPX());

    this.photosBtn = document.getElementById('btn-toggle-photos');
    this.photosBtn.addEventListener('click', () => this._togglePhotos());
  }

  _togglePhotos() {
    this.photosVisible = !this.photosVisible;
    this.photosBtn.classList.toggle('active', this.photosVisible);
    if (this.photosVisible) {
      if (this.photos.length > 0) {
        this.mapManager.loadPhotos(this.photos, (idx) => this._showPhoto(idx));
      }
    } else {
      this.mapManager.clearPhotos();
    }
  }

  _initPOI() {
    this.poiBtn = document.getElementById('btn-add-poi');
    this.poiPanel = document.getElementById('poi-panel');
    this.poiList = document.getElementById('poi-list');

    this.poiBtn.addEventListener('click', () => this._togglePOIMode());

    document.getElementById('poi-panel-close').addEventListener('click', () => {
      this.poiPanel.classList.add('hidden');
    });

    this.mapManager.map.on('click', (e) => {
      if (!this.poiMode || !this.currentTrack) return;
      const nearest = this._findNearestPoint(e.latlng);
      if (nearest.idx < 0) return;
      const pt = this.currentTrack[nearest.idx];

      this.mapManager.showNewPOIPopup(
        L.latLng(pt.lat, pt.lon),
        pt.ele,
        (name, comment) => {
          this._addPOI({ lat: pt.lat, lon: pt.lon, ele: pt.ele, name, comment });
          this._togglePOIMode(false);
        },
        () => {}
      );
    });
  }

  _togglePOIMode(force) {
    this.poiMode = force !== undefined ? force : !this.poiMode;
    this.poiBtn.classList.toggle('active', this.poiMode);
    document.body.classList.toggle('poi-mode-active', this.poiMode);
  }

  _addPOI(data) {
    const poi = {
      id: ++this._poiIdCounter,
      lat: data.lat,
      lon: data.lon,
      ele: data.ele,
      name: data.name || 'Unnamed POI',
      comment: data.comment || '',
    };
    this.pois.push(poi);

    this.mapManager.addPOIMarker(poi, {
      onEdit: (updated) => this._updatePOI(updated),
      onDelete: (p) => this._deletePOI(p),
    });

    this._renderPOIPanel();
  }

  _updatePOI(updated) {
    const idx = this.pois.findIndex(p => p.id === updated.id);
    if (idx < 0) return;
    this.pois[idx].name = updated.name;
    this.pois[idx].comment = updated.comment;
    this.mapManager.updatePOIPopup(this.pois[idx]);
    this._renderPOIPanel();
  }

  _deletePOI(poi) {
    this.mapManager.removePOIMarker(poi);
    this.pois = this.pois.filter(p => p.id !== poi.id);
    this._renderPOIPanel();
  }

  _renderPOIPanel() {
    if (this.pois.length === 0) {
      this.poiPanel.classList.add('hidden');
      return;
    }

    this.poiPanel.classList.remove('hidden');
    this.poiList.innerHTML = this.pois.map(poi => `
      <div class="poi-list-item" data-poi-id="${poi.id}">
        <div class="poi-list-name">${poi.name}</div>
        ${poi.comment ? `<div class="poi-list-comment">${poi.comment}</div>` : ''}
      </div>
    `).join('');

    this.poiList.querySelectorAll('.poi-list-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = parseInt(el.dataset.poiId);
        const poi = this.pois.find(p => p.id === id);
        if (poi) this.mapManager.openPOIPopup(poi);
      });
    });
  }

  _exportGPX() {
    if (!this.parsedTracks || this.parsedTracks.length === 0) {
      alert('No track loaded to export');
      return;
    }

    const trackName = this.trackSelect.selectedOptions[0]?.textContent || 'Track';
    const gpxContent = GPXExporter.export(this.parsedTracks, this.pois, trackName);
    const filename = trackName.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_') + '_export.gpx';
    GPXExporter.download(gpxContent, filename);
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
      const resp = await fetch('gpx-manifest.json');
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
    this.parsedTracks = [];

    let allPoints = [];
    const hoverLines = [];

    for (const xml of xmlStrings) {
      const parsed = GPXParser.parse(xml);
      if (parsed.tracks.length === 0) continue;

      this.parsedTracks.push(...parsed.tracks);
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

    this.parsedTracks = parsed.tracks;
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

  _initLightbox() {
    this.lightbox = document.getElementById('lightbox');
    this.lbImage = document.getElementById('lb-image');
    this.lbCaption = document.getElementById('lb-caption');
    this.lbPrev = document.getElementById('lb-prev');
    this.lbNext = document.getElementById('lb-next');
    this._lbIndex = 0;

    this.lightbox.addEventListener('click', (e) => {
      if (e.target === this.lightbox || e.target.id === 'lb-close') {
        this.lightbox.classList.add('hidden');
      }
    });

    this.lbPrev.addEventListener('click', (e) => {
      e.stopPropagation();
      this._showPhoto(this._lbIndex - 1);
    });

    this.lbNext.addEventListener('click', (e) => {
      e.stopPropagation();
      this._showPhoto(this._lbIndex + 1);
    });

    document.addEventListener('keydown', (e) => {
      if (this.lightbox.classList.contains('hidden')) return;
      if (e.key === 'Escape') this.lightbox.classList.add('hidden');
      else if (e.key === 'ArrowLeft') this._showPhoto(this._lbIndex - 1);
      else if (e.key === 'ArrowRight') this._showPhoto(this._lbIndex + 1);
    });
  }

  _showPhoto(idx) {
    if (this.photos.length === 0) return;
    this._lbIndex = ((idx % this.photos.length) + this.photos.length) % this.photos.length;
    const photo = this.photos[this._lbIndex];
    this.lbImage.src = photo.src;
    this.lbCaption.textContent = photo.date ? photo.date.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3') : photo.name;
    this.lightbox.classList.remove('hidden');
  }

  async _loadPhotos() {
    try {
      const resp = await fetch('pics-manifest.json');
      if (!resp.ok) return;
      this.photos = await resp.json();
    } catch {
      // No photos — that's fine
    }
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
