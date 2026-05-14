# QasrAlawani Search AI

Arabic-language semantic search and AI styling tool for the Qasr Al Awani (قصر الأواني) home-goods catalog. Combines vector search with multimodal generation to deliver three distinct user experiences in one app.

## Features

The app exposes three modes, switchable from a top bar:

### 🔍 Search Project (`مشروع البحث`)
- **Semantic kNN search** over ~9,300 products via OpenAI embeddings (`text-embedding-3-small`, 1536-d) and Elasticsearch dense vectors.
- **AI enrichment** runs in parallel on each query:
  - "Did you mean…?" spell correction
  - Ambiguous-query detection with refinement suggestions grounded in real product titles
  - Smart inline filters (brands at position 8, sizes at 16, contextual third filter at 24)
  - Related searches inline at position 32
  - Three budget recommendations (cheapest / best value / premium) with marketing copy
- **Image-based search** — upload a photo, GPT-4o-mini Vision extracts a short Arabic search phrase.
- **Product-code lookup** — typing a code like `TL-RGB02-08` (or a prefix like `8105-`) bypasses all AI and returns exact/prefix matches instantly.
- **Multi-layer cache** — repeat searches return in ~30 ms (~300× faster than cold path).

### 🎨 Tansiq Project (`مشروع التنسيقات`)
- Three independent rows, each with its own search input and horizontal product carousel.
- Drag any product into the side compose box (up to 3).
- Compose generates a single home-styled image via **Google Gemini 2.5 Flash Image (Nano Banana)**, which accepts the real product images as input and composites them. Falls back to `gpt-image-1` → `dall-e-3` → `dall-e-2` if Gemini is unavailable.

### 📄 Product Page Tansiq (`تنسيقات صفحة المنتج`)
- Replicates a real product page with one anchor product locked in (SKU `TL-RGB02-08`).
- A collapsible "نسقي ضيافتك في أقل من دقيقة AI" widget hosts a 3-slot drop zone (the anchor is slot 1, fixed).
- Two scoped search rows (`بيالات وفناجين`, `طوفرية`) with dynamic color-chip filters extracted from the fetched results.
- After composition: summary panel with line items, total before/after discount, and a single "add the whole arrangement to cart" button.

## Tech Stack

| Layer | Tech |
|------|------|
| Frontend | React 19 + Vite, axios, vanilla CSS (no UI lib) |
| Backend | Node.js + Express 5, dotenv |
| Search | Elasticsearch (Elastic Cloud), kNN on `dense_vector` |
| LLM | OpenAI GPT-4o-mini, `text-embedding-3-small`, GPT-4o-mini Vision |
| Image generation | Google Gemini 2.5 Flash Image (Nano Banana), OpenAI `gpt-image-1`/DALL-E as fallback |

## Prerequisites

- Node.js 18+ (built and tested on 24)
- An Elasticsearch cluster (Elastic Cloud free tier works)
- API keys for: OpenAI, Google Gemini (AI Studio), Elastic

## Setup

```bash
git clone <this-repo>
cd search-app
```

### Backend

```bash
cd backend
npm install
cp .env.example .env       # then fill in your keys
```

`.env` values needed (see `backend/.env.example`):
- `OPENAI_API_KEY`
- `ELASTIC_ENDPOINT` and `ELASTIC_API_KEY`
- `GEMINI_API_KEY`
- `PORT` (optional, defaults to 5000)

### Frontend

```bash
cd ../frontend
npm install
```

The frontend talks to `http://localhost:5000` by default (hardcoded in `src/App.jsx`).

## Data

The product catalog (`backend/data/products.csv`) is **not included** in the repository (gitignored). Provide your own CSV with these columns at minimum:

```
id, title, brand, link, image_link, price, sale_price, color, size, mpn, sku
```

## Indexing (one-time, then whenever the catalog changes)

```bash
cd backend
node scripts/create-index.js    # creates the 'products' Elasticsearch index — DROPS existing one
node scripts/index-products.js  # generates embeddings and bulk-uploads (~5-10 minutes for 9k products)
```

`create-index.js` is destructive — it deletes the existing index before recreating. `index-products.js` appends, so re-running without recreating will duplicate.

## Running

In two terminals:

```bash
# Terminal 1 — backend
cd backend
npm run dev                # nodemon on port 5000

# Terminal 2 — frontend
cd frontend
npm run dev                # Vite on port 5173
```

Open <http://localhost:5173>.

## Project Structure

```
search-app/
├── backend/
│   ├── index.js               # all routes: /search, /chat, /image-search, /tansiq, /tansiq-compose
│   ├── scripts/
│   │   ├── create-index.js    # creates the ES mapping (1536-d dense_vector + keyword fields)
│   │   └── index-products.js  # reads CSV, embeds titles, bulk-uploads
│   └── data/products.csv      # not in repo
├── frontend/
│   └── src/
│       ├── App.jsx            # single-component app with three view modes
│       ├── App.css            # all styles
│       └── main.jsx
├── .gitignore
├── CLAUDE.md                  # architecture notes for AI coding tools
└── README.md
```

A deeper architectural walkthrough lives in `CLAUDE.md`.

## Performance Notes

The backend uses six in-memory LRU caches with 5–30 minute TTLs:
- `responseCache` — full `/search` responses (5 min)
- `embeddingCache`, `classifyCache` — query-level
- `aiSummaryCache`, `intentCache`, `smartFiltersCache`, `relatedSearchesCache` — per-feature
- `typoCache` — "did you mean" results

Classification and embedding requests run in parallel rather than sequentially. A repeated query is served in tens of milliseconds; first-hit cold latency is bounded by OpenAI's API.

## Notes on Costs

- OpenAI: each cold search makes ~5 GPT-4o-mini calls + 1 embedding. Image search adds one Vision call. Negligible cost per search (~$0.001).
- Gemini Nano Banana: ~$0.04 per composed image; free tier covers ~1,500 images/day.
- Elasticsearch: depends on cluster size; the free Elastic Cloud tier suffices for development.
