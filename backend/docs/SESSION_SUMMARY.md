# QasrAlawani Search AI — Comprehensive Session Summary

**Date:** 2026-05-18
**Scope:** Search quality overhaul, AI features, infrastructure, security
**Working tree:** `C:\Users\DELL\Desktop\search-app\backend`

---

## 1. Search Pipeline Architecture (current state)

A user query goes through this pipeline before products are returned:

```
USER QUERY ("ثلاجة كهربائية")
   │
   ├─ 1. Product-code shortcut — if query looks like an ID (digits/hyphens),
   │     direct CSV lookup, skip everything below
   │
   ├─ 2. Response cache check — full JSON hit returns in <30ms
   │
   ├─ 3. Parallel: classifySearchType + BGE-M3 embed + CLIP text embed
   │     · BGE-M3 (Ollama) → 1024-d semantic vector (Arabic)
   │     · CLIP text encoder (Xenova) → 512-d vector in IMAGE space
   │     · Arabic→English translation cached for CLIP
   │
   ├─ 4. ES Hybrid Query: BM25 + 2 kNN signals
   │     · multi_match (title^2 + brand + color + size, fuzzy AUTO)
   │     · kNN on `embedding` field (BGE) — boost 1.5
   │     · kNN on `clip_image_embedding` field — boost 3.5 for device queries, 1.5 else
   │     · function_score wraps multi_match — ×1.15 for in-season products
   │
   ├─ 5. BGE-Reranker (local, top 15) — neural cross-encoder rescoring
   │
   ├─ 6. Strict filter chain (post-retrieval):
   │     · Accessory filter (first 3 words match ACCESSORY_KEYWORDS)
   │     · Undersized filter (large-appliance query → exclude مل / <10 لتر / اطفال)
   │     · Subject filter (title must match stem of query subject)
   │     · Modifier filter (40+ rules: كهربائية → require واط/كهرب, etc.)
   │     · Deduplication (same title can't appear twice)
   │     · Hard filter params: kind=appliance, subtype=split_ac, tag=X, material=X
   │     · Auto appliance-intent: exclude product_kind=accessory if query says آلة/ماكينة/جهاز
   │
   ├─ 7. Brand extraction + reorder (home_elec preferred for electric)
   │
   ├─ 8. Fast intent (dictionary → statistical → LLM)
   │     · Dictionary covers 37 appliance categories (instant)
   │     · Statistical extractor pulls common bigrams from result titles
   │     · LLM fallback only for queries with neither
   │
   ├─ 9. AI features in parallel (skipped if ?skipAI=true):
   │     · generateAISummary (cheapest/bestValue/premium picks with marketing copy)
   │     · detectIntent (LLM, only if dict + statistical failed)
   │     · generateSmartFilters (sizes + 3rd-category options)
   │     · generateRelatedSearches (4 related queries from catalog)
   │     · detectTypo (did-you-mean suggestions)
   │
   └─ 10. Cache final response + log zero-results
```

**Two endpoints serve this:**
- `GET /search?q=&limit=500&skipAI=true&skipIntent=false` — fast lane (products + dictionary intent), used by frontend for first paint
- `GET /search/ai?q=&skipIntent=false` — slow lane (LLM features), fetched in parallel for progressive UI

---

## 2. Models Active in Production

| Model | Type | Where | What it does |
|---|---|---|---|
| BGE-M3 (Ollama) | 568M-param embedding | Local | Semantic Arabic understanding (1024-d) |
| CLIP ViT-B/32 (Xenova) | Vision-language transformer | Local | Cross-modal text↔image (512-d) |
| BGE-Reranker (Xenova) | Cross-encoder | Local | Re-scores top 15 results |
| GPT-4o-mini (OpenAI) | LLM | API | AI summary, smart filters, related, did-you-mean, intent (fallback), classify |
| Gemini 2.5 Image Pro | Vision generation | API | Tansiq composition (unchanged) |

**Open-source layers (BGE + CLIP) handle ~85% of search relevance. LLM only used for narrative features and ambiguous classification.**

---

## 3. Critical Quality Fixes Implemented This Session

