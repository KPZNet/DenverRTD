# Denver RTD — Live Train Map

A web app that shows every Denver RTD train moving in real time on a map,
with all rail lines and stations drawn from official RTD data.

## Run

```bash
npm install
npm start
# open http://localhost:3000
```

The first run downloads RTD's static GTFS feed (~8 MB zip) into `gtfs/` —
subsequent starts reuse the local copy.

## How it works

- **Backend** (`server.js`, `lib/`): an Express server that parses the static
  GTFS feed (rail routes, track shapes, stops, stop times) and polls RTD's
  public GTFS-Realtime protobuf feeds (`VehiclePosition.pb`,
  `TripUpdate.pb`) every 15 s. Each vehicle's lat/lon is projected onto its
  trip's track geometry and matched with its next stop's predicted
  arrival/departure times.
- **API**:
  - `GET /api/routes` — rail lines, track shapes (with cumulative distances), stations
  - `GET /api/trains` — live vehicles: snapped track distance, status,
    current/next stop, predicted arrival epoch, bearing
  - `GET /api/stops/:id/arrivals` — upcoming rail arrivals for a station
- **Frontend** (`public/`): Leaflet map on a dark basemap. A
  `requestAnimationFrame` loop glides each train along its track: velocity is
  the max of (a) approaching the latest measured position and (b) the speed
  required to make the predicted next-stop arrival, so trains visibly slow
  into stations, hold at the platform until departure time, then pull away.
  Direction arrows use the feed's reported bearing.

Click a train for its destination and next stop; click a station for live
arrivals. Legend rows toggle each line on/off.

## Data

- GTFS static + GTFS-RT feeds: https://www.rtd-denver.com/open-records/open-spatial-information
- Basemap: Esri World Dark Gray
