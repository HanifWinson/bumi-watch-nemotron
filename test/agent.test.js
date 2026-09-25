// test/agent.test.js
// Offline tests. Nebius is mocked; the database is a real in-memory SQLite,
// so the SQL queries are actually executed.
// Run: npm test

process.env.NODE_ENV = "test";
process.env.NEBIUS_API_KEY = "test-key";
process.env.DB_PATH = ":memory:";

import { test, beforeEach } from "node:test";

const realFetch = globalThis.fetch; // the Nebius mock below replaces it
import assert from "node:assert/strict";

const { db, insertDocs, pruneOldRows } = await import("../config/db.js");
const { runAgent } = await import("../agent/nemotron.js");
const { executeTool, TOOLS } = await import("../agent/toolDefinitions.js");
const tools = await import("../agent/tools.js");

const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const daysAgo  = (d) => hoursAgo(d * 24);

function seed() {
  for (const t of ["air_quality", "fire_hotspots", "bmkg_events", "rainfall"]) db.exec(`DELETE FROM ${t}`);

  insertDocs("air_quality", [
    { timestamp: hoursAgo(1), province: "Riau", city: "Pekanbaru", parameter: "aqi", value: 80, aqi: 164, coordinates: { lat: 0.5, lon: 101.4 } },
    { timestamp: hoursAgo(2), province: "Riau", city: "Pekanbaru", parameter: "aqi", value: 60, aqi: 150 },
    { timestamp: hoursAgo(1), province: "DKI Jakarta", city: "Jakarta", parameter: "aqi", value: 40, aqi: 112 },
    { timestamp: daysAgo(10), province: "DKI Jakarta", city: "Jakarta", parameter: "aqi", value: 200, aqi: 300 }, // outside 7-day window
  ]);
  insertDocs("fire_hotspots", [
    { timestamp: hoursAgo(3), province: "Riau", coordinates: { lat: 1.1, lon: 101.1 }, frp: 30, confidence: "h", satellite: "VIIRS" },
    { timestamp: hoursAgo(3), province: "Riau", coordinates: { lat: 1.2, lon: 101.2 }, frp: 20, confidence: "n", satellite: "VIIRS" },
    { timestamp: hoursAgo(4), province: "Riau", coordinates: { lat: 1.3, lon: 101.3 }, frp: 10, confidence: "85",  satellite: "MODIS" },
    { timestamp: hoursAgo(5), province: "Kalimantan Barat", coordinates: { lat: 0, lon: 109 }, frp: 5, confidence: "40", satellite: "MODIS" },
  ]);
  insertDocs("bmkg_events", [
    { timestamp: hoursAgo(6), province: "Jawa Barat", coordinates: { lat: -7, lon: 107 }, magnitude: 5.2, severity: "medium", event_type: "earthquake" },
    { timestamp: hoursAgo(30), province: "Maluku", coordinates: { lat: -3, lon: 128 }, magnitude: 3.1, severity: "low", event_type: "earthquake" },
  ]);
  insertDocs("rainfall", [
    { timestamp: daysAgo(2), province: "Riau", rainfall_mm: 2, drought_risk: "medium", flood_risk: "none" },
    { timestamp: hoursAgo(1), province: "Riau", rainfall_mm: 0.5, drought_risk: "high", flood_risk: "none" },
    { timestamp: hoursAgo(1), province: "Jawa Barat", rainfall_mm: 20, drought_risk: "none", flood_risk: "medium" },
  ]);
}

let sent = [];
function mockNebius(script) {
  let i = 0;
  globalThis.fetch = async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
    const message = script[Math.min(i++, script.length - 1)];
    return { ok: true, json: async () => ({ choices: [{ message }] }) };
  };
}

beforeEach(() => { sent = []; seed(); });

// ─── Database ─────────────────────────────────────────────────────────────────
test("duplicate records are skipped (re-fetching overlapping windows)", () => {
  const doc = { timestamp: "2026-09-20T05:23:00Z", province: "Riau", coordinates: { lat: 1.5, lon: 101.5 }, frp: 30, satellite: "VIIRS" };
  assert.deepEqual(insertDocs("fire_hotspots", [doc]), { inserted: 1, skipped: 0 });
  assert.deepEqual(insertDocs("fire_hotspots", [doc, doc]), { inserted: 0, skipped: 2 });
  // same place and time but a different satellite is a separate detection
  assert.deepEqual(insertDocs("fire_hotspots", [{ ...doc, satellite: "MODIS" }]), { inserted: 1, skipped: 0 });
});

test("timestamps with offsets are stored as UTC", () => {
  insertDocs("air_quality", [{ timestamp: "2026-09-22T14:00:00+07:00", city: "X", parameter: "pm25", aqi: 50 }]);
  const row = db.prepare("SELECT timestamp FROM air_quality WHERE city = 'X'").get();
  assert.equal(row.timestamp, "2026-09-22T07:00:00.000Z");
});

