// pipeline/index.js
// Main orchestrator — runs all data fetchers on a schedule.
// Normally started by the agent server (same process, same SQLite file).
// Can also run on its own: node pipeline/index.js

import dotenv from "dotenv";
dotenv.config();

import { fileURLToPath } from "node:url";
import { setupDatabase, pruneOldRows } from "../config/db.js";
import { fetchAndIndexAirQuality }     from "./fetchAirQuality.js";
import { fetchAndIndexBMKG }           from "./fetchBMKG.js";
import { fetchAndIndexFireHotspots }   from "./fetchFireHotspots.js";
import { fetchAndIndexResourceWatch }  from "./fetchResourceWatch.js";
import { fetchAndIndexRainfall }       from "./fetchRainfall.js";
import { log } from "../utils/helpers.js";

const INTERVAL_MS = (parseInt(process.env.PIPELINE_INTERVAL_MINUTES) || 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Run all fetchers ─────────────────────────────────────────────────────────
let running = false;
let lastResourceWatch = 0;

export async function runPipeline() {
  if (running) {
    log("Pipeline", "Previous run still in progress — skipping this tick", "warn");
    return;
  }
  running = true;
  try {
    await runAllFetchers();
  } finally {
    running = false;
  }
}

async function runAllFetchers() {
  const start = Date.now();
  log("Pipeline", "━━━ Starting data pipeline run ━━━");

  const tasks = [
    { name: "Air Quality (WAQI)",                  fn: fetchAndIndexAirQuality    },
    { name: "Earthquakes (BMKG)",                  fn: fetchAndIndexBMKG          },
    { name: "Fire Hotspots (NASA FIRMS)",          fn: fetchAndIndexFireHotspots  },
    { name: "Rainfall (Open-Meteo)",               fn: fetchAndIndexRainfall      },
  ];
  // Yearly/static datasets: once a day is plenty
  if (Date.now() - lastResourceWatch >= DAY_MS) {
    lastResourceWatch = Date.now();
    tasks.push({ name: "Environment Data (Resource Watch)", fn: fetchAndIndexResourceWatch });
  }

  const results = await Promise.allSettled(
    tasks.map(async ({ name, fn }) => {
      try {
        await fn();
      } catch (err) {
        log(name, `Failed: ${err.message}`, "error");
        throw err;
      }
    })
  );

  const passed  = results.filter(r => r.status === "fulfilled").length;
  const failed  = results.filter(r => r.status === "rejected").length;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  const pruned = pruneOldRows();
  if (pruned) log("Pipeline", `Pruned ${pruned} rows past retention`);

  log("Pipeline", `━━━ Run complete: ${passed}/${tasks.length} sources OK, ${failed} failed — ${elapsed}s ━━━`);
}

// Start the schedule: run once now, then every INTERVAL_MS.
// Returns a stop() function.
export function startPipeline() {
  const optional = ["NASA_FIRMS_API_KEY", "WAQI_API_KEY"];
  optional.forEach(k => {
    if (!process.env[k]) log("Config", `${k} not set — that source will be skipped`, "warn");
  });

  setupDatabase();
  runPipeline().catch(err => log("Pipeline", `Run failed: ${err.message}`, "error"));
  log("Pipeline", `Scheduled every ${INTERVAL_MS / 60000} minutes`);

  const timer = setInterval(() => {
    runPipeline().catch(err => log("Pipeline", `Run failed: ${err.message}`, "error"));
  }, INTERVAL_MS);
  return () => clearInterval(timer);
}

// ─── Standalone mode ─────────────────────────────────────────────────────────
// `node pipeline/index.js` runs the schedule on its own. `--once` runs one
// pass and exits (handy for seeding the database before a demo).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  console.log("\n  🌿 Bumi Watch — Indonesia Environmental Intelligence Pipeline\n");
  if (process.argv.includes("--once")) {
    setupDatabase();
    runPipeline()
      .then(() => process.exit(0))
      .catch(err => { console.error("Fatal pipeline error:", err); process.exit(1); });
  } else {
    startPipeline();
  }
}
