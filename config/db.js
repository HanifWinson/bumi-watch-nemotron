// config/db.js
// SQLite database (replaces Elastic Cloud). One file, no account, no server.
// Tables mirror the old Elastic indices. Coordinates are stored as lat/lon columns.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
dotenv.config();

const DB_PATH = process.env.DB_PATH || "./data/bumiwatch.db";

// ─── Table definitions ────────────────────────────────────────────────────────
// columns: name → SQL type. `unique` = columns that identify a duplicate record,
// so the pipeline can re-fetch overlapping windows without double counting.
// `retainDays` = rows older than this are deleted on each pipeline run.
export const TABLES = {
  air_quality: {
    columns: {
      timestamp: "TEXT NOT NULL", province: "TEXT", city: "TEXT", location_name: "TEXT",
      lat: "REAL", lon: "REAL", parameter: "TEXT", value: "REAL", unit: "TEXT",
      aqi: "INTEGER", aqi_category: "TEXT", source: "TEXT",
    },
    unique: ["city", "parameter", "timestamp"],
    indexes: [["province", "timestamp"], ["timestamp"]],
    retainDays: 31,
  },

  bmkg_events: {
    columns: {
      timestamp: "TEXT NOT NULL", event_type: "TEXT", province: "TEXT", lat: "REAL", lon: "REAL",
      magnitude: "REAL", depth_km: "REAL", description: "TEXT", severity: "TEXT", source: "TEXT",
    },
    unique: ["timestamp", "lat", "lon", "magnitude"],
    indexes: [["province", "timestamp"], ["timestamp"]],
    retainDays: 31,
  },

  fire_hotspots: {
    columns: {
      timestamp: "TEXT NOT NULL", province: "TEXT", lat: "REAL", lon: "REAL",
      brightness: "REAL", confidence: "TEXT", frp: "REAL", satellite: "TEXT", source: "TEXT",
    },
    unique: ["timestamp", "lat", "lon", "satellite"],
    indexes: [["province", "timestamp"], ["timestamp"]],
    retainDays: 31,
  },

  rainfall: {
    columns: {
      timestamp: "TEXT NOT NULL", province: "TEXT", lat: "REAL", lon: "REAL",
      rainfall_mm: "REAL", total_mm: "REAL", period_days: "INTEGER",
      drought_risk: "TEXT", flood_risk: "TEXT", source: "TEXT",
    },
    unique: ["province", "timestamp"],
    indexes: [["province", "timestamp"], ["timestamp"]],
    retainDays: 31,
  },

  deforestation: {
    columns: {
      timestamp: "TEXT NOT NULL", province: "TEXT", island: "TEXT", lat: "REAL", lon: "REAL",
      area_ha: "REAL", alert_type: "TEXT", confidence: "TEXT", source: "TEXT",
    },
    unique: ["timestamp", "lat", "lon", "alert_type"],
    indexes: [["province", "timestamp"]],
  },

  land_temperature: {
    columns: {
      timestamp: "TEXT NOT NULL", province: "TEXT", lat: "REAL", lon: "REAL",
      anomaly_celsius: "REAL", severity: "TEXT", source: "TEXT",
    },
    unique: ["timestamp", "province", "lat", "lon"],
    indexes: [["province", "timestamp"]],
  },

  water_stress: {
    columns: {
      timestamp: "TEXT NOT NULL", province: "TEXT", lat: "REAL", lon: "REAL",
      stress_score: "REAL", stress_category: "TEXT", stress_label: "TEXT", source: "TEXT",
    },
    unique: ["province", "lat", "lon", "stress_category"],
    indexes: [["province"]],
  },

  co2_emissions: {
    columns: {
      timestamp: "TEXT NOT NULL", province: "TEXT", sector: "TEXT", emissions_mtco2: "REAL",
      year: "INTEGER", lat: "REAL", lon: "REAL", source: "TEXT",
    },
    unique: ["province", "sector", "year"],
    indexes: [["year"]],
  },

  disasters: {
    columns: {
      timestamp: "TEXT NOT NULL", province: "TEXT", city: "TEXT", lat: "REAL", lon: "REAL",
      disaster_type: "TEXT", affected_people: "INTEGER", description: "TEXT",
      status: "TEXT", source: "TEXT",
    },
    unique: ["timestamp", "province", "disaster_type"],
    indexes: [["province", "timestamp"]],
    retainDays: 365,
  },
};

// ─── Connection ───────────────────────────────────────────────────────────────
function open() {
  if (DB_PATH !== ":memory:") fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const d = new Database(DB_PATH);
  d.pragma("journal_mode = WAL");   // pipeline can write while the agent reads
  d.pragma("synchronous = NORMAL");
  d.pragma("busy_timeout = 5000");
  return d;
}

export const db = open();

// ─── Schema setup (idempotent) ────────────────────────────────────────────────
export function setupDatabase() {
  for (const [table, def] of Object.entries(TABLES)) {
    const cols = Object.entries(def.columns).map(([c, t]) => `${c} ${t}`).join(", ");
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY, ${cols})`);
    if (def.unique) {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${table} ON ${table} (${def.unique.join(", ")})`);
    }
    for (const idx of def.indexes || []) {
      db.exec(`CREATE INDEX IF NOT EXISTS ix_${table}_${idx.join("_")} ON ${table} (${idx.join(", ")})`);
    }
  }
}

setupDatabase();

// ─── Writes ───────────────────────────────────────────────────────────────────
// Takes the same document objects the fetchers used to send to Elastic.
// `coordinates: {lat, lon}` is flattened; unknown fields are ignored;
// duplicates (per the table's unique key) are skipped.
const insertCache = new Map();

export function insertDocs(table, docs) {
  const def = TABLES[table];
  if (!def) throw new Error(`Unknown table: ${table}`);
  if (!docs?.length) return { inserted: 0, skipped: 0 };

  const cols = Object.keys(def.columns);
  if (!insertCache.has(table)) {
    insertCache.set(table, db.prepare(
      `INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(c => "@" + c).join(", ")})`
    ));
  }
  const stmt = insertCache.get(table);

  let inserted = 0;
  const run = db.transaction((rows) => {
    for (const doc of rows) {
      const row = {};
      for (const c of cols) {
        if (c === "lat") row.lat = num(doc.coordinates?.lat ?? doc.lat);
        else if (c === "lon") row.lon = num(doc.coordinates?.lon ?? doc.lon);
        else row[c] = normalise(doc[c]);
      }
      row.timestamp = toUTC(row.timestamp);
      if (!row.timestamp) continue;
      inserted += stmt.run(row).changes;
    }
  });
  run(docs);
  return { inserted, skipped: docs.length - inserted };
}

// Sources send "+07:00" offsets, "Z", etc. Store everything as UTC ISO so
// text comparison on timestamp is also correct time comparison.
function toUTC(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function normalise(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

// ─── Retention ────────────────────────────────────────────────────────────────
export function pruneOldRows() {
  let removed = 0;
  for (const [table, def] of Object.entries(TABLES)) {
    if (!def.retainDays) continue;
    removed += db.prepare(`DELETE FROM ${table} WHERE timestamp < ?`).run(sinceISO(def.retainDays)).changes;
  }
  return removed;
}

// ─── Time helper ──────────────────────────────────────────────────────────────
// Rolling window: 1 = the last 24 hours, 7 = the last 7 × 24 hours.
export function sinceISO(days) {
  return new Date(Date.now() - days * 24 * 3600e3).toISOString();
}
