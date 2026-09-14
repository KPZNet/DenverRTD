const GtfsRt = require('gtfs-realtime-bindings');

const VP_URL = 'https://www.rtd-denver.com/files/gtfs-rt/VehiclePosition.pb';
const TU_URL = 'https://www.rtd-denver.com/files/gtfs-rt/TripUpdate.pb';
const POLL_MS = 15000;

const STATUS = { 0: 'INCOMING_AT', 1: 'STOPPED_AT', 2: 'IN_TRANSIT_TO' };

const num = v => (v == null ? null : Number(v));

async function fetchFeed(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return GtfsRt.transit_realtime.FeedMessage.decode(Buffer.from(await res.arrayBuffer()));
}

function startPolling(staticData) {
  const { railIds, trips, shapes, stops, tripStops, projectToShape } = staticData;
  const state = { trains: [], feedTs: null, error: null, arrivalsByStop: new Map() };

  async function poll() {
    try {
      const [vpFeed, tuFeed] = await Promise.all([fetchFeed(VP_URL), fetchFeed(TU_URL)]);
      const now = Math.floor(Date.now() / 1000);

      // Index trip updates: tripId -> sorted stop time updates.
      const tuByTrip = new Map();
      const arrivals = new Map(); // stopId -> [{ts, routeId, headsign}]
      for (const e of tuFeed.entity) {
        const tu = e.tripUpdate;
        if (!tu || !tu.trip) continue;
        const trip = trips.get(tu.trip.tripId);
        const routeId = tu.trip.routeId || (trip && trip.routeId);
        if (!routeId || !railIds.has(routeId)) continue;
        const ups = (tu.stopTimeUpdate || [])
          .map(u => ({
            seq: u.stopSequence,
            stopId: u.stopId,
            arr: num(u.arrival && u.arrival.time),
            dep: num(u.departure && u.departure.time),
            delay: num(u.arrival && u.arrival.delay) ?? num(u.departure && u.departure.delay) ?? 0,
          }))
          .sort((a, b) => a.seq - b.seq);
        tuByTrip.set(tu.trip.tripId, { routeId, updates: ups, headsign: trip ? trip.headsign : '' });
        const sched = tripStops.get(tu.trip.tripId) || [];
        const firstSeq = sched.length ? sched[0].seq : null;
        const lastSeq = sched.length ? sched[sched.length - 1].seq : null;
        for (const u of ups) {
          // A trip's origin stop is a departure only; its terminus an arrival only.
          const isFirst = u.seq != null && firstSeq != null && u.seq <= firstSeq;
          const isLast = u.seq != null && lastSeq != null && u.seq >= lastSeq;
          const arr = isFirst ? null : u.arr;
          const dep = isLast ? null : u.dep;
          const t = arr || dep;
          const fresh = (arr != null && arr >= now - 60) || (dep != null && dep >= now - 60);
          if (t == null || !fresh) continue;
          if (!arrivals.has(u.stopId)) arrivals.set(u.stopId, []);
          arrivals.get(u.stopId).push({ ts: t, arr, dep, routeId, headsign: trip ? trip.headsign : '', delay: u.delay });
        }
      }
      state.arrivalsByStop = arrivals;

      const trains = [];
      for (const e of vpFeed.entity) {
        const v = e.vehicle;
        if (!v || !v.trip || !v.position) continue;
        const trip = trips.get(v.trip.tripId);
        const routeId = v.trip.routeId || (trip && trip.routeId);
        if (!routeId || !railIds.has(routeId)) continue;

        const lat = v.position.latitude;
        const lon = v.position.longitude;
        const shape = trip ? shapes.get(trip.shapeId) : null;
        let dist = null;
        if (shape) {
          const p = projectToShape(shape, lat, lon);
          if (p.offTrack < 1500) dist = p.dist;
        }

        // Determine the stop the vehicle is at / heading to.
        const schedStops = (tripStops.get(v.trip.tripId) || []);
        const updates = (tuByTrip.get(v.trip.tripId) || {}).updates || [];
        const findUpdate = s => updates.find(u => u.stopId === s.stopId) ||
          updates.find(u => u.seq === s.seq);
        const stopInfo = s => {
          const u = findUpdate(s);
          const fallback = sched => (sched != null ? sched + (u ? u.delay || 0 : 0) : null);
          return {
            stopId: s.stopId,
            name: (stops.get(s.stopId) || {}).name || s.stopId,
            dist: s.dist,
            arr: u && u.arr != null ? u.arr : fallback(s.arr),
            dep: u && u.dep != null ? u.dep : fallback(s.dep),
            delay: u ? u.delay : 0,
          };
        };

        const status = STATUS[v.currentStatus] || 'IN_TRANSIT_TO';
        let current = null;
        let next = null;
        if (status === 'STOPPED_AT' || status === 'INCOMING_AT') {
          const s = schedStops.find(x => x.stopId === v.stopId);
          if (s) current = stopInfo(s);
        }
        const idx = schedStops.findIndex(x => x.stopId === v.stopId);
        if (status === 'IN_TRANSIT_TO' && idx >= 0) {
          next = stopInfo(schedStops[idx]);
        } else if (idx >= 0 && idx + 1 < schedStops.length) {
          next = stopInfo(schedStops[idx + 1]);
        }
        if (!next && dist != null) {
          const s = schedStops.find(x => x.dist != null && x.dist > dist + 30);
          if (s) next = stopInfo(s);
        }

        trains.push({
          id: (v.vehicle && v.vehicle.id) || e.id,
          label: (v.vehicle && v.vehicle.label) || '',
          routeId,
          tripId: v.trip.tripId,
          headsign: trip ? trip.headsign : '',
          direction: trip ? trip.direction : v.trip.directionId,
          lat, lon,
          bearing: num(v.position.bearing),
          speed: num(v.position.speed),
          status,
          shapeId: trip ? trip.shapeId : null,
          dist,
          current,
          next,
          ts: num(v.timestamp),
        });
      }

      state.trains = trains;
      state.feedTs = num(vpFeed.header && vpFeed.header.timestamp);
      state.error = null;
    } catch (err) {
      state.error = String(err.message || err);
      console.error('RT poll failed:', state.error);
    }
  }

  poll();
  setInterval(poll, POLL_MS);

  return {
    trains: () => ({ ts: Math.floor(Date.now() / 1000), feedTs: state.feedTs, error: state.error, trains: state.trains }),
    arrivals: stopId => {
      const list = (state.arrivalsByStop.get(stopId) || [])
        .sort((a, b) => a.ts - b.ts)
        .slice(0, 8)
        .map(a => ({
          ...a,
          route: (staticData.routes.get(a.routeId) || {}).short || a.routeId,
          color: (staticData.routes.get(a.routeId) || {}).color || '888888',
        }));
      return { stop: stops.get(stopId) || null, arrivals: list };
    },
  };
}

module.exports = { startPolling };
