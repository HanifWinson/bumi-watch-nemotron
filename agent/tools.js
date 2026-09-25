// agent/tools.js
// Query functions that the Nemotron agent calls (via toolDefinitions.js).
// Each reads from SQLite and returns the same shape the Elastic version did.

import { db, sinceISO } from "../config/db.js";
import { aqiCategory } from "../utils/helpers.js";

// Builds "WHERE timestamp >= ? [AND province = ?] ..." plus params
function where({ days, province, extra = [], alias = "" }) {
  const a = alias ? `${alias}.` : "";
  const clauses = [`${a}timestamp >= @since`];
  const params = { since: sinceISO(days) };
  if (province) { clauses.push(`${a}province = @province`); params.province = province; }
  for (const [sql, key, val] of extra) {
    if (val !== undefined && val !== null && val !== "" && val !== 0) {
      clauses.push(sql);
      params[key] = val;
    }
  }
  return { sql: "WHERE " + clauses.join(" AND "), params };
}

const round = (v) => Math.round(v || 0);
const fixed1 = (v) => (v === null || v === undefined ? undefined : Number(v).toFixed(1));

// FIRMS confidence: VIIRS uses l/n/h, MODIS uses 0–100. Treat h/high or ≥80 as high.
const HIGH_CONFIDENCE =
  "(lower(confidence) IN ('h','high') OR (confidence GLOB '[0-9]*' AND CAST(confidence AS INTEGER) >= 80))";

// ─── Air Quality ──────────────────────────────────────────────────────────────
export async function queryAirQuality({ province, city, days = 7, limit = 10 }) {
  const w = where({ days, province, extra: [["city LIKE @city", "city", city ? `%${city}%` : undefined]] });

  const readings = db.prepare(
    `SELECT * FROM air_quality ${w.sql} ORDER BY timestamp DESC LIMIT @limit`
  ).all({ ...w.params, limit });

  const byProvince = db.prepare(`
    SELECT province, AVG(aqi) AS avg_aqi, MAX(aqi) AS max_aqi
    FROM air_quality ${w.sql} AND aqi IS NOT NULL
    GROUP BY province
    ORDER BY avg_aqi DESC
  `).all(w.params);

  const latestStmt = db.prepare(`
    SELECT * FROM air_quality ${w.sql} AND province IS @p
    ORDER BY timestamp DESC LIMIT 1
  `);

  const overall = db.prepare(
    `SELECT AVG(aqi) AS avg, MAX(aqi) AS max FROM air_quality ${w.sql}`
  ).get(w.params);

  return {
    readings,
    summary: byProvince.map((b) => ({
      province: b.province,
      avg_aqi:  round(b.avg_aqi),
      max_aqi:  round(b.max_aqi),
      // Labels computed here so the model doesn't misread the scale
      avg_category: aqiCategory(round(b.avg_aqi)),
      max_category: aqiCategory(round(b.max_aqi)),
      latest:   latestStmt.get({ ...w.params, p: b.province }),
    })),
    overall_avg: round(overall?.avg),
    overall_max: round(overall?.max),
    overall_max_category: overall?.max == null ? null : aqiCategory(round(overall.max)),
  };
}