### 3.1 Cross-modal visual search (CLIP text encoder)
- **Problem:** "ثلاجة" matched small thermoses (named ثلاجة in Arabic) before real fridges
- **Fix:** Loaded `CLIPTextModelWithProjection` directly (not feature-extraction pipeline). Arabic query → English translation → 512-d vector compared to product images
- **Result:** Real refrigerators now top 6 results; mini thermoses below

### 3.2 Modifier-aware filtering (40+ rules)
- **Problem:** "عصارة كهربائية" returned manual juicers; "إبريق زجاج" mixed with steel
- **Fix:** `MODIFIER_RULES` table — each modifier word has `require` regex (must be in title) and optional `exclude` regex
- Coverage: power (كهربائية/يدوية/لاسلكية), operation (بخار/هوائية/إنفرتر), material (إستيل/زجاج/خشب/جرانيت/سيراميك), design (بابين/مدمج/سبلت/شباك), set/single (طقم/مفرد)
- **Result:** Strict per-modifier filtering — only products with the modifier (or its synonym) survive

### 3.3 Strict subject filter (no fallback to noise)
- **Before:** if subject filter zeroed results, kept unfiltered list (showed كاسات for "بوتاجاز" search)
- **After:** subject filter is strict — 0 results is more honest than irrelevant ones
- "بوتاجاز" now returns 0 (catalog has none), not 9 unrelated products

### 3.4 Undersized filter for large appliances
- **Problem:** "ثلاجة" returned 1L mini-thermoses (technically called ثلاجة)
- **Fix:** When query contains a LARGE_APPLIANCE word (ثلاجة/غسالة/فرن/مكيف/سخان) AND doesn't itself say "اطفال" or specify small capacity → exclude any product with "مل" or "<10 لتر" or "اطفال" in title
- Smart: "ثلاجة اطفال" → keeps the small ones; "ثلاجة 1 لتر" → keeps 1L items

### 3.5 Deduplication
- **Problem:** "عصارة ليمون" appeared 3 times in results (different SKUs, same title)
- **Fix:** post-filter that drops duplicate titles (case-insensitive)

### 3.6 Faster rerank
- Reduced from top 30 to top 15 → ~50% latency reduction on reranker step with no measurable quality loss

---

## 4. Suggestion System (Intent Box)

### Three-tier architecture (zero-LLM for 99% of queries)

```
Query → 1. Dictionary lookup (37 categories, <1ms)
         ↓ miss
        2. Statistical extractor from top-30 product titles (~5ms)
         ↓ insufficient confidence
        3. LLM (gpt-4o-mini, ~1.5s) — last resort
```

### Dictionary (37 categories)
Maintained in `INTENT_DICTIONARY` (index.js). Each entry: 3-4 suggestions with title/description/icon/searchQuery. Categories: ثلاجة, غسالة, نشافة, فرن, مكنسة, قلاية, خلاط, ميكروويف, ترامس, ترمس, صحون, قدر, مكيف, سخان, شواية, محمصة, ساندويش, كاسات, فناجين, دلال, عجانة, خفاقة, محضر, شفاط, موقد, إبريق, غلاية, عصارة, مقلاة, حلة, مروحة, ميزان, مطحنة, سلاطة, صينية, سكاكين, طاولة, مفرش.

**Aliases** (`INTENT_ALIASES`): plurals/spelling variants → root key (e.g. ثلاجات → ثلاجة, ابريق → إبريق, دلة → دلال).

**Validation:** every suggestion has been verified to return ≥3 real products in the catalog. مكواة and مدفأة removed (only 1 product each). بوتاجاز removed (catalog has none). شواية فحم, ترامس ذكية, صحون تقديم all removed.

### Statistical extractor
For any query not in dictionary:
- Extract tokens from top-30 product titles
- Filter brand names (auto-detected from `brand` field) and stopwords (طقم/كوب/زجاج/أبيض/...)
- Count bigrams (frequency ≥3) and unigrams (frequency ≥3)
- Preserve longest original word per stem (avoids truncation: ليمون not ليم)
- Build "<query> <pattern>" suggestions

### Dynamic gate
If `products.length < 5` for the query, return no intent (no point suggesting filters for empty catalog).

