// pipeline/fetchDeforestation.js
// Fetches deforestation alerts from Global Forest Watch for Indonesia.
// Uses the GFW Data API: https://www.globalforestwatch.org/help/developers/

import { insertDocs } from "../config/db.js";
import { geoPoint, log } from "../utils/helpers.js";

const SOURCE = "Global Forest Watch";
const TABLE  = "deforestation";

// GFW dataset IDs for deforestation alerts
const DATASETS = {
  GLAD_L:  "gfw_integrated_alerts",   // GLAD Landsat alerts
  RADD:    "raddh_forest_alerts",      // RADD alerts (tropical forests)
};

// Indonesia's Geostore ID on GFW (country boundary)
const INDONESIA_ISO = "IDN";

async function fetchGFWAlerts(dataset, days = 7) {
  const dateTo   = new Date().toISOString().split("T")[0];
  const dateFrom = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];

  // GFW Analysis API — aggregate alerts by country
  const url = `https://data-api.globalforestwatch.org/dataset/${dataset}/latest/query`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.GFW_API_KEY,
    },
    body: JSON.stringify({
      sql: `
        SELECT
          umd_glad_landsat_alerts__date AS alert_date,
          umd_glad_landsat_alerts__confidence AS confidence,
          COUNT(*) AS alert_count,
          SUM(area__ha) AS total_area_ha,
          AVG(latitude) AS center_lat,
          AVG(longitude) AS center_lon
        FROM results
        WHERE iso = '${INDONESIA_ISO}'
          AND umd_glad_landsat_alerts__date >= '${dateFrom}'
          AND umd_glad_landsat_alerts__date <= '${dateTo}'
        GROUP BY alert_date, confidence
        ORDER BY alert_date DESC
        LIMIT 500
      `
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GFW API error: ${res.status} — ${errText}`);
  }

  const data = await res.json();
  return data.data || [];
}

// Map island from coordinates (rough bounding boxes)
function inferIsland(lat, lon) {
  if (lon >= 95 && lon <= 108 && lat >= -6 && lat <= 6)   return "Sumatra";
  if (lon >= 108 && lon <= 117 && lat >= -4 && lat <= 2)  return "Kalimantan";
  if (lon >= 106 && lon <= 115 && lat >= -9 && lat <= -5) return "Java";
  if (lon >= 115 && lon <= 119 && lat >= -9 && lat <= -7) return "Bali";
  if (lon >= 131 && lon <= 141 && lat >= -9 && lat <= 0)  return "Papua";
  if (lon >= 119 && lon <= 131 && lat >= -6 && lat <= 2)  return "Sulawesi";
  return "Other";
}

function transformAlert(raw, dataset) {
  const lat = parseFloat(raw.center_lat) || 0;
  const lon = parseFloat(raw.center_lon) || 0;

  return {
    timestamp:   raw.alert_date
                   ? new Date(raw.alert_date).toISOString()
                   : new Date().toISOString(),
    province:    "Multiple",  // aggregate record — province drill-down needs tile query
    island:      inferIsland(lat, lon),
    coordinates: geoPoint(lat, lon),
    area_ha:     parseFloat(raw.total_area_ha) || 0,
    alert_type:  dataset === "GLAD_L" ? "GLAD" : "RADD",
    confidence:  raw.confidence || "nominal",
    source:      SOURCE,
  };
}

export async function fetchAndIndexDeforestation() {
  log(SOURCE, "Fetching deforestation alerts for Indonesia...");

  const [gladAlerts, raddAlerts] = await Promise.all([
    fetchGFWAlerts("GLAD_L", 7).catch(e => { log(SOURCE, `GLAD: ${e.message}`, "warn"); return []; }),
    fetchGFWAlerts("RADD",   7).catch(e => { log(SOURCE, `RADD: ${e.message}`, "warn"); return []; }),
  ]);

  const allAlerts = [
    ...gladAlerts.map(a => transformAlert(a, "GLAD_L")),
    ...raddAlerts.map(a => transformAlert(a, "RADD")),
  ];

  log(SOURCE, `Fetched ${allAlerts.length} deforestation alert records`);
  if (allAlerts.length === 0) return;

  const { inserted, skipped } = insertDocs(TABLE, allAlerts);
  log(SOURCE, `Stored ${inserted} new alerts in ${TABLE} (${skipped} duplicates skipped)`, "success");
}
