import { useState } from 'react'

export default function DeveloperMode({ devInfo, loading, loadingAI, apiUrl }) {
  const [expanded, setExpanded] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [activeTab, setActiveTab] = useState('pipeline')

  const open = expanded || pinned

  const fastMs = devInfo?.fastDuration
  const aiMs = devInfo?.aiDuration
  const productsCount = devInfo?.productsCount ?? 0
  const brandsCount = devInfo?.brandsCount ?? 0
  const smartFiltersCount = devInfo?.smartFiltersCount ?? 0
  const relatedCount = devInfo?.relatedCount ?? 0
  const queryType = devInfo?.searchType || 'pending'
  const didYouMean = devInfo?.didYouMean
  const intentAmbiguous = devInfo?.intentAmbiguous
  const hasData = devInfo && devInfo.query

  const stageStatus = (done) => {
    if (loading && !done) return 'pending'
    if (done) return 'done'
    return 'idle'
  }

  const tabs = [
    { id: 'pipeline', label: '🔍 Pipeline' },
    { id: 'api', label: '📡 API' },
    { id: 'stack', label: '🚀 Stack' },
    { id: 'models', label: '⚙️ Models' },
  ]

  return (
    <div
      className={`dev-mode ${open ? 'dev-mode-open' : ''}`}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => !pinned && setExpanded(false)}
    >
      <button
        className="dev-mode-toggle"
        onClick={() => setPinned(!pinned)}
        title={pinned ? 'Unpin' : 'Pin open'}
      >
        <span className="dev-mode-icon">🔧</span>
        <span className="dev-mode-label">Developer Mode</span>
        {hasData && <span className="dev-mode-status">{queryType}</span>}
        <span className="dev-mode-chevron">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="dev-mode-panel" dir="ltr">
          <div className="dev-tabs">
            {tabs.map(t => (
              <button
                key={t.id}
                className={`dev-tab ${activeTab === t.id ? 'active' : ''}`}
                onClick={() => setActiveTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* === PIPELINE === */}
          {activeTab === 'pipeline' && (
            <div className="dev-section">
              <div className="dev-section-title">Search Pipeline — runs on every query</div>
              {!hasData ? (
                <div className="dev-empty">Run a search to see live stages with real numbers.</div>
              ) : null}
              <ol className="dev-stages">
                <li className={`dev-stage stage-${stageStatus(hasData)}`}>
                  <div className="dev-stage-head">
                    <span className="dev-stage-num">1</span>
                    <span className="dev-stage-name">Query Classification</span>
                    {hasData && <span className="dev-stage-info">type: <code>{queryType}</code></span>}
                  </div>
                  <div className="dev-stage-desc">
                    Regex match against device-words list (fast path). Falls back to GPT-4.1-nano JSON-mode if no match.
                    Output: <code>general</code> | <code>device</code> | <code>kitchenware</code>. Drives accessory
                    exclusion + brand boost.
                  </div>
                </li>

                <li className={`dev-stage stage-${stageStatus(hasData)}`}>
                  <div className="dev-stage-head">
                    <span className="dev-stage-num">2</span>
                    <span className="dev-stage-name">Typo Correction</span>
                    {hasData && (
                      <span className="dev-stage-info">
                        {didYouMean ? <>suggested: <code>{didYouMean}</code></> : 'no typo'}
                      </span>
                    )}
                  </div>
                  <div className="dev-stage-desc">
                    Catalog-anchored fuzzy matching against 2,676-word vocab. Levenshtein distance with edge-character
                    penalty: <code>+0.5</code> if first letter differs, <code>+0.3</code> if last letter differs (e.g.
                    "غسلة" → "غسّالة" not "سلة"). Skipped entirely when the original query already returns 5+ results,
                    preventing false positives like "غسالة → غلاية".
                  </div>
                </li>

                <li className={`dev-stage stage-${stageStatus(hasData)}`}>
                  <div className="dev-stage-head">
                    <span className="dev-stage-num">3</span>
                    <span className="dev-stage-name">Subject Extraction + Embedding</span>
                    <span className="dev-stage-info">1024-d · Ollama local</span>
                  </div>
                  <div className="dev-stage-desc">
                    Strips modifiers (colors, materials, generic device words, numbers + units) before embedding:
                    "خلاط احمر" → embeds as <code>خلاط</code>, "ماكينة قهوة" → <code>قهوة</code>. Prevents modifiers
                    from dominating the BGE-M3 vector. Model: <code>bge-m3</code> via Ollama (free, &lt;100ms).
                  </div>
                </li>

                <li className={`dev-stage stage-${stageStatus(hasData)}`}>
                  <div className="dev-stage-head">
                    <span className="dev-stage-num">4</span>
                    <span className="dev-stage-name">Elasticsearch kNN</span>
                    {hasData && <span className="dev-stage-info">returned <code>{productsCount}</code></span>}
                  </div>
                  <div className="dev-stage-desc">
                    Index <code>products_local</code>. Field <code>embedding</code> (dense_vector, 1024-d, cosine).
                    <code> k = limit</code>, <code>num_candidates = min(limit*2, 1000)</code>.
                  </div>
                </li>

                <li className={`dev-stage stage-${stageStatus(hasData)}`}>
                  <div className="dev-stage-head">
                    <span className="dev-stage-num">5</span>
                    <span className="dev-stage-name">CLIP Visual Re-rank</span>
                    <span className="dev-stage-info">dual: full + focused</span>
                  </div>
                  <div className="dev-stage-desc">
                    Translates the cleaned subject to English, encodes via CLIP text encoder (512-d), then runs a
                    dual kNN against both <code>clip_image_embedding</code> (full product image) and
                    <code> clip_image_embedding_focused</code> (center-crop blend). ES takes the higher match —
                    works whether the catalog image is studio or lifestyle.
                  </div>
                </li>

                <li className={`dev-stage stage-${stageStatus(hasData)}`}>
                  <div className="dev-stage-head">
                    <span className="dev-stage-num">6</span>
                    <span className="dev-stage-name">BGE-Reranker (top 15)</span>
                    <span className="dev-stage-info">cross-encoder</span>
                  </div>
                  <div className="dev-stage-desc">
                    Reorders the top-15 with a precision cross-encoder. Higher quality than the bi-encoder kNN alone.
                  </div>
                </li>

                <li className={`dev-stage stage-${stageStatus(hasData)}`}>
                  <div className="dev-stage-head">
                    <span className="dev-stage-num">7</span>
                    <span className="dev-stage-name">Smart Accessory + Subject Scoring</span>
                    {hasData && (
                      <span className="dev-stage-info">
                        {queryType === 'device' ? 'device mode ON' : 'subject scoring'}
                      </span>
                    )}
                  </div>
                  <div className="dev-stage-desc">
                    <strong>Intent-aware accessory filter:</strong> drops titles starting with accessory keywords
                    (وعاء, غطاء, شنطة, يدوي …) — UNLESS the query itself contains that keyword (e.g. "شنطة ترامس"
                    keeps thermos bags, "ترامس" excludes them).
                    <strong> Subject scoring (0-1):</strong> word-level stem equality (not substring) so "قلايز"
                    does not match "قلاي". Each product scored by what fraction of subject stems appear in its
                    title; perfect matches (1.0) come first, partial matches fill in. Alef variants
                    (آ/أ/إ) and the "ال" prefix are normalized so "ألة" = "آلة" = "الة" = "الآلة".
                  </div>
                </li>

                <li className={`dev-stage stage-${stageStatus(hasData)}`}>
                  <div className="dev-stage-head">
                    <span className="dev-stage-num">8</span>
                    <span className="dev-stage-name">Brand Extraction</span>
                    {hasData && <span className="dev-stage-info">found <code>{brandsCount}</code></span>}
                  </div>
                  <div className="dev-stage-desc">
                    Counts brands from top-50 kNN results. Minimum 2 occurrences. Powers the filter chips.
                  </div>
                </li>

                <li className={`dev-stage stage-${stageStatus(!loading)}`}>
                  <div className="dev-stage-head">
                    <span className="dev-stage-num">9</span>
                    <span className="dev-stage-name">Fast Response</span>
                    {fastMs != null && <span className="dev-stage-info"><code>{fastMs}ms</code></span>}
                  </div>
                  <div className="dev-stage-desc">
                    Products + brands + intent (from dictionary) return immediately. Frontend renders the grid.
                  </div>
                </li>

                <li className={`dev-stage stage-${stageStatus(!loadingAI && aiMs != null)}`}>
                  <div className="dev-stage-head">
                    <span className="dev-stage-num">10</span>
                    <span className="dev-stage-name">AI Features (parallel)</span>
                    {aiMs != null && (
                      <span className="dev-stage-info">
                        <code>{aiMs}ms</code> · {smartFiltersCount} filters · {relatedCount} related
                      </span>
                    )}
                  </div>
                  <div className="dev-stage-desc">
                    Four GPT-4.1-nano calls in parallel: AI summary, intent (LLM fallback), smart filters, related
                    searches.
                    <strong> Every intent suggestion is validated against the catalog</strong> via a quick ES count
                    (fuzziness 0, AND operator); suggestions with &lt;3 real products are dropped, and the whole chip
                    row is hidden if fewer than 2 valid options remain. AI Summary recommendations are pre-filtered
                    by subject-match score so the LLM only picks from on-topic products. Cached on disk + memory
                    (24h TTL).
                  </div>
                </li>
              </ol>
            </div>
          )}

          {/* === API === */}
          {activeTab === 'api' && (
            <div className="dev-section">
              <div className="dev-section-title">REST API — base URL: <code>{apiUrl}</code></div>

              <div className="dev-endpoint">
                <div className="dev-endpoint-head"><span className="method get">GET</span> <code>/search</code></div>
                <div className="dev-endpoint-desc">Main product search. Returns products + brands + intent.</div>
                <pre className="dev-code">{`GET /search?q=عصارة&limit=500&skipAI=true&skipIntent=false

Response:
{
  "products": [ { id, mpn, title, price, sale_price, image_link, link, brand, color, size } ],
  "searchType": "device" | "general",
  "filters": { "brands": [...] },
  "intent": { "isAmbiguous": bool, "suggestions": [...] }
}`}</pre>
              </div>

              <div className="dev-endpoint">
                <div className="dev-endpoint-head"><span className="method get">GET</span> <code>/search/ai</code></div>
                <div className="dev-endpoint-desc">AI enrichment (intent · summary · smart filters · related).</div>
                <pre className="dev-code">{`GET /search/ai?q=عصارة&skipIntent=false

Response:
{
  "aiSummary": { "summary", "recommendations", "totalProducts", "priceRange", "topBrands" },
  "intent":    { "isAmbiguous", "message", "suggestions": [...] },
  "filters":   { "sizes": [...], "thirdOptions": [...] },
  "relatedSearches": [...],
  "didYouMean": "..." | null
}`}</pre>
              </div>

              <div className="dev-endpoint">
                <div className="dev-endpoint-head"><span className="method get">GET</span> <code>/suggest</code></div>
                <div className="dev-endpoint-desc">Autocomplete from 8,308 catalog phrases. Debounce 120ms client-side.</div>
                <pre className="dev-code">{`GET /suggest?q=قه&limit=8 → { "suggestions": ["قهوة", "قهوة عربية", ...] }`}</pre>
              </div>

              <div className="dev-endpoint">
                <div className="dev-endpoint-head"><span className="method post">POST</span> <code>/chat</code></div>
                <div className="dev-endpoint-desc">Conversational assistant. Returns reply + quickReplies + suggestedProduct.</div>
                <pre className="dev-code">{`POST /chat  { "message": "أبي ترامس", "history": [...last 6 turns...] }
→ { "reply", "quickReplies": [...], "suggestedProduct": { ...productObj } }`}</pre>
              </div>

              <div className="dev-endpoint">
                <div className="dev-endpoint-head"><span className="method post">POST</span> <code>/image-search</code></div>
                <div className="dev-endpoint-desc">Visual similarity search. CLIP embedding of uploaded image → kNN on image vectors.</div>
                <pre className="dev-code">{`POST /image-search  multipart/form-data { "image": <file> }
→ { "products": [...visually similar products] }`}</pre>
              </div>

              <div className="dev-endpoint">
                <div className="dev-endpoint-head"><span className="method post">POST</span> <code>/tansiq-compose</code></div>
                <div className="dev-endpoint-desc">Generates a styled scene image from selected products using Gemini Nano Banana 2.</div>
                <pre className="dev-code">{`POST /tansiq-compose  { "products": [ {title, image_link}, ... up to 3 ] }
→ { "success": true, "imageUrl": "data:image/jpeg;base64,...", "model": "gemini-3.1-flash-image-preview" }`}</pre>
              </div>

              <div className="dev-endpoint">
                <div className="dev-endpoint-head"><span className="method post">POST</span> <code>/track/click</code></div>
                <div className="dev-endpoint-desc">Analytics — fire on product card click. No auth.</div>
                <pre className="dev-code">{`POST /track/click  { "query", "productId", "title", "position" }`}</pre>
              </div>

              <div className="dev-endpoint admin">
                <div className="dev-endpoint-head"><span className="method get">GET</span> <code>/admin/dashboard</code> <span className="auth-tag">requires login</span></div>
                <div className="dev-endpoint-desc">Analytics dashboard UI. Login via <code>/admin/dashboard/login</code> (POST). Returns admin key used in subsequent <code>X-Admin-Key</code> header.</div>
              </div>
            </div>
          )}

          {/* === STACK === */}
          {activeTab === 'stack' && (
            <div className="dev-section">
              <div className="dev-section-title">Tech Stack</div>
              <div className="dev-stack">
                <div className="dev-stack-group">
                  <div className="dev-stack-heading">Backend</div>
                  <ul>
                    <li>Node.js 20 + Express</li>
                    <li>Elasticsearch Cloud — vector store (9,299 products)</li>
                    <li>Ollama + BGE-M3 — local text embeddings (1024-d)</li>
                    <li>@xenova/transformers — CLIP (text + image, 512-d)</li>
                    <li>@xenova/transformers — BGE-Reranker (cross-encoder)</li>
                    <li>OpenAI GPT-4.1-nano — intent · filters · summaries · chat</li>
                    <li>Google Gemini Nano Banana 2 — composition image gen</li>
                    <li>Sharp — center-crop image processing for focused embeddings</li>
                    <li>dotenv · cors · axios · @google/genai · openai · multer</li>
                  </ul>
                </div>
                <div className="dev-stack-group">
                  <div className="dev-stack-heading">Frontend</div>
                  <ul>
                    <li>React 18 + Vite</li>
                    <li>Axios — parallel fast + AI requests</li>
                    <li>No state library (useState/useRef only)</li>
                    <li>RTL Arabic UI · Tailwind-free pure CSS</li>
                  </ul>
                </div>
                <div className="dev-stack-group">
                  <div className="dev-stack-heading">Infrastructure</div>
                  <ul>
                    <li>Hetzner Cloud CPX22 — 2 vCPU AMD · 4GB RAM · 80GB SSD</li>
                    <li>Ubuntu 24.04 · PM2 cluster mode · auto-restart</li>
                    <li>Caddy + Let's Encrypt — auto HTTPS via sslip.io wildcard DNS</li>
                    <li>Vercel — frontend hosting · auto-deploy on git push</li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* === MODELS === */}
          {activeTab === 'models' && (
            <div className="dev-section">
              <div className="dev-section-title">Models & Configuration</div>
              <table className="dev-table">
                <thead>
                  <tr><th>Purpose</th><th>Model</th><th>Provider</th></tr>
                </thead>
                <tbody>
                  <tr><td>Text embedding (query + index)</td><td><code>bge-m3</code> · 1024-d</td><td>Ollama (self-host)</td></tr>
                  <tr><td>Image embedding (full)</td><td><code>CLIP ViT-B/32</code> · 512-d</td><td>transformers.js</td></tr>
                  <tr><td>Image embedding (focused)</td><td><code>CLIP ViT-B/32</code> · 512-d, center-crop 60%</td><td>transformers.js + sharp</td></tr>
                  <tr><td>Text→Image search</td><td><code>CLIP text encoder</code></td><td>transformers.js</td></tr>
                  <tr><td>Re-ranking top 15</td><td><code>bge-reranker-base</code></td><td>transformers.js</td></tr>
                  <tr><td>Intent · filters · summary · chat</td><td><code>gpt-4.1-nano</code></td><td>OpenAI</td></tr>
                  <tr><td>Composition image gen</td><td><code>gemini-3.1-flash-image-preview</code></td><td>Google (Nano Banana 2)</td></tr>
                </tbody>
              </table>

              <div className="dev-section-title" style={{ marginTop: '1rem' }}>Key Constants & Algorithms</div>
              <pre className="dev-code">{`MAX_PRODUCTS              = 22000
EMBEDDING_DIM             = 1024 (BGE-M3) · 512 (CLIP)
kNN_LIMIT                 = 500 (fetched) → top 30 (displayed)
RERANK_TOP                = 15
TYPO_SKIP_THRESHOLD       = 5  // skip typo correction if original ≥ 5 results
TYPO_EDGE_PENALTY         = first-char +0.5 · last-char +0.3
SUBJECT_MATCH_STRATEGY    = word-level stem equality (not substring)
                            "قلايز" ≠ "قلاي"; "ألة" = "آلة" = "الة"

INTENT_VALIDATION         = every chip query runs a quick ES count;
                            < 3 catalog matches → dropped;
                            < 2 remaining chips → entire row hidden
INTENT_PROMPT             = axis-based methodology + negative few-shots
                            forbids mixed-axis or paraphrased suggestions

AI_SUMMARY_PREFILTER      = recommendations pool restricted to products
                            with subject score ≥ 0.5 (perfect first)
RELATED_VALIDATION        = each suggestion checked against catalogVocab
                            (2,676 unique stems) + length & stop-word caps

ACCESSORY_KEYWORDS        = [وعاء, سلة, غطاء, شنطة, يدوي, …]
  └─ intent-aware: skipped when query itself contains the keyword
GENERIC_DEVICE_WORDS      = [ماكينة, آلة, جهاز, صانعة]  // stripped from subject
SPECIFIC_DEVICE_NAMES     = [ثلاجة, غسالة, فرن, عصارة, مطحنة, …]  // kept
SUBJECT_MODIFIERS         = colors + materials + size adjectives  // stripped before embedding
INTENT_DICTIONARY         = pre-built; LLM is fallback only

IMAGE_SEARCH_BLEND        = 0.35 * full + 0.65 * focused (L2-normalized)
CACHE_TTL                 = 24h response · in-memory LRU 5000 entries
CADDY_TIMEOUT             = 300s (for Nano Banana image generation)`}</pre>
            </div>
          )}

          <div className="dev-footer">
            {pinned ? '📌 pinned — click toggle to unpin' : 'hover to keep open · click to pin'}
          </div>
        </div>
      )}
    </div>
  )
}
