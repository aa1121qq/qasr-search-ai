import { useState } from 'react'
import axios from 'axios'
import './RescueLab.css'

// 🚑 صفحة "إنقاذ الذكاء الصناعي": تكتب جملة، وتشوف وش يسوي الإنقاذ خطوة خطوة — بدون عرض المنتجات
const GATE_REASON = {
  outside_catalog: 'مو من أنواع منتجات المتجر',
  too_few_products: 'أقل من منتجين',
}

function RescueResult({ r }) {
  const [openJudge, setOpenJudge] = useState(null)
  return (
    <div className="rl-card">
      <div className="rl-card-head">
        <span className="rl-query">«{r.query}»</span>
        <span className="rl-meta">{(r.ms / 1000).toFixed(1)} ث · {r.model}</span>
      </div>

      <div className={`rl-verdict ${r.chosen ? 'ok' : 'none'}`}>
        {r.chosen
          ? <>✅ الإنقاذ يعرض: <b>«{r.chosen}»</b> — {r.acceptedCount} منتج مقبول</>
          : <>⛔ ما في إنقاذ — العميل يشوف صفحة "لم نجد نتائج"</>}
      </div>

      <ol className="rl-steps">
        <li>
          <div className="rl-step-title">البحث العادي</div>
          <div className="rl-step-body">
            {r.strictCount > 0
              ? <>الجملة نفسها تطابق {r.strictCount} منتج حرفياً — في الموقع الإنقاذ ما يشتغل إلا لو النتائج صفر.</>
              : <>ما في منتج يحتوي كل كلمات الجملة.</>}
          </div>
        </li>
        <li>
          <div className="rl-step-title">وش فهم الذكاء الصناعي</div>
          <div className="rl-step-body">
            اختار من {r.typesCount} نوع منتج في المتجر:{' '}
            {r.proposed.length
              ? r.proposed.map((t, i) => <span key={i} className="rl-chip">{t}</span>)
              : <span className="rl-muted">ولا نوع — ما لقى شي يلبّي الحاجة</span>}
          </div>
        </li>
        {r.gates.length > 0 && (
          <li>
            <div className="rl-step-title">التحقق من الاقتراحات</div>
            <div className="rl-step-body">
              {r.gates.map((g, i) => (
                <div key={i} className={`rl-gate ${g.ok ? 'ok' : 'bad'}`}>
                  {g.ok ? '✔' : '✖'} «{g.term}» —{' '}
                  {g.ok ? `${g.count} منتج` : (GATE_REASON[g.reason] || g.reason) + (g.count != null ? ` (${g.count})` : '')}
                </div>
              ))}
            </div>
          </li>
        )}
        {r.attempts.length > 0 && (
          <li>
            <div className="rl-step-title">فحص الصلة</div>
            <div className="rl-step-body">
              {r.attempts.map((a, i) => (
                <div key={i} className="rl-attempt">
                  <div>
                    «{a.term}»: {a.afterFilters} منتج مرشح ← الذكاء الصناعي قبل <b>{a.accepted}</b>
                    {a.judged.length < a.afterFilters && <span className="rl-muted"> (فحص أول {a.judged.length})</span>}
                    {a.judged.length > 0 && (
                      <button className="rl-link" onClick={() => setOpenJudge(openJudge === i ? null : i)}>
                        {openJudge === i ? 'إخفاء السبب' : 'ليش؟'}
                      </button>
                    )}
                  </div>
                  {openJudge === i && (
                    <ul className="rl-judged">
                      {a.judged.map((j, k) => (
                        <li key={k} className={j.accepted ? 'ok' : 'bad'}>{j.accepted ? '✔' : '✖'} {j.title}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </li>
        )}
      </ol>
    </div>
  )
}

export default function RescueLab({ apiUrl, modeSwitch }) {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState([])

  const run = async (e) => {
    e?.preventDefault()
    const q = text.trim()
    if (!q || loading) return
    setLoading(true)
    setError('')
    try {
      const res = await axios.get(`${apiUrl}/rescue/inspect`, { params: { q } })
      setResults(prev => [res.data, ...prev].slice(0, 20))
      setText('')
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app" dir="rtl">
      {modeSwitch}
      <div className="rl-page">
        <h1 className="rl-title">🚑 إنقاذ الذكاء الصناعي</h1>
        <p className="rl-sub">اكتب جملة وشوف وش يفهم منها الإنقاذ ووش يختار — بدون عرض المنتجات.</p>
        <form className="rl-form" onSubmit={run}>
          <input
            className="rl-input"
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="مثال: جهاز طارد الذباب"
            disabled={loading}
          />
          <button className="rl-btn" type="submit" disabled={loading || !text.trim()}>
            {loading ? 'جاري التحليل…' : 'حلّل'}
          </button>
        </form>
        {error && <div className="rl-error">صار خطأ: {error}</div>}
        {results.map((r, i) => <RescueResult key={`${r.query}-${results.length - i}`} r={r} />)}
      </div>
    </div>
  )
}
