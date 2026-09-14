/* Denver RTD live trains — frontend.
 * Polls /api/trains, interpolates each vehicle along its trip's track shape
 * using measured position + predicted next-stop arrival, animates via rAF. */

const POLL_MS = 10000;
const STALE_MS = 90000;
const MAX_SPEED = 45; // m/s sanity clamp

// Union Station — the downtown hub where all rail lines converge.
// Position is the GTFS parent-station centroid (stop_id 33727).
const UNION_STATION = { name: 'Union Station', lat: 39.754338, lon: -105.00214 };
const UNION_STATION_SVG = `
<svg viewBox="0 0 80 56" width="56" height="40" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="40" cy="28" rx="34" ry="24" fill="#ffcf5c" opacity="0.18"/>
  <rect x="7" y="26" width="17" height="18" rx="1" fill="#b9c0c9" stroke="#0c0f13" stroke-width="2"/>
  <rect x="56" y="26" width="17" height="18" rx="1" fill="#b9c0c9" stroke="#0c0f13" stroke-width="2"/>
  <g fill="#0c0f13">
    <rect x="11" y="30" width="3" height="5"/><rect x="16" y="30" width="3" height="5"/>
    <rect x="11" y="37" width="3" height="5"/><rect x="16" y="37" width="3" height="5"/>
    <rect x="60" y="30" width="3" height="5"/><rect x="65" y="30" width="3" height="5"/>
    <rect x="60" y="37" width="3" height="5"/><rect x="65" y="37" width="3" height="5"/>
  </g>
  <rect x="24" y="15" width="32" height="29" rx="1" fill="#e9edf2" stroke="#0c0f13" stroke-width="2"/>
  <rect x="27" y="8" width="26" height="8" rx="1" fill="#e9edf2" stroke="#0c0f13" stroke-width="2"/>
  <text x="40" y="14.2" text-anchor="middle" font-size="4.6" font-weight="800" fill="#0c0f13" letter-spacing="0.3">UNION STA.</text>
  <circle cx="40" cy="24" r="4.4" fill="#0c0f13"/>
  <circle cx="40" cy="24" r="3.2" fill="#ffd34d"/>
  <line x1="40" y1="24" x2="40" y2="21.6" stroke="#0c0f13" stroke-width="0.9"/>
  <line x1="40" y1="24" x2="41.9" y2="24.9" stroke="#0c0f13" stroke-width="0.9"/>
  <path d="M28 44 v-6 a3.2 3.2 0 0 1 6.4 0 v6 z" fill="#0c0f13"/>
  <path d="M36.8 44 v-7 a3.2 3.2 0 0 1 6.4 0 v7 z" fill="#0c0f13"/>
  <path d="M45.6 44 v-6 a3.2 3.2 0 0 1 6.4 0 v6 z" fill="#0c0f13"/>
  <rect x="2" y="44" width="76" height="2.4" fill="#0c0f13"/>
  <rect x="5" y="48" width="70" height="1.4" fill="#6b7684"/>
  <rect x="9" y="50.5" width="62" height="1.4" fill="#6b7684"/>
</svg>`;

const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([39.72, -104.99], 11);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
  attribution: '&copy; Esri, DeLorme, HERE | RTD GTFS-RT',
  maxZoom: 16,
}).addTo(map);

const shapes = new Map();      // shapeId -> {pts, cum, routeId, layer}
const routesById = new Map();  // routeId -> {short,long,color,text}
const routeLayers = new Map(); // routeId -> L.layerGroup (polylines)
const stopLayer = L.layerGroup().addTo(map);
const trains = new Map();      // vehicleId -> anim state
const hiddenRoutes = new Set();

function pointAt(shape, dist) {
  const { pts, cum } = shape;
  if (dist <= 0) return pts[0];
  if (dist >= cum[cum.length - 1]) return pts[pts.length - 1];
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= dist) lo = mid; else hi = mid;
  }
  const seg = cum[hi] - cum[lo] || 1;
  const t = (dist - cum[lo]) / seg;
  return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * t, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t];
}

