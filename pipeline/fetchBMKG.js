// pipeline/fetchBMKG.js
// Fetches earthquake and weather alerts from BMKG (Indonesia's meteorology agency).
// BMKG provides free public APIs — no API key required.

import { insertDocs } from "../config/db.js";
import { geoPoint, inferProvince, inferProvinceFromCoords, log } from "../utils/helpers.js";

const SOURCE = "BMKG";
const TABLE  = "bmkg_events";

// ─── Earthquake data ─────────────────────────────────────────────────────────
async function fetchEarthquakes() {
  // BMKG public endpoint — returns last 15 significant earthquakes (M >= 5.0)
  const res = await fetch("https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json");
  if (!res.ok) throw new Error(`BMKG earthquake API error: ${res.status}`);
  const data = await res.json();
  return data.Infogempa?.gempa ? [data.Infogempa.gempa] : [];
}

async function fetchRecentEarthquakes() {
  // Returns the last 15 earthquakes of M5.0 and above
  const res = await fetch("https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json");
  if (!res.ok) throw new Error(`BMKG recent quakes API error: ${res.status}`);
  const data = await res.json();
  return data.Infogempa?.gempa || [];
}

function transformEarthquake(raw) {
  // BMKG coordinate format: "6.31 LS" (south latitude) or "2.15 LU" (north)
  const parseCoord = (str) => {
    if (!str) return 0;
    const val = parseFloat(str);
    return str.includes("LS") ? -val : val;
  };

  const lat = parseCoord(raw.Lintang);
  const lon = parseFloat(raw.Bujur);
  // Coordinates first (offshore epicentres snap to the nearest province); the
  // region text only names a handful of big cities.
  const byCoords = inferProvinceFromCoords(lat, lon);
  const province = byCoords !== "Unknown" ? byCoords : inferProvince(raw.Wilayah || "");

  return {
    timestamp:   parseBMKGTime(raw),
    event_type:  "earthquake",
    province,
    coordinates: geoPoint(lat, lon),
    magnitude:   parseFloat(raw.Magnitude) || null,
    depth_km:    parseFloat(raw.Kedalaman) || null,
    description: raw.Wilayah || "",
    severity:    classifyEarthquakeSeverity(parseFloat(raw.Magnitude)),
    source:      SOURCE,
  };
}

// BMKG gives an ISO "DateTime" field. Prefer it: "Tanggal" uses Indonesian
// month names (Mei, Agu, Okt, Des) that JS Date can't parse, and "Jam" is in
// WIB/WITA/WIT, not server time.
const TZ_OFFSET = { WIB: "+07:00", WITA: "+08:00", WIT: "+09:00" };
const ID_MONTHS = { Jan: "Jan", Feb: "Feb", Mar: "Mar", Apr: "Apr", Mei: "May", Jun: "Jun",
                    Jul: "Jul", Agu: "Aug", Agt: "Aug", Sep: "Sep", Okt: "Oct", Nov: "Nov", Des: "Dec" };

function parseBMKGTime(raw) {
  if (raw.DateTime) {
    const d = new Date(raw.DateTime);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (raw.Tanggal && raw.Jam) {
    const [dd, mon, yyyy] = raw.Tanggal.trim().split(/\s+/);
    const tz = (raw.Jam.match(/(WIB|WITA|WIT)$/i)?.[1] || "WIB").toUpperCase();
    const time = raw.Jam.replace(/\s*(WIB|WITA|WIT)$/i, "").trim();
    const months = { Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12" };
    const m = months[ID_MONTHS[mon?.slice(0, 3)] || mon?.slice(0, 3)];
    if (m && dd && yyyy) {
      const d = new Date(`${yyyy}-${m}-${dd.padStart(2, "0")}T${time}${TZ_OFFSET[tz]}`);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return null; // unparseable → row is skipped rather than stamped "now"
}

function classifyEarthquakeSeverity(magnitude) {
  if (magnitude >= 7.0) return "extreme";
  if (magnitude >= 6.0) return "high";
  if (magnitude >= 5.0) return "medium";
  return "low";
}

// ─── Main export ─────────────────────────────────────────────────────────────
export async function fetchAndIndexBMKG() {
  log(SOURCE, "Fetching BMKG earthquake and weather data...");

  const [latest, recent] = await Promise.all([
    fetchEarthquakes().catch(e => { log(SOURCE, e.message, "warn"); return []; }),
    fetchRecentEarthquakes().catch(e => { log(SOURCE, e.message, "warn"); return []; }),
  ]);

  // Deduplicate by combining both lists
  const allQuakes = [...latest, ...recent];
  log(SOURCE, `Fetched ${allQuakes.length} earthquake records`);

  if (allQuakes.length === 0) return;

  const { inserted, skipped } = insertDocs(TABLE, allQuakes.map(raw => transformEarthquake(raw)));
  log(SOURCE, `Stored ${inserted} new events in ${TABLE} (${skipped} duplicates skipped)`, "success");
}
