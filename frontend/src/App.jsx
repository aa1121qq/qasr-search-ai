import { useState, useRef, useEffect } from 'react'
import axios from 'axios'
import './App.css'
import DeveloperMode from './DeveloperMode.jsx'
import TansiqDevMode from './TansiqDevMode.jsx'
import ImageCropper from './ImageCropper.jsx'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'

const INITIAL_COUNT = 30
const LOAD_MORE_COUNT = 30
const BRANDS_AFTER = 8
const SIZES_AFTER = 16
const THIRD_AFTER = 24
const RELATED_AFTER = 32

// منتج ثابت في مشروع تنسيقات صفحة المنتج
const LOCKED_PRODUCT = {
  id: 'TL-RGB02-08',
  mpn: 'TL-RGB02-08',
  title: 'ترمس اينور من تافولو بسعة 1 لتر باللون الذهبي المطفي بيد خشبي',
  color: 'برتقالي',
  size: '1 لتر',
  price: '74',
  originalPrice: '149',
  hasDiscount: true,
  discountPercentage: 50,
  brand: 'تافولو',
  link: 'product/tavolo-enor-thermos-1l-matte-gold-with-wooden-handle-p-tl-rgb02-08',
  image_link: 'https://imgs.qasralawani.net/media/catalog/product/t/l/tl-rbg02-08_1_.jpg',
  locked: true,
}

// 🪄 انميشن: تطير صورة المنتج من البطاقة إلى الصندوق
function flyToDropZone(sourceEvent, dropZoneSelector, onComplete) {
  const card = sourceEvent.currentTarget.closest('.tansiq-card, .page-tansiq-mini-card')
  const img = card?.querySelector('img')
  const dropZone = document.querySelector(dropZoneSelector)
  if (!img || !dropZone) { onComplete(); return }

  const sourceRect = img.getBoundingClientRect()
  const targetRect = dropZone.getBoundingClientRect()

  const clone = img.cloneNode(true)
  Object.assign(clone.style, {
    position: 'fixed',
    left: `${sourceRect.left}px`,
    top: `${sourceRect.top}px`,
    width: `${sourceRect.width}px`,
    height: `${sourceRect.height}px`,
    margin: '0',
    padding: '0',
    zIndex: '9999',
    pointerEvents: 'none',
    borderRadius: '12px',
    boxShadow: '0 14px 36px rgba(102, 126, 234, 0.5)',
    transition: 'all 0.55s cubic-bezier(0.4, 0, 0.2, 1)',
    objectFit: 'contain',
    background: '#FAF9FE',
  })
  document.body.appendChild(clone)

  // force reflow ثم تشغيل الانميشن
  void clone.offsetHeight
  requestAnimationFrame(() => {
    const targetX = targetRect.left + targetRect.width / 2 - 28
    const targetY = targetRect.top + 18
    Object.assign(clone.style, {
      left: `${targetX}px`,
      top: `${targetY}px`,
      width: '56px',
      height: '56px',
      opacity: '0.4',
      transform: 'scale(0.85) rotate(-6deg)',
    })
  })

  setTimeout(() => {
    clone.remove()
    onComplete()
  }, 550)
}

// كلمات الملحقات للتحقق في الفرونت أيضاً
const ACCESSORY_KEYWORDS = [
  'وعاء', 'سلة', 'غطاء', 'كيس', 'فلتر', 'ملحق', 'قطعة غيار',
  'حشوة', 'مخلب', 'ملعقة', 'مقشطة', 'فرشاة', 'سن', 'شفرة',
  'ورق', 'بطانة', 'حامل', 'سدادة', 'صينية', 'رف داخلي',
  'يدوي', 'يدوية', 'يدويه',
]

