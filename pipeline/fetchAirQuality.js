// pipeline/fetchAirQuality.js
// Fetches the current AQI of every WAQI station in Indonesia from WAQI's map
// queries. WAQI's per-city feed (/feed/<city>) silently answers with the nearest
// or an unrelated station for names it doesn't know ("bali" returned a station
// in India), so we ask for the stations inside Indonesia's bounding box instead.
//
// Values are US EPA AQI (0–500), not concentrations: WAQI's per-pollutant
// numbers are AQI sub-indices too, which is why only the overall AQI is stored.
//
// Get free token at: https://aqicn.org/data-platform/token/
// Docs: https://aqicn.org/json-api/doc/#api-Map_Queries-GetMapStations

import { insertDocs } from "../config/db.js";
import { aqiCategory, log } from "../utils/helpers.js";
import { provinceAt } from "../utils/provinceShapes.js";

const SOURCE = "WAQI";
const TABLE  = "air_quality";

// south, west, north, east — includes parts of Malaysia, Singapore, Brunei, Timor-Leste
const INDONESIA_BOUNDS = [-11, 95, 6, 141];

// WAQI thins out stations in busy areas when the map area is large (one query
// for all of Indonesia dropped Kemayoran and GBK in Jakarta). So: start with a
// 2×4 grid and split any tile that comes back busy into four, a few levels deep.
const BUSY_TILE = 20;
const MAX_DEPTH = 3;
const CONCURRENCY = 4; // WAQI rejects bursts of parallel requests

// Stations are on land, so they must sit inside a province outline. Only allow
// a small snap for coastal stations the simplified coastline cuts off; a larger
// one would pull in Sarawak stations just across the border.
const STATION_SNAP_DEG = 0.1;

const FOREIGN = /malaysia|singapore|brunei|timor|thailand|philippines|sarawak|sabah|johor/i;

async function fetchTile([south, west, north, east]) {
  const url = `https://api.waqi.info/v2/map/bounds?latlng=${south},${west},${north},${east}&networks=all&token=${process.env.WAQI_API_KEY}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`WAQI error: ${res.status}`);
  const data = await res.json();
  if (data.status !== "ok") throw new Error(`WAQI error: ${data.data || data.status}`);
  return data.data || [];
}

function quarters([s, w, n, e]) {
  const my = (s + n) / 2, mx = (w + e) / 2;
  return [[s, w, my, mx], [s, mx, my, e], [my, w, n, mx], [my, mx, n, e]];
}

async function fetchStations() {
  const [S, W, N, E] = INDONESIA_BOUNDS;
  const queue = [];
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 4; c++) {
      const box = [S + (r * (N - S)) / 2, W + (c * (E - W)) / 4, S + ((r + 1) * (N - S)) / 2, W + ((c + 1) * (E - W)) / 4];
      queue.push({ box, depth: 0 });
    }
  }

  const stations = new Map(); // uid → station; tiles overlap on their edges
  let calls = 0, failed = 0;
  while (queue.length) {
    const batch = queue.splice(0, CONCURRENCY);
    const results = await Promise.allSettled(batch.map((t) => fetchTile(t.box)));
    calls += batch.length;
    results.forEach((r, i) => {
      if (r.status === "rejected") { failed++; return; }
      for (const s of r.value) stations.set(s.uid, s);
      if (r.value.length >= BUSY_TILE && batch[i].depth < MAX_DEPTH) {
        queue.push(...quarters(batch[i].box).map((box) => ({ box, depth: batch[i].depth + 1 })));
      }
    });
  }

  if (failed === calls) throw new Error("WAQI map query failed for every tile");
  if (failed) log(SOURCE, `${failed} of ${calls} map tiles failed; some stations may be missing`, "warn");
  return [...stations.values()];
}

export function transformStation(s) {
  const aqi = parseInt(s.aqi, 10); // "-" for stations without a current reading
  if (!Number.isFinite(aqi) || !s.station?.time) return null;
  if (FOREIGN.test(s.station.name || "")) return null;

  const province = provinceAt(s.lat, s.lon, STATION_SNAP_DEG);
  if (province === "Unknown") return null;

  const name = (s.station.name || `Station ${s.uid}`).replace(/,\s*Indonesia$/i, "");
  return {
    timestamp:     s.station.time,
    province,
    city:          name,
    location_name: name,
    coordinates:   { lat: s.lat, lon: s.lon },
    parameter:     "aqi",
    value:         aqi,
    unit:          "AQI",
    aqi,
    aqi_category:  aqiCategory(aqi),
    source:        SOURCE,
  };
}

export async function fetchAndIndexAirQuality() {
  if (!process.env.WAQI_API_KEY) {
    log(SOURCE, "WAQI_API_KEY not set — skipping", "warn");
    return;
  }
  log(SOURCE, "Fetching air quality stations across Indonesia...");

  const stations = await fetchStations();
  const readings = stations.map(transformStation).filter(Boolean);
  log(SOURCE, `Fetched ${readings.length} Indonesian stations (${stations.length - readings.length} outside Indonesia or offline)`);
  if (readings.length === 0) return;

  const { inserted, skipped } = insertDocs(TABLE, readings);
  log(SOURCE, `Stored ${inserted} new readings in ${TABLE} (${skipped} duplicates skipped)`, "success");
}
