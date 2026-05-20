import { useState } from 'react'

export default function TansiqDevMode({
  apiUrl,
  selectedCount = 0,
  composing = false,
  composedImage,
  composedModel,
  composeDuration,
  flowName = 'Multi-row Tansiq',
}) {
  const [expanded, setExpanded] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [activeTab, setActiveTab] = useState('pipeline')

  const open = expanded || pinned
  const hasCompose = !!composedImage
  const composeFailed = !composing && composedModel === null && selectedCount > 0 && !hasCompose

  const tabs = [
    { id: 'pipeline', label: '🎨 Compose Pipeline' },
    { id: 'api', label: '📡 API' },
    { id: 'models', label: '⚙️ Image Models' },
    { id: 'stack', label: '🚀 Stack' },
  ]

  const stageStatus = (done, active = false) => {
    if (active) return 'pending'
    if (done) return 'done'
    return 'idle'
  }

  // Stage state derivations
  const s1_done = selectedCount > 0
  const s2_done = selectedCount >= 1
  const s3_active = composing
  const s3_done = hasCompose || composeFailed
  const s4_active = composing
  const s4_done = hasCompose || composeFailed
  const s5_done = hasCompose
  const s5_failed = composeFailed
  const s6_done = hasCompose

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
        <span className="dev-mode-label">Developer Mode — Tansiq</span>
        {hasCompose && composedModel && (
          <span className="dev-mode-status">{composedModel.split(' ')[0]}</span>
        )}
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
              <div className="dev-section-title">
                {flowName} — from product selection to final image
              </div>

              <ol className="dev-stages">
                <li className={`dev-stage stage-${stageStatus(s1_done)}`}>
                  <div className="dev-stage-head">
                    <span className="dev-stage-num">1</span>
                    <span className="dev-stage-name">Product Search (per row)</span>
                    {s1_done && <span className="dev-stage-info">via <code>/search</code></span>}
                  </div>
                  <div className="dev-stage-desc">
                    Each row queries the same semantic search pipeline used in Search project:
                    Ollama BGE-M3 query embedding → Elasticsearch kNN (1024-d cosine) → CLIP visual re-rank
                    → BGE-Reranker → accessory + subject filters. Returns up to 30 products per row.
                  </div>
                </li>

                <li className={`dev-stage stage-${stageStatus(s2_done)}`}>
                  <div className="dev-stage-head">
                    <span className="dev-stage-num">2</span>
                    <span className="dev-stage-name">User Selection</span>
                    <span className="dev-stage-info">
                      <code>{selectedCount}</code> / 3 products
                    </span>
                  </div>
                  <div className="dev-stage-desc">
                    Drag &amp; drop or tap-to-select adds products to the composition tray (max 3).
                    Each picked item carries <code>title</code>, <code>image_link</code>, <code>color</code>, <code>size</code>.
                    These are the inputs to Gemini.
                  </div>
                </li>

                <li className={`dev-stage stage-${stageStatus(s3_done, s3_active)}`}>
                  <div className="dev-stage-head">
                    <span className="dev-stage-num">3</span>
                    <span className="dev-stage-name">Image Fetch &amp; Base64 Encoding</span>
                    {s3_active && <span className="dev-stage-info">in progress…</span>}
                    {s3_done && !composeFailed && <span className="dev-stage-info">✓ uploaded</span>}
                  </div>
                  <div className="dev-stage-desc">
                    Backend (<code>fetchImageAsBase64</code>) downloads each product's image from the catalog CDN
                    and encodes it as base64 with proper MIME type. This becomes <code>inlineData</code> on the
                    Gemini request — the actual pixels of your real products.
                  </div>
                </li>

                <li className={`dev-stage stage-${stageStatus(s4_done, s4_active)}`}>
                  <div className="dev-stage-head">
                    <span className="dev-stage-num">4</span>
                    <span className="dev-stage-name">Prompt Construction (strict rules)</span>
                  </div>
                  <div className="dev-stage-desc">
                    A long structured prompt is sent alongside the images with hard constraints:
                    <strong> preserve exact colors</strong> · <strong>preserve product shape &amp; logos</strong> ·
                    <strong> realistic relative sizes</strong> (a thermos ≫ a cup) · <strong>single camera angle</strong>
                    · <strong>no invented products</strong>. Plus scene direction (Saudi majlis · marble · warm light).
                  </div>
                </li>

                <li className={`dev-stage stage-${s5_failed ? 'failed' : stageStatus(s5_done, composing)}`}>
                  <div className="dev-stage-head">
                    <span className="dev-stage-num">5</span>
                    <span className="dev-stage-name">AI Image Generation</span>
                    {composing && <span className="dev-stage-info">generating… (~25s)</span>}
                    {s5_done && (
                      <span className="dev-stage-info">
                        {composedModel ? <code>{composedModel}</code> : null}
                        {composeDuration != null && <> · <code>{(composeDuration / 1000).toFixed(1)}s</code></>}
                      </span>
                    )}
                  </div>
                  <div className="dev-stage-desc">
                    Primary model: <code>gemini-3.1-flash-image-preview</code> (Nano Banana 2) — accepts real product
                    images as input and preserves their appearance. Fallback chain on failure:
                    OpenAI <code>gpt-image-1</code> → <code>dall-e-3</code> → <code>dall-e-2</code> (text-only, won't preserve real products).
                  </div>
                </li>

                <li className={`dev-stage stage-${stageStatus(s6_done)}`}>
                  <div className="dev-stage-head">
                    <span className="dev-stage-num">6</span>
                    <span className="dev-stage-name">Display + Add to Cart</span>
                    {s6_done && <span className="dev-stage-info">✓ rendered</span>}
                  </div>
                  <div className="dev-stage-desc">
                    Response returns a <code>data:image/jpeg;base64,...</code> URL the browser renders inline.
                    A model badge shows which engine generated it. User can save the image or add the underlying
                    products to cart in one click.
                  </div>
                </li>
              </ol>
            </div>
          )}

          {/* === API === */}
          {activeTab === 'api' && (
            <div className="dev-section">
              <div className="dev-section-title">Tansiq REST API — base: <code>{apiUrl}</code></div>

              <div className="dev-endpoint">
                <div className="dev-endpoint-head"><span className="method post">POST</span> <code>/tansiq</code></div>
                <div className="dev-endpoint-desc">Search products for a single composition row.</div>
                <pre className="dev-code">{`POST /tansiq  { "q": "ترامس" }

Response:
{
  "success": true,
  "products": [ { id, mpn, title, price, image_link, color, size, ... } ]
}`}</pre>
              </div>

              <div className="dev-endpoint">
                <div className="dev-endpoint-head"><span className="method post">POST</span> <code>/tansiq-compose</code></div>
                <div className="dev-endpoint-desc">
                  Generates the composed scene image. Takes up to 3 products. Long-running request (~25s with Nano
                  Banana 2). Backend timeout is 300s.
                </div>
                <pre className="dev-code">{`POST /tansiq-compose
{
  "products": [
    { "title": "طقم ترامس ميرا", "image_link": "https://qasralawani.com/...jpg", "color": "ذهبي", "size": "1L" },
    { "title": "...", "image_link": "...", "color": "...", "size": "..." }
  ]
}

Response (success):
{
  "success": true,
  "imageUrl": "data:image/jpeg;base64,/9j/4AAQ...",
  "model": "gemini-3.1-flash-image-preview (Nano Banana Flash 3.1)"
}

Response (all models failed):
{ "success": false, "message": "Image generation failed", "errors": [...] }`}</pre>
              </div>

              <div className="dev-endpoint">
                <div className="dev-endpoint-head"><span className="method post">POST</span> <code>/track/tansiq</code></div>
                <div className="dev-endpoint-desc">Analytics event when a composition is created. No auth.</div>
                <pre className="dev-code">{`POST /track/tansiq  { "products": [{id, title}], "model": "gemini-3.1-flash-image-preview" }`}</pre>
              </div>
            </div>
          )}

          {/* === MODELS === */}
          {activeTab === 'models' && (
            <div className="dev-section">
              <div className="dev-section-title">Image Generation Models</div>
              <table className="dev-table">
                <thead>
                  <tr><th>Model</th><th>Role</th><th>Accepts product images?</th><th>Typical latency</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td><code>gemini-3.1-flash-image-preview</code><br /><span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>Nano Banana 2 — current</span></td>
                    <td>Primary</td>
                    <td>✅ Yes — preserves real product appearance</td>
                    <td>~20-30s</td>
                  </tr>
                  <tr>
                    <td><code>gemini-3-pro-image-preview</code><br /><span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>Nano Banana Pro</span></td>
                    <td>Optional (highest quality)</td>
                    <td>✅ Yes</td>
                    <td>~60-150s</td>
                  </tr>
                  <tr>
                    <td><code>gpt-image-1</code></td>
                    <td>Fallback #1</td>
                    <td>❌ No — text-only, generates lookalikes</td>
                    <td>~15-25s</td>
                  </tr>
                  <tr>
                    <td><code>dall-e-3</code></td>
                    <td>Fallback #2</td>
                    <td>❌ No</td>
                    <td>~15-25s</td>
                  </tr>
                  <tr>
                    <td><code>dall-e-2</code></td>
                    <td>Fallback #3</td>
                    <td>❌ No</td>
                    <td>~10s</td>
                  </tr>
                </tbody>
              </table>

              <div className="dev-section-title" style={{ marginTop: '1rem' }}>Prompt rules sent to Gemini</div>
              <pre className="dev-code">{`✓ Pixel-accurate copy of source product (color, shape, logo, label)
✓ Realistic relative sizes (thermos ≫ cup, tray ≫ items on it)
✓ Single camera angle & focal length for all products
✓ Build scene AROUND unchanged products (no overlap, no covering)
✓ Saudi/Arabian majlis aesthetic · marble or wood surface · warm light
✗ Do NOT recolor, retexture, or restyle any product
✗ Do NOT add, remove, or modify any handle, lid, decoration
✗ Do NOT invent new products beyond the inputs
✗ Do NOT enlarge small accessories to make them prominent
✗ No people, no text overlays added by the model`}</pre>
            </div>
          )}

          {/* === STACK === */}
          {activeTab === 'stack' && (
            <div className="dev-section">
              <div className="dev-section-title">Tansiq Tech Stack</div>
              <div className="dev-stack">
                <div className="dev-stack-group">
                  <div className="dev-stack-heading">AI Models</div>
                  <ul>
                    <li>Google Gemini Nano Banana 2 — primary</li>
                    <li>OpenAI gpt-image-1 / dall-e-3 / dall-e-2 — fallbacks</li>
                  </ul>
                </div>
                <div className="dev-stack-group">
                  <div className="dev-stack-heading">Backend</div>
                  <ul>
                    <li>Node.js Express endpoint <code>/tansiq-compose</code></li>
                    <li><code>@google/genai</code> SDK</li>
                    <li><code>openai</code> SDK</li>
                    <li>Native fetch + base64 image encoding</li>
                  </ul>
                </div>
                <div className="dev-stack-group">
                  <div className="dev-stack-heading">Frontend</div>
                  <ul>
                    <li>React 18 + Vite · Axios POST (no timeout)</li>
                    <li>Drag &amp; drop API · flyToDropZone animation</li>
                    <li>Inline base64 image render · download link</li>
                  </ul>
                </div>
                <div className="dev-stack-group">
                  <div className="dev-stack-heading">Infrastructure</div>
                  <ul>
                    <li>Caddy reverse proxy (300s timeout for long generation)</li>
                    <li>Hetzner Cloud CPX22 — Ubuntu · PM2</li>
                    <li>HTTPS via Let's Encrypt + sslip.io</li>
                  </ul>
                </div>
              </div>
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