function App() {
  const [query, setQuery] = useState('')
  const [autocomplete, setAutocomplete] = useState([])
  const [showAutocomplete, setShowAutocomplete] = useState(false)
  const autocompleteTimerRef = useRef(null)
  const [allProducts, setAllProducts] = useState([])
  const [searchType, setSearchType] = useState('general')
  const [displayCount, setDisplayCount] = useState(INITIAL_COUNT)
  const [aiSummary, setAiSummary] = useState(null)
  const [intent, setIntent] = useState(null)
  const [filters, setFilters] = useState({ brands: [], sizes: [], sizesTitle: '', thirdOptions: [], thirdTitle: '' })
  const [relatedSearches, setRelatedSearches] = useState([])
  const [didYouMean, setDidYouMean] = useState(null)
  const [activeBrand, setActiveBrand] = useState(null)
  const [activeSize, setActiveSize] = useState(null)
  const [activeThird, setActiveThird] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [hasSearched, setHasSearched] = useState(false)
  
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState([
    {
      role: 'assistant',
      content: { 
        reply: '👋 مرحباً! أنا مساعدك الذكي في قصر الأواني. اسألني عن أي منتج وأنا أساعدك تختار الأفضل!',
        quickReplies: ['أبي ماكينة قهوة', 'أبي ثلاجة', 'هدية للأم'],
        suggestedProduct: null
      }
    }
  ])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const chatBodyRef = useRef(null)

  const [imageLoading, setImageLoading] = useState(false)
  const [loadingAI, setLoadingAI] = useState(false)
  const fileInputRef = useRef(null)

  // 🎯 Image cropper modal — يظهر بعد رفع صورة
  const [cropperImage, setCropperImage] = useState(null)

  // 🔧 Developer Mode — tracks live pipeline data for the most recent search
  const [devInfo, setDevInfo] = useState(null)

  // 🔧 Tansiq compose timing
  const [tansiqComposeDuration, setTansiqComposeDuration] = useState(null)
  const [pageTansiqComposeDuration, setPageTansiqComposeDuration] = useState(null)

  // Mode switch (الصفحة الافتراضية = تنسيقات السريع AI)
  const [mode, setMode] = useState('page-tansiq') // 'search' | 'tansiq' | 'page-tansiq'

  // Tansiq state: 3 independent rows, each with its own query + products
  const [tansiqRows, setTansiqRows] = useState([
    { id: 1, query: '', products: [], loading: false, hasSearched: false, error: '' },
    { id: 2, query: '', products: [], loading: false, hasSearched: false, error: '' },
    { id: 3, query: '', products: [], loading: false, hasSearched: false, error: '' },
  ])
  const [tansiqSelected, setTansiqSelected] = useState([])
  const [tansiqComposing, setTansiqComposing] = useState(false)
  const [tansiqComposedImage, setTansiqComposedImage] = useState(null)
  const [tansiqComposedModel, setTansiqComposedModel] = useState(null)
  const [tansiqError, setTansiqError] = useState('')

  // مشروع تنسيقات صفحة المنتج state
  const [pageTansiqExpanded, setPageTansiqExpanded] = useState(false)
  const [pageTansiqRows, setPageTansiqRows] = useState([
    { id: 1, label: 'بيالات وفناجين', queries: ['بيالات', 'فناجيل'], allProducts: [], selectedColor: null, loading: false, hasFetched: false, error: '' },
    { id: 2, label: 'طوفرية', queries: ['طوفرية'], allProducts: [], selectedColor: null, loading: false, hasFetched: false, error: '' },
  ])
  const [pageTansiqSelected, setPageTansiqSelected] = useState([])
  const [pageTansiqComposing, setPageTansiqComposing] = useState(false)
  const [pageTansiqComposedImage, setPageTansiqComposedImage] = useState(null)
  const [pageTansiqComposedModel, setPageTansiqComposedModel] = useState(null)
  const [pageTansiqError, setPageTansiqError] = useState('')

  useEffect(() => {
    if (chatBodyRef.current) {
      chatBodyRef.current.scrollTop = chatBodyRef.current.scrollHeight
    }
  }, [chatMessages])

  // 🔍 Autocomplete handler — يُنفّذ مع debounce 120ms من الحرف الثاني
  const handleQueryChange = (e) => {
    const v = e.target.value
    setQuery(v)
    if (autocompleteTimerRef.current) clearTimeout(autocompleteTimerRef.current)
    if (v.trim().length < 2) {
      setAutocomplete([])
      setShowAutocomplete(false)
      return
    }
    autocompleteTimerRef.current = setTimeout(async () => {
      try {
        const r = await axios.get(`${API_URL}/suggest`, { params: { q: v, limit: 8 } })
        const list = r.data?.suggestions || []
        setAutocomplete(list)
        setShowAutocomplete(list.length > 0)
      } catch { /* silent */ }
    }, 120)
  }

  const pickAutocomplete = (phrase) => {
    setQuery(phrase)
    setAutocomplete([])
    setShowAutocomplete(false)
    // نطلق البحث مباشرة بالعبارة المختارة
    performSearch(phrase)
  }

  const performSearch = async (searchQuery, skipIntent = false) => {
    if (!searchQuery.trim()) return
    
    setLoading(true)
    setError('')
    setHasSearched(true)
    setAiSummary(null)
    setIntent(null)
    setFilters({ brands: [], sizes: [], sizesTitle: '', thirdOptions: [], thirdTitle: '' })
    setRelatedSearches([])
    setDidYouMean(null)
    setActiveBrand(null)
    setActiveSize(null)
    setActiveThird(null)
    setDisplayCount(INITIAL_COUNT)

    // 🚀 Lazy Loading: نطلب المنتجات والميزات الذكية بالتوازي
    setLoadingAI(true)

    // 🔧 reset dev info for this search
    setDevInfo({ query: searchQuery, searchType: null, productsCount: 0, brandsCount: 0, smartFiltersCount: 0, relatedCount: 0, didYouMean: null, intentAmbiguous: false, fastDuration: null, aiDuration: null })
    const tFastStart = Date.now()
    const tAiStart = Date.now()

    // 1) المنتجات + intent (سريع، بدون LLM) — نظهرها فوراً
    // debug=1 يجلب pipeline trace للـ Developer Mode
    const fastPromise = axios.get(`${API_URL}/search`, {
      params: { q: searchQuery, limit: 500, skipAI: 'true', skipIntent: skipIntent ? 'true' : 'false', debug: '1' },
    }).then(response => {
      const fastDuration = Date.now() - tFastStart
      setAllProducts(response.data.products || [])
      setSearchType(response.data.searchType || 'general')
      setFilters(prev => ({
        ...prev,
        brands: response.data.filters?.brands || [],
      }))
      // ⚡ intent من القاموس يأتي فوراً مع المنتجات
      if (response.data.intent && response.data.intent.suggestions?.length > 0) {
        setIntent(response.data.intent)
      }
      setDevInfo(prev => ({
        ...prev,
        searchType: response.data.searchType || 'general',
        productsCount: (response.data.products || []).length,
        brandsCount: (response.data.filters?.brands || []).length,
        intentAmbiguous: !!response.data.intent?.isAmbiguous,
        fastDuration,
        // 🔬 Live pipeline trace from backend (per-query execution path)
        trace: response.data.debug?.trace || null,
        topProductTitle: response.data.products?.[0]?.title || null,
      }))
      setLoading(false)
    }).catch(err => {
      setError('Search failed: ' + err.message)
      setAllProducts([])
      setLoading(false)
    })

    // 2) ميزات الـ AI (تحمّل في الخلفية وتظهر تباعاً)
    const aiPromise = axios.get(`${API_URL}/search/ai`, {
      params: { q: searchQuery, skipIntent: skipIntent ? 'true' : 'false' },
    }).then(response => {
      const aiDuration = Date.now() - tAiStart
      setAiSummary(response.data.aiSummary || null)
      // intent من LLM يحدّث فقط لو القاموس لم يطابق
      if (response.data.intent?.suggestions?.length > 0) {
        setIntent(response.data.intent)
      }
      const aiFilters = {
        sizes: response.data.filters?.sizes || [],
        sizesTitle: response.data.filters?.sizesTitle || '',
        thirdOptions: response.data.filters?.thirdOptions || [],
        thirdTitle: response.data.filters?.thirdTitle || '',
      }
      setFilters(prev => ({ ...prev, ...aiFilters }))
      setRelatedSearches(response.data.relatedSearches || [])
      setDidYouMean(response.data.didYouMean || null)
      setDevInfo(prev => ({
        ...prev,
        smartFiltersCount: aiFilters.sizes.length + aiFilters.thirdOptions.length,
        relatedCount: (response.data.relatedSearches || []).length,
        didYouMean: response.data.didYouMean || null,
        intentAmbiguous: prev?.intentAmbiguous || !!response.data.intent?.isAmbiguous,
        aiDuration,
      }))
    }).catch(err => {
      console.warn('AI enrichment failed:', err.message)
    }).finally(() => {
      setLoadingAI(false)
    })

    await Promise.allSettled([fastPromise, aiPromise])
  }

  const handleSearch = (e) => {
    e.preventDefault()
    performSearch(query)
  }

  const fetchPageTansiqRow = async (rowId) => {
    const row = pageTansiqRows.find(r => r.id === rowId)
    if (!row) return
    const queries = row.queries && row.queries.length > 0 ? row.queries : [row.query]
    setPageTansiqRows(prev => prev.map(r => r.id === rowId ? { ...r, loading: true, error: '' } : r))
    try {
      const results = await Promise.all(
        queries.map(q => axios.get(`${API_URL}/search`, { params: { q, limit: 30, skipIntent: 'true' } }))
      )
      // 🔀 merge + dedupe by link / mpn / title
      const seen = new Set()
      const merged = []
      for (const res of results) {
        for (const p of (res.data.products || [])) {
          const key = p.link || p.mpn || p.title
          if (key && !seen.has(key)) { seen.add(key); merged.push(p) }
        }
      }
      setPageTansiqRows(prev => prev.map(r => r.id === rowId
        ? { ...r, allProducts: merged, loading: false, hasFetched: true }
        : r))
    } catch (err) {
      setPageTansiqRows(prev => prev.map(r => r.id === rowId
        ? { ...r, loading: false, error: 'فشل: ' + (err.response?.data?.message || err.message) }
        : r))
    }
  }

  const setPageTansiqColorFilter = (rowId, color) => {
    setPageTansiqRows(prev => prev.map(r => r.id === rowId
      ? { ...r, selectedColor: r.selectedColor === color ? null : color }
      : r))
  }

  const handlePageDrop = (product) => {
    if (!product) return
    if (pageTansiqSelected.length >= 2) return // لأن المنتج المقفول هو الأول
    if (pageTansiqSelected.some(p => p.link === product.link)) return
    if (product.link === LOCKED_PRODUCT.link) return
    setPageTansiqSelected([...pageTansiqSelected, product])
    setPageTansiqComposedImage(null)
  }

  const handlePageRemove = (idx) => {
    setPageTansiqSelected(pageTansiqSelected.filter((_, i) => i !== idx))
    setPageTansiqComposedImage(null)
  }

  const composePageTansiq = async () => {
    const all = [LOCKED_PRODUCT, ...pageTansiqSelected]
    if (all.length < 1) return
    setPageTansiqComposing(true)
    setPageTansiqError('')
    setPageTansiqComposedImage(null)
    setPageTansiqComposedModel(null)
    setPageTansiqComposeDuration(null)
    const t0 = Date.now()
    try {
      const res = await axios.post(`${API_URL}/tansiq-compose`, { products: all })
      setPageTansiqComposedImage(res.data.imageUrl)
      setPageTansiqComposedModel(res.data.model || null)
      setPageTansiqComposeDuration(Date.now() - t0)
      // 📊 fire-and-forget analytics
      axios.post(`${API_URL}/track/tansiq`, {
        products: all.map(p => ({ id: p.mpn || p.id, title: p.title, link: p.link })),
        query: 'page-tansiq',
      }).catch(() => {})
    } catch (err) {
      setPageTansiqError('فشل توليد الصورة: ' + (err.response?.data?.message || err.message))
      setPageTansiqComposeDuration(Date.now() - t0)
    } finally {
      setPageTansiqComposing(false)
    }
  }

  const searchTansiqRow = async (rowId, q) => {
    if (!q.trim()) return
    setTansiqRows(prev => prev.map(r => r.id === rowId ? { ...r, loading: true, query: q, error: '' } : r))
    try {
      const res = await axios.get(`${API_URL}/search`, {
        params: { q, limit: 30, skipIntent: 'true' },
      })
      setTansiqRows(prev => prev.map(r => r.id === rowId
        ? { ...r, products: res.data.products || [], loading: false, hasSearched: true }
        : r))
    } catch (err) {
      setTansiqRows(prev => prev.map(r => r.id === rowId
        ? { ...r, loading: false, error: 'فشل البحث: ' + (err.response?.data?.message || err.message) }
        : r))
    }
  }

  const updateTansiqQuery = (rowId, q) => {
    setTansiqRows(prev => prev.map(r => r.id === rowId ? { ...r, query: q } : r))
  }

  const handleTansiqDrop = (product) => {
    if (!product) return
    if (tansiqSelected.length >= 3) return
    if (tansiqSelected.some(p => p.link === product.link)) return
    setTansiqSelected([...tansiqSelected, product])
  }

  const handleTansiqRemove = (idx) => {
    setTansiqSelected(tansiqSelected.filter((_, i) => i !== idx))
    setTansiqComposedImage(null)
  }

  const composeTansiq = async () => {
    if (tansiqSelected.length < 1) return
    setTansiqComposing(true)
    setTansiqError('')
    setTansiqComposedImage(null)
    setTansiqComposedModel(null)
    setTansiqComposeDuration(null)
    const t0 = Date.now()
    try {
      const res = await axios.post(`${API_URL}/tansiq-compose`, {
        products: tansiqSelected,
      })
      setTansiqComposedImage(res.data.imageUrl)
      setTansiqComposedModel(res.data.model || null)
      setTansiqComposeDuration(Date.now() - t0)
      // 📊 fire-and-forget analytics
      axios.post(`${API_URL}/track/tansiq`, {
        products: tansiqSelected.map(p => ({ id: p.mpn || p.id, title: p.title, link: p.link })),
        query: 'multi-row-tansiq',
      }).catch(() => {})
    } catch (err) {
      setTansiqError('فشل توليد الصورة: ' + (err.response?.data?.message || err.message))
      setTansiqComposeDuration(Date.now() - t0)
    } finally {
      setTansiqComposing(false)
    }
  }

  const handleImageUpload = (e) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!file.type.startsWith('image/')) {
      setError('الرجاء اختيار ملف صورة')
      return
    }
    if (file.size > 8 * 1024 * 1024) {
      setError('حجم الصورة كبير جداً (الحد الأقصى 8MB)')
      return
    }

    // ✨ بدل الإرسال المباشر، نعرض cropper ليختار المستخدم المنتج الرئيسي
    const reader = new FileReader()
    reader.onload = (ev) => {
      setCropperImage(ev.target.result)
      setError('')
      // reset input so the same file can be picked again
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
    reader.readAsDataURL(file)
  }

  // يُنادى بعد ما المستخدم يحدد المنطقة في الـ cropper
  const submitCroppedImage = async (croppedDataUrl) => {
    setCropperImage(null)
    const reader = { onload: null }
    // مباشرة استخدم الـ data URL
    const ev = { target: { result: croppedDataUrl } }
    {
      setImageLoading(true)
      setError('')
      try {
        const response = await axios.post(`${API_URL}/image-search`, {
          image: ev.target.result,
          userCropped: true,
        })
        if (response.data.success && response.data.visualSearch && response.data.products) {
          // 📷 بحث بصري — نعرض المنتجات المشابهة مباشرة بدون بحث نصي تالي
          setAllProducts(response.data.products)
          setSearchType('visual')
          setQuery('')  // ⚠️ خانة البحث تبقى فاضية للتأكيد إن البحث بصري وليس نصي
          setHasSearched(true)
          setAiSummary(null)
          setIntent(null)
          setFilters({ brands: [], sizes: [], sizesTitle: '', thirdOptions: [], thirdTitle: '' })
          setRelatedSearches([])
          setDidYouMean(null)
          setDisplayCount(INITIAL_COUNT)
        } else if (response.data.success && response.data.query) {
          // legacy: نص → بحث عادي (لم يعد المسار الافتراضي لكن نحتفظ به للأمان)
          setQuery(response.data.query)
          performSearch(response.data.query, true)
        } else {
          setError(response.data.message || 'لم نتمكن من التعرّف على المنتج في الصورة')
        }
      } catch (err) {
        setError('فشل تحليل الصورة: ' + (err.response?.data?.message || err.message))
      } finally {
        setImageLoading(false)
      }
    }
  }

  const handleSuggestionClick = (suggestionQuery) => {
    setQuery(suggestionQuery)
    performSearch(suggestionQuery, true)
  }

  const handleSkipIntent = () => setIntent(null)

  const handleFilterClick = (type, value) => {
    if (type === 'brand') {
      setActiveBrand(activeBrand === value ? null : value)
    } else if (type === 'size') {
      setActiveSize(activeSize === value ? null : value)
    } else if (type === 'third') {
      setActiveThird(activeThird === value ? null : value)
    }
    setDisplayCount(INITIAL_COUNT)
  }

  const handleRelatedSearch = (relatedQuery) => {
    setQuery(relatedQuery)
    performSearch(relatedQuery, true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handleLoadMore = () => {
    setDisplayCount(prev => prev + LOAD_MORE_COUNT)
  }

  // Smart filtering with context preservation
  const filteredProducts = allProducts.filter(product => {
    if (activeBrand && product.brand !== activeBrand) return false
    
    // For size filter, check if size exists in title
    // (the products are already filtered by search context from backend)
    if (activeSize) {
      const titleLower = product.title.toLowerCase()
      const sizeLower = activeSize.toLowerCase()
      if (!titleLower.includes(sizeLower)) return false
      
      // Extra check: if searching for a device, exclude accessories
      if (searchType === 'device') {
        const isAcc = ACCESSORY_KEYWORDS.some(kw => titleLower.includes(kw))
        if (isAcc) return false
      }
    }
    
    if (activeThird) {
      const titleLower = product.title.toLowerCase()
      const thirdLower = activeThird.toLowerCase()
      if (!titleLower.includes(thirdLower)) return false
    }
    
    return true
  })

  const displayedProducts = filteredProducts.slice(0, displayCount)
  const remainingCount = filteredProducts.length - displayCount
  const hasActiveFilters = activeBrand || activeSize || activeThird

  const sendChatMessage = async (message) => {
    if (!message.trim() || chatLoading) return
    
    const userMessage = { role: 'user', content: message }
    const newMessages = [...chatMessages, userMessage]
    setChatMessages(newMessages)
    setChatInput('')
    setChatLoading(true)

    try {
      const response = await axios.post(`${API_URL}/chat`, {
        message: message,
        history: chatMessages.map(m => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : m.content.reply
        }))
      })
      
      setChatMessages([...newMessages, {
        role: 'assistant',
        content: {
          reply: response.data.reply,
          quickReplies: response.data.quickReplies || [],
          suggestedProduct: response.data.suggestedProduct || null
        }
      }])
    } catch (err) {
      setChatMessages([...newMessages, {
        role: 'assistant',
        content: { reply: 'عذراً، حدث خطأ.', quickReplies: [], suggestedProduct: null }
      }])
    } finally {
      setChatLoading(false)
    }
  }

  const handleChatSubmit = (e) => {
    e.preventDefault()
    sendChatMessage(chatInput)
  }

  const handleQuickReply = (reply) => sendChatMessage(reply)

  const renderProductsGrid = () => {
    const items = []
    
    displayedProducts.forEach((product, idx) => {
      items.push(
        <a
          key={product.id}
          href={product.link}
          target="_blank"
          rel="noopener noreferrer"
          className="product-card"
          onClick={() => {
            // 📊 تتبّع نقرة المنتج للتقارير
            try {
              axios.post(`${API_URL}/track/click`, {
                query, productId: product.id, productTitle: product.title,
                position: idx + 1, source: 'search',
              }).catch(() => {})
            } catch {}
          }}
        >
          {product.hasDiscount && (
            <div className="discount-badge">-{product.discountPercentage}%</div>
          )}
          <img src={product.image_link} alt={product.title} className="product-image" />
          <div className="product-info">
            <h3 className="product-title">{product.title}</h3>
            <div className="product-prices">
              {product.price && <span className="product-price">{product.price}</span>}
              {product.hasDiscount && product.originalPrice && (
                <span className="product-original-price">{product.originalPrice}</span>
              )}
            </div>
            {product.brand && <p className="product-brand">{product.brand}</p>}
          </div>
        </a>
      )
      
      const productNumber = idx + 1

      if (productNumber === BRANDS_AFTER && aiSummary?.recommendations && !hasActiveFilters) {
        items.push(
          <div key="ai-recommendations-inline" className="inline-recommendations">
            <div className="inline-recommendations-header">
              <span className="inline-recommendations-icon">🎯</span>
              <h3>توصيات مختارة لك</h3>
            </div>
            <div className="recommendations-grid">
              <RecommendationCard
                type="cheapest"
                data={aiSummary.recommendations.cheapest}
                icon="💰"
                label="الأرخص"
              />
              <RecommendationCard
                type="bestValue"
                data={aiSummary.recommendations.bestValue}
                icon="⭐"
                label="الأفضل قيمة"
                featured={true}
              />
              <RecommendationCard
                type="premium"
                data={aiSummary.recommendations.premium}
                icon="👑"
                label="الأرقى"
              />
            </div>
          </div>
        )
      }

      if (productNumber === BRANDS_AFTER && filters.brands && filters.brands.length > 0 && !hasActiveFilters) {
        items.push(
          <div key="brands-filter" className="inline-filter inline-filter-brands">
            <div className="inline-filter-header">
              <span className="inline-filter-icon">🎛️</span>
              <span className="inline-filter-title">ايش الماركة اللي تفضّلها؟</span>
            </div>
            <div className="inline-filter-options">
              {filters.brands.map((brand, i) => (
                <button
                  key={i}
                  className={`inline-filter-btn brand-btn ${activeBrand === brand ? 'active' : ''}`}
                  onClick={() => handleFilterClick('brand', brand)}
                >
                  {brand}
                </button>
              ))}
            </div>
          </div>
        )
      }

      if (productNumber === SIZES_AFTER && filters.sizes && filters.sizes.length > 0 && !hasActiveFilters) {
        items.push(
          <div key="sizes-filter" className="inline-filter inline-filter-sizes">
            <div className="inline-filter-header">
              <span className="inline-filter-icon">📏</span>
              <span className="inline-filter-title">{filters.sizesTitle || 'ايش الحجم اللي يناسبك؟'}</span>
            </div>
            <div className="inline-filter-options">
              {filters.sizes.map((size, i) => (
                <button
                  key={i}
                  className={`inline-filter-btn size-btn ${activeSize === size ? 'active' : ''}`}
                  onClick={() => handleFilterClick('size', size)}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>
        )
      }

      if (productNumber === THIRD_AFTER && filters.thirdOptions && filters.thirdOptions.length > 0 && !hasActiveFilters) {
        items.push(
          <div key="third-filter" className="inline-filter inline-filter-third">
            <div className="inline-filter-header">
              <span className="inline-filter-icon">✨</span>
              <span className="inline-filter-title">{filters.thirdTitle || 'خيارات إضافية'}</span>
            </div>
            <div className="inline-filter-options">
              {filters.thirdOptions.map((opt, i) => (
                <button
                  key={i}
                  className={`inline-filter-btn third-btn ${activeThird === opt ? 'active' : ''}`}
                  onClick={() => handleFilterClick('third', opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
        )
      }

      if (productNumber === RELATED_AFTER && relatedSearches && relatedSearches.length > 0) {
        items.push(
          <div key="related-searches" className="inline-filter inline-filter-related">
            <div className="inline-filter-header">
              <span className="inline-filter-icon">🔍</span>
              <span className="inline-filter-title">بحوث ذات صلة</span>
            </div>
            <div className="related-searches-list">
              {relatedSearches.map((related, i) => (
                <button
                  key={i}
                  className="related-search"
                  onClick={() => handleRelatedSearch(related.query)}
                >
                  <span className="related-search-icon">{related.icon}</span>
                  <span>{related.query}</span>
                </button>
              ))}
            </div>
          </div>
        )
      }
    })

    return items
  }

  const modeSwitch = (
    <div className="mode-switch">
      <button
        className={`mode-switch-btn ${mode === 'search' ? 'active' : ''}`}
        onClick={() => setMode('search')}
      >
        🔍 مشروع البحث AI
      </button>
      <button
        className={`mode-switch-btn ${mode === 'tansiq' ? 'active' : ''}`}
        onClick={() => {
          if (mode === 'tansiq') return
          const pwd = window.prompt('🔒 هذا المشروع محمي بكلمة سر — أدخل كلمة السر:')
          if (pwd === null) return // user cancelled
          if (pwd === '114141') {
            setMode('tansiq')
          } else {
            window.alert('❌ كلمة السر غير صحيحة')
          }
        }}
        title="محمي بكلمة سر"
      >
        🔒 🎨 مشروع التنسيقات المتقدم AI
      </button>
      <button
        className={`mode-switch-btn ${mode === 'page-tansiq' ? 'active' : ''}`}
        onClick={() => setMode('page-tansiq')}
      >
        📄 مشروع تنسيقات السريع AI
      </button>
      <button
        className={`mode-switch-btn ${mode === 'dashboard' ? 'active' : ''}`}
        onClick={() => setMode('dashboard')}
      >
        📊 تقرير البحث
      </button>
    </div>
  )

  if (mode === 'dashboard') {
    return (
      <div className="app" dir="rtl">
        {modeSwitch}
        <div style={{ background: 'white', borderRadius: '16px', overflow: 'hidden', height: 'calc(100vh - 120px)', margin: '0 1rem', boxShadow: '0 4px 12px rgba(0,0,0,.08)' }}>
          <iframe
            src={`${API_URL}/admin/dashboard`}
            title="تقرير البحث"
            style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
          />
        </div>
      </div>
    )
  }

  if (mode === 'tansiq') {
    return (
      <TansiqProject
        modeSwitch={modeSwitch}
        devMode={
          <TansiqDevMode
            apiUrl={API_URL}
            selectedCount={tansiqSelected.length}
            composing={tansiqComposing}
            composedImage={tansiqComposedImage}
            composedModel={tansiqComposedModel}
            composeDuration={tansiqComposeDuration}
            flowName="Multi-row Tansiq"
          />
        }
        rows={tansiqRows}
        selected={tansiqSelected}
        composing={tansiqComposing}
        composedImage={tansiqComposedImage}
        composedModel={tansiqComposedModel}
        error={tansiqError}
        onRowSearch={searchTansiqRow}
        onRowQueryChange={updateTansiqQuery}
        onDrop={handleTansiqDrop}
        onRemove={handleTansiqRemove}
        onCompose={composeTansiq}
      />
    )
  }

  if (mode === 'page-tansiq') {
    return (
      <PageTansiqProject
        modeSwitch={modeSwitch}
        devMode={
          <TansiqDevMode
            apiUrl={API_URL}
            selectedCount={pageTansiqSelected.length + 1}
            composing={pageTansiqComposing}
            composedImage={pageTansiqComposedImage}
            composedModel={pageTansiqComposedModel}
            composeDuration={pageTansiqComposeDuration}
            flowName="Product Page Tansiq (locked product + extras)"
          />
        }
        lockedProduct={LOCKED_PRODUCT}
        rows={pageTansiqRows}
        expanded={pageTansiqExpanded}
        selected={pageTansiqSelected}
        composing={pageTansiqComposing}
        composedImage={pageTansiqComposedImage}
        composedModel={pageTansiqComposedModel}
        error={pageTansiqError}
        onToggleExpand={() => setPageTansiqExpanded(!pageTansiqExpanded)}
        onFetchRow={fetchPageTansiqRow}
        onSelectColor={setPageTansiqColorFilter}
        onDrop={handlePageDrop}
        onRemove={handlePageRemove}
        onCompose={composePageTansiq}
      />
    )
  }

  return (
    <div className="app" dir="rtl">
      {cropperImage && (
        <ImageCropper
          imageSrc={cropperImage}
          onConfirm={submitCroppedImage}
          onCancel={() => setCropperImage(null)}
        />
      )}
      {modeSwitch}
      <DeveloperMode devInfo={devInfo} loading={loading} loadingAI={loadingAI} apiUrl={API_URL} />
      <header className="header">
        <h1>QasrAlawani Search AI</h1>
      </header>

      <form className="search-form" onSubmit={handleSearch}>
        <div className="search-input-wrapper" style={{ position: 'relative', flex: 1 }}>
          <input
            type="text"
            className="search-input"
            placeholder="ابحث عن منتج..."
            value={query}
            onChange={handleQueryChange}
            onFocus={() => { if (autocomplete.length > 0) setShowAutocomplete(true) }}
            onBlur={() => { setTimeout(() => setShowAutocomplete(false), 200) }}
            autoComplete="off"
          />
          {showAutocomplete && autocomplete.length > 0 && (
            <ul className="autocomplete-dropdown" role="listbox">
              {autocomplete.map((s, i) => (
                <li
                  key={i}
                  role="option"
                  onMouseDown={(e) => { e.preventDefault(); pickAutocomplete(s) }}
                >
                  <span className="ac-icon">🔍</span>
                  <span className="ac-text">{s}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleImageUpload}
        />
        <button
          type="button"
          className="image-search-button"
          onClick={() => fileInputRef.current?.click()}
          disabled={imageLoading || loading}
          title="ابحث بصورة"
          aria-label="ابحث بصورة"
        >
          {imageLoading ? '⏳' : '📷'}
        </button>
        <button type="submit" className="search-button" disabled={loading || imageLoading}>
          {loading ? 'جاري البحث...' : 'Search'}
        </button>
      </form>

      {imageLoading && (
        <div className="loading">
          <div className="robot-loader">
            <div className="spinner-ring"></div>
            <div className="robot-emoji">📷</div>
          </div>
          <p className="loading-text">جاري تحليل الصورة...</p>
          <div className="loading-progress">
            <div className="loading-progress-bar"></div>
          </div>
        </div>
      )}

      {didYouMean && !loading && (
        <div className="did-you-mean">
          هل تقصد:{' '}
          <button
            className="did-you-mean-link"
            onClick={() => {
              setQuery(didYouMean)
              performSearch(didYouMean, true)
            }}
          >
            {didYouMean}
          </button>
          ؟
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {loading && (
        <div className="loading">
          <div className="robot-loader">
            <div className="spinner-ring"></div>
            <div className="robot-emoji">🤖</div>
          </div>
          <p className="loading-text">جاري البحث وتحليل النتائج...</p>
          <div className="loading-progress">
            <div className="loading-progress-bar"></div>
          </div>
        </div>
      )}

      {/* 💫 Skeleton للـ intent أثناء التحميل */}
      {loadingAI && !loading && hasSearched && !intent && (
        <div className="ai-skeleton intent-skeleton">
          <div className="ai-skeleton-shimmer"></div>
          <div className="ai-skeleton-text">💡 جاري تحليل البحث الذكي...</div>
        </div>
      )}

      {intent && intent.isAmbiguous && intent.suggestions && intent.suggestions.length > 0 && !loading && (
        <div className="intent-box">
          <div className="intent-header">
            <span className="intent-icon">💡</span>
            <h3>{intent.message || 'يبدو إن بحثك عام'}</h3>
          </div>
          <p className="intent-subtitle">اختر تصنيفاً للحصول على نتائج أدق:</p>
          <div className="intent-suggestions">
            {intent.suggestions.map((suggestion, idx) => (
              <button
                key={idx}
                className="intent-suggestion"
                onClick={() => handleSuggestionClick(suggestion.searchQuery)}
              >
                <div className="intent-suggestion-icon">
                  {getEmojiForIcon(suggestion.icon)}
                </div>
                <div className="intent-suggestion-content">
                  <div className="intent-suggestion-title">{suggestion.title}</div>
                  <div className="intent-suggestion-desc">{suggestion.description}</div>
                </div>
              </button>
            ))}
          </div>
          <button className="intent-skip" onClick={handleSkipIntent}>
            تخطي وعرض كل النتائج ↓
          </button>
        </div>
      )}

      {hasSearched && !loading && filteredProducts.length > 0 && (
        <div className="results-count">
          <strong>{filteredProducts.length}</strong> منتج
          {hasActiveFilters && (
            <span className="active-filter-info">
              {' '}مفلتر بـ <strong>"{activeBrand || activeSize || activeThird}"</strong>
              <button 
                className="clear-filter-btn"
                onClick={() => {
                  setActiveBrand(null)
                  setActiveSize(null)
                  setActiveThird(null)
                  setDisplayCount(INITIAL_COUNT)
                }}
              >
                ✕ مسح الفلتر
              </button>
            </span>
          )}
        </div>
      )}

      <div className="products-grid">
        {renderProductsGrid()}
      </div>

      {remainingCount > 0 && !loading && (
        <div className="load-more-section">
          <button className="load-more-btn" onClick={handleLoadMore}>
            عرض المزيد ({remainingCount} منتج متبقي)
          </button>
        </div>
      )}

    </div>
  )
}

function TansiqProject({
  modeSwitch, devMode, rows, selected, composing, composedImage, composedModel, error,
  onRowSearch, onRowQueryChange, onDrop, onRemove, onCompose,
}) {
  const [dragOver, setDragOver] = useState(false)
  const [cartAdded, setCartAdded] = useState(false)

  const handleMobileSelect = (product, e) => {
    if (selected.length >= 3) return
    flyToDropZone(e, '.tansiq-drop-zone', () => onDrop(product))
  }

  const extractPriceNum = (priceStr) => {
    if (!priceStr) return 0
    const m = String(priceStr).match(/[\d.]+/)
    return m ? parseFloat(m[0]) : 0
  }

  const totalPrice = selected.reduce((sum, p) => sum + extractPriceNum(p.price), 0)

  const handleAddToCart = () => {
    setCartAdded(true)
    setTimeout(() => setCartAdded(false), 2500)
  }

  const handleDragStart = (e, product) => {
    e.dataTransfer.setData('application/json', JSON.stringify(product))
    e.dataTransfer.effectAllowed = 'copy'
  }

  const handleDragOver = (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }

  const handleDragLeave = () => setDragOver(false)

  const handleDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    try {
      const product = JSON.parse(e.dataTransfer.getData('application/json'))
      onDrop(product)
    } catch {}
  }

  return (
    <div className="app tansiq-page" dir="rtl">
      {modeSwitch}
      {devMode}
      <header className="tansiq-header">
        <h1 className="tansiq-title">🎨 مشروع التنسيقات المتقدم AI</h1>
        <p className="tansiq-subtitle">ابحث في كل صف، اسحب 3 منتجات إلى الصندوق، ثم اطلب التصميم</p>
      </header>

      <div className="tansiq-layout">
        <div className="tansiq-rows">
          {rows.map((row, idx) => (
            <TansiqRow
              key={row.id}
              row={row}
              defaultPlaceholder={['ابحث (مثلاً: ترامس)', 'ابحث (مثلاً: فناجين)', 'ابحث (مثلاً: مفردات)'][idx]}
              onSearch={(q) => onRowSearch(row.id, q)}
              onQueryChange={(q) => onRowQueryChange(row.id, q)}
              onDragStart={handleDragStart}
              onMobileSelect={handleMobileSelect}
            />
          ))}
        </div>

        <aside className="tansiq-chat-box">
          <div className="tansiq-chat-header">
            <span>🛒</span>
            <h3>صندوق التنسيق</h3>
            <span className="tansiq-chat-count">{selected.length}/3</span>
          </div>
          <p className="tansiq-chat-hint">اسحب 3 منتجات هنا ثم اطلب التصميم</p>

          <div
            className={`tansiq-drop-zone ${dragOver ? 'is-over' : ''} ${selected.length === 3 ? 'is-full' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {selected.length === 0 && (
              <div className="tansiq-drop-empty">
                <div className="tansiq-drop-icon">📦</div>
                <p>اسحب المنتجات هنا</p>
              </div>
            )}
            {selected.map((p, i) => (
              <div key={i} className="tansiq-dropped">
                <img src={p.image_link} alt={p.title} />
                <div className="tansiq-dropped-info">
                  <div className="tansiq-dropped-title">{p.title}</div>
                  {p.color && <div className="tansiq-dropped-meta">{p.color}</div>}
                </div>
                <button className="tansiq-dropped-remove" onClick={() => onRemove(i)} aria-label="حذف">✕</button>
              </div>
            ))}
          </div>

          <button
            className="tansiq-compose-btn"
            onClick={onCompose}
            disabled={selected.length === 0 || composing}
          >
            {composing ? '⏳ جاري توليد التصميم...' : `✨ صمّم لي تنسيق بيتي (${selected.length})`}
          </button>

          {composing && (
            <div className="tansiq-compose-loading">
              <div className="loading-progress">
                <div className="loading-progress-bar"></div>
              </div>
              <p>الـ AI يصمّم مشهد منزلي يجمع منتجاتك...</p>
            </div>
          )}

          {composedImage && (
            <div className="tansiq-composed">
              <h4>🏠 التصميم النهائي</h4>
              <img src={composedImage} alt="تنسيق منزلي" />
              <p className="ai-image-disclaimer">
                ⚠️ قد تختلف صورة المنتج المُنشأة بالذكاء الاصطناعي عن المنتج الموجود في الموقع
              </p>
              {composedModel && (
                <p className={`composed-model-tag ${composedModel.includes('gemini') || composedModel.includes('Nano') ? 'is-gemini' : 'is-openai'}`}>
                  🤖 تم التوليد بـ: <strong>{composedModel}</strong>
                </p>
              )}
              <a href={composedImage} target="_blank" rel="noopener noreferrer" className="tansiq-composed-download">
                فتح بحجم كامل ↗
              </a>
            </div>
          )}

          {composedImage && selected.length > 0 && (
            <div className="tansiq-final">
              <div className="tansiq-final-header">
                <span>🎁</span>
                <h4>المنتجات في التنسيق</h4>
              </div>
              <div className="tansiq-final-items">
                {selected.map((p, i) => (
                  <div key={i} className="tansiq-final-item">
                    <img src={p.image_link} alt={p.title} />
                    <div className="tansiq-final-item-info">
                      <div className="tansiq-final-item-title">{p.title}</div>
                      {(p.color || p.size) && (
                        <div className="tansiq-final-item-meta">
                          {p.color}{p.color && p.size ? ' • ' : ''}{p.size}
                        </div>
                      )}
                    </div>
                    <div className="tansiq-final-item-price">
                      {extractPriceNum(p.price).toFixed(2)} ر.س
                    </div>
                  </div>
                ))}
              </div>
              <div className="tansiq-final-total">
                <span>الإجمالي:</span>
                <strong>{totalPrice.toFixed(2)} ر.س</strong>
              </div>
              <button
                className={`tansiq-add-cart ${cartAdded ? 'added' : ''}`}
                onClick={handleAddToCart}
                disabled={cartAdded}
              >
                {cartAdded ? '✓ تمت الإضافة للسلة' : '🛒 أضف الكل للسلة'}
              </button>
            </div>
          )}

          {error && <div className="error">{error}</div>}
        </aside>
      </div>
    </div>
  )
}

function TansiqRow({ row, defaultPlaceholder, onSearch, onQueryChange, onDragStart, onMobileSelect }) {
  const scrollRef = useRef(null)

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!row.query.trim()) return
    onSearch(row.query)
  }

  const scrollBy = (direction) => {
    // RTL: direction 'next' = scroll right (which is reading-direction forward)
    const el = scrollRef.current
    if (!el) return
    const amount = el.clientWidth * 0.8
    el.scrollBy({ left: direction === 'next' ? -amount : amount, behavior: 'smooth' })
  }

  return (
    <div className="tansiq-row">
      <form className="tansiq-row-search" onSubmit={handleSubmit}>
        <span className="tansiq-row-search-icon">🔍</span>
        <input
          type="text"
          className="tansiq-row-search-input"
          placeholder={defaultPlaceholder}
          value={row.query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
        <button
          type="submit"
          className="tansiq-row-search-btn"
          disabled={row.loading || !row.query.trim()}
        >
          {row.loading ? '...' : 'ابحث'}
        </button>
      </form>

      {row.error && <div className="error" style={{ marginTop: '0.5rem' }}>{row.error}</div>}

      {row.loading && (
        <div className="tansiq-row-loading">
          <div className="loading-progress" style={{ maxWidth: '100%' }}>
            <div className="loading-progress-bar"></div>
          </div>
        </div>
      )}

      {!row.loading && row.hasSearched && row.products.length === 0 && (
        <div className="tansiq-row-empty">لا توجد نتائج</div>
      )}

      {row.products.length > 0 && (
        <div className="tansiq-carousel-wrapper">
          <button
            type="button"
            className="tansiq-carousel-arrow tansiq-carousel-arrow-prev"
            onClick={() => scrollBy('prev')}
            aria-label="السابق"
          >‹</button>
          <div className="tansiq-carousel" ref={scrollRef}>
            {row.products.map((product, pidx) => (
              <div
                key={pidx}
                className="tansiq-card"
                draggable
                onDragStart={(e) => onDragStart(e, product)}
              >
                {product.hasDiscount && (
                  <div className="discount-badge">-{product.discountPercentage}%</div>
                )}
                <button
                  type="button"
                  className="mobile-select-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    onMobileSelect(product, e)
                  }}
                  aria-label="إضافة للتنسيق"
                >+</button>
                <img src={product.image_link} alt={product.title} className="tansiq-card-image" />
                <div className="tansiq-card-info">
                  <div className="tansiq-card-title">{product.title}</div>
                  <div className="tansiq-card-meta">
                    {product.price && <span className="tansiq-card-price">{product.price}</span>}
                    {product.color && <span className="tansiq-card-color">• {product.color}</span>}
                  </div>
                </div>
                <div className="tansiq-drag-hint">↤ اسحبني</div>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="tansiq-carousel-arrow tansiq-carousel-arrow-next"
            onClick={() => scrollBy('next')}
            aria-label="التالي"
          >›</button>
        </div>
      )}
    </div>
  )
}

function PageTansiqProject({
  modeSwitch, devMode, lockedProduct, rows, expanded, selected, composing, composedImage, composedModel, error,
  onToggleExpand, onFetchRow, onSelectColor, onDrop, onRemove, onCompose,
}) {
  const [dragOver, setDragOver] = useState(false)
  const [cartAdded, setCartAdded] = useState(false)

  const handleMobileSelect = (product, e) => {
    if (selected.length >= 2) return
    flyToDropZone(e, '.page-tansiq-drop-zone', () => onDrop(product))
  }

  const extractPriceNum = (priceStr) => {
    if (!priceStr) return 0
    const m = String(priceStr).match(/[\d.]+/)
    return m ? parseFloat(m[0]) : 0
  }

  const allProducts = [lockedProduct, ...selected]
  const totalBefore = allProducts.reduce((s, p) =>
    s + extractPriceNum(p.originalPrice || p.price), 0)
  const totalAfter = allProducts.reduce((s, p) =>
    s + extractPriceNum(p.price), 0)
  const totalSaved = totalBefore - totalAfter

  const handleDragStart = (e, product) => {
    e.dataTransfer.setData('application/json', JSON.stringify(product))
    e.dataTransfer.effectAllowed = 'copy'
  }
  const handleDragOver = (e) => { e.preventDefault(); setDragOver(true) }
  const handleDragLeave = () => setDragOver(false)
  const handleDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    try {
      const product = JSON.parse(e.dataTransfer.getData('application/json'))
      onDrop(product)
    } catch {}
  }

  const handleAddCart = () => {
    setCartAdded(true)
    setTimeout(() => setCartAdded(false), 2500)
  }

  return (
    <div className="app product-page-app" dir="rtl">
      {modeSwitch}
      {devMode}

      <div className="product-page-shell">
        {/* breadcrumb */}
        <div className="product-page-breadcrumb">
          الرئيسية ‹ الترامس وتقديمات الضيافة ‹ العلامات التجارية ‹ {lockedProduct.title.substring(0, 50)}...
        </div>

        <div className="product-page-grid">
          {/* صورة المنتج (يمين في RTL) */}
          <div className="product-page-image-side">
            <div className="product-page-discount-flag">
              <div>نصف السعر</div>
              <div className="small">& أكثر</div>
            </div>
            <img src={lockedProduct.image_link} alt={lockedProduct.title} className="product-page-main-image" />
          </div>

          {/* تفاصيل المنتج */}
          <div className="product-page-info-side">
            <div className="product-page-availability">متوفر</div>
            <h1 className="product-page-title">{lockedProduct.title}</h1>
            <div className="product-page-meta-row">
              <span>النوع: <strong>{lockedProduct.brand}</strong></span>
              <span>الكود: <strong>{lockedProduct.mpn}</strong></span>
            </div>
            <div className="product-page-tags">
              متاح: ترمس، اينور، تافولو، 1 لتر، الذهبي المطفي، بيد خشبي
            </div>

            <div className="product-page-price-row">
              <span className="product-page-price-current">{lockedProduct.price} ر.س</span>
              <span className="product-page-discount-pct">-{lockedProduct.discountPercentage}%</span>
              <span className="product-page-price-original">{lockedProduct.originalPrice}</span>
              <span className="product-page-saved">وفرت 75 ر.س</span>
            </div>

            <div className="product-page-coupon">
              <span>🎁 خصم إضافي</span> استخدم كود <strong>TH10</strong>
            </div>

            {/* ودجت AI */}
            <div className={`page-tansiq-widget ${expanded ? 'expanded' : ''}`}>
              <button className="page-tansiq-widget-header" onClick={onToggleExpand}>
                <span className="page-tansiq-widget-icon">🤖</span>
                <div className="page-tansiq-widget-text">
                  <div className="page-tansiq-widget-title">نسقي ضيافتك في أقل من دقيقة</div>
                  <div className="page-tansiq-widget-subtitle">بمساعدة الذكاء الاصطناعي ✨</div>
                </div>
                <span className="page-tansiq-widget-chevron">{expanded ? '▲' : '▼'}</span>
              </button>

              {expanded && (
                <div className="page-tansiq-widget-body">
                  {/* صندوق السحب */}
                  <div className="page-tansiq-drop-section">
                    <div className="page-tansiq-section-header">
                      <span>🛒 صندوق التنسيق</span>
                      <span className="page-tansiq-counter">{selected.length + 1}/3</span>
                    </div>
                    <div
                      className={`page-tansiq-drop-zone ${dragOver ? 'is-over' : ''}`}
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                      onDrop={handleDrop}
                    >
                      <div className="page-tansiq-slot locked">
                        <span className="page-tansiq-lock-badge">🔒 ثابت</span>
                        <img src={lockedProduct.image_link} alt={lockedProduct.title} />
                        <div className="page-tansiq-slot-info">
                          <div className="page-tansiq-slot-title">{lockedProduct.title}</div>
                          <div className="page-tansiq-slot-price">{lockedProduct.price} ر.س</div>
                        </div>
                      </div>
                      {selected.map((p, i) => (
                        <div key={i} className="page-tansiq-slot filled">
                          <img src={p.image_link} alt={p.title} />
                          <div className="page-tansiq-slot-info">
                            <div className="page-tansiq-slot-title">{p.title}</div>
                            <div className="page-tansiq-slot-price">{p.price} ر.س</div>
                          </div>
                          <button className="page-tansiq-slot-remove" onClick={() => onRemove(i)}>✕</button>
                        </div>
                      ))}
                      {[...Array(Math.max(0, 2 - selected.length))].map((_, i) => (
                        <div key={`empty-${i}`} className="page-tansiq-slot empty">
                          <span>+ اسحب منتج هنا</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* الصفوف */}
                  {rows.map(row => (
                    <PageTansiqRow
                      key={row.id}
                      row={row}
                      thermosColor={lockedProduct.color}
                      onFetch={() => onFetchRow(row.id)}
                      onSelectColor={(c) => onSelectColor(row.id, c)}
                      onDragStart={handleDragStart}
                      onMobileSelect={handleMobileSelect}
                    />
                  ))}

                  {/* زر التصميم */}
                  <button
                    className="page-tansiq-compose-btn"
                    onClick={onCompose}
                    disabled={selected.length === 0 || composing}
                  >
                    {composing ? '⏳ جاري التصميم بالـ AI...' : '🎨 صمّم لي ضيافتي'}
                  </button>

                  {composing && (
                    <div className="loading-progress" style={{ marginTop: '0.75rem' }}>
                      <div className="loading-progress-bar"></div>
                    </div>
                  )}

                  {composedImage && (
                    <>
                      <div className="page-tansiq-result">
                        <h4>🏠 ضيافتك الجاهزة</h4>
                        <img src={composedImage} alt="التنسيق النهائي" />
                        <p className="ai-image-disclaimer">
                          ⚠️ قد تختلف صورة المنتج المُنشأة بالذكاء الاصطناعي عن المنتج الموجود في الموقع
                        </p>
                        {composedModel && (
                          <p className={`composed-model-tag ${composedModel.includes('gemini') || composedModel.includes('Nano') ? 'is-gemini' : 'is-openai'}`}>
                            🤖 تم التوليد بـ: <strong>{composedModel}</strong>
                          </p>
                        )}
                        <a href={composedImage} target="_blank" rel="noopener noreferrer">فتح بحجم كامل ↗</a>
                      </div>

                      <div className="page-tansiq-summary">
                        <div className="page-tansiq-section-header">
                          <span>🎁 محتويات الصورة</span>
                          <span>{allProducts.length} منتجات</span>
                        </div>
                        <div className="page-tansiq-summary-items">
                          {allProducts.map((p, i) => (
                            <div key={i} className="page-tansiq-summary-item">
                              <img src={p.image_link} alt={p.title} />
                              <div className="page-tansiq-summary-item-info">
                                <div className="page-tansiq-summary-item-title">{p.title}</div>
                                {p.color && <div className="page-tansiq-summary-item-meta">{p.color}</div>}
                              </div>
                              <div className="page-tansiq-summary-item-price">
                                {p.hasDiscount && p.originalPrice && (
                                  <span className="strike">{extractPriceNum(p.originalPrice).toFixed(0)}</span>
                                )}
                                <strong>{extractPriceNum(p.price).toFixed(2)} ر.س</strong>
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="page-tansiq-totals">
                          <div className="page-tansiq-total-row">
                            <span>السعر قبل الخصم:</span>
                            <span className="strike">{totalBefore.toFixed(2)} ر.س</span>
                          </div>
                          <div className="page-tansiq-total-row">
                            <span>الإجمالي بعد الخصم:</span>
                            <strong>{totalAfter.toFixed(2)} ر.س</strong>
                          </div>
                          {totalSaved > 0 && (
                            <div className="page-tansiq-total-row saved">
                              <span>💰 وفرت:</span>
                              <strong>{totalSaved.toFixed(2)} ر.س</strong>
                            </div>
                          )}
                        </div>
                        <button
                          className={`page-tansiq-add-all-cart ${cartAdded ? 'added' : ''}`}
                          onClick={handleAddCart}
                          disabled={cartAdded}
                        >
                          {cartAdded
                            ? `✓ تمت إضافة ${allProducts.length} منتجات للسلة`
                            : `🛒 أضف كل محتويات التنسيق للسلة`}
                        </button>
                      </div>
                    </>
                  )}

                  {error && <div className="error">{error}</div>}
                </div>
              )}
            </div>

            <button className="product-page-add-cart">
              <span>🛒</span> إضافة لسلة التسوق
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function PageTansiqRow({ row, thermosColor, onFetch, onSelectColor, onDragStart, onMobileSelect }) {
  const colors = [...new Set(row.allProducts.map(p => p.color).filter(c => c && c.trim()))]
  const filteredProducts = row.selectedColor
    ? row.allProducts.filter(p => p.color === row.selectedColor)
    : row.allProducts

  return (
    <div className="page-tansiq-row">
      <div className="page-tansiq-row-head">
        <h4>🔍 {row.label}</h4>
        <button
          className="page-tansiq-row-fetch"
          onClick={onFetch}
          disabled={row.loading}
        >
          {row.loading ? '⏳ جاري الجلب...' : (row.hasFetched ? 'إعادة الجلب' : 'جلب المنتجات')}
        </button>
      </div>

      {row.hasFetched && colors.length > 0 && (
        <div className="page-tansiq-color-filter">
          <span className="page-tansiq-color-question">
            🎨 أي لون يناسب الترمس{thermosColor ? ` (${thermosColor})` : ''}؟
          </span>
          <div className="page-tansiq-color-chips">
            {colors.map(c => (
              <button
                key={c}
                className={`page-tansiq-color-chip ${row.selectedColor === c ? 'active' : ''}`}
                onClick={() => onSelectColor(c)}
              >
                {c}
              </button>
            ))}
            {row.selectedColor && (
              <button
                className="page-tansiq-color-chip clear"
                onClick={() => onSelectColor(row.selectedColor)}
              >
                ✕ كل الألوان
              </button>
            )}
          </div>
        </div>
      )}

      {row.error && <div className="error" style={{ marginTop: '0.5rem' }}>{row.error}</div>}

      {filteredProducts.length > 0 && (
        <div className="page-tansiq-row-products">
          {filteredProducts.map((p, i) => (
            <div
              key={i}
              className="page-tansiq-mini-card"
              draggable
              onDragStart={(e) => onDragStart(e, p)}
              title="اسحب إلى صندوق التنسيق أو اضغط +"
            >
              <button
                type="button"
                className="page-tansiq-select-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  e.preventDefault()
                  onMobileSelect(p, e)
                }}
                aria-label="إضافة للتنسيق"
                title="إضافة للتنسيق"
              >+</button>
              <img src={p.image_link} alt={p.title} />
              <div className="page-tansiq-mini-title">{p.title}</div>
              <div className="page-tansiq-mini-meta">
                <span className="page-tansiq-mini-price">{p.price} ر.س</span>
                {p.color && <span className="page-tansiq-mini-color">{p.color}</span>}
              </div>

              {/* 🔍 Hover popup — enlarged image + name */}
              <div className="page-tansiq-hover-popup">
                <img src={p.image_link} alt={p.title} />
                <div className="page-tansiq-hover-title">{p.title}</div>
                {p.color && <div className="page-tansiq-hover-meta">{p.color}{p.size ? ` · ${p.size}` : ''}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {row.hasFetched && filteredProducts.length === 0 && !row.loading && (
        <div className="page-tansiq-row-empty">
          {row.selectedColor ? `لا توجد منتجات بلون "${row.selectedColor}"` : 'لا توجد نتائج'}
        </div>
      )}
    </div>
  )
}

function RecommendationCard({ type, data, icon, label, featured }) {
  if (!data) return null

  return (
    <a
      href={data.link}
      target="_blank"
      rel="noopener noreferrer"
      className={`rec-card rec-${type} ${featured ? 'featured' : ''}`}
    >
      {data.hasDiscount && (
        <div className="rec-discount-badge">-{data.discountPercentage}%</div>
      )}
      {featured && <div className="rec-featured-badge">الأكثر مبيعاً</div>}
      
      <div className="rec-image-wrapper">
        <img src={data.image_link} alt={data.title} className="rec-image" />
      </div>
      
      <div className="rec-content">
        <div className="rec-label">
          <span className="rec-icon">{icon}</span>
          <span className={`rec-label-text rec-label-${type}`}>{label}</span>
        </div>

        <h4 className="rec-title">{data.title}</h4>

        {data.marketing && (
          <p className={`rec-marketing rec-marketing-${type}`}>{data.marketing}</p>
        )}

        <div className="rec-prices">
          <span className={`rec-price rec-price-${type}`}>{data.price}</span>
          {data.hasDiscount && data.originalPrice && (
            <span className="rec-original-price">{data.originalPrice}</span>
          )}
        </div>

        {data.pros && data.pros.length > 0 && (
          <div className="rec-pros">
            <div className="rec-pros-title">✅ المميزات:</div>
            <ul className="rec-pros-list">
              {data.pros.slice(0, 3).map((pro, idx) => (
                <li key={idx}>{pro}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </a>
  )
}

function getEmojiForIcon(iconName) {
  const iconMap = {
    'coffee': '☕', 'kitchen': '🍳', 'package': '📦', 'gift': '🎁',
    'home': '🏠', 'fridge': '❄️', 'fire': '🔥', 'sparkles': '✨',
    'cart': '🛒', 'heart': '❤️', 'cup': '🍵', 'tool': '🔧',
  }
  return iconMap[iconName] || '🔍'
}

export default App
