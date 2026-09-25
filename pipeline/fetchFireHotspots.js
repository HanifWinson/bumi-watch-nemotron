// pipeline/fetchFireHotspots.js
// Fetches active fire hotspots from NASA FIRMS for Indonesia's bounding box.
// Free API key at: https://firms.modaps.eosdis.nasa.gov/api/area/

import { insertDocs } from "../config/db.js";
import { geoPoint, inferProvinceFromCoords, log } from "../utils/helpers.js";

const SOURCE = "NASA FIRMS";
const TABLE  = "fire_hotspots";

// Indonesia bounding box (rough)
// West: 95°E  East: 141°E  South: 11°S  North: 6°N
// It also covers Malaysia, Brunei, Timor-Leste and southern Philippines.
const INDONESIA_BBOX = "95,-11,141,6";

// Fires are on land: allow ~20 km for coastlines the simplified outlines cut
// off. Anything farther out is in a neighbouring country and isn't stored.
const FIRE_SNAP_DEG = 0.2;

async function fetchHotspots(satellite = "VIIRS_SNPP_NRT", days = 1) {
  // NASA FIRMS requires MAP_KEY not regular API key
  const mapKey = process.env.NASA_FIRMS_API_KEY;
  if (!mapKey) throw new Error("NASA_FIRMS_API_KEY not set");

  // Correct URL format: /api/area/csv/MAP_KEY/SATELLITE/BBOX/DAYS
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}/${satellite}/${INDONESIA_BBOX}/${days}`;

  const res = await fetch(url, {
    headers: { "Accept": "text/csv,text/plain,*/*" }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`NASA FIRMS error: ${res.status} — ${body.slice(0, 200)}`);
  }

  const text = await res.text();
  // Check if response is an error message not CSV
  if (text.startsWith("<!") || text.includes("Invalid") || text.includes("Error")) {
    throw new Error(`NASA FIRMS returned error: ${text.slice(0, 200)}`);
  }

  return parseCSV(text);
}

function parseCSV(csvText) {
  const lines = csvText.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = line.split(",");
    return Object.fromEntries(headers.map((h, i) => [h, values[i]?.trim()]));
  });
}

function transformHotspot(raw) {
  const lat      = parseFloat(raw.latitude);
  const lon      = parseFloat(raw.longitude);
  const province = inferProvinceFromCoords(lat, lon, FIRE_SNAP_DEG);

  return {
    timestamp:   raw.acq_date && raw.acq_time
                   ? new Date(`${raw.acq_date}T${raw.acq_time.padStart(4, "0").replace(/(\d{2})(\d{2})/, "$1:$2")}:00Z`).toISOString()
                   : new Date().toISOString(),
    province,
    coordinates: geoPoint(lat, lon),
    brightness:  parseFloat(raw.bright_ti4 || raw.brightness) || null,
    confidence:  (raw.confidence || "").toLowerCase(),
    frp:         parseFloat(raw.frp) || null,
    satellite:   raw.satellite || "VIIRS",
    source:      SOURCE,
  };
}

export async function fetchAndIndexFireHotspots() {
  log(SOURCE, "Fetching fire hotspots for Indonesia...");

  // Fetch from both MODIS and VIIRS for better coverage
  const [viirs, modis] = await Promise.all([
    fetchHotspots("VIIRS_SNPP_NRT", 2).catch(e => { log(SOURCE, e.message, "warn"); return []; }),
    fetchHotspots("MODIS_NRT", 2).catch(e => { log(SOURCE, e.message, "warn"); return []; }),
  ]);

  const allHotspots = [...viirs, ...modis];
  const inIndonesia = allHotspots.map(transformHotspot).filter(h => h.province !== "Unknown");
  log(SOURCE, `Fetched ${allHotspots.length} fire hotspots, ${inIndonesia.length} in Indonesia`);

  if (inIndonesia.length === 0) return;

  const { inserted, skipped } = insertDocs(TABLE, inIndonesia);
  log(SOURCE, `Stored ${inserted} new hotspots in ${TABLE} (${skipped} duplicates skipped)`, "success");
}
