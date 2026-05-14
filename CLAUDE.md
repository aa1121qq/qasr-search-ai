# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Arabic-language e-commerce semantic search for "قصر الأواني" (Qasr Al Awani). React/Vite frontend hits an Express backend that does vector search (Elasticsearch + OpenAI embeddings) and wraps results with GPT-4o-mini features (intent disambiguation, smart filters, recommendations, related searches, chat).

## Commands

Backend (from `backend/`):
- `npm run dev` — start with nodemon (port 5000, configurable via `PORT`)
- `npm start` — start without reload
- `node scripts/create-index.js` — (re)create the `products` Elasticsearch index. **Destructive: drops the existing index.**
- `node scripts/index-products.js` — read `data/products.csv`, embed titles via OpenAI (`text-embedding-3-small`, 1536d), bulk-upload to ES in batches of 100. Caps at `MAX_PRODUCTS = 22000`.

Frontend (from `frontend/`):
- `npm run dev` — Vite dev server
- `npm run lint` — ESLint
- `npm run build` — production build

There are no automated tests.

## Required environment (`backend/.env`)

`OPENAI_API_KEY`, `ELASTIC_ENDPOINT`, `ELASTIC_API_KEY`, optional `PORT`. The file is `.gitignored` and currently contains live keys — do not commit or echo it.

## Architecture

### Search pipeline (`backend/index.js` → `GET /search`)

The whole request is a fixed pipeline; understanding the ordering is critical before changing any stage:

1. **Classify search type** (`classifySearchType`). Fast path: regex-match the query against `DEVICE_INDICATORS` (= `GENERIC_DEVICE_WORDS` ∪ `SPECIFIC_DEVICE_NAMES`) with word boundaries. If hit, return `type: 'device'` synchronously — no LLM call. Otherwise fall back to GPT-4o-mini with a JSON-mode prompt. Output drives `excludeAccessories` and `preferHomeElec`.
2. **Embed query** with `text-embedding-3-small`.
3. **kNN search** against the `products` index (`embedding` field, cosine, 1536d) with `k = limit`, `num_candidates = min(limit*2, 1000)`.
4. **Accessory filter** (`isAccessory`) — only when `excludeAccessories`. Title-substring check against `ACCESSORY_KEYWORDS`.
5. **Subject filter** (`extractSubject` + `titleMatchesSubject`) — runs for *every* search regardless of type. Strips only `GENERIC_DEVICE_WORDS` (e.g. "ماكينة", "آلة") with word-boundary regex so that specific device names like "غسالة" survive. Matching normalizes Arabic (Alef/Ya unification, diacritics stripping), then stems suffixes (`ات`, `ين`, `ون`, `ها`, `ية`, `ة`, `ه`). Single-word subjects must match by stem; multi-word subjects only require the first stem if it's ≥4 chars, otherwise every stem must match. **If the filter would zero out results, it is skipped** and the unfiltered list is kept.
6. **Reorder** — when `preferHomeElec`, push brand "home elec" to the front.
7. **Brand extraction** (`extractBrands`) — only counts brands from products whose title contains a query word, top 50 by kNN score, minimum 2 occurrences per brand.
8. **Four AI calls in parallel** via `Promise.all`: `generateAISummary` (cheapest/bestValue/premium picks; matches GPT's chosen title back to a real product by exact title or 20-char prefix), `detectIntent` (suggests sub-categories when ambiguous; client can skip via `?skipIntent=true` after a refinement click), `generateSmartFilters` (sizes + a context-appropriate third filter), `generateRelatedSearches`.

### `POST /chat`

Embed user message → kNN top-10 → GPT-4o-mini with last 6 turns of history and the top-5 products as context. The model must return JSON with `reply`, `quickReplies`, `suggestedProduct.title`; the backend re-resolves `suggestedProduct` back to a real product by exact-or-prefix title match before returning.

### Two-tier device word lists

`GENERIC_DEVICE_WORDS` (ماكينة/آلة/جهاز/صانعة) are *prefixes* — removed during subject extraction so "ماكينة قهوة" filters by "قهوة". `SPECIFIC_DEVICE_NAMES` (ثلاجة/غسالة/فرن/…) are *kept* because they are the subject themselves ("غسالة ملابس" filters by "غسالة"). Adding a word to the wrong list silently breaks subject matching for that category. Both lists, plus `ACCESSORY_KEYWORDS`, are duplicated in `frontend/src/App.jsx` for client-side size-filter checks — keep them in sync.

### Frontend (`frontend/src/App.jsx`)

Single-component app (~600 lines). Hardcoded backend URL `http://localhost:5000`. After fetch, holds the full result list (up to 500 products) in `allProducts` and applies brand/size/third filters client-side. Inline filter cards are interleaved into the grid at fixed positions: brands after card 8, sizes after 16, third after 24 (`BRANDS_AFTER`/`SIZES_AFTER`/`THIRD_AFTER`) — and only when `!hasActiveFilters`. Pagination is "load more" by 30. When the active filter is `size` and `searchType === 'device'`, accessory titles are re-filtered in the client even though the backend already filtered, because a size like "12 لتر" can match accessories that snuck past.

### Index schema (`scripts/create-index.js`)

`title` is a `text` field with `standard` analyzer; all other metadata (`image_link`, `price`, `sale_price`, `brand`, `link`) is `keyword`. `embedding` is `dense_vector` 1536d cosine. If you change `MAX_PRODUCTS` or the embedding model, rerun *both* scripts in order — the indexer does not deduplicate, it appends.