test("rows past retention are pruned", () => {
  insertDocs("air_quality", [{ timestamp: daysAgo(40), city: "Old", parameter: "pm25", aqi: 10 }]);
  assert.ok(pruneOldRows() >= 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM air_quality WHERE city = 'Old'").get().n, 0);
});

// ─── Queries ──────────────────────────────────────────────────────────────────
test("air quality: province averages, time window respected", async () => {
  const r = await tools.queryAirQuality({ days: 7 });
  assert.deepEqual(r.summary.map(s => [s.province, s.avg_aqi, s.max_aqi]), [["Riau", 157, 164], ["DKI Jakarta", 112, 112]]);
  assert.equal(r.overall_max, 164); // the 300 from 10 days ago is excluded
  assert.equal(r.summary[0].latest.aqi, 164);
  assert.equal(r.readings.find(x => x.aqi === 164).lat, 0.5);
});

test("fires: counts, FRP, and high confidence across VIIRS and MODIS formats", async () => {
  const r = await tools.queryFireHotspots({ days: 1 });
  assert.equal(r.total_count, 4);
  assert.equal(r.high_confidence_count, 2); // "h" and "85"; not "n" or "40"
  assert.deepEqual(r.by_province[0], { province: "Riau", count: 3, total_frp: 60 });
});

test("earthquakes: stats, min magnitude, time window", async () => {
  const all = await tools.queryEarthquakes({ days: 7 });
  assert.equal(all.total, 2);
  assert.equal(all.max_magnitude, 5.2);
  const big = await tools.queryEarthquakes({ days: 7, minMagnitude: 5 });
  assert.equal(big.total, 1);
  const today = await tools.queryEarthquakes({ days: 0 });
  assert.equal(today.earthquakes.every(e => e.magnitude === 5.2), true);
});

test("rainfall: averages and latest risk per province", async () => {
  const r = await tools.queryRainfall({ province: "Riau", days: 7 });
  assert.deepEqual(r.by_province, [{ province: "Riau", avg_rain_mm: "1.3", drought_risk: "high", flood_risk: "none" }]);
});

test("cross correlation pulls all four sources for one province", async () => {
  const r = await tools.queryCrossCorrelation({ province: "Riau", days: 7 });
  assert.equal(r.air_quality.summary[0].province, "Riau");
  assert.equal(r.fires.total_count, 3);
  assert.equal(r.earthquakes.total, 0);
  assert.equal(r.rainfall.by_province[0].drought_risk, "high");
});

test("empty database returns zeros, not errors", async () => {
  for (const t of ["air_quality", "fire_hotspots", "bmkg_events", "rainfall"]) db.exec(`DELETE FROM ${t}`);
  const r = await tools.queryNationalOverview({ days: 1 });
  assert.equal(r.fires.total_count, 0);
  assert.equal(r.air_quality.overall_avg, 0);
  assert.deepEqual(r.rainfall.by_province, []);
});

// ─── Tool layer ───────────────────────────────────────────────────────────────
test("tool schemas are valid OpenAI function definitions", () => {
  assert.equal(TOOLS.length, 6);
  for (const t of TOOLS) {
    assert.equal(t.type, "function");
    assert.ok(t.function.name && t.function.description);
    assert.equal(t.function.parameters.type, "object");
  }
});

test("province case is fixed, unknown province falls back to national", async () => {
  const a = await executeTool("query_fire_hotspots", { province: "riau", days: 7 });
  assert.equal(a.total_count, 3);
  const b = await executeTool("query_fire_hotspots", { province: "Atlantis", days: "7" });
  assert.equal(b.total_count, 4);
});

test("large raw results are trimmed", async () => {
  const r = await executeTool("query_fire_hotspots", {});
  assert.equal(r.hotspots.length, 3);
});

// ─── Agent loop ───────────────────────────────────────────────────────────────
test("model calls tools on real data, then answers", async () => {
  mockNebius([
    { role: "assistant", content: "", tool_calls: [
      { id: "c1", type: "function", function: { name: "query_air_quality", arguments: '{"province":"Riau","days":1}' } },
      { id: "c2", type: "function", function: { name: "query_fire_hotspots", arguments: '{"province":"Riau","days":"1"}' } },
    ]},
    { role: "assistant", content: "<think>tinggi</think>AQI Riau 157 (Tidak Sehat), 3 titik api.\n📍 Sources: WAQI, NASA FIRMS | Period: 1 hari" },
  ]);

  const out = await runAgent({ systemPrompt: "sys", question: "Udara di Pekanbaru hari ini?" });

  assert.match(out.answer, /AQI Riau 157/);
  assert.doesNotMatch(out.answer, /think/);
  assert.deepEqual(out.sources.sort(), ["NASA FIRMS", "WAQI"]);
  assert.equal(out.steps, 2);

  assert.match(sent[0].url, /api\.tokenfactory\.nebius\.com\/v1\/chat\/completions$/);
  assert.equal(sent[0].headers.Authorization, "Bearer test-key");
  assert.equal(sent[0].body.model, "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B");

  // Tool results fed back to the model contain the real query output
  const toolMsgs = sent[1].body.messages.filter(m => m.role === "tool");
  assert.deepEqual(toolMsgs.map(m => m.tool_call_id), ["c1", "c2"]);
  assert.equal(JSON.parse(toolMsgs[1].content).total_count, 3);
});

test("bad tool arguments are reported back, not thrown", async () => {
  mockNebius([
    { role: "assistant", content: "", tool_calls: [
      { id: "c1", type: "function", function: { name: "query_rainfall", arguments: "{not json" } },
      { id: "c2", type: "function", function: { name: "does_not_exist", arguments: "{}" } },
    ]},
    { role: "assistant", content: "Data tidak tersedia." },
  ]);
  const out = await runAgent({ systemPrompt: "sys", question: "hujan?" });
  assert.equal(out.answer, "Data tidak tersedia.");
  const toolMsgs = sent[1].body.messages.filter(m => m.role === "tool");
  assert.match(toolMsgs[0].content, /Invalid JSON/);
  assert.match(toolMsgs[1].content, /Unknown tool/);
});

test("step limit forces a final answer without tools", async () => {
  mockNebius([
    ...Array(5).fill({ role: "assistant", content: "", tool_calls: [
      { id: "c", type: "function", function: { name: "query_national_overview", arguments: "{}" } },
    ]}),
    { role: "assistant", content: "Ringkasan nasional." },
  ]);
  const out = await runAgent({ systemPrompt: "sys", question: "overview" });
  assert.equal(out.answer, "Ringkasan nasional.");
  assert.equal(sent.length, 6);
  assert.equal(sent[5].body.tools, undefined);
});

test("history is converted to OpenAI roles", async () => {
  mockNebius([{ role: "assistant", content: "ok" }]);
  await runAgent({
    systemPrompt: "sys", question: "q",
    history: [{ role: "user", content: "hi" }, { role: "model", parts: [{ text: "halo" }] }, { bad: true }],
  });
  assert.deepEqual(sent[0].body.messages.map(m => m.role), ["system", "user", "assistant", "user"]);
});

// ─── Dashboard endpoint data ──────────────────────────────────────────────────
test("dashboard: stations, fire points and quakes come straight from SQL", async () => {
  const { getDashboard, getProvince, clampDays, resolveProvince } = await import("../agent/dashboard.js");
  const d = await getDashboard({ days: 7 });

  assert.equal(d.air.stations.length, 2);                 // Pekanbaru + Jakarta, latest reading each
  assert.equal(d.air.stations.find((s) => s.city === "Pekanbaru").aqi, 164);
  assert.equal(d.air.max_aqi, 164);                       // 10-day-old 300 is outside the window
  assert.equal(d.fires.total, 4);
  assert.equal(d.fires.points.length, 4);
  assert.equal(d.fires.by_province[0].province, "Riau");
  assert.equal(d.earthquakes.max_magnitude, 5.2);
  assert.equal(d.earthquakes.events.length, 2);
  assert.ok(d.rainfall.by_province.length > 0);

  const riau = await getProvince({ province: "Riau", days: 7 });
  assert.equal(riau.fires.total_count, 3);
  assert.equal(riau.air_stations.length, 1);

  assert.equal(clampDays("99"), 30);
  assert.equal(clampDays("x", 7), 7);
  assert.equal(resolveProvince("riau"), "Riau");
  assert.equal(resolveProvince("Atlantis"), null);
});

// ─── Time window ──────────────────────────────────────────────────────────────
test("1 day means the last 24 hours, not since midnight yesterday", async () => {
  const { sinceISO } = await import("../config/db.js");
  const age = Date.now() - new Date(sinceISO(1)).getTime();
  assert.ok(Math.abs(age - 24 * 3600e3) < 5000);

  const r = await tools.queryEarthquakes({ days: 1 }); // seeded: 6h ago and 30h ago
  assert.equal(r.total, 1);
});

// ─── API ──────────────────────────────────────────────────────────────────────
test("agent endpoint is rate limited per IP", async () => {
  process.env.AGENT_RATE_LIMIT = "2";
  const { default: app } = await import("../agent/index.js");
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/api/agent`;
  const ask = () => realFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  try {
    assert.equal((await ask()).status, 400); // empty question, but counted
    assert.equal((await ask()).status, 400);
    const limited = await ask();
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  } finally {
    server.close();
  }
});

test("a reply with no text and no tool calls is a clear error, not a crash", async () => {
  mockNebius([{ role: "assistant", content: null }]);
  await assert.rejects(runAgent({ systemPrompt: "sys", question: "q" }), /empty answer/);
});

test("air quality results carry the AQI category, so the model doesn't guess it", async () => {
  const r = await tools.queryAirQuality({ days: 7 });
  const riau = r.summary.find((s) => s.province === "Riau");
  assert.equal(riau.max_aqi, 164);
  assert.equal(riau.max_category, "Unhealthy");
  assert.equal(r.overall_max_category, "Unhealthy");
});
