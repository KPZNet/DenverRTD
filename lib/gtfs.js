const fs = require('fs');
const path = require('path');
const readline = require('readline');
const AdmZip = require('adm-zip');

const GTFS_URL = 'https://www.rtd-denver.com/files/gtfs/google_transit.zip';
const RAIL_TYPES = new Set(['0', '2']); // light rail + commuter rail

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function eachRow(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (!line) continue;
    if (!header) { header = parseCsvLine(line); continue; }
    fn(parseCsvLine(line), header);
  }
}

async function ensureGtfs(dir) {
  if (fs.existsSync(path.join(dir, 'stop_times.txt'))) return;
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, 'google_transit.zip');
  console.log('Downloading GTFS static feed...');
  const res = await fetch(GTFS_URL);
  if (!res.ok) throw new Error(`GTFS download failed: ${res.status}`);
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  new AdmZip(zipPath).extractAllTo(dir, true);
  console.log('GTFS extracted.');
}

// Distance helpers — equirectangular approximation keyed to the shape's mean lat.
function makeMetric(meanLat) {
  const kx = Math.cos((meanLat * Math.PI) / 180) * 111320;
  const ky = 110540;
  return { kx, ky };
}

function buildCum(pts) {
  const meanLat = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const { kx, ky } = makeMetric(meanLat);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = (pts[i][1] - pts[i - 1][1]) * kx;
    const dy = (pts[i][0] - pts[i - 1][0]) * ky;
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  return cum; // meters
}

function projectToShape(shape, lat, lon) {
  const meanLat = lat;
  const { kx, ky } = makeMetric(meanLat);
  const px = lon * kx;
  const py = lat * ky;
  const { pts, cum } = shape;
  let bestD2 = Infinity;
  let bestDist = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][1] * kx;
    const ay = pts[i][0] * ky;
    const bx = pts[i + 1][1] * kx;
    const by = pts[i + 1][0] * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    const d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy);
    if (d2 < bestD2) {
      bestD2 = d2;
      bestDist = cum[i] + Math.sqrt(len2) * t;
    }
  }
  return { dist: bestDist, offTrack: Math.sqrt(bestD2) };
}

function pointAt(shape, dist) {
  const { pts, cum } = shape;
  if (dist <= 0) return pts[0];
  if (dist >= cum[cum.length - 1]) return pts[pts.length - 1];
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= dist) lo = mid; else hi = mid;
  }
  const seg = cum[hi] - cum[lo] || 1;
  const t = (dist - cum[lo]) / seg;
  return [
    pts[lo][0] + (pts[hi][0] - pts[lo][0]) * t,
    pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t,
  ];
}

function hmsToSec(s) {
  if (!s) return null;
  const [h, m, sec] = s.split(':').map(Number);
  return h * 3600 + m * 60 + sec;
}

