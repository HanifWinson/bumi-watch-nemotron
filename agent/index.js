// agent/index.js
// Express server exposing the Bumi Watch Nemotron agent as an HTTP API.
// The frontend calls POST /api/agent with a question and gets back an answer.

import express from "express";
import cors    from "cors";
import compression from "compression";
import dotenv  from "dotenv";
import { runAgent }      from "./nemotron.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { getDashboard, getProvince, dataFreshness, clampDays, resolveProvince } from "./dashboard.js";
import { startPipeline } from "../pipeline/index.js";

dotenv.config();

const app  = express();
const PORT = process.env.PORT || process.env.AGENT_PORT || 3001;
const MODEL = process.env.NEMOTRON_MODEL || "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";

// CORS_ORIGINS=https://bumiwatch.example.com,http://localhost:3000 restricts
// which sites may call the API. Unset = any origin (fine for local dev).
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors(CORS_ORIGINS.length ? { origin: CORS_ORIGINS } : undefined));
app.use(express.json({ limit: "32kb" }));
app.use(compression()); // the dashboard's fire points are ~1 MB of JSON before gzip

// Behind a proxy (Render, Fly, Railway, nginx) set TRUST_PROXY=1 so req.ip is the
// visitor's address rather than the proxy's.
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

// ─── Agent rate limit ─────────────────────────────────────────────────────────
// Every question costs Nebius tokens. Fixed window per IP, in memory.
const AGENT_RATE_LIMIT = parseInt(process.env.AGENT_RATE_LIMIT, 10) || 10; // per minute
const RATE_WINDOW_MS = 60 * 1000;
const hits = new Map();

function agentRateLimit(req, res, next) {
  const now = Date.now();
  const entry = hits.get(req.ip);
  if (!entry || now - entry.start >= RATE_WINDOW_MS) {
    hits.set(req.ip, { start: now, count: 1 });
    return next();
  }
  if (entry.count >= AGENT_RATE_LIMIT) {
    const retry = Math.ceil((entry.start + RATE_WINDOW_MS - now) / 1000);
    res.set("Retry-After", String(retry));
    return res.status(429).json({ error: `Too many questions. Try again in ${retry}s.` });
  }
  entry.count++;
  next();
}

// Forget idle IPs so the map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of hits) if (now - e.start >= RATE_WINDOW_MS) hits.delete(ip);
}, RATE_WINDOW_MS).unref();

// ─── Health check ─────────────────────────────────────────────────────────────
// Also reports how much data is stored and how fresh it is.
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "Bumi Watch Agent", version: "2.0.0", model: MODEL, data: dataFreshness() });
});

// ─── Dashboard data ───────────────────────────────────────────────────────────
// Straight from SQLite, no LLM, so the dashboard loads fast and the numbers
// are exact. ?days=1..30
app.get("/api/dashboard", async (req, res) => {
  try {
    res.json(await getDashboard({ days: clampDays(req.query.days, 1) }));
  } catch (err) {
    console.error("❌ Dashboard error:", err.message);
    res.status(500).json({ error: "Failed to load dashboard data" });
  }
});

// All four sources for one province. ?days=1..30
app.get("/api/province/:name", async (req, res) => {
  const province = resolveProvince(req.params.name);
  if (!province) return res.status(404).json({ error: "Unknown province" });
  try {
    res.json(await getProvince({ province, days: clampDays(req.query.days, 7) }));
  } catch (err) {
    console.error("❌ Province error:", err.message);
    res.status(500).json({ error: "Failed to load province data" });
  }
});

// ─── Main agent endpoint ──────────────────────────────────────────────────────
app.post("/api/agent", agentRateLimit, async (req, res) => {
  const { question, history = [] } = req.body || {};

  if (!question?.trim()) {
    return res.status(400).json({ error: "Question is required" });
  }

  console.log(`\n🤖 Question: ${question}`);
  const started = Date.now();

  try {
    const { answer, toolCalls, sources, steps } = await runAgent({
      systemPrompt: SYSTEM_PROMPT,
      question,
      history: Array.isArray(history) ? history : [],
    });

    console.log(`✅ Answer generated in ${steps} step(s), ${toolCalls.length} tool call(s), ${Date.now() - started}ms`);

    res.json({
      answer,
      metadata: {
        model:      MODEL,
        tool_calls: toolCalls,
        sources,
        steps,
        latency_ms: Date.now() - started,
        timestamp:  new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("❌ Agent error:", err.message);
    // Upstream error bodies stay in the server log, not in the response
    res.status(500).json({
      error: /timed out/i.test(err.message) ? "The model took too long to answer" : "Agent failed to process question",
    });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
// The data pipeline runs in this same process so both share one SQLite file.
// Set RUN_PIPELINE=false to run it separately (node pipeline/index.js).
if (process.env.NODE_ENV !== "test") {
  if (process.env.RUN_PIPELINE !== "false") startPipeline();

  app.listen(PORT, () => {
    console.log(`
  🌿 Bumi Watch Agent (Nemotron via Nebius) on http://localhost:${PORT}
  Model: ${MODEL}

  GET  /health               → health check
  GET  /api/dashboard?days=1  → map + stats data
  GET  /api/province/:name    → one province, all sources
  POST /api/agent             → ask a question

  curl -X POST http://localhost:${PORT}/api/agent \\
    -H "Content-Type: application/json" \\
    -d '{"question": "Bagaimana kualitas udara di Jakarta?"}'
  `);
  });
}

export default app;
