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

// One point per province, for sources that are queried by point (rainfall).
// Centroids of the province outlines, plus the capitals of the provinces the
// outline file predates.
export const PROVINCE_CENTERS = {
  ...provinceCentroids(),
  "Kepulauan Riau":   { lat:  0.9186, lon: 104.4450 }, // Tanjung Pinang
  "Kalimantan Utara": { lat:  2.8400, lon: 117.3700 }, // Tanjung Selor
  "Sulawesi Barat":   { lat: -2.6800, lon: 118.8900 }, // Mamuju
  "Papua Barat Daya": { lat: -0.8800, lon: 131.2600 }, // Sorong
  "Papua Selatan":    { lat: -8.4900, lon: 140.4000 }, // Merauke
  "Papua Tengah":     { lat: -3.3700, lon: 135.5000 }, // Nabire
  "Papua Pegunungan": { lat: -4.1000, lon: 138.9500 }, // Wamena
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
export function inferProvinceFromCoords(lat, lon) {
  if (lat == null || lon == null) return "Unknown";
  return provinceAt(Number(lat), Number(lon));
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
