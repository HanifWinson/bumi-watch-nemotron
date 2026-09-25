# Handoff: deploying Bumi Watch

For whoever deploys the backend (this repo) and the frontend
([HanifWinson/bumi-watch-frontend](https://github.com/HanifWinson/bumi-watch-frontend)).

**Step-by-step deployment guide (Railway + Vercel or any static host):** [`DEPLOYMENT.md` in the frontend repo](https://github.com/HanifWinson/bumi-watch-frontend/blob/main/DEPLOYMENT.md).
This file is the background: what the backend needs and why.
Written 2026-09-25, after a round of backend fixes. The README covers what the project is; this covers
what you need to know to put it online.

## How the pieces fit

```
Frontend (Vite + React, static)  ──HTTPS──▶  Backend (this repo, Node 22 + Express)
  built with VITE_API_URL                      ├─ API: /health, /api/dashboard, /api/province/:name, /api/agent
  any static host, e.g. Vercel                ├─ Pipeline: fetches all sources every 30 min, same process
                                               └─ SQLite file (DB_PATH) ── needs a persistent disk
                                                        ▲
                             NASA FIRMS · WAQI · BMKG · Open-Meteo      Nebius Token Factory (Nemotron)
```

The backend is one process: the API and the data pipeline run together and share one SQLite file.

## 1. Secrets

Get these from the project owner **privately** (never commit them; `.env` is git-ignored):

| Variable | Needed for |
|---|---|
| `NEBIUS_API_KEY` | The chat agent. Without it every question fails. |
| `NASA_FIRMS_API_KEY` | Fire hotspots |
| `WAQI_API_KEY` | Air quality |

BMKG (earthquakes) and Open-Meteo (rainfall) need no key.

## 2. Deploy the backend

Use the Dockerfile. It runs `node agent/index.js` on port 3001 and keeps the database in `/data`.

**Hard requirements**

- **Exactly one instance.** SQLite lives on local disk, the pipeline runs inside the server, and the
  rate limiter is in memory. Two instances means two databases and double API usage. Don't enable autoscaling.
- **A persistent disk mounted at `/data`.** Without it the database is wiped on every restart or redeploy.
  (It refills within seconds of starting, but 7- and 30-day history is lost.)
- **Always on.** Hosts that sleep idle apps (free tiers of some platforms) stop the 30-minute pipeline, so data goes stale.

**Environment variables** (full list with comments in `.env.example`)

| Variable | Set to |
|---|---|
| `NEBIUS_API_KEY`, `NASA_FIRMS_API_KEY`, `WAQI_API_KEY` | The keys above |
| `NEMOTRON_MODEL` | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` (the default; exact capitalisation matters, Nebius rejects `nvidia/nemotron-3-nano-30b-a3b`) |
| `CORS_ORIGINS` | The frontend's URL(s), comma-separated, e.g. `https://bumi-watch-frontend.vercel.app`. Leave unset and any website can call the API and spend Nebius credits. |
| `TRUST_PROXY` | `1` on almost any host (Render, Railway, Fly, Cloud Run, nginx). Without it every visitor shares one rate-limit bucket. |
| `PORT` | Usually injected by the host; defaults to 3001 |
| `DB_PATH` | Leave the Dockerfile's `/data/bumiwatch.db` |

Optional: `AGENT_RATE_LIMIT` (questions per minute per IP, default 10), `NEMOTRON_MAX_TOKENS` (default 4096),
`PIPELINE_INTERVAL_MINUTES` (default 30).

**Check it** once it's up:

```bash
curl https://<backend>/health                 # "status":"ok", row counts per table, latest timestamps
curl "https://<backend>/api/dashboard?days=1"  # fires, ~130 AQI stations, quakes, rainfall for 38 provinces
curl -X POST https://<backend>/api/agent -H "Content-Type: application/json" \
     -d '{"question":"Where is the air quality worst in Indonesia today?"}'   # takes ~5-20 s
```

The first pipeline run starts with the server and takes a few seconds. `/health` shows `rows: 0` until it finishes.
On a fresh database that first run also backfills the last 10 days of fires (~85k hotspots, 4 FIRMS requests),
so the 7-day view and its timelapse have history straight away. It happens once; later runs fetch the last 2 days.
Logs print one line per source per run, and every question with the tools it called.

## 3. Deploy the frontend

Any static host works (Vercel suggested; step-by-step in the frontend repo's `DEPLOYMENT.md`).
Build command `npm run build`, output directory `dist`.

`VITE_API_URL` is baked in **at build time**, so set it to the backend URL (no trailing slash) in the host's
environment variables before building, and rebuild if it changes.

Then put the frontend's final URL(s) in the backend's `CORS_ORIGINS` and restart the backend.
If the dashboard says "Can't reach the Bumi Watch backend", it's `VITE_API_URL` or CORS. The browser console shows which.

## 4. Backend changes the frontend should know about

These landed on 2026-09-25 and change what the frontend receives:

- **Air quality is ~130 WAQI stations** across ~29 provinces, not 25 cities, and **overall AQI only**. The old
  per-pollutant values (PM2.5, PM10, O₃…) were AQI sub-indices mislabelled as µg/m³ and are gone. Station names
  look like `Kabupaten Muaro Jambi` or `Talang Betutu Palembang`. The Sources page text ("25 Indonesian cities",
  pollutant list) is now out of date.
- **"24h" is a true rolling 24 hours** (it used to reach back to midnight UTC yesterday, up to 48 h). Counts on
  the default view are smaller and now correct.
- **Provinces are assigned with the same outlines the map draws** (`public/indonesia-provinces.geojson`, copied to
  `utils/`). Fires in Kalimantan Tengah no longer show up as Kalimantan Barat, and the province panel's station list fills in.
- **Rainfall covers all 38 provinces.** Seven of them (Kepulauan Riau, Kalimantan Utara, Sulawesi Barat and the four
  new Papua provinces) have no outline on the map, so they appear in rankings but can't be clicked on the map.
- **The chat uses `POST /api/agent/stream`** (Server-Sent Events), so it can show each tool call live. If a host or
  proxy buffers responses, the steps arrive all at once at the end; Railway doesn't. The frontend falls back
  to `POST /api/agent` if the stream endpoint is missing.
- **`POST /api/agent` can return `429`** with `{"error":"Too many questions. Try again in Ns."}` and a `Retry-After`
  header (10 per minute per IP). Errors no longer include a `details` field; use `error`.

## 5. Known gaps

- The map outlines have 32 provinces, not Indonesia's current 38. A proper fix is a 38-province GeoJSON used by both
  the map and `utils/provinceShapes.js`; until then, points in the newer provinces are counted under their parent province.
- A question has no overall time limit: up to 6 model calls × 60 s each. Normal questions take 5–20 s.
- The pipeline log's "N/N sources OK" counts skipped sources (missing keys) as OK.
- Resource Watch datasets (deforestation, CO₂, …) are fetched daily but nothing reads them yet.

## Running locally

```bash
cp .env.example .env    # fill in the three keys
npm install
npm test                # 27 offline tests, no keys needed
npm start               # API + pipeline on http://localhost:3001
```

Frontend: `npm run dev` in the frontend repo (http://localhost:3000); it talks to `localhost:3001` by default.