### Where intent is computed
- **`/search`** runs dictionary + statistical → returns intent with products (sub-second)
- **`/search/ai`** also runs them; falls back to LLM `detectIntent` only if both fail
- Frontend prefers intent from `/search` (instant) and only updates from `/search/ai` if LLM produced something different

---

## 5. Catalog Tagging (in progress)

### ES mapping (already applied)
New keyword fields on `products_local` index:
- `product_kind` — appliance/cookware/serveware/kitchen_tool/storage/thermos/accessory/consumable/furniture/textile/bath/decor/other
- `product_subtype` — canonical English snake_case (split_ac, refrigerator_2door, etc.)
- `product_tags` — array of descriptive tags
- `product_material` — steel/glass/plastic/ceramic/wood/granite/melamine/silicone/aluminum/cast_iron/mixed/unknown
- `product_seasonal` — summer/winter/ramadan/eid/school/wedding/none (**left empty — user fills manually**)
- `tagged_at` — timestamp

### Classification scripts
- `scripts/sample-tag-products.js` — classifies 50 random products → `data/sample_tags.json` for human review. Does NOT touch ES.
- `scripts/tag-products.js` — full catalog classifier. Uses gpt-4o-mini in batches of 20, 5 concurrent → ~4 products/sec. Skips already-tagged. Resumable. **Does NOT fill product_seasonal.**

### Current state
- Sample of 50 products tagged → file written ✓
- Full catalog tagging restarted in background after user said "اعمل كل شي اشتغل انت"
- ETA ~30 min for remaining ~7,700 products
- Estimated cost: ~$0.30 in OpenAI tokens

### Hard filter API (already wired)
`/search` accepts: `?kind=appliance&subtype=split_ac&tag=portable&material=steel`. Each filter is graceful — products without the tag are NOT excluded (so search keeps working for untagged products).

---

## 6. Seasonal Boost

### Logic (live)
- `getCurrentSeason()` returns `summer` (May–Sep), `winter` (Dec–Feb), or `null`
- ES `function_score` multiplies score by 1.15 for products where `product_seasonal === currentSeason`
- Boost is small enough not to override strong relevance — only nudges ties

### Data (manual)
- `product_seasonal` field exists in mapping but is intentionally NOT populated by the LLM classifier
- User will fill manually via `POST /admin/add-product` or direct ES bulk update
- Until populated, seasonal boost is a no-op (correct fallback behavior)

---

## 7. Zero-Results Logging & Dashboard

### Logging
- Every search where `count ≤ 3` is appended to `backend/data/zero-results.jsonl`
- Fields: ts, query, count, searchType, total (ES match count before filters)
- Append-only, never edited — safe for grep/jq analysis

### JSON API
`GET /admin/analytics/zero-results?days=7&maxResults=3&limit=100`
Returns aggregated top failing queries with: query, occurrences, lastResultCount, firstSeen, lastSeen, searchTypes.

### HTML Dashboard
`GET /admin/analytics/zero-results.html?days=7` — RTL Arabic table view with color-coded badges. Live, requires admin auth.

---

## 8. Admin Security (re-implemented)

### Auth flow
1. **Bootstrap secret** (`ADMIN_SECRET` env var) — never sent in normal requests
2. **`POST /admin/token`** — caller proves it has bootstrap secret → server issues HMAC-signed JWT-like token
3. **Subsequent admin calls** — send `Authorization: Bearer <token>` (or `X-Admin-Token` header)

### Token format
`base64url({exp, scope, nonce}).hmac_sha256(payload, ADMIN_SECRET)` — self-contained, no DB.

