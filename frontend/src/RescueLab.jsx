import { useState } from 'react'
import axios from 'axios'
import './RescueLab.css'

// 🚑 صفحة "إنقاذ الذكاء الصناعي": تكتب جملة، وتشوف وش يسوي الإنقاذ خطوة خطوة — بدون عرض المنتجات
const COMPARE_MODELS = ['gpt-5-nano', 'gpt-6-luna']

const GATE_REASON = {
  too_many_words: 'أكثر من 3 كلمات',
  outside_vocab: 'فيه كلمة مو من الكلمات المسموحة',
  too_short: 'كلمة وحدة قصيرة وعامة',
  too_few_products: 'أقل من منتجين',
}

function RescueResult({ r }) {
  const [openShown, setOpenShown] = useState(false)
  const [openNear, setOpenNear] = useState(false)
  const [openSpell, setOpenSpell] = useState(false)
  return (
    <div className="rl-card">
      <div className="rl-card-head">
        <span className="rl-query">«{r.query}»</span>
        <span className="rl-meta">
          <b className={r.live ? 'rl-live' : ''}>{r.model}</b>{r.live ? ' (البحث الحالي)' : ' (للمقارنة)'} · {(r.ms / 1000).toFixed(1)} ث
        </span>
      </div>

      <div className={`rl-verdict ${r.spell?.count > 0 || r.chosen ? 'ok' : 'none'}`}>
        {r.spell?.count > 0
          ? <>✍️ التصحيح الإملائي يكفي: يعرض <b>«{r.spell.to}»</b> — {r.spell.count} منتج</>
          : r.chosen
            ? <>✅ الإنقاذ يعرض: <b>«{r.chosen}»</b> — {r.shownCount} منتج</>
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
          <div className="rl-step-title">التصحيح الإملائي</div>
          <div className="rl-step-body">
            {r.spell?.to
              ? <>صحّحها الذكاء الصناعي إلى <span className="rl-chip">{r.spell.to}</span> — إعادة البحث جابت <b>{r.spell.count}</b> منتج
                  {r.spell.count > 0
                    ? <button className="rl-link" onClick={() => setOpenSpell(!openSpell)}>{openSpell ? 'إخفاء' : 'وش هي؟'}</button>
                    : <span className="rl-muted"> (صفر، فيكمل الإنقاذ على الجملة المصححة)</span>}
                  {openSpell && <ul className="rl-judged">{r.spell.shown.map((t, i) => <li key={i}>{t}</li>)}</ul>}</>
              : <span className="rl-muted">ما لقى خطأ إملائي — يكمل الإنقاذ على الجملة كما هي.</span>}
          </div>
        </li>
        {r.stop !== 'spell_found' && <>
        <li>
          <div className="rl-step-title">أقرب 30 منتج للجملة</div>
          <div className="rl-step-body">
            الإنقاذ يبدأ من المنتجات الأقرب للجملة، حتى لو ما لها علاقة.
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
            <div className="rl-step-title">وش اختار الذكاء الصناعي</div>
            <div className="rl-step-body">
              {r.proposed.length
                ? r.proposed.map((t, i) => <span key={i} className="rl-chip">{t}</span>)
                : <span className="rl-muted">ولا مصطلح</span>}
              {r.gates.map((g, i) => (
                <div key={i} className={`rl-gate ${g.ok ? 'ok' : 'bad'}`}>
                  {g.ok ? '✔' : '✖'} «{g.term}» —{' '}
                  {g.ok ? `${g.count} منتج` : (GATE_REASON[g.reason] || g.reason) + (g.count != null ? ` (${g.count})` : '')}
                </div>
              ))}
              {r.gates.filter(g => g.ok).length > 1 && <div className="rl-muted">يختار الأخص (الأكثر كلمات).</div>}
            </div>
          </li>
        )}
        {r.chosen && (
          <li>
            <div className="rl-step-title">وش ينعرض للعميل</div>
            <div className="rl-step-body">
              منتجات «{r.chosen}» اللي فيها كل كلمات المصطلح.
              <button className="rl-link" onClick={() => setOpenShown(!openShown)}>{openShown ? 'إخفاء' : 'وش هي؟'}</button>
              {openShown && <ul className="rl-judged">{r.shown.map((t, i) => <li key={i}>{t}</li>)}</ul>}
            </div>
          </li>
        )}
        </>}
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
      // نفس الجملة على الموديلين بالتوازي: الحالي (gpt-5-nano) ولونا للمقارنة
      const runs = await Promise.all(COMPARE_MODELS.map(model =>
        axios.get(`${apiUrl}/rescue/inspect`, { params: { q, model } })
          .then(res => res.data)
          .catch(err => ({ query: q, model, error: err.response?.data?.error || err.message }))
      ))
      setResults(prev => [{ query: q, runs }, ...prev].slice(0, 20))
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
            placeholder="مثال: مكاين سبرسو"
            disabled={loading}
          />
          <button className="rl-btn" type="submit" disabled={loading || !text.trim()}>
            {loading ? 'جاري التحليل…' : 'حلّل'}
          </button>
        </form>
        {error && <div className="rl-error">صار خطأ: {error}</div>}
        {results.map((g, i) => (
          <div key={`${g.query}-${results.length - i}`} className="rl-compare">
            {g.runs.map(r => r.error
              ? <div key={r.model} className="rl-card"><div className="rl-error">{r.model}: {r.error}</div></div>
              : <RescueResult key={r.model} r={r} />)}
          </div>
        ))}
      </div>
    </div>
  )
}
