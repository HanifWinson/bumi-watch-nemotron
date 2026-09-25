// agent/toolDefinitions.js
// Tool schemas (OpenAI function-calling format) that Nemotron can call,
// plus the dispatcher that maps a tool call to the real database query.
// This replaces the old keyword router in prompts.js: the model now decides
// which data it needs.

import { INDONESIA_PROVINCES } from "../utils/helpers.js";
import {
  queryAirQuality,
  queryFireHotspots,
  queryEarthquakes,
  queryRainfall,
  queryCrossCorrelation,
  queryNationalOverview,
} from "./tools.js";

// ─── Shared parameter definitions ─────────────────────────────────────────────
const provinceParam = {
  type: "string",
  enum: INDONESIA_PROVINCES,
  description:
    "Indonesian province, exact name from the list. Map cities to their province " +
    "(e.g. Bandung → Jawa Barat, Pekanbaru → Riau, Makassar → Sulawesi Selatan). " +
    "Omit for all of Indonesia.",
};

const daysParam = (def) => ({
  type: "integer",
  minimum: 1,
  maximum: 30,
  description: `How many days to look back. 1 = today/now, 7 = this week, 30 = this month. Default ${def}.`,
});

// ─── Tool schemas ─────────────────────────────────────────────────────────────
export const TOOLS = [
  {
    type: "function",
    function: {
      name: "query_air_quality",
      description:
        "Air quality (US EPA AQI, 0-500) from WAQI monitoring stations across Indonesia. Returns average and max AQI per province. " +
        "Values are AQI, not µg/m³.",
      parameters: {
        type: "object",
        properties: {
          province: provinceParam,
          city: { type: "string", description: "Optional part of a station name, e.g. Palembang, Pekanbaru, Bekasi" },
          days: daysParam(7),
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_fire_hotspots",
      description:
        "Active fire hotspots from NASA FIRMS satellites (MODIS/VIIRS). Returns total count, high-confidence count, and count + fire radiative power (MW) per province.",
      parameters: {
        type: "object",
        properties: {
          province: provinceParam,
          days: daysParam(7),
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_earthquakes",
      description: "Earthquake events from BMKG. Returns count, max/avg magnitude and recent events.",
      parameters: {
        type: "object",
        properties: {
          province: provinceParam,
          minMagnitude: { type: "number", description: "Only include quakes at or above this magnitude" },
          days: daysParam(7),
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_rainfall",
      description:
        "Rainfall (mm/day) from Open-Meteo with drought and flood risk classification per province.",
      parameters: {
        type: "object",
        properties: {
          province: provinceParam,
          days: daysParam(7),
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_cross_correlation",
      description:
        "Fetches air quality, fires, earthquakes and rainfall for ONE province at once. Use for general " +
        "'how is the environment in X' questions or when looking for links between sources " +
        "(e.g. fires driving up AQI, low rain raising fire risk).",
      parameters: {
        type: "object",
        properties: {
          province: provinceParam,
          days: daysParam(7),
        },
        required: ["province"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_national_overview",
      description:
        "Summary of all four data sources across the whole of Indonesia. Use for national or 'which province is worst' questions.",
      parameters: {
        type: "object",
        properties: {
          days: daysParam(1),
        },
      },
    },
  },
];

// ─── Dispatcher ───────────────────────────────────────────────────────────────
const HANDLERS = {
  query_air_quality:       queryAirQuality,
  query_fire_hotspots:     queryFireHotspots,
  query_earthquakes:       queryEarthquakes,
  query_rainfall:          queryRainfall,
  query_cross_correlation: queryCrossCorrelation,
  query_national_overview: queryNationalOverview,
};

// Which data source each tool draws on (used for the "sources" metadata)
export const TOOL_SOURCES = {
  query_air_quality:       ["WAQI"],
  query_fire_hotspots:     ["NASA FIRMS"],
  query_earthquakes:       ["BMKG"],
  query_rainfall:          ["Open-Meteo"],
  query_cross_correlation: ["WAQI", "NASA FIRMS", "BMKG", "Open-Meteo"],
  query_national_overview: ["WAQI", "NASA FIRMS", "BMKG", "Open-Meteo"],
};

export async function executeTool(name, args = {}) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);

  const clean = sanitizeArgs(args);
  const result = await handler(clean);
  return compactResult(result);
}

// Models sometimes send days as a string or out of range, or a province
// that isn't in the list. Normalise before it hits the database.
function sanitizeArgs(args) {
  const out = { ...args };
  if (out.days !== undefined) {
    const d = parseInt(out.days, 10);
    out.days = Number.isFinite(d) ? Math.min(Math.max(d, 1), 30) : undefined;
    if (out.days === undefined) delete out.days;
  }
  if (out.province && !INDONESIA_PROVINCES.includes(out.province)) {
    const match = INDONESIA_PROVINCES.find(
      (p) => p.toLowerCase() === String(out.province).toLowerCase()
    );
    if (match) out.province = match;
    else delete out.province; // unknown → fall back to national
  }
  if (out.minMagnitude !== undefined) {
    const m = parseFloat(out.minMagnitude);
    if (Number.isFinite(m)) out.minMagnitude = m;
    else delete out.minMagnitude;
  }
  return out;
}

// Raw record lists can be large. Keep aggregates, trim raw record arrays,
// so tool results don't flood the model's context.
const RAW_ARRAYS = ["readings", "hotspots", "records", "earthquakes"];
const MAX_RAW = 3;
const MAX_BUCKETS = 10;

function compactResult(value) {
  if (Array.isArray(value)) return value.slice(0, MAX_BUCKETS).map(compactResult);
  if (!value || typeof value !== "object") return value;

  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (RAW_ARRAYS.includes(key) && Array.isArray(v)) {
      out[key] = v.slice(0, MAX_RAW).map(stripRecord);
    } else if (key === "latest") {
      out[key] = stripRecord(v);
    } else {
      out[key] = compactResult(v);
    }
  }
  return out;
}

function stripRecord(r) {
  if (!r || typeof r !== "object") return r;
  const { raw, _raw, ...rest } = r;
  return rest;
}
