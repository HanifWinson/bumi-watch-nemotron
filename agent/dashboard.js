// agent/dashboard.js
// Read-only data for the frontend dashboard and map. Plain SQL, no LLM:
// the numbers on screen come straight from the database, while the chat
// goes through the Nemotron agent.

import { db, sinceISO } from "../config/db.js";
import { INDONESIA_PROVINCES } from "../utils/helpers.js";
import { queryFireHotspots, queryEarthquakes, queryRainfall, queryCrossCorrelation } from "./tools.js";

const MAX_FIRE_POINTS = 2000;
const MAX_QUAKES = 50;

export function clampDays(value, fallback = 1) {
  const d = parseInt(value, 10);
  return Number.isFinite(d) ? Math.min(Math.max(d, 1), 30) : fallback;
}

export function resolveProvince(name = "") {
  return INDONESIA_PROVINCES.find((p) => p.toLowerCase() === String(name).toLowerCase().trim()) || null;
}

export function dataFreshness() {
  const tables = ["air_quality", "fire_hotspots", "bmkg_events", "rainfall"];
  return Object.fromEntries(tables.map((t) => [
    t, db.prepare(`SELECT COUNT(*) AS rows, MAX(timestamp) AS latest FROM ${t}`).get(),
  ]));
}

// Latest overall AQI per station.
// SQLite returns the other columns from the row that holds MAX(timestamp).
function airStations(since) {
  return db.prepare(`
    SELECT city, province, lat, lon, aqi, aqi_category AS category, MAX(timestamp) AS timestamp
    FROM air_quality
    WHERE timestamp >= @since AND parameter = 'aqi' AND aqi IS NOT NULL
    GROUP BY city
    ORDER BY aqi DESC
  `).all({ since });
}

export async function getDashboard({ days = 1 } = {}) {
  const since = sinceISO(days);

  const stations = airStations(since);
  const aqiValues = stations.map((s) => s.aqi);

  const [fires, quakes, rain] = await Promise.all([
    queryFireHotspots({ days, limit: 0 }),
    queryEarthquakes({ days, limit: 0 }),
    queryRainfall({ days, limit: 0 }),
  ]);

  const firePoints = db.prepare(`
    SELECT lat, lon, frp, confidence, satellite, timestamp, province
    FROM fire_hotspots
    WHERE timestamp >= @since AND lat IS NOT NULL AND lon IS NOT NULL
    ORDER BY timestamp DESC LIMIT @limit
  `).all({ since, limit: MAX_FIRE_POINTS });

  const quakeEvents = db.prepare(`
    SELECT lat, lon, magnitude, depth_km, description, severity, timestamp, province
    FROM bmkg_events
    WHERE timestamp >= @since AND event_type = 'earthquake' AND lat IS NOT NULL
    ORDER BY timestamp DESC LIMIT @limit
  `).all({ since, limit: MAX_QUAKES });

  return {
    period_days: days,
    generated_at: new Date().toISOString(),
    freshness: dataFreshness(),
    air: {
      average_aqi: aqiValues.length ? Math.round(aqiValues.reduce((a, b) => a + b, 0) / aqiValues.length) : null,
      max_aqi: aqiValues.length ? Math.max(...aqiValues) : null,
      stations,
    },
    fires: {
      total: fires.total_count,
      high_confidence: fires.high_confidence_count,
      by_province: fires.by_province,
      points: firePoints,
      points_truncated: fires.total_count > firePoints.length,
    },
    earthquakes: {
      total: quakes.total,
      max_magnitude: quakes.max_magnitude,
      events: quakeEvents,
    },
    rainfall: {
      average_mm: rain.avg_rainfall === undefined ? null : Number(rain.avg_rainfall),
      by_province: rain.by_province,
    },
  };
}

export async function getProvince({ province, days = 7 }) {
  const data = await queryCrossCorrelation({ province, days });
  const since = sinceISO(days);
  data.air_stations = airStations(since).filter((s) => s.province === province);
  return data;
}
