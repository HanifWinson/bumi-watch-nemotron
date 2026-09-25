// pipeline/fetchRainfall.js
// Fetches the last 7 days of rainfall per province from the Open-Meteo archive.
// Free, no key needed.
//
// Docs: https://open-meteo.com/en/docs/historical-weather-api

import { insertDocs } from "../config/db.js";
import { geoPoint, log, PROVINCE_CENTERS } from "../utils/helpers.js";

const SOURCE = "Open-Meteo";
const TABLE  = "rainfall";

// ─── Fetch rainfall data directly from Open-Meteo ────────────────────────────
// Completely free, no key, reliable, covers all Indonesian provinces
async function fetchRainfallData() {
  // Open-Meteo requires end_date to be yesterday at latest
  const yesterday  = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
  const endDate    = yesterday.toISOString().split("T")[0];
  const startDate  = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    .toISOString().split("T")[0];

  // Every province, including the fire-prone ones (Riau, Jambi, Sumsel,
  // Kalimantan) so rainfall can be correlated with fires.
  const keyProvinces = Object.keys(PROVINCE_CENTERS);

  // Collect results properly using Promise.allSettled with return values
  const settled = await Promise.allSettled(
    keyProvinces.map(async province => {
      const center = PROVINCE_CENTERS[province];
      if (!center) return null;

      const url = new URL("https://archive-api.open-meteo.com/v1/archive");
      url.searchParams.set("latitude",   center.lat);
      url.searchParams.set("longitude",  center.lon);
      url.searchParams.set("start_date", startDate);
      url.searchParams.set("end_date",   endDate);
      url.searchParams.set("daily",      "precipitation_sum");
      url.searchParams.set("timezone",   "Asia/Jakarta");

      const res = await fetch(url.toString());
      if (!res.ok) return null;

      const data  = await res.json();
      const daily = data.daily;
      if (!daily?.time?.length) return null;

      const totalRain = daily.precipitation_sum
        ?.reduce((a, b) => a + (b || 0), 0) || 0;
      const avgDaily  = totalRain / daily.time.length;

      return { province, center, avgDailyMm: avgDaily, totalMm: totalRain, days: daily.time.length };
    })
  );

  // Filter out failures and nulls
  return settled
    .filter(r => r.status === "fulfilled" && r.value !== null)
    .map(r => r.value);
}

// The archive only changes once a day, so stamp records with the start of
// today (WIB). Later runs the same day are then skipped as duplicates instead
// of adding another row per province every 30 minutes.
function startOfTodayWIB() {
  const wib = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  return new Date(`${wib}T00:00:00+07:00`).toISOString();
}

function transformRainfallRecord(raw) {
  return {
    timestamp:       startOfTodayWIB(),
    province:        raw.province || "Unknown",
    coordinates:     raw.center
                       ? geoPoint(raw.center.lat, raw.center.lon)
                       : geoPoint(-2.5, 118),
    rainfall_mm:     parseFloat(raw.avgDailyMm?.toFixed(2)) || 0,
    total_mm:        parseFloat(raw.totalMm?.toFixed(2)) || 0,
    period_days:     raw.days || 7,
    drought_risk:    classifyDroughtRisk(raw.avgDailyMm),
    flood_risk:      classifyFloodRisk(raw.avgDailyMm),
    source:          SOURCE,
  };
}

function classifyDroughtRisk(avgDailyMm) {
  if (avgDailyMm < 1)  return "high";
  if (avgDailyMm < 3)  return "medium";
  if (avgDailyMm < 6)  return "low";
  return "none";
}

function classifyFloodRisk(avgDailyMm) {
  if (avgDailyMm > 50) return "extreme";
  if (avgDailyMm > 30) return "high";
  if (avgDailyMm > 15) return "medium";
  if (avgDailyMm > 8)  return "low";
  return "none";
}

export async function fetchAndIndexRainfall() {
  log(SOURCE, "Fetching rainfall data for Indonesia...");

  const rawData = await fetchRainfallData();
  if (!rawData.length) {
    log(SOURCE, "No rainfall data returned", "warn");
    return;
  }

  const docs = rawData.map(transformRainfallRecord);
  log(SOURCE, `Fetched rainfall data for ${docs.length} provinces`);

  const { inserted, skipped } = insertDocs(TABLE, docs);
  log(SOURCE, `Stored ${inserted} new rainfall records in ${TABLE} (${skipped} duplicates skipped)`, "success");
}
