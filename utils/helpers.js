// utils/helpers.js
// Shared utilities: province mapping, AQI calculation, geo-point formatting.

import { provinceAt, provinceCentroids } from "./provinceShapes.js";

// ─── Indonesia province list (ISO 3166-2:ID) ────────────────────────────────
export const INDONESIA_PROVINCES = [
  "Aceh", "Sumatera Utara", "Sumatera Barat", "Riau", "Jambi",
  "Sumatera Selatan", "Bengkulu", "Lampung", "Kepulauan Bangka Belitung",
  "Kepulauan Riau", "DKI Jakarta", "Jawa Barat", "Jawa Tengah",
  "DI Yogyakarta", "Jawa Timur", "Banten", "Bali", "Nusa Tenggara Barat",
  "Nusa Tenggara Timur", "Kalimantan Barat", "Kalimantan Tengah",
  "Kalimantan Selatan", "Kalimantan Timur", "Kalimantan Utara",
  "Sulawesi Utara", "Sulawesi Tengah", "Sulawesi Selatan", "Sulawesi Tenggara",
  "Gorontalo", "Sulawesi Barat", "Maluku", "Maluku Utara",
  "Papua Barat", "Papua Barat Daya", "Papua", "Papua Selatan", "Papua Tengah", "Papua Pegunungan",
];

// One point per province, for sources that are queried by point (rainfall):
// the centroid of each of the 38 province outlines. Kepulauan Riau's largest
// island is remote Natuna, so it's measured at its capital instead.
export const PROVINCE_CENTERS = {
  ...provinceCentroids(),
  "Kepulauan Riau": { lat: 0.9186, lon: 104.445 }, // Tanjung Pinang
};

// ─── AQI calculation (US EPA standard) ──────────────────────────────────────
const AQI_BREAKPOINTS = {
  pm25: [
    { cLow: 0,     cHigh: 12.0,  iLow: 0,   iHigh: 50  },
    { cLow: 12.1,  cHigh: 35.4,  iLow: 51,  iHigh: 100 },
    { cLow: 35.5,  cHigh: 55.4,  iLow: 101, iHigh: 150 },
    { cLow: 55.5,  cHigh: 150.4, iLow: 151, iHigh: 200 },
    { cLow: 150.5, cHigh: 250.4, iLow: 201, iHigh: 300 },
    { cLow: 250.5, cHigh: 500.4, iLow: 301, iHigh: 500 },
  ],
};

export function calculateAQI(parameter, value) {
  const breakpoints = AQI_BREAKPOINTS[parameter.toLowerCase()];
  if (!breakpoints) return null;

  const bp = breakpoints.find(b => value >= b.cLow && value <= b.cHigh);
  if (!bp) return null;

  const aqi = Math.round(
    ((bp.iHigh - bp.iLow) / (bp.cHigh - bp.cLow)) * (value - bp.cLow) + bp.iLow
  );
  return aqi;
}

export function aqiCategory(aqi) {
  if (aqi <= 50)  return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for Sensitive Groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return "Hazardous";
}

// ─── Geo-point formatter ─────────────────────────────────────────────────────
export function geoPoint(lat, lon) {
  return { lat: parseFloat(lat), lon: parseFloat(lon) };
}

// ─── Infer province from GPS coordinates ─────────────────────────────────────
// maxOffshoreDeg: how far outside a province outline a point may be and still
// count for it (default ~1.5°, for offshore earthquakes).
export function inferProvinceFromCoords(lat, lon, maxOffshoreDeg) {
  if (lat == null || lon == null) return "Unknown";
  return provinceAt(Number(lat), Number(lon), maxOffshoreDeg);
}

// ─── Infer Indonesian province from city name ────────────────────────────────
// Simple lookup — extend as needed
const CITY_TO_PROVINCE = {
  "jakarta": "DKI Jakarta",
  "bandung": "Jawa Barat",
  "surabaya": "Jawa Timur",
  "semarang": "Jawa Tengah",
  "yogyakarta": "DI Yogyakarta",
  "medan": "Sumatera Utara",
  "palembang": "Sumatera Selatan",
  "pekanbaru": "Riau",
  "denpasar": "Bali",
  "makassar": "Sulawesi Selatan",
  "pontianak": "Kalimantan Barat",
  "samarinda": "Kalimantan Timur",
  "jayapura": "Papua",
};

export function inferProvince(cityName = "") {
  const key = cityName.toLowerCase().trim();
  for (const [city, province] of Object.entries(CITY_TO_PROVINCE)) {
    if (key.includes(city)) return province;
  }
  return "Unknown";
}

// ─── Logger ──────────────────────────────────────────────────────────────────
export function log(source, message, level = "info") {
  const icon = { info: "ℹ️", success: "✅", warn: "⚠️", error: "❌" }[level] || "•";
  console.log(`${icon} [${source}] ${message}`);
}