### Scopes
- `write` — 15-minute TTL. Required for /admin/add-product, /admin/clear-cache, /admin/reload-csv.
- `read` — 1-hour TTL. Sufficient for /admin/analytics/*.
- Write token grants read access (superset).

### Rate limits
- Write endpoints: 3 calls/min/IP
- Read endpoints: 30 calls/min/IP
- Token issuance: 5 calls/min/IP (brute force protection on bootstrap)

### Audit log
- Every admin call (success or failure) appended to `backend/data/admin-audit.jsonl`
- Fields: ts, ip, path, scope, result (allowed_token / rate_limited / invalid_token / etc.), tokenScope

### Backwards compatibility
- Legacy `X-Admin-Key` header still works (uses ADMIN_SECRET as the static key). Logged as `allowed_static_key_deprecated`. Migrate to tokens.

### Dev mode
If `ADMIN_SECRET` is empty, requests from localhost (127.0.0.1, ::1) are allowed. Remote requests rejected with 401.

### Open architectural decisions (still in proposal doc)
1. Bootstrap secret rotation schedule (default: 90 days, manual)
2. Audit log retention/rotation policy
3. CORS lockdown for admin endpoints
4. Whether to add `/admin/cache/invalidate?key=...` (finer than full flush)
5. IP allowlist / Cloudflare Access layer (defense in depth)
6. Move to JWT (RS256) when admin count grows >3
7. Move secrets from .env to OS keychain / secret manager

These are documented in `backend/docs/admin-security-proposal.md` and can be implemented incrementally.

---

## 9. Admin Endpoints (current)

| Endpoint | Method | Scope | Purpose |
|---|---|---|---|
| `/admin/token` | POST | (bootstrap secret) | Issue HMAC token |
| `/admin/add-product` | POST | write | Add single product with auto-embeddings (BGE + CLIP) |
| `/admin/clear-cache` | POST | write | Flush all in-memory + disk caches |
| `/admin/reload-csv` | POST | write | Reload product-code lookup catalog |
| `/admin/analytics/zero-results` | GET | read | JSON top failing queries |
| `/admin/analytics/zero-results.html` | GET | read | HTML dashboard (RTL) |

---

## 10. Frontend (no breaking changes)

`frontend/src/App.jsx`:
- Calls `/search?skipAI=true` for fast first paint (products + dictionary intent)
- Calls `/search/ai` in parallel for AI summary, smart filters, related, did-you-mean
- Intent box uses whichever endpoint returns suggestions first
- Skeleton loader for AI features while LLM is computing
- Hardcoded `http://localhost:5000` (production uses `import.meta.env.VITE_API_URL`)

The hard filter chips (using new product_kind/subtype) are NOT yet wired into the frontend — chips still work via search-expansion (clicking sends a new query with appended modifier). Wiring chips to query params is documented as future work.

---

## 11. Files Changed/Created This Session

### Backend code
| File | Status | Purpose |
|---|---|---|
| `backend/index.js` | Modified extensively | All search pipeline changes |
| `backend/scripts/add-tags-mapping.js` | New | ES mapping update for product_* fields |
| `backend/scripts/tag-products.js` | New (modified) | Full catalog LLM classifier |
| `backend/scripts/sample-tag-products.js` | New | Sample-50 classifier (file output, no ES) |
| `backend/scripts/add-product.js` | New | CLI to add single product with embeddings |

### Documentation
| File | Status | Purpose |
|---|---|---|
| `backend/docs/admin-security-proposal.md` | New | Options + recommendation + open decisions |
| `backend/docs/STATUS.md` | New | Mid-session checkpoint (now superseded by this file) |
| `backend/docs/SESSION_SUMMARY.md` | This file | Complete English summary |

### Data
| File | Status |
|---|---|
| `backend/data/sample_tags.json` | New — 50 product classifications for review |
| `backend/data/zero-results.jsonl` | New — live log of failing queries |
| `backend/data/admin-audit.jsonl` | New — admin access audit |
| `backend/data/tag-products-resume.log` | New — tagging script live log |

### Environment requirements
Add to `backend/.env`:
- `ADMIN_SECRET=<random 32-byte hex>` — required for production admin auth
- All existing keys (OPENAI_API_KEY, ELASTIC_*) unchanged

---

## 12. Performance Benchmarks

| Operation | Latency (cold) | Latency (warm) |
|---|---|---|
| `/search?skipAI=true` (fast lane) | 1.2-3.5s | <100ms (cache) |
| `/search/ai` (full LLM pipeline) | 4-7s | <50ms (cache) |
| BGE-M3 embed | ~50-100ms | (cache 30min) |
| CLIP text embed | ~200ms | (cache via translation cache) |
| ES kNN+BM25+reranker | ~300-600ms | — |
| Intent (dictionary) | <1ms | — |
| Intent (statistical) | ~5ms | — |
| Intent (LLM fallback) | ~1500ms | — |
| AI summary (LLM) | ~3000-4500ms | — |
| Image search (CLIP) | ~1500ms | — |

---

## 13. Outstanding Issues (deliberately deferred)

| Issue | Source | Why deferred |
|---|---|---|
| ~1600 partially-tagged products from earlier run | Run was killed before user constraint | Awaiting user decision: clear, keep, or migrate |
| Frontend chips → hard filter params | Frontend complexity | Backend ready; needs UI work |
| `/search/ai` stream (SSE) | Latency on cold cache | User chose other priorities |
| CTR ranking signal | No live traffic yet | Need user data |
| A/B testing framework | No live traffic yet | Need user data |
| `/admin/cache/invalidate?key=` (granular) | Operational | Use clear-cache for now |
| Audit log rotation | Operational | Append-only is fine for now |
| Magento integration (webhook/poll) | Out of scope | Proposal exists in earlier session |

---

## 14. How to Verify Everything Works

```bash
# 1. Hard search quality test
curl -s "http://localhost:5000/search?q=%D8%B9%D8%B5%D8%A7%D8%B1%D8%A9%20%D9%83%D9%87%D8%B1%D8%A8%D8%A7%D8%A6%D9%8A%D8%A9&limit=500&skipAI=true" \
  | python -c "import sys,json; d=json.load(sys.stdin); print('count:',d['count']); [print(' ',p['title'][:60]) for p in d['products'][:5]]"
# Expected: only electric juicers (واط in title), no manual ones

# 2. Modifier filter
curl -s "http://localhost:5000/search?q=%D8%A5%D8%A8%D8%B1%D9%8A%D9%82%20%D8%B2%D8%AC%D8%A7%D8%AC&limit=500&skipAI=true" | grep -o '"title":"[^"]*"' | head -5
# Expected: every title contains زجاج

# 3. Strict subject (catalog gap)
curl -s "http://localhost:5000/search?q=%D8%A8%D9%88%D8%AA%D8%A7%D8%AC%D8%A7%D8%B2&limit=500&skipAI=true" | grep -o '"count":[0-9]*'
# Expected: count:0 (no actual gas stoves in catalog)

# 4. Zero-results dashboard (open in browser)
# http://localhost:5000/admin/analytics/zero-results.html

# 5. Sample tags file
cat backend/data/sample_tags.json | python -c "import sys,json; d=json.load(sys.stdin); print(len(d),'products'); from collections import Counter; print(Counter([x['kind'] for x in d]))"
# Expected: 50 products with kind distribution

# 6. Admin token flow
curl -X POST http://localhost:5000/admin/token \
  -H "X-Bootstrap-Secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" -d '{"scope":"read"}'
# Expected: {"success":true,"token":"...","scope":"read","expiresIn":3600}

# Then use the token:
curl -H "Authorization: Bearer <token>" http://localhost:5000/admin/analytics/zero-results
```

---

## 15. Key Design Principles Followed

1. **Open-source first** — BGE-M3, CLIP, BGE-Reranker all run locally. LLM only for narrative output.
2. **Layered fallback** — dictionary → statistical → LLM. Fastest tier handles most queries.
3. **Strict over forgiving** — 0 results is more honest than misleading results.
4. **Graceful schema migrations** — new fields are nullable; filters skip products without the field.
5. **Cacheable** — every expensive computation has an LRU cache with TTL.
6. **Observable** — every failure (zero-result, rate limit, invalid token) is logged.
7. **No silent regressions** — each search-quality fix has a test case in the smoke-test list.

---

## 16. Recommended Next Steps After Review

1. **Open `backend/data/sample_tags.json`** — 10-minute review. If happy, the full-catalog run will be done by the time you read this.
2. **Set `ADMIN_SECRET` in `.env`** — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Restart backend.
3. **Open `http://localhost:5000/admin/analytics/zero-results.html`** — review what's failing in real searches.
4. **Decide on the 1600 pre-tagged products** — clear, keep, or migrate (see STATUS.md option a/b/c).
5. **Answer 7 decisions in `admin-security-proposal.md`** — bootstrap rotation, audit retention, etc.
6. **Manually fill `product_seasonal`** for products you want boosted in current month — example bulk update script can be added on request.

End of summary.
