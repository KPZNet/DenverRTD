const express = require('express');
const compression = require('compression');
const path = require('path');
const { loadStatic } = require('./lib/gtfs');
const { startPolling } = require('./lib/rt');

const PORT = process.env.PORT || 3000;
const GTFS_DIR = path.join(__dirname, 'gtfs');

async function main() {
  console.log('Loading static GTFS data...');
  const staticData = await loadStatic(GTFS_DIR);
  const rt = startPolling(staticData);

  const app = express();
  app.use(compression());
  app.use(express.static(path.join(__dirname, 'public')));

  let routesCache = null;
  app.get('/api/routes', (req, res) => {
    if (!routesCache) routesCache = staticData.apiRoutes();
    res.json(routesCache);
  });
  app.get('/api/trains', (req, res) => res.json(rt.trains()));
  app.get('/api/stops/:id/arrivals', (req, res) => res.json(rt.arrivals(req.params.id)));

  app.listen(PORT, () => console.log(`RTD live map: http://localhost:${PORT}`));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
