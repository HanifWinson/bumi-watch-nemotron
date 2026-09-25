// utils/provinceShapes.js
// Point → province using real province outlines, the same GeoJSON the
// frontend map draws (a copy lives next to this file). Replaces the old
// bounding boxes, which overlapped and put e.g. Palangka Raya in Kalimantan Barat.
//
// The shapes use the older 32-province boundaries: Kepulauan Riau, Kalimantan
// Utara, Sulawesi Barat and the new Papua provinces fall inside their parent
// province, which matches what the map shows.

import fs from "node:fs";

const SHAPES_URL = new URL("./indonesia-provinces.geojson", import.meta.url);

// Points just off a simplified coastline (coastal fires, offshore quakes) go to
// the nearest province, if it is within this many degrees (~1° ≈ 110 km).
const MAX_OFFSHORE_DEG = 1.5;

let shapes = null;

function load() {
  if (shapes) return shapes;
  const geo = JSON.parse(fs.readFileSync(SHAPES_URL, "utf8"));
  shapes = geo.features.flatMap((f) => {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    return polys.map((rings) => ({ name: f.properties.name, rings, bbox: bboxOf(rings[0]) }));
  });
  return shapes;
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

export function provinceAt(lat, lon, maxOffshoreDeg = MAX_OFFSHORE_DEG) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "Unknown";

  for (const s of load()) {
    const b = s.bbox;
    if (lon < b.minX || lon > b.maxX || lat < b.minY || lat > b.maxY) continue;
    if (inPolygon(lon, lat, s.rings)) return s.name;
  }

  // Not on land: nearest outline vertex, if close enough
  let best = "Unknown";
  let bestD = maxOffshoreDeg ** 2;
  for (const s of shapes) {
    const b = s.bbox;
    if (lon < b.minX - maxOffshoreDeg || lon > b.maxX + maxOffshoreDeg ||
        lat < b.minY - maxOffshoreDeg || lat > b.maxY + maxOffshoreDeg) continue;
    for (const [x, y] of s.rings[0]) {
      const d = (x - lon) ** 2 + (y - lat) ** 2;
      if (d < bestD) { bestD = d; best = s.name; }
    }
  }
  return best;
}

// Area-weighted centroid of each province's largest polygon, for sources that
// take one point per province (rainfall).
export function provinceCentroids() {
  const largest = new Map();
  for (const s of load()) {
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
