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

const LEGACY_GATE_REASON = {
  too_many_words: 'أكثر من 3 كلمات',
  outside_vocab: 'فيه كلمة مو من الكلمات المسموحة',
  too_short: 'كلمة وحدة قصيرة وعامة',
  too_few_products: 'أقل من منتجين',
}

function LegacyResult({ r }) {
  const [openShown, setOpenShown] = useState(false)
  const [openNear, setOpenNear] = useState(false)
  return (
    <div className="rl-card">
      <div className="rl-card-head">
        <span className="rl-query">«{r.query}»</span>
        <span className="rl-meta">{(r.ms / 1000).toFixed(1)} ث · الطريقة الأصلية</span>
      </div>

      <div className={`rl-verdict ${r.chosen ? 'ok' : 'none'}`}>
        {r.chosen
          ? <>الإنقاذ الأصلي يعرض: <b>«{r.chosen}»</b> — {r.shownCount} منتج <span className="rl-muted">(بدون فحص صلة)</span></>
          : <>⛔ ما في إنقاذ — العميل يشوف صفحة "لم نجد نتائج"</>}
      </div>

      <ol className="rl-steps">
        <li>
          <div className="rl-step-title">البحث العادي</div>
          <div className="rl-step-body">
            {r.strictCount > 0
              ? <>الجملة نفسها تطابق {r.strictCount} منتج حرفياً.</>
              : <>ما في منتج يحتوي كل كلمات الجملة.</>}
          </div>
        </li>
        <li>
          <div className="rl-step-title">أقرب 30 منتج للجملة</div>
          <div className="rl-step-body">
            الإنقاذ الأصلي يبدأ من المنتجات الأقرب للجملة، حتى لو ما لها علاقة.
            <button className="rl-link" onClick={() => setOpenNear(!openNear)}>{openNear ? 'إخفاء' : 'أول 10'}</button>
            {openNear && <ul className="rl-judged">{r.neighbourhood.map((t, i) => <li key={i}>{t}</li>)}</ul>}
          </div>
        </li>
        <li>
          <div className="rl-step-title">الكلمات المسموحة ({r.vocab.length})</div>
          <div className="rl-step-body">
            {r.vocab.length
              ? r.vocab.map((w, i) => <span key={i} className="rl-chip rl-chip-sm">{w}</span>)
              : <span className="rl-muted">ولا كلمة</span>}
            {r.stop === 'vocab_too_small' && <div className="rl-gate bad">✖ أقل من 3 كلمات — يوقف هنا</div>}
          </div>
        </li>
        {r.stop !== 'vocab_too_small' && (
          <li>
            <div className="rl-step-title">وش ركّب الذكاء الصناعي</div>
            <div className="rl-step-body">
              {r.proposed.length
                ? r.proposed.map((t, i) => <span key={i} className="rl-chip">{t}</span>)
                : <span className="rl-muted">ولا مصطلح</span>}
              {r.gates.map((g, i) => (
                <div key={i} className={`rl-gate ${g.ok ? 'ok' : 'bad'}`}>
                  {g.ok ? '✔' : '✖'} «{g.term}» —{' '}
                  {g.ok ? `${g.count} منتج` : (LEGACY_GATE_REASON[g.reason] || g.reason) + (g.count != null ? ` (${g.count})` : '')}
                </div>
              ))}
              {r.gates.filter(g => g.ok).length > 1 && <div className="rl-muted">يختار الأطول (الأخص)، مو الأقرب.</div>}
            </div>
          </li>
        )}
        {r.chosen && (
          <li>
            <div className="rl-step-title">وش ينعرض للعميل</div>
            <div className="rl-step-body">
              كل منتجات «{r.chosen}» بعد فلتر الكلمات — ما في ذكاء صناعي يتأكد إنها تلبّي حاجة العميل.
              <button className="rl-link" onClick={() => setOpenShown(!openShown)}>{openShown ? 'إخفاء' : 'وش هي؟'}</button>
              {openShown && <ul className="rl-judged">{r.shown.map((t, i) => <li key={i}>{t}</li>)}</ul>}
            </div>
          </li>
        )}
      </ol>
    </div>
  )
}

export default function RescueLab({ apiUrl, modeSwitch }) {
  const [text, setText] = useState('')
  const [tab, setTab] = useState('current')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState({ current: [], legacy: [] })

  const run = async (e) => {
    e?.preventDefault()
    const q = text.trim()
    if (!q || loading) return
    setLoading(true)
    setError('')
    const which = tab
    try {
      const path = which === 'legacy' ? '/rescue/inspect-legacy' : '/rescue/inspect'
      const res = await axios.get(`${apiUrl}${path}`, { params: { q } })
      setResults(prev => ({ ...prev, [which]: [res.data, ...prev[which]].slice(0, 20) }))
      setText('')
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  const list = results[tab]

  return (
    <div className="app" dir="rtl">
      {modeSwitch}
      <div className="rl-page">
        <h1 className="rl-title">🚑 إنقاذ الذكاء الصناعي</h1>
        <p className="rl-sub">اكتب جملة وشوف وش يفهم منها الإنقاذ ووش يختار — بدون عرض المنتجات.</p>
        <div className="rl-tabs">
          <button className={`rl-tab ${tab === 'current' ? 'active' : ''}`} onClick={() => setTab('current')}>الإنقاذ الحالي</button>
          <button className={`rl-tab ${tab === 'legacy' ? 'active' : ''}`} onClick={() => setTab('legacy')}>الإنقاذ قبل التعديل</button>
        </div>
        {tab === 'legacy' && (
          <p className="rl-note">
            الطريقة الأصلية: تاخذ أقرب 30 منتج للجملة، تجمع أكثر كلماتها تكراراً، والذكاء الصناعي يركّب منها مصطلحاً، وتعرض منتجاته بدون فحص صلة. هذي نسخة للعرض بس، والموقع يستخدم الطريقة الحالية.
          </p>
        )}
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
        {list.map((r, i) => tab === 'legacy'
          ? <LegacyResult key={`l-${r.query}-${list.length - i}`} r={r} />
          : <RescueResult key={`c-${r.query}-${list.length - i}`} r={r} />)}
      </div>
    </div>
  )
}
