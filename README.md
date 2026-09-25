<div align="center">

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&size=14&pause=1000&color=8A9A5B&center=true&vCenter=true&width=500&lines=Real-time+environmental+intelligence;Powered+by+NVIDIA+Nemotron+on+Nebius;Built+for+270M%2B+Indonesians;Ask+the+Earth.+It's+Listening." alt="Typing SVG" />

# 🌿 Bumi Watch

### Indonesia Environmental Intelligence Platform

*Ask the Earth. It's Listening.*

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![NVIDIA Nemotron](https://img.shields.io/badge/Model-NVIDIA%20Nemotron-76B900?logo=nvidia&logoColor=white)](https://nebius.com/services/token-factory/nemotron)
[![Nebius](https://img.shields.io/badge/Runs%20on-Nebius%20Token%20Factory-052B42)](https://tokenfactory.nebius.com)
[![SQLite](https://img.shields.io/badge/Data-SQLite-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![Hackathon](https://img.shields.io/badge/Nebius%20x%20NVIDIA-Global%20AI%20Hackathon-orange)](https://nebiusglobalaihackathon.devpost.com/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

</div>

---

## 🗺️ What is Bumi Watch?

**Bumi Watch** is an AI-powered environmental monitoring platform for Indonesia. It unifies real-time data on air quality, fire hotspots, earthquakes, and rainfall — then makes that data *conversational* through an **NVIDIA Nemotron** agent running on **Nebius Token Factory**. The agent decides for itself which data to pull, using real function calling over six database query tools.

> *"Provinsi mana yang paling banyak titik api saat ini?"*
> → **"Sulawesi Tengah: 15 hotspots, 151 MW fire radiative power — NASA FIRMS"**

> *"Bagaimana kondisi lingkungan di Jakarta?"*
> → **"AQI 157 (Tidak Sehat), curah hujan 2.9 mm/hari — WAQI + Open-Meteo"**

Real data. Real answers. No hallucinations.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     DATA SOURCES                                 │
│   NASA FIRMS · BMKG · WAQI · Open-Meteo                         │
└──────────────────────────┬──────────────────────────────────────┘
                           │ every 30 min
┌──────────────────────────▼──────────────────────────────────────┐
│  ONE NODE.JS PROCESS                                             │
│                                                                  │
│  Data pipeline ──writes──▶ SQLite (one file, deduplicated)       │
│                                 ▲                                │
│                                 │ SQL queries                    │
│  Nemotron agent ──tool calls────┘                                │
│   NVIDIA Nemotron 3 via Nebius Token Factory                     │
│   model picks tools → queries run → model answers                │
│   6 tools · parallel calls · cross-source correlation            │
└──────────────────────────┬──────────────────────────────────────┘
                           │ POST /api/agent
┌──────────────────────────▼──────────────────────────────────────┐
│                         FRONTEND                                 │
│             React + Vite · Leaflet maps · Chat UI                │
└─────────────────────────────────────────────────────────────────┘
```

### What changed from v1

v1 (Google Cloud AI Hackathon) used a keyword router: regex matched words like
"jakarta" or "gempa", pre-fetched data, and pasted it into the prompt. The model
never chose anything.

v1 also needed an Elastic Cloud account. v2 stores everything in a local SQLite
file, so the whole backend is one process with no external database. Records have
unique keys, so re-fetching overlapping time windows every 30 minutes no longer
double-counts fires and earthquakes.

v2 is a real agent. Nemotron receives six tool schemas and decides which to call,
with what province and time range, and can call several in parallel or chain calls
across steps. City names ("Pekanbaru") are mapped to provinces by the model, and
the province parameter is an enum of all 38 provinces so it can't invent one.

---

## ✨ What Makes This Different

| Capability | Generic Chatbot | Bumi Watch |
|-----------|----------------|------------|
| Current AQI in Pekanbaru | ❌ Guesses | ✅ Real WAQI sensor |
| Active fires today | ❌ Can't know | ✅ NASA FIRMS satellite |
| Cross-source correlation | ❌ No | ✅ Fire × AQI × Rainfall |
| Bahasa Indonesia | ✅ Generic | ✅ Auto-detected |
| Cites sources | ❌ Rarely | ✅ Every response |
| Real earthquake data | ❌ Training data | ✅ Live BMKG feed |

---

## 📡 Data Sources

| Source | Table | Data | Update |
|--------|-------|------|--------|
| [WAQI](https://aqicn.org) | `air_quality` | AQI from ~130 monitoring stations | 30 min |
| [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov) | `fire_hotspots` | Satellite fire hotspots | 30 min |
| [BMKG](https://data.bmkg.go.id) | `bmkg_events` | Earthquakes & weather | 30 min |
| [Open-Meteo](https://open-meteo.com) | `rainfall` | Rainfall + drought/flood risk | 30 min |

---

## 🤖 Agent Capabilities

The Nemotron agent understands natural language in **Bahasa Indonesia and English**:

```
"Bagaimana kondisi lingkungan di Jakarta?"
→ Calls: query_cross_correlation(province="DKI Jakarta")
→ Returns: Cited report linking AQI, fires, rainfall

"Provinsi mana yang paling banyak titik api?"
→ Calls: query_fire_hotspots()
→ Returns: Ranked list with fire radiative power (MW)

"Is the smoke in Pekanbaru from fires? Has it been dry?"
→ Calls in parallel: query_air_quality(Riau), query_fire_hotspots(Riau), query_rainfall(Riau)
→ Returns: Links low rainfall → fire count → AQI, only if the numbers support it
```

| Tool | Source |
|------|--------|
| `query_air_quality` | WAQI |
| `query_fire_hotspots` | NASA FIRMS |
| `query_earthquakes` | BMKG |
| `query_rainfall` | Open-Meteo |
| `query_cross_correlation` | All four, one province |
| `query_national_overview` | All four, all Indonesia |

Every response includes metadata: which tools were called, with what arguments, and which sources were used.

---

## 🛠️ Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| AI Brain | NVIDIA Nemotron 3 Nano (30B-A3B) | Tool selection, reasoning, answers |
| Inference | Nebius Token Factory | OpenAI-compatible API, function calling |
| Storage | SQLite (better-sqlite3) | Time-series storage, SQL aggregation, dedup |
| Agent API | Node.js + Express | Tool-calling loop, `POST /api/agent` |
| Data Pipeline | Node.js | Scheduled fetching, runs in the agent process |
| Frontend | React + Vite + Tailwind | Interactive dashboard |
| Maps | Leaflet + React-Leaflet | Interactive Indonesia province map |

---

## 🚀 Getting Started

### Prerequisites
- Node.js >= 22
- [WAQI token](https://aqicn.org/data-platform/token/) (free)
- [NASA FIRMS MAP_KEY](https://firms.modaps.eosdis.nasa.gov/api/area/) (free)
- [Nebius Token Factory API key](https://tokenfactory.nebius.com)

### Installation

```bash
# 1. Clone the repo
git clone https://github.com/HanifWinson/bumi-watch-project.git
cd bumi-watch-project

# 2. Install dependencies
npm install

# 3. Set up environment variables
cp .env.example .env
# Fill in NEBIUS_API_KEY, WAQI_API_KEY, NASA_FIRMS_API_KEY

# 4. (Optional) Run the tests — no keys or network needed
npm test

# 5. Seed the database with one pipeline run
npm run pipeline:once

# 6. Start the agent (also keeps the pipeline running every 30 min)
npm start
# → Agent running at http://localhost:3001
# → GET /health shows row counts and how fresh each source is

# 7. Start the frontend (new terminal)
cd bumiwatch-frontend
npm install
npm run dev
# → Frontend at http://localhost:3000
```

### Docker

```bash
docker build -t bumiwatch .
docker run -p 3001:3001 --env-file .env -v bumiwatch-data:/data bumiwatch
```

The volume keeps the SQLite file between restarts.

### API

| Endpoint | What it returns |
|----------|-----------------|
| `POST /api/agent` | `{question, history}` → Nemotron's answer plus the tools it called, sources, steps and latency |
| `GET /api/dashboard?days=1` | Stats, AQI stations, fire points and earthquakes for the map (plain SQL, no LLM) |
| `GET /api/province/:name?days=7` | All four sources for one province |
| `GET /health` | Model name, row counts and the latest timestamp per table |

### Test the Agent

```bash
# PowerShell
Invoke-WebRequest -Uri "http://localhost:3001/api/agent" `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"question": "Bagaimana kondisi lingkungan di Jakarta?"}'
```

---

## 📁 Project Structure

```
bumi-watch-project/
├── agent/
│   ├── index.js           # Express server — /api/agent, /api/dashboard, /api/province
│   ├── dashboard.js       # Read-only dashboard + province data for the frontend
│   ├── nemotron.js        # Nebius client + tool-calling loop
│   ├── toolDefinitions.js # Tool schemas, argument checks, dispatcher
│   ├── tools.js           # SQL query functions
│   └── prompts.js         # System prompt
├── pipeline/
│   ├── index.js          # Orchestrator (every 30 min, or --once)
│   ├── fetchAirQuality.js    # WAQI → air_quality
│   ├── fetchBMKG.js          # BMKG → bmkg_events
│   ├── fetchFireHotspots.js  # NASA FIRMS → fire_hotspots
│   ├── fetchRainfall.js      # Open-Meteo → rainfall
│   └── fetchResourceWatch.js # Resource Watch datasets
├── test/
│   ├── agent.test.js     # Queries + agent loop (in-memory SQLite, Nebius mocked)
│   └── pipeline.test.js  # Fetchers against sample API payloads
├── config/
│   └── db.js             # SQLite connection, 9 table schemas, inserts
├── utils/
│   └── helpers.js        # AQI calc, province mapping (all 38)
├── bumiwatch-frontend/   # React + Vite frontend
├── .env.example
└── README.md
```

---

## 🌟 Live Demo Examples

```
Question: "Provinsi mana yang paling banyak titik api saat ini?"

Answer:
Berdasarkan data real-time dari NASA FIRMS (7 hari terakhir):
• Sulawesi Tengah: 15 hotspots, FRP 151 MW
• Maluku Utara:    12 hotspots
• Jawa Tengah:     7 hotspots
Total Indonesia: 1,075 hotspots terdeteksi

📍 Sources: NASA FIRMS | Period: Last 7 days
```

---

## 🗓️ Roadmap

- [x] Data pipeline — WAQI, BMKG, NASA FIRMS, Open-Meteo
- [x] v2: SQLite storage with deduplication (replaces Elastic Cloud)
- [x] Cross-correlation engine — multi-source reasoning
- [x] Province coordinate mapping — all 38 provinces
- [x] React + Vite frontend — Leaflet maps, chat UI
- [x] v2: Nemotron agent with real function calling on Nebius Token Factory
- [ ] Pipeline scheduled on Nebius Serverless
- [ ] Proactive alerts (agent flags anomalies without being asked)

---

## 👥 Team

| Name | Role |
|------|------|
| Hanif Muhammad Rifqi | Project Lead · Data Pipeline · AI Agent |
| Hannan Muhammad | Frontend Designer · Deployment |
| Muhammad Hanif Fadhillah | Backend Developer · Video Maker |

---

## 📄 License

[MIT License](./LICENSE) — open source as required by the competition.

---

<div align="center">

Made with 🌿 for Indonesia · Nebius x NVIDIA Global AI Hackathon

*Bumi = Earth in Bahasa Indonesia*


</div>
