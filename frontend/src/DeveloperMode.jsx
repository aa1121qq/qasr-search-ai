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
                    Regex match against device-words list (fast path). Falls back to GPT-4o-mini JSON-mode if no match.
                    Output: <code>general</code> | <code>device</code>. Drives accessory exclusion + brand boost.
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
                    Catalog-anchored fuzzy matching. Compares query tokens against the 2,676-word product vocabulary.
                    Triggers only when no exact catalog match.
                  </div>
                </li>

                <li className={`dev-stage stage-${stageStatus(hasData)}`}>
                  <div className="dev-stage-head">
                    <span className="dev-stage-num">3</span>
                    <span className="dev-stage-name">Query Embedding</span>
                    <span className="dev-stage-info">1024-d · Ollama local</span>
                  </div>
                  <div className="dev-stage-desc">
                    Model: <code>bge-m3</code> via Ollama on the same VPS. Free (no API cost), &lt;100ms per query.
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
                    <span className="dev-stage-info">text → image</span>
                  </div>
                  <div className="dev-stage-desc">
                    Encodes the Arabic query to CLIP text embedding (512-d), boosts products whose image embedding is
                    visually close. Catches "looks like" matches a text-only search misses.
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
                    <span className="dev-stage-name">Accessory + Subject Filters</span>
                    {hasData && (
                      <span className="dev-stage-info">
                        {queryType === 'device' ? 'device mode ON' : 'subject only'}
                      </span>
                    )}
                  </div>
                  <div className="dev-stage-desc">
                    Device queries: drop titles starting with accessory keywords (وعاء, غطاء, يدوي, …).
                    Subject filter: stems Arabic suffixes (ات, ين, ون, ها, ية, ة, ه) and requires title match.
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
                    Four GPT-4o-mini calls in parallel: AI summary, intent (LLM fallback), smart filters, related searches.
                    Cached on disk + memory.
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
                    <li>OpenAI GPT-4o-mini — intent · filters · summaries · chat</li>
                    <li>Google Gemini Nano Banana 2 — composition image gen</li>
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
                  <tr><td>Image embedding</td><td><code>CLIP ViT-B/32</code> · 512-d</td><td>transformers.js</td></tr>
                  <tr><td>Text→Image search</td><td><code>CLIP text encoder</code></td><td>transformers.js</td></tr>
                  <tr><td>Re-ranking top 15</td><td><code>bge-reranker-base</code></td><td>transformers.js</td></tr>
                  <tr><td>Intent · filters · summary · chat</td><td><code>gpt-4o-mini</code></td><td>OpenAI</td></tr>
                  <tr><td>Composition image gen</td><td><code>gemini-3.1-flash-image-preview</code></td><td>Google</td></tr>
                </tbody>
              </table>

              <div className="dev-section-title" style={{ marginTop: '1rem' }}>Key Constants</div>
              <pre className="dev-code">{`MAX_PRODUCTS              = 22000
EMBEDDING_DIM             = 1024 (BGE-M3) · 512 (CLIP)
kNN_LIMIT                 = 500 (fetched) → top 30 (displayed)
RERANK_TOP                = 15
ACCESSORY_KEYWORDS        = [وعاء, سلة, غطاء, ..., يدوي, يدوية]
GENERIC_DEVICE_WORDS      = [ماكينة, آلة, جهاز, صانعة]  // stripped from subject
SPECIFIC_DEVICE_NAMES     = [ثلاجة, غسالة, فرن, ..., عصارة, مطحنة]  // kept
INTENT_DICTIONARY         = pre-built; LLM is fallback only`}</pre>
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
