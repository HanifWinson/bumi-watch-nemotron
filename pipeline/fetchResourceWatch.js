// pipeline/fetchResourceWatch.js
// Fetches multiple environmental datasets from the Resource Watch (RW) API
// by World Resources Institute — covers deforestation, land temperature,
// water stress, CO2 emissions, and more for Indonesia.
//
// Docs: https://resource-watch.github.io/doc-api/
// No API key required for read access.

import { insertDocs } from "../config/db.js";
import { geoPoint, log } from "../utils/helpers.js";

const SOURCE  = "Resource Watch";
const BASE    = "https://api.resourcewatch.org/v1";

// ─── Indonesia ISO code ───────────────────────────────────────────────────────
const COUNTRY = "IDN";

// ─── SQLite tables ────────────────────────────────────────────────────────────
const INDICES = {
  deforestation:   "deforestation",
  land_temp:       "land_temperature",
  water_stress:    "water_stress",
  co2:             "co2_emissions",
};

// ─── Search for dataset ID by name ───────────────────────────────────────────
async function findDatasetId(searchTerm) {
  const url = new URL(`${BASE}/dataset`);
  url.searchParams.set("name",       searchTerm);
  url.searchParams.set("env",        "production");
  url.searchParams.set("page[size]", "5");

  const res = await fetch(url.toString(), {
    headers: { "Accept": "application/json" }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.data?.[0]?.id || null;
}

// ─── Dataset IDs on Resource Watch ───────────────────────────────────────────
// IDs discovered via search on 2026-05-14
const DATASETS = {
  deforestation: {
    id:     "5c5e654e-182b-4ab4-8a3c-edff79cc68ea",
    search: "tree cover loss",
    index:  INDICES.deforestation,
  },
  land_temp: {
    id:     "d1007731-3fd8-4024-bf3a-953d4987fbc7",
    search: "land surface temperature",
    index:  INDICES.land_temp,
  },
  water_stress: {
    id:     "dcd1e9c7-1370-404e-8816-eaa51d4b1a39",
    search: "aqueduct water risk",
    index:  INDICES.water_stress,
  },
  co2: {
    id:     "f2677710-5f98-4f4d-b748-59f60e7c0d81",
    search: "co2 emissions",
    index:  INDICES.co2,
  },
};

// ─── Fetch dataset metadata ───────────────────────────────────────────────────
async function fetchDatasetInfo(datasetId) {
  const res = await fetch(`${BASE}/dataset/${datasetId}`, {
    headers: { "Accept": "application/json" }
  });
  if (!res.ok) throw new Error(`RW dataset info error: ${res.status}`);
  const data = await res.json();
  return data.data;
}

// ─── Query dataset via RW Query API with ID fallback + retry ─────────────────
async function queryDataset(datasetKey, sql) {
  const config = DATASETS[datasetKey];
  let id = config.id;

  const tryQuery = async (datasetId) => {
    const url = new URL(`${BASE}/query/${datasetId}`);
    url.searchParams.set("sql", sql);
    const res = await fetch(url.toString(), {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(20000), // 20s timeout
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`RW query error ${res.status}: ${err}`);
    }
    const data = await res.json();
    return data.data || [];
  };

  // Try up to 2 times (handles 503 transient errors)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await tryQuery(id);
    } catch (err) {
      if (err.message.includes("404") && config.search) {
        log(SOURCE, `Dataset ${id} not found, searching for "${config.search}"...`, "warn");
        const foundId = await findDatasetId(config.search);
        if (foundId) {
          log(SOURCE, `Found dataset ID: ${foundId}`, "info");
          config.id = foundId;
          id = foundId;
          continue;
        }
      }
      if (err.message.includes("503") && attempt < 2) {
        log(SOURCE, `503 timeout, retrying in 3s...`, "warn");
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw err;
    }
  }
}

// ─── 1. Deforestation — direct GLAD alerts API ───────────────────────────────
async function fetchDeforestation() {
  log(SOURCE, "Fetching GLAD deforestation alerts for Indonesia...");

  // Direct GLAD API — bypasses RW entirely, much more stable
  const endDate   = new Date().toISOString().split("T")[0];
  const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString().split("T")[0];

  // Try multiple known GLAD API endpoints
  const endpoints = [
    `https://glad.umd.edu/api/gladAlerts/summary?gladConfirmOnly=false&period=${startDate},${endDate}&iso=IDN`,
    `https://glad-api.earthenginepartners.appspot.com/v1/query?iso=IDN&period=${startDate},${endDate}`,
  ];

  let res, lastError;
  for (const endpoint of endpoints) {
    try {
      res = await fetch(endpoint, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) break;
      lastError = `${res.status}`;
    } catch (e) {
      lastError = e.message;
    }
  }

  if (!res?.ok) throw new Error(`GLAD API error: ${lastError}`);

  const data   = await res.json();
  const alerts = Array.isArray(data?.data?.alerts)
    ? data.data.alerts
    : Array.isArray(data?.data) ? data.data : [];

  return alerts.map(alert => ({
    timestamp:   new Date(alert.date || startDate).toISOString(),
    province:    alert.adm1Name || "Unknown",
    island:      inferIslandFromProvince(alert.adm1Name || ""),
    coordinates: alert.lat && alert.lon
                   ? geoPoint(alert.lat, alert.lon)
                   : geoPoint(-2.5, 118),
    area_ha:     parseFloat(alert.areaHa) || 0,
    alert_type:  "GLAD",
    confidence:  alert.confirmed ? "high" : "nominal",
    source:      SOURCE,
  }));
}

// ─── 2. Land Surface Temperature ─────────────────────────────────────────────
async function fetchLandTemperature() {
  log(SOURCE, "Fetching land surface temperature anomalies...");

  const sql = `
    SELECT
      year,
      month,
      anomaly_celsius,
      province,
      latitude,
      longitude
    FROM data
    WHERE iso = '${COUNTRY}'
      AND year >= 2024
    ORDER BY year DESC, month DESC
    LIMIT 300
  `;

  const rows = await queryDataset("land_temp", sql).catch(() => []);

  return rows.map(r => ({
    timestamp:        new Date(`${r.year}-${String(r.month).padStart(2,'0')}-01`).toISOString(),
    province:         r.province || "Unknown",
    coordinates:      r.latitude && r.longitude
                        ? geoPoint(r.latitude, r.longitude)
                        : geoPoint(-2.5, 118),
    anomaly_celsius:  parseFloat(r.anomaly_celsius) || 0,
    severity:         classifyTempAnomaly(parseFloat(r.anomaly_celsius)),
    source:           SOURCE,
  }));
}

// ─── 3. Water Stress ─────────────────────────────────────────────────────────
async function fetchWaterStress() {
  log(SOURCE, "Fetching water stress data for Indonesia...");

  const sql = `
    SELECT
      name_1 AS province,
      bws_cat AS stress_category,
      bws_label AS stress_label,
      bws_raw AS stress_score,
      latitude,
      longitude
    FROM data
    WHERE iso_a3 = '${COUNTRY}'
    ORDER BY bws_raw DESC
    LIMIT 200
  `;

  const rows = await queryDataset("water_stress", sql).catch(() => []);

  return rows.map(r => ({
    timestamp:      new Date().toISOString(),
    province:       r.province || "Unknown",
    coordinates:    r.latitude && r.longitude
                      ? geoPoint(r.latitude, r.longitude)
                      : geoPoint(-2.5, 118),
    stress_score:   parseFloat(r.stress_score) || 0,
    stress_category: r.stress_category || "Unknown",
    stress_label:   r.stress_label || "Unknown",
    source:         SOURCE,
  }));
}

// ─── 4. CO2 Emissions ────────────────────────────────────────────────────────
async function fetchCO2Emissions() {
  log(SOURCE, "Fetching CO2 emissions data for Indonesia...");

  const sql = `
    SELECT
      year,
      emissions_mtco2,
      sector,
      province
    FROM data
    WHERE iso = '${COUNTRY}'
      AND year >= 2018
    ORDER BY year DESC, emissions_mtco2 DESC
    LIMIT 200
  `;

  const rows = await queryDataset("co2", sql).catch(() => []);

  return rows.map(r => ({
    timestamp:        new Date(`${r.year}-01-01`).toISOString(),
    province:         r.province || "National",
    sector:           r.sector || "Total",
    emissions_mtco2:  parseFloat(r.emissions_mtco2) || 0,
    year:             parseInt(r.year),
    coordinates:      geoPoint(-2.5, 118), // country-level data
    source:           SOURCE,
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function inferIslandFromProvince(province = "") {
  const p = province.toLowerCase();
  if (p.includes("aceh") || p.includes("sumatera") || p.includes("riau") ||
      p.includes("jambi") || p.includes("bengkulu") || p.includes("lampung"))
    return "Sumatra";
  if (p.includes("kalimantan")) return "Kalimantan";
  if (p.includes("jawa") || p.includes("jakarta") || p.includes("banten") ||
      p.includes("yogyakarta")) return "Java";
  if (p.includes("sulawesi") || p.includes("gorontalo")) return "Sulawesi";
  if (p.includes("papua")) return "Papua";
  if (p.includes("bali")) return "Bali";
  if (p.includes("maluku")) return "Maluku";
  return "Other";
}

function classifyTempAnomaly(celsius) {
  if (celsius >= 3)  return "extreme";
  if (celsius >= 2)  return "high";
  if (celsius >= 1)  return "medium";
  if (celsius >= 0)  return "low";
  return "below_average";
}

// ─── Index helpers ────────────────────────────────────────────────────────────
async function bulkIndex(table, docs) {
  if (docs.length === 0) return;
  const { inserted, skipped } = insertDocs(table, docs);
  log(SOURCE, `Stored ${inserted} new rows in ${table} (${skipped} duplicates skipped)`, "success");
}

// ─── Main export ──────────────────────────────────────────────────────────────
export async function fetchAndIndexResourceWatch() {
  log(SOURCE, "━━━ Starting Resource Watch data fetch ━━━");

  const [deforestation, landTemp, waterStress, co2] = await Promise.allSettled([
    fetchDeforestation(),
    fetchLandTemperature(),
    fetchWaterStress(),
    fetchCO2Emissions(),
  ]);

  await Promise.all([
    deforestation.status === "fulfilled"
      ? bulkIndex(INDICES.deforestation, deforestation.value)
      : log(SOURCE, `Deforestation failed: ${deforestation.reason}`, "error"),

    landTemp.status === "fulfilled"
      ? bulkIndex(INDICES.land_temp, landTemp.value)
      : log(SOURCE, `Land temp failed: ${landTemp.reason}`, "error"),

    waterStress.status === "fulfilled"
      ? bulkIndex(INDICES.water_stress, waterStress.value)
      : log(SOURCE, `Water stress failed: ${waterStress.reason}`, "error"),

    co2.status === "fulfilled"
      ? bulkIndex(INDICES.co2, co2.value)
      : log(SOURCE, `CO2 failed: ${co2.reason}`, "error"),
  ]);

  log(SOURCE, "━━━ Resource Watch fetch complete ━━━");
}
