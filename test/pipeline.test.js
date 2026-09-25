// test/pipeline.test.js
// Runs the real fetchers against sample API payloads (network mocked)
// and checks what lands in SQLite.

process.env.NODE_ENV = "test";
process.env.DB_PATH = ":memory:";
process.env.WAQI_API_KEY = "test";
process.env.NASA_FIRMS_API_KEY = "test";

import { test } from "node:test";
import assert from "node:assert/strict";

const { db } = await import("../config/db.js");
const { fetchAndIndexBMKG }         = await import("../pipeline/fetchBMKG.js");
const { fetchAndIndexFireHotspots } = await import("../pipeline/fetchFireHotspots.js");
const { fetchAndIndexAirQuality }   = await import("../pipeline/fetchAirQuality.js");
const { fetchAndIndexRainfall }     = await import("../pipeline/fetchRainfall.js");
const { queryFireHotspots }         = await import("../agent/tools.js");
const { INDONESIA_PROVINCES, inferProvinceFromCoords } = await import("../utils/helpers.js");

const today = new Date().toISOString().slice(0, 10);

// Sample payloads in each API's real format
const BMKG_QUAKE = {
  Tanggal: "22 Sep 2026", Jam: "10:15:30 WIB", DateTime: `${today}T03:15:30+00:00`,
  Lintang: "7.12 LS", Bujur: "106.55 BT", Magnitude: "5.1", Kedalaman: "10 km",
  Wilayah: "Pusat gempa di laut 80 km BaratDaya Kab. Sukabumi",
};
const BMKG_NO_ISO = { ...BMKG_QUAKE, DateTime: undefined, Tanggal: "5 Des 2025", Jam: "08:00:00 WITA", Magnitude: "4.0" };
const FIRMS_CSV = [
  "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight",
  `0.51,101.44,340.2,0.4,0.4,${today},0523,N,VIIRS,h,2.0NRT,295.1,12.5,D`,
  `0.52,101.45,330.0,0.4,0.4,${today},0523,N,VIIRS,n,2.0NRT,290.0,4.1,D`,
  `3.38,101.58,335.0,0.4,0.4,${today},0523,N,VIIRS,h,2.0NRT,292.0,9.9,D`, // Selangor, Malaysia: not stored
].join("\n");

const WAQI_STATIONS = [
  { uid: 13650, lat: -2.9, lon: 104.7, aqi: "373", station: { name: "Talang Betutu Palembang, Indonesia", time: `${today}T11:00:00+07:00` } },
  { uid: -416815, lat: -6.24, lon: 106.99, aqi: "60", station: { name: "Bekasi Kayuringin", time: `${today}T11:00:00+07:00` } },
  { uid: 2616, lat: 1.22, lon: 111.46, aqi: "158", station: { name: "Sri Aman, Sarawak, Malaysia", time: `${today}T11:00:00+07:00` } },
  { uid: 5779, lat: 4.33, lon: 113.99, aqi: "78", station: { name: "Miri", time: `${today}T11:00:00+07:00` } }, // Malaysia, no country in name
  { uid: 8647, lat: -6.18, lon: 106.83, aqi: "-", station: { name: "Jakarta Central (US Consulate), Indonesia", time: "1970-01-01T00:00:00Z" } },
];

function mockFetch() {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (b) => ({ ok: true, json: async () => b, text: async () => JSON.stringify(b) });
    if (u.includes("autogempa"))     return json({ Infogempa: { gempa: BMKG_QUAKE } });
    if (u.includes("gempaterkini"))  return json({ Infogempa: { gempa: [BMKG_QUAKE, BMKG_NO_ISO] } });
    if (u.includes("firms"))         return { ok: true, text: async () => FIRMS_CSV };
    if (u.includes("api.waqi.info/v2/map/bounds")) return json({ status: "ok", data: WAQI_STATIONS });
    if (u.includes("open-meteo"))    return json({ daily: { time: ["a","b","c","d"], precipitation_sum: [0, 1, 0, 1] } });
    return { ok: false, status: 404, text: async () => "not mocked", json: async () => ({}) };
  };
}