function headingAt(shape, dist) {
  const { pts, cum } = shape;
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < dist) i++;
  const [a, b] = [pts[i], pts[Math.min(i + 1, pts.length - 1)]];
  const dy = b[0] - a[0];
  const dx = (b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180);
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

function trainIcon(t, heading, stopped) {
  const r = routesById.get(t.routeId) || {};
  const label = r.short || '?';
  return L.divIcon({
    className: 'train-wrap',
    iconSize: [0, 0],
    html: `<div class="tm ${stopped ? 'stopped' : ''}" style="--c:#${r.color || '888'};--tc:#${r.text || 'fff'}">
      <div class="tm-arrow" style="transform:rotate(${heading}deg) translateY(-15px)"></div>
      <div class="tm-dot">${label}</div>
    </div>`,
  });
}

function fmtCountdown(ts, now) {
  const s = Math.round(ts - now);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function trainPopup(t, now) {
  const r = routesById.get(t.routeId) || {};
  const parts = [`<div class="pop-title"><span class="arr-chip" style="background:#${r.color}">${r.short || t.routeId}</span> ${r.long || ''}</div>`];
  if (t.headsign) parts.push(`<div class="pop-sub">→ ${t.headsign}</div>`);
  if (t.status === 'STOPPED_AT' && t.current) {
    parts.push(`<div>At ${t.current.name}${t.current.dep ? ` — dep ${fmtCountdown(t.current.dep, now)}` : ''}</div>`);
  }
  if (t.next) {
    const arr = t.next.arr ? fmtCountdown(t.next.arr, now) : '—';
    parts.push(`<div>Next: ${t.next.name} <b>${arr}</b>${t.next.delay > 60 ? ` <span class="arr-delay late">+${Math.round(t.next.delay / 60)}m</span>` : ''}</div>`);
  }
  parts.push(`<div class="pop-sub">${t.status.replace(/_/g, ' ').toLowerCase()} · vehicle ${t.label || t.id}</div>`);
  return parts.join('');
}

/* ---------- static layers ---------- */

async function loadRoutes() {
  const data = await fetch('/api/routes').then(r => r.json());
  for (const r of data.routes) routesById.set(r.id, r);

  for (const s of data.shapes) {
    const shape = { pts: s.pts, cum: s.cum, routeId: s.routeId };
    shapes.set(s.id, shape);
    const r = routesById.get(s.routeId) || {};
    if (!routeLayers.has(s.routeId)) routeLayers.set(s.routeId, L.layerGroup().addTo(map));
    const color = `#${r.color || '888'}`;
    routeLayers.get(s.routeId).addLayer(L.polyline(s.pts, { color: '#000', weight: 6, opacity: 0.35, interactive: false }));
    routeLayers.get(s.routeId).addLayer(L.polyline(s.pts, { color, weight: 3, opacity: 0.9, interactive: false }));
  }

  for (const st of data.stops) {
    const m = L.circleMarker([st.lat, st.lon], {
      radius: 3.5, color: '#14181d', weight: 1.5, fillColor: '#dfe3e8', fillOpacity: 1,
    });
    m.bindTooltip(st.name, { direction: 'top', offset: [0, -4] });
    m.on('click', () => showStop(st));
    stopLayer.addLayer(m);
  }

  const usStops = data.stops.filter(s => s.name.startsWith('Union Station'));
  L.marker([UNION_STATION.lat, UNION_STATION.lon], {
    icon: L.divIcon({ className: 'station-wrap', iconSize: [56, 40], iconAnchor: [28, 36], html: UNION_STATION_SVG }),
    zIndexOffset: 900,
  })
    .bindTooltip('Union Station', { permanent: true, direction: 'right', offset: [26, -16], className: 'station-label' })
    .on('click', () => showUnionStation(usStops))
    .addTo(map);

  buildLegend(data.routes);
}

async function showStop(st) {
  const res = await fetch(`/api/stops/${st.id}/arrivals`).then(r => r.json());
  const now = Date.now() / 1000;
  const rows = (res.arrivals || []).map(a => `
    <div class="arr-row">
      <span class="arr-chip" style="background:#${a.color}">${a.route}</span>
      <span>${a.headsign || ''}</span>
      <span class="arr-in">${fmtCountdown(a.ts, now)}</span>
      ${a.delay > 60 ? `<span class="arr-delay late">+${Math.round(a.delay / 60)}m</span>` : ''}
    </div>`).join('');
  L.popup().setLatLng([st.lat, st.lon])
    .setContent(`<div class="pop-title">${st.name}</div>${rows || '<div class="pop-sub">No upcoming rail arrivals</div>'}`)
    .openOn(map);
}

async function showUnionStation(stops) {
  const now = Date.now() / 1000;
  const all = [];
  await Promise.all(stops.map(async st => {
    try {
      const res = await fetch(`/api/stops/${st.id}/arrivals`).then(r => r.json());
      for (const a of res.arrivals || []) all.push(a);
    } catch { /* one bad platform shouldn't break the board */ }
  }));
  all.sort((a, b) => a.ts - b.ts);
  const seen = new Set();
  const rows = [];
  for (const a of all) {
    const key = `${a.route}|${a.headsign}|${a.ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(`
    <div class="arr-row">
      <span class="arr-chip" style="background:#${a.color}">${a.route}</span>
      <span>${a.headsign || ''}</span>
      <span class="arr-in">${fmtCountdown(a.ts, now)}</span>
      ${a.delay > 60 ? `<span class="arr-delay late">+${Math.round(a.delay / 60)}m</span>` : ''}
    </div>`);
    if (rows.length >= 14) break;
  }
  L.popup().setLatLng([UNION_STATION.lat, UNION_STATION.lon])
    .setContent(`<div class="pop-title">Union Station</div><div class="pop-sub">All rail departures</div>${rows.join('') || '<div class="pop-sub">No upcoming rail departures</div>'}`)
    .openOn(map);
}

/* ---------- legend ---------- */

function buildLegend(routes) {
  const el = document.getElementById('legend');
  el.innerHTML = '';
  const sorted = [...routes].sort((a, b) => a.short.localeCompare(b.short));
  for (const r of sorted) {
    const row = document.createElement('div');
    row.className = 'legend-row';
    row.id = `leg-${r.id}`;
    row.innerHTML = `<span class="legend-chip" style="background:#${r.color}">${r.short}</span>
      <span class="legend-name">${r.long}</span><span class="legend-count" id="cnt-${r.id}"></span>`;
    row.onclick = () => {
      if (hiddenRoutes.has(r.id)) {
        hiddenRoutes.delete(r.id);
        row.classList.remove('off');
        routeLayers.get(r.id)?.addTo(map);
      } else {
        hiddenRoutes.add(r.id);
        row.classList.add('off');
        routeLayers.get(r.id)?.remove();
      }
    };
    el.appendChild(row);
  }
}

/* ---------- live trains ---------- */

async function pollTrains() {
  let data;
  try {
    data = await fetch('/api/trains').then(r => r.json());
  } catch { return; }
  const now = Date.now() / 1000;
  document.getElementById('feed-age').textContent = data.feedTs
    ? `${Math.max(0, Math.round(now - data.feedTs))}s ago`
    : '—';
  document.getElementById('feed-err').hidden = !data.error;
  document.getElementById('train-count').textContent = data.trains.length;

  const counts = {};
  const seen = new Set();

  for (const t of data.trains) {
    if (!routesById.has(t.routeId)) continue;
    counts[t.routeId] = (counts[t.routeId] || 0) + 1;
    seen.add(t.id);
    let st = trains.get(t.id);
    if (!st) {
      st = {
        marker: L.marker([t.lat, t.lon], { icon: trainIcon(t, t.bearing || 0, false), zIndexOffset: 1000 }).addTo(map),
        pos: t.dist != null ? t.dist : null,   // meters along shape
        ll: [t.lat, t.lon],                    // rendered latlon (fallback / current)
        target: [t.lat, t.lon],
        lastSeen: now,
        popup: null,
      };
      st.marker.bindPopup(() => trainPopup(st.data, Date.now() / 1000));
      trains.set(t.id, st);
    }
    st.data = t;
    st.lastSeen = now;
    if (t.dist != null && st.pos == null) st.pos = t.dist; // shape just became available
    if (t.dist != null && st.pos != null && Math.abs(t.dist - st.pos) > 800) st.pos = t.dist; // teleport fix
    st.target = [t.lat, t.lon];
  }

  for (const r of routesById.values()) {
    const el = document.getElementById(`cnt-${r.id}`);
    if (el) el.textContent = counts[r.id] || '';
  }

  for (const [id, st] of trains) {
    if (now - st.lastSeen > STALE_MS / 1000) {
      map.removeLayer(st.marker);
      trains.delete(id);
    }
  }
}

/* ---------- animation ---------- */

let lastFrame = performance.now();
function tick(nowMs) {
  const dt = Math.min((nowMs - lastFrame) / 1000, 0.25);
  lastFrame = nowMs;
  const now = Date.now() / 1000;

  for (const st of trains.values()) {
    const t = st.data;
    if (!t) continue;
    const hidden = hiddenRoutes.has(t.routeId);
    st.marker.setOpacity(hidden ? 0 : 1);
    if (hidden) continue;
    const shape = t.shapeId && shapes.get(t.shapeId);
    const stopped = t.status === 'STOPPED_AT';

    if (shape && st.pos != null) {
      // Measured target from the feed.
      const measured = t.dist != null ? t.dist : st.pos;
      // Velocity to close on measured position gently (~6s horizon).
      let v = (measured - st.pos) / 6;
      // Schedule-driven velocity: speed needed to make predicted arrival.
      if (t.next && t.next.dist != null && t.next.arr != null && t.next.dist > st.pos) {
        const rem = t.next.arr - now;
        const vsched = rem > 0 ? (t.next.dist - st.pos) / rem : 12;
        v = Math.max(v, Math.min(vsched, MAX_SPEED));
      }
      if (stopped && t.current && t.current.dep && now < t.current.dep) v = Math.min(v, 0.4);
      if (stopped && !t.current) v = Math.min(v, 0.4);
      v = Math.max(-8, Math.min(MAX_SPEED, v));
      const prevPos = st.pos;
      st.pos += v * dt;
      // Hold at the platform: don't let a train roll through a stop early.
      if (t.next && t.next.dist != null && t.next.arr != null &&
          now < t.next.arr && prevPos <= t.next.dist && st.pos > t.next.dist) {
        st.pos = t.next.dist;
      }
      const [lat, lon] = pointAt(shape, st.pos);
      st.ll = [lat, lon];
      // Heading: feed bearing, else shape direction (flipped if moving backward).
      let h = t.bearing;
      if (h == null || h === 0) {
        h = headingAt(shape, st.pos);
        if (v < -0.5) h += 180;
      }
      st.marker.setLatLng(st.ll);
      if (stopped !== st.lastStopped) {
        st.marker.setIcon(trainIcon(t, h, stopped));
        st.lastStopped = stopped;
        st.lastHeading = h;
      } else if (Math.abs(((h - (st.lastHeading || 0)) + 540) % 360 - 180) > 4) {
        const el = st.marker.getElement();
        const arrow = el && el.querySelector('.tm-arrow');
        if (arrow) arrow.style.transform = `rotate(${h}deg) translateY(-15px)`;
        st.lastHeading = h;
      }
    } else {
      // No shape — plain interpolation toward reported position.
      const k = Math.min(1, dt * 0.8);
      st.ll = [st.ll[0] + (st.target[0] - st.ll[0]) * k, st.ll[1] + (st.target[1] - st.ll[1]) * k];
      st.marker.setLatLng(st.ll);
    }
  }
  requestAnimationFrame(tick);
}

loadRoutes().then(() => {
  pollTrains();
  setInterval(pollTrains, POLL_MS);
  requestAnimationFrame(tick);
});
