// pipeline/fetchFireHotspots.js
// Fetches active fire hotspots from NASA FIRMS for Indonesia's bounding box.
// Free API key at: https://firms.modaps.eosdis.nasa.gov/api/area/

import { db, insertDocs } from "../config/db.js";
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

// FIRMS returns at most 5 days per request. A fresh database gets two 5-day
// windows (10 days) once, so the 7-day view and its timelapse have history
// from the start; after that each run fetches the last 2 days.
const MAX_DAYS_PER_REQUEST = 5;
const BACKFILL_DAYS = 10;
let backfillChecked = false;

async function fetchHotspots(satellite = "VIIRS_SNPP_NRT", days = 1, startDate) {
  // NASA FIRMS requires MAP_KEY not regular API key
  const mapKey = process.env.NASA_FIRMS_API_KEY;
  if (!mapKey) throw new Error("NASA_FIRMS_API_KEY not set");

  // /api/area/csv/MAP_KEY/SATELLITE/BBOX/DAYS[/START_DATE]; without a start
  // date it's the most recent DAYS days
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}/${satellite}/${INDONESIA_BBOX}/${days}${startDate ? `/${startDate}` : ""}`;

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

// Checked once per process: does the database already reach back ~BACKFILL_DAYS?
function fetchWindows() {
  const recent = [{ days: 2 }];
  if (backfillChecked) return recent;
  backfillChecked = true;

  const { oldest } = db.prepare(`SELECT MIN(timestamp) AS oldest FROM ${TABLE}`).get();
  const covered = oldest && Date.now() - new Date(oldest).getTime() > (BACKFILL_DAYS - 2) * 864e5;
  if (covered) return recent;

  const start = new Date(Date.now() - (BACKFILL_DAYS - 1) * 864e5).toISOString().slice(0, 10);
  log(SOURCE, `Backfilling the last ${BACKFILL_DAYS} days of fires (from ${start})`);
  return [{ days: MAX_DAYS_PER_REQUEST, start }, { days: MAX_DAYS_PER_REQUEST }];
}

export async function fetchAndIndexFireHotspots() {
  log(SOURCE, "Fetching fire hotspots for Indonesia...");

  // Both VIIRS and MODIS for better coverage, for each time window
  const requests = fetchWindows().flatMap(({ days, start }) =>
    ["VIIRS_SNPP_NRT", "MODIS_NRT"].map((sat) =>
      fetchHotspots(sat, days, start).catch(e => { log(SOURCE, e.message, "warn"); return []; })
    )
  );
  const allHotspots = (await Promise.all(requests)).flat();
  const inIndonesia = allHotspots.map(transformHotspot).filter(h => h.province !== "Unknown");
  log(SOURCE, `Fetched ${allHotspots.length} fire hotspots, ${inIndonesia.length} in Indonesia`);

  if (inIndonesia.length === 0) return;

  const { inserted, skipped } = insertDocs(TABLE, inIndonesia);
  log(SOURCE, `Stored ${inserted} new hotspots in ${TABLE} (${skipped} duplicates skipped)`, "success");
}
