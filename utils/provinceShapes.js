// utils/provinceShapes.js
// Point → province with real outlines, in two steps:
//
// 1. Is the point in Indonesia? indonesia-land.geojson: detailed coastlines
//    (older 32-province file, used only as a land mask). Keeps fires and air
//    stations in Malaysia, Singapore and Timor-Leste out.
// 2. Which of the 38 provinces? indonesia-provinces.geojson: current
//    boundaries incl. the 2022 Papua split (the same file the frontend map
//    draws; CC BY 4.0, github.com/denyherianto/indonesia-geojson-topojson-maps-with-38-provinces).
//    Its coastlines are coarser, so a point in Indonesia that falls just
//    outside them goes to the nearest province.

import fs from "node:fs";

const LAND_URL      = new URL("./indonesia-land.geojson", import.meta.url);
const PROVINCES_URL = new URL("./indonesia-provinces.geojson", import.meta.url);

// Points just off a coastline (coastal fires, offshore quakes) still count if
// they're this close to land (~1° ≈ 110 km). Callers pass tighter values.
const MAX_OFFSHORE_DEG = 1.5;

let land = null;
let provinces = null;

function loadShapes(url) {
  const geo = JSON.parse(fs.readFileSync(url, "utf8"));
  return geo.features.flatMap((f) => {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    return polys.map((rings) => ({ name: f.properties.name, rings, bbox: bboxOf(rings[0]) }));
  });
}

function load() {
  land ??= loadShapes(LAND_URL);
  provinces ??= loadShapes(PROVINCES_URL);
}

function bboxOf(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

// Ray casting; GeoJSON coordinates are [lon, lat]
function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(lon, lat, rings) {
  if (!inRing(lon, lat, rings[0])) return false;
  return !rings.slice(1).some((hole) => inRing(lon, lat, hole));
}

function containing(shapes, lat, lon) {
  for (const s of shapes) {
    const b = s.bbox;
    if (lon < b.minX || lon > b.maxX || lat < b.minY || lat > b.maxY) continue;
    if (inPolygon(lon, lat, s.rings)) return s;
  }
  return null;
}

// Closest outline vertex within maxDeg, or null
function nearest(shapes, lat, lon, maxDeg) {
  let best = null;
  let bestD = maxDeg ** 2;
  for (const s of shapes) {
    const b = s.bbox;
    if (lon < b.minX - maxDeg || lon > b.maxX + maxDeg || lat < b.minY - maxDeg || lat > b.maxY + maxDeg) continue;
    for (const [x, y] of s.rings[0]) {
      const d = (x - lon) ** 2 + (y - lat) ** 2;
      if (d < bestD) { bestD = d; best = s; }
    }
  }
  return best;
}

export function provinceAt(lat, lon, maxOffshoreDeg = MAX_OFFSHORE_DEG) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "Unknown";
  load();

  // Always check the detailed coastlines first: the coarse province outlines
  // can spill over a border (e.g. into Sarawak)
  const inIndonesia = containing(land, lat, lon) || nearest(land, lat, lon, maxOffshoreDeg);
  if (!inIndonesia) return "Unknown";

  // Then the current province it's in, or the nearest one if the coarse
  // coastline cuts it off
  const hit = containing(provinces, lat, lon);
  if (hit) return hit.name;
  return nearest(provinces, lat, lon, Math.max(maxOffshoreDeg, 0.5) + 0.5)?.name ?? "Unknown";
}

// Area-weighted centroid of each province's largest polygon, for sources that
// take one point per province (rainfall).
export function provinceCentroids() {
  load();
  const largest = new Map();
  for (const s of provinces) {
    const area = Math.abs(ringArea(s.rings[0]));
    if (!largest.has(s.name) || area > largest.get(s.name).area) largest.set(s.name, { area, ring: s.rings[0] });
  }
  const out = {};
  for (const [name, { ring }] of largest) out[name] = centroidOf(ring);
  return out;
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

function centroidOf(ring) {
  const a = ringArea(ring);
  let cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
  }
  return { lat: +(cy / (6 * a)).toFixed(4), lon: +(cx / (6 * a)).toFixed(4) };
}