test("BMKG: uses ISO DateTime, parses Indonesian months + WITA, dedupes", async () => {
  mockFetch();
  await fetchAndIndexBMKG();
  const rows = db.prepare("SELECT * FROM bmkg_events ORDER BY magnitude DESC").all();
  assert.equal(rows.length, 2); // BMKG_QUAKE appears in both feeds → stored once
  assert.equal(rows[0].timestamp, `${today}T03:15:30.000Z`);
  assert.equal(rows[0].lat, -7.12);
  assert.equal(rows[0].province, "Jawa Barat"); // from coordinates, name lookup failed
  assert.equal(rows[1].timestamp, "2025-12-05T00:00:00.000Z"); // "Des", 08:00 WITA = 00:00 UTC
});

test("FIRMS: CSV → rows, re-running the pipeline doesn't double count", async () => {
  mockFetch();
  await fetchAndIndexFireHotspots();
  await fetchAndIndexFireHotspots(); // next 30-min run fetches the same 2-day window
  const r = await queryFireHotspots({ days: 1 });
  // CSV served for both VIIRS and MODIS requests; satellite column comes from
  // the CSV ("N"), so the second satellite's identical rows are also deduped.
  assert.equal(r.total_count, 2);
  assert.equal(r.high_confidence_count, 1);
});

test("WAQI: Indonesian stations only, overall AQI stored as AQI", async () => {
  mockFetch();
  await fetchAndIndexAirQuality();
  await fetchAndIndexAirQuality(); // next run, same readings
  const rows = db.prepare("SELECT city, province, parameter, value, unit, aqi, timestamp FROM air_quality ORDER BY aqi DESC").all();
  assert.deepEqual(rows.map(r => r.city), ["Talang Betutu Palembang", "Bekasi Kayuringin"]); // Malaysia + offline dropped
  assert.equal(rows[0].province, "Sumatera Selatan");
  assert.equal(rows[1].province, "Jawa Barat");
  assert.equal(rows[0].aqi, 373);
  assert.equal(rows[0].unit, "AQI");
  assert.equal(rows[0].parameter, "aqi");
  assert.equal(rows[0].timestamp, `${today}T04:00:00.000Z`);
});

test("Open-Meteo: one record per province with risk levels, once a day", async () => {
  mockFetch();
  await fetchAndIndexRainfall();
  await fetchAndIndexRainfall(); // next 30-min run the same day
  const rows = db.prepare("SELECT * FROM rainfall").all();
  assert.equal(rows.length, INDONESIA_PROVINCES.length); // every province, no duplicates
  assert.ok(rows.some(r => r.province === "Kalimantan Tengah"));
  assert.equal(rows[0].rainfall_mm, 0.5);
  assert.equal(rows[0].drought_risk, "high");
  assert.equal(rows[0].source, "Open-Meteo");
});

test("provinces come from the outlines, not overlapping boxes", () => {
  assert.equal(inferProvinceFromCoords(-2.21, 113.92), "Kalimantan Tengah"); // Palangka Raya
  assert.equal(inferProvinceFromCoords(-2.53, 112.95), "Kalimantan Tengah"); // Sampit
  assert.equal(inferProvinceFromCoords(-2.45, 103.8), "Sumatera Selatan");   // Musi Banyuasin
  assert.equal(inferProvinceFromCoords(-1.6, 103.6), "Jambi");               // Muaro Jambi
  assert.equal(inferProvinceFromCoords(-7.8, 106.3), "Jawa Barat");          // offshore, snaps to nearest
  assert.equal(inferProvinceFromCoords(-15, 100), "Unknown");                // open Indian Ocean
});

test("WAQI: busy map tiles are split so thinned-out stations are found", async () => {
  db.exec("DELETE FROM air_quality");
  const station = (uid, lat, lon) => ({ uid, lat, lon, aqi: "50", station: { name: `Station ${uid}`, time: `${today}T11:00:00+07:00` } });
  // 25 Java stations: a big tile only reports the first 20, like WAQI thinning a busy area
  const java = Array.from({ length: 25 }, (_, i) => station(i + 1, -7.0, 107 + i * 0.1));
  const calls = [];
  globalThis.fetch = async (url) => {
    const [s, w, n, e] = new URL(String(url)).searchParams.get("latlng").split(",").map(Number);
    calls.push([s, w, n, e]);
    const inside = java.filter((st) => st.lat >= s && st.lat <= n && st.lon >= w && st.lon <= e);
    const shown = (n - s) * (e - w) > 20 ? inside.slice(0, 20) : inside;
    return { ok: true, json: async () => ({ status: "ok", data: shown }) };
  };
  await fetchAndIndexAirQuality();
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM air_quality").get();
  assert.equal(n, 25);
  assert.ok(calls.length > 8); // started with 8 tiles, then split the busy one
});