async function loadStatic(dir) {
  await ensureGtfs(dir);
  const routes = new Map(); // routeId -> info
  const railIds = new Set();
  const trips = new Map(); // rail tripId -> info
  const neededShapes = new Set();
  const shapes = new Map(); // shapeId -> {pts, cum, routeId, rawTotal}
  const stops = new Map(); // stopId -> {name, lat, lon}
  const tripStops = new Map(); // rail tripId -> [{seq, stopId, arr, dep, rawDist}]
  const stopRoutes = new Map(); // stopId -> Set(routeShort)
  const railStops = new Set();

  console.log('Loading routes...');
  await eachRow(path.join(dir, 'routes.txt'), (c, h) => {
    const row = {};
    h.forEach((k, i) => (row[k] = c[i]));
    if (!RAIL_TYPES.has(row.route_type)) return;
    routes.set(row.route_id, {
      id: row.route_id,
      short: row.route_short_name || row.route_id,
      long: row.route_long_name || '',
      color: row.route_color || '888888',
      text: row.route_text_color || 'FFFFFF',
      type: row.route_type,
    });
    railIds.add(row.route_id);
  });
  console.log(`  ${railIds.size} rail routes`);

  await eachRow(path.join(dir, 'trips.txt'), (c, h) => {
    const row = {};
    h.forEach((k, i) => (row[k] = c[i]));
    if (!railIds.has(row.route_id)) return;
    trips.set(row.trip_id, {
      routeId: row.route_id,
      serviceId: row.service_id,
      shapeId: row.shape_id,
      headsign: row.trip_headsign || '',
      direction: row.direction_id,
    });
    if (row.shape_id) neededShapes.add(row.shape_id);
  });
  console.log(`  ${trips.size} rail trips, ${neededShapes.size} shapes`);

  console.log('Loading shapes...');
  {
    const raw = new Map(); // shapeId -> [{seq, lat, lon, dist}]
    await eachRow(path.join(dir, 'shapes.txt'), (c, h) => {
      const shapeId = c[h.indexOf('shape_id')];
      if (!neededShapes.has(shapeId)) return;
      if (!raw.has(shapeId)) raw.set(shapeId, []);
      raw.get(shapeId).push({
        seq: +c[h.indexOf('shape_pt_sequence')],
        lat: +c[h.indexOf('shape_pt_lat')],
        lon: +c[h.indexOf('shape_pt_lon')],
        dist: +c[h.indexOf('shape_dist_traveled')] || 0,
      });
    });
    for (const [id, pts] of raw) {
      pts.sort((a, b) => a.seq - b.seq);
      const latlon = pts.map(p => [p.lat, p.lon]);
      const cum = buildCum(latlon);
      const rawTotal = pts[pts.length - 1].dist;
      const trip = [...trips.values()].find(t => t.shapeId === id);
      shapes.set(id, {
        pts: latlon,
        cum,
        rawTotal,
        ratio: rawTotal > 0 ? cum[cum.length - 1] / rawTotal : 1,
        routeId: trip ? trip.routeId : null,
      });
    }
  }
  console.log(`  ${shapes.size} shapes loaded`);

  await eachRow(path.join(dir, 'stops.txt'), (c, h) => {
    const id = c[h.indexOf('stop_id')];
    stops.set(id, {
      name: c[h.indexOf('stop_name')] || '',
      lat: +c[h.indexOf('stop_lat')],
      lon: +c[h.indexOf('stop_lon')],
    });
  });
  console.log(`  ${stops.size} stops`);

  console.log('Loading stop_times (rail only)...');
  {
    const idx = {};
    let header = null;
    await eachRow(path.join(dir, 'stop_times.txt'), (c, h) => {
      header = h;
      idx.trip = h.indexOf('trip_id');
      idx.arr = h.indexOf('arrival_time');
      idx.dep = h.indexOf('departure_time');
      idx.stop = h.indexOf('stop_id');
      idx.seq = h.indexOf('stop_sequence');
      idx.dist = h.indexOf('shape_dist_traveled');
      const tripId = c[idx.trip];
      if (!trips.has(tripId)) return;
      if (!tripStops.has(tripId)) tripStops.set(tripId, []);
      tripStops.get(tripId).push({
        seq: +c[idx.seq],
        stopId: c[idx.stop],
        arr: hmsToSec(c[idx.arr]),
        dep: hmsToSec(c[idx.dep]),
        rawDist: +c[idx.dist] || null,
      });
    });
  }

  // Normalize stop distances to meters along the shape; collect rail stop set.
  const projCache = new Map(); // shapeId:stopId -> dist
  const stopDist = (shape, stopId) => {
    const key = `${shapeKey(shape)}:${stopId}`;
    if (!projCache.has(key)) {
      const s = stops.get(stopId);
      projCache.set(key, s ? projectToShape(shape, s.lat, s.lon).dist : null);
    }
    return projCache.get(key);
  };
  const shapeIds = new WeakMap();
  let shapeSeq = 0;
  const shapeKey = s => {
    if (!shapeIds.has(s)) shapeIds.set(s, ++shapeSeq);
    return shapeIds.get(s);
  };

  for (const [tripId, list] of tripStops) {
    list.sort((a, b) => a.seq - b.seq);
    const trip = trips.get(tripId);
    const shape = shapes.get(trip.shapeId);
    const route = routes.get(trip.routeId);
    for (const st of list) {
      if (shape) {
        st.dist = st.rawDist != null && shape.rawTotal > 0
          ? st.rawDist * shape.ratio
          : stopDist(shape, st.stopId);
      } else st.dist = null;
      railStops.add(st.stopId);
      if (!stopRoutes.has(st.stopId)) stopRoutes.set(st.stopId, new Set());
      stopRoutes.get(st.stopId).add(route.short);
    }
  }
  console.log(`  ${tripStops.size} rail trips with stop times, ${railStops.size} rail stops`);

  return {
    routes, railIds, trips, shapes, stops, tripStops, stopRoutes, railStops,
    projectToShape, pointAt,
    apiRoutes() {
      return {
        routes: [...railIds].map(id => routes.get(id)),
        shapes: [...shapes.entries()].map(([id, s]) => ({
          id,
          routeId: s.routeId,
          pts: s.pts,
          cum: s.cum.map(d => Math.round(d)),
        })),
        stops: [...railStops].map(id => ({
          id,
          ...stops.get(id),
          routes: [...(stopRoutes.get(id) || [])],
        })),
      };
    },
  };
}

module.exports = { loadStatic };