// ─── Fire Hotspots ────────────────────────────────────────────────────────────
export async function queryFireHotspots({ province, days = 7, limit = 20 }) {
  const w = where({ days, province });

  const hotspots = db.prepare(
    `SELECT * FROM fire_hotspots ${w.sql} ORDER BY timestamp DESC LIMIT @limit`
  ).all({ ...w.params, limit });

  const totals = db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN ${HIGH_CONFIDENCE} THEN 1 ELSE 0 END) AS high
    FROM fire_hotspots ${w.sql}
  `).get(w.params);

  const byProvince = db.prepare(`
    SELECT province, COUNT(*) AS count, SUM(frp) AS total_frp
    FROM fire_hotspots ${w.sql}
    GROUP BY province
    ORDER BY count DESC
  `).all(w.params);

  return {
    hotspots,
    total_count: totals?.total || 0,
    high_confidence_count: totals?.high || 0,
    by_province: byProvince.map((b) => ({
      province:  b.province,
      count:     b.count,
      total_frp: round(b.total_frp),
    })),
  };
}

// ─── Earthquakes ──────────────────────────────────────────────────────────────
export async function queryEarthquakes({ province, minMagnitude = 0, days = 7, limit = 10 }) {
  const w = where({
    days, province,
    extra: [["magnitude >= @minMag", "minMag", minMagnitude]],
  });

  const earthquakes = db.prepare(
    `SELECT * FROM bmkg_events ${w.sql} ORDER BY timestamp DESC LIMIT @limit`
  ).all({ ...w.params, limit });

  const stats = db.prepare(`
    SELECT COUNT(*) AS total, AVG(magnitude) AS avg, MAX(magnitude) AS max
    FROM bmkg_events ${w.sql}
  `).get(w.params);

  const bucket = (col, n) => db.prepare(`
    SELECT ${col} AS key, COUNT(*) AS doc_count
    FROM bmkg_events ${w.sql}
    GROUP BY ${col} ORDER BY doc_count DESC LIMIT ${n}
  `).all(w.params);

  return {
    earthquakes,
    total:         stats?.total || 0,
    avg_magnitude: fixed1(stats?.avg),
    max_magnitude: stats?.max ?? null,
    by_severity:   bucket("severity", 5),
    by_province:   bucket("province", 10),
  };
}

// ─── Rainfall ─────────────────────────────────────────────────────────────────
export async function queryRainfall({ province, days = 7, limit = 15 }) {
  const w = where({ days, province });

  const records = db.prepare(
    `SELECT * FROM rainfall ${w.sql} ORDER BY timestamp DESC LIMIT @limit`
  ).all({ ...w.params, limit });

  const avg = db.prepare(`SELECT AVG(rainfall_mm) AS avg FROM rainfall ${w.sql}`).get(w.params);

  const riskBuckets = (col) => db.prepare(`
    SELECT ${col} AS key, COUNT(*) AS doc_count
    FROM rainfall ${w.sql}
    GROUP BY ${col} ORDER BY doc_count DESC LIMIT 5
  `).all(w.params);

  // Average rain per province, with risk levels from the most recent reading
  const wr = where({ days, province, alias: "r" });
  const wx = where({ days, province, alias: "x" });
  const latestRisk = (col) => `(SELECT x.${col} FROM rainfall x ${wx.sql}
      AND x.province IS r.province ORDER BY x.timestamp DESC LIMIT 1)`;

  const byProvince = db.prepare(`
    SELECT r.province, AVG(r.rainfall_mm) AS avg_rain,
           ${latestRisk("drought_risk")} AS drought_risk,
           ${latestRisk("flood_risk")} AS flood_risk
    FROM rainfall r ${wr.sql}
    GROUP BY r.province
    ORDER BY avg_rain ASC
  `).all(wr.params);

  return {
    records,
    avg_rainfall: fixed1(avg?.avg),
    drought_risk: riskBuckets("drought_risk"),
    flood_risk:   riskBuckets("flood_risk"),
    by_province:  byProvince.map((b) => ({
      province:     b.province,
      avg_rain_mm:  fixed1(b.avg_rain),
      drought_risk: b.drought_risk || "unknown",
      flood_risk:   b.flood_risk || "unknown",
    })),
  };
}

// ─── Cross-correlation — the killer feature ───────────────────────────────────
// Fetches all four data types for a province at once.
export async function queryCrossCorrelation({ province, days = 7 }) {
  const [airQuality, fires, earthquakes, rainfall] = await Promise.allSettled([
    queryAirQuality({ province, days }),
    queryFireHotspots({ province, days }),
    queryEarthquakes({ province, days }),
    queryRainfall({ province, days }),
  ]);

  return {
    province,
    period_days: days,
    air_quality: airQuality.status === "fulfilled" ? airQuality.value : null,
    fires:       fires.status === "fulfilled" ? fires.value : null,
    earthquakes: earthquakes.status === "fulfilled" ? earthquakes.value : null,
    rainfall:    rainfall.status === "fulfilled" ? rainfall.value : null,
  };
}

// ─── National overview ────────────────────────────────────────────────────────
export async function queryNationalOverview({ days = 1 }) {
  const [airQuality, fires, earthquakes, rainfall] = await Promise.allSettled([
    queryAirQuality({ days, limit: 5 }),
    queryFireHotspots({ days, limit: 5 }),
    queryEarthquakes({ days, limit: 5 }),
    queryRainfall({ days, limit: 5 }),
  ]);

  return {
    period_days: days,
    air_quality: airQuality.status === "fulfilled" ? airQuality.value : null,
    fires:       fires.status === "fulfilled" ? fires.value : null,
    earthquakes: earthquakes.status === "fulfilled" ? earthquakes.value : null,
    rainfall:    rainfall.status === "fulfilled" ? rainfall.value : null,
  };
}
