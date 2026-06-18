require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const { Client } = require('@elastic/elasticsearch');
const OpenAI = require('openai');
const { GoogleGenAI } = require('@google/genai');
const { CohereClient } = require('cohere-ai');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const esClient = new Client({
  node: process.env.ELASTIC_ENDPOINT,
  auth: { apiKey: process.env.ELASTIC_API_KEY },
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

// Cohere (اختياري): إذا المفتاح موجود نستخدم Cohere للـ embeddings والـ rerank
const cohere = process.env.COHERE_API_KEY
  ? new CohereClient({ token: process.env.COHERE_API_KEY })
  : null;

// ⚡ Local AI (Ollama): self-hosted، أسرع للـ embeddings، أبطأ للـ LLM بدون GPU
const USE_LOCAL_EMBED = process.env.USE_LOCAL_EMBED === 'true';
const USE_LOCAL_LLM = process.env.USE_LOCAL_LLM === 'true';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'bge-m3';
const OLLAMA_LLM_MODEL = process.env.OLLAMA_LLM_MODEL || 'qwen2.5:3b';

async function localEmbed(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`Ollama embed: HTTP ${res.status}`);
  const data = await res.json();
  return data.embedding;
}

async function localVision({ prompt, imageDataUrl, jsonMode = true, temperature = 0.3 }) {
  // إزالة الـ prefix "data:image/jpeg;base64," وإبقاء base64 فقط
  const base64 = imageDataUrl.includes(',') ? imageDataUrl.split(',')[1] : imageDataUrl;
  const body = {
    model: process.env.OLLAMA_VISION_MODEL || 'llava:7b',
    stream: false,
    messages: [{ role: 'user', content: prompt, images: [base64] }],
    options: { temperature },
  };
  if (jsonMode) body.format = 'json';

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ollama vision: HTTP ${res.status}`);
  const data = await res.json();
  return data.message?.content || '';
}

// 🌐 Local Rerank via @xenova/transformers (ESM → dynamic import)
let _rerankerPipeline = null;
async function getLocalReranker() {
  if (_rerankerPipeline) return _rerankerPipeline;
  const { pipeline, env: txEnv } = await import('@xenova/transformers');
  txEnv.cacheDir = './models-cache';
  console.log('🚀 Loading BGE-Reranker (first time — downloads ~250MB)...');
  _rerankerPipeline = await pipeline('text-classification', 'Xenova/bge-reranker-base');
  console.log('✅ BGE-Reranker loaded');
  return _rerankerPipeline;
}

// 🖼️ CLIP — بحث بصري حقيقي (image → embedding مباشرة)
let _clipPipeline = null;
async function getClipPipeline() {
  if (_clipPipeline) return _clipPipeline;
  const { pipeline, env: txEnv } = await import('@xenova/transformers');
  txEnv.cacheDir = './models-cache';
  console.log('🚀 Loading CLIP image encoder (first time — downloads ~150MB)...');
  _clipPipeline = await pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32');
  console.log('✅ CLIP loaded');
  return _clipPipeline;
}

// CLIP text encoder — يستخدم CLIPTextModelWithProjection مباشرة
// (the 'feature-extraction' pipeline يحاول تشغيل image encoder ويفشل بدون pixel_values)
let _clipTextModel = null;
let _clipTokenizer = null;
async function getClipTextModel() {
  if (_clipTextModel && _clipTokenizer) return { model: _clipTextModel, tokenizer: _clipTokenizer };
  const { AutoTokenizer, CLIPTextModelWithProjection, env: txEnv } = await import('@xenova/transformers');
  txEnv.cacheDir = './models-cache';
  console.log('🚀 Loading CLIP text encoder...');
  _clipTokenizer = await AutoTokenizer.from_pretrained('Xenova/clip-vit-base-patch32');
  _clipTextModel = await CLIPTextModelWithProjection.from_pretrained('Xenova/clip-vit-base-patch32');
  console.log('✅ CLIP text encoder loaded');
  return { model: _clipTextModel, tokenizer: _clipTokenizer };
}

async function clipTextEmbedding(text) {
  const { model, tokenizer } = await getClipTextModel();
  const inputs = tokenizer(text, { padding: true, truncation: true });
  const out = await model(inputs);
  // text_embeds: tensor [1, 512] — نفس الـ space كـ image embedding
  const arr = Array.from(out.text_embeds.data);
  // L2-normalize للمقارنة بالـ cosine
  const norm = Math.sqrt(arr.reduce((s, x) => s + x * x, 0)) || 1;
  return arr.map(x => x / norm);
}

// ترجمة استعلام عربي إلى إنجليزي للـ CLIP (يفهم الإنجليزي أساساً)
async function translateForClip(arabicQuery) {
  const key = (arabicQuery || '').toLowerCase().trim();
  const cached = translationCache.get(key);
  if (cached !== undefined) return cached;

  // لو الكلمة إنجليزية أصلاً، نمررها كما هي
  if (/^[\x00-\x7F\s]+$/.test(arabicQuery)) {
    translationCache.set(key, arabicQuery);
    return arabicQuery;
  }

  if (!openai) {
    translationCache.set(key, arabicQuery);
    return arabicQuery;
  }
  try {
    const r = await openai.chat.completions.create({
      model: 'gpt-4.1-nano',
      messages: [{
        role: 'user',
        content: `Translate this Arabic product search to short English (just the product noun(s), nothing else). Examples: "ثلاجة" → "refrigerator", "ماكينة قهوة" → "coffee machine", "قلاية هوائية" → "air fryer", "ترمس" → "thermos".\n\nArabic: "${arabicQuery}"\nEnglish:`,
      }],
      temperature: 0,
      max_tokens: 30,
    });
    const translated = (r.choices[0]?.message?.content || '').trim().replace(/^["']|["']$/g, '');
    translationCache.set(key, translated);
    return translated || arabicQuery;
  } catch {
    translationCache.set(key, arabicQuery);
    return arabicQuery;
  }
}

async function clipImageEmbedding(imageInput) {
  const featurer = await getClipPipeline();
  let target = imageInput;
  let tempFile = null;
  // لو data URL: ينحفظ مؤقتاً ثم نمرّر المسار
  if (typeof imageInput === 'string' && imageInput.startsWith('data:image/')) {
    const base64 = imageInput.split(',')[1];
    const buffer = Buffer.from(base64, 'base64');
    tempFile = path.join(require('os').tmpdir(), `clip-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
    fs.writeFileSync(tempFile, buffer);
    target = tempFile;
  }
  try {
    const result = await featurer(target);
    return Array.from(result.data);
  } finally {
    if (tempFile) { try { fs.unlinkSync(tempFile); } catch {} }
  }
}


// 🎯 Focused query embedding — للبحث بالصورة لما يرفع المستخدم صورة فيها عدة منتجات
// متوسط مرجّح: 35% للصورة الكاملة + 65% للقَصّ المركزي (60% من الجانب الأقصر)
// النتيجة: التركيز على المنتج اللي في وسط الصورة بدل المشهد كله
async function clipImageEmbeddingFocused(imageInput) {
  const sharp = require('sharp');
  const os = require('os');
  const fsx = require('fs');
  if (typeof imageInput !== 'string' || !imageInput.startsWith('data:image/')) {
    return clipImageEmbedding(imageInput);
  }
  const base64 = imageInput.split(',')[1];
  const buffer = Buffer.from(base64, 'base64');
  const tmps = [];
  try {
    const meta = await sharp(buffer).metadata();
    const W = meta.width || 0;
    const H = meta.height || 0;
    const side = Math.min(W, H);
    if (!side || side < 64) return clipImageEmbedding(imageInput);

    // 🎯 Multi-region ensemble — يلتقط المنتج سواء كان مركزياً أو علوياً
    // Banner/category images غالباً يكون المنتج في النصف العلوي مع نص بالأسفل
    const mkCrop = async (frac, posY, suffix) => {
      const s = Math.floor(side * frac);
      const l = Math.floor((W - s) / 2);
      // posY: 0 = top edge, 0.5 = center, 1 = bottom edge
      const tmax = Math.max(0, H - s);
      const t = Math.floor(tmax * posY);
      const fp = path.join(os.tmpdir(), 'clip-' + suffix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.jpg');
      tmps.push(fp);
      await sharp(buffer).extract({ left: l, top: t, width: s, height: s }).jpeg().toFile(fp);
      return fp;
    };

    const fpFull = path.join(os.tmpdir(), 'clip-full-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.jpg');
    tmps.push(fpFull);
    await sharp(buffer).jpeg().toFile(fpFull);
    // center crops
    const fpCenter60 = await mkCrop(0.60, 0.5, 'c60');
    const fpTight45 = await mkCrop(0.45, 0.5, 'c45');
    // upper-biased crop — يلتقط المنتجات في النصف العلوي (banner/category images)
    const fpUpper55 = await mkCrop(0.55, 0.25, 'up55');

    const featurer = await getClipPipeline();
    const [outFull, outCenter, outTight, outUpper] = await Promise.all([
      featurer(fpFull),
      featurer(fpCenter60),
      featurer(fpTight45),
      featurer(fpUpper55),
    ]);
    const vFull = Array.from(outFull.data);
    const vCenter = Array.from(outCenter.data);
    const vTight = Array.from(outTight.data);
    const vUpper = Array.from(outUpper.data);

    // Weighted blend across 4 regions:
    //   - tight center (heaviest) — pure product, no text/logos
    //   - center 60% — product + light context
    //   - upper crop — catches products in top portion (banners with bottom text)
    //   - full — overall scene
    const blended = new Array(vFull.length);
    for (let i = 0; i < vFull.length; i++) {
      blended[i] = 0.15 * vFull[i] + 0.25 * vCenter[i] + 0.35 * vTight[i] + 0.25 * vUpper[i];
    }
    let norm = 0;
    for (const x of blended) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < blended.length; i++) blended[i] /= norm;
    return blended;
  } finally {
    for (const t of tmps) { try { fsx.unlinkSync(t); } catch {} }
  }
}

async function localRerank(query, documents) {
  const reranker = await getLocalReranker();
  const scores = [];
  for (let i = 0; i < documents.length; i++) {
    try {
      const out = await reranker(query, { text_pair: documents[i] });
      scores.push({ index: i, score: out[0]?.score || 0 });
    } catch {
      scores.push({ index: i, score: 0 });
    }
  }
  return scores.sort((a, b) => b.score - a.score);
}

async function localChat({ prompt, history = [], jsonMode = true, temperature = 0.3 }) {
  const messages = [];
  history.slice(-6).forEach(m => {
    messages.push({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: typeof m.content === 'string' ? m.content : (m.content?.reply || ''),
    });
  });
  messages.push({ role: 'user', content: prompt });

  const body = {
    model: OLLAMA_LLM_MODEL,
    messages,
    stream: false,
    options: { temperature },
  };
  if (jsonMode) body.format = 'json';

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ollama chat: HTTP ${res.status}`);
  const data = await res.json();
  return data.message?.content || '';
}
const USE_COHERE = !!cohere;
const EMBEDDING_DIMS = USE_COHERE ? 1024 : 1536;
const COHERE_EMBED_MODEL = 'embed-multilingual-v3.0';
const COHERE_RERANK_MODEL = 'rerank-v3.5';

const INDEX_NAME = process.env.INDEX_NAME || 'products';
const EMBED_PROVIDER = USE_LOCAL_EMBED ? `Ollama/${OLLAMA_EMBED_MODEL}` : USE_COHERE ? 'Cohere' : 'OpenAI';
const LLM_PROVIDER = USE_LOCAL_LLM ? `Ollama/${OLLAMA_LLM_MODEL}` : USE_COHERE ? 'Cohere' : 'OpenAI';
console.log(`📁 ES index: ${INDEX_NAME}\n🧠 Embeddings: ${EMBED_PROVIDER}\n💬 LLM: ${LLM_PROVIDER}`);

// قاموس البحث بكود المنتج (id / mpn / sku) - يُحمَّل من CSV عند بدء السيرفر
let productByCode = new Map();
const CSV_PATH = path.join(__dirname, 'data', 'products.csv');

function loadProductCatalog() {
  return new Promise((resolve, reject) => {
    const map = new Map();
    fs.createReadStream(CSV_PATH)
      .pipe(parse({ columns: true, skip_empty_lines: true }))
      .on('data', (row) => {
        if (!row.title) return;
        const product = {
          title: (row.title || '').trim(),
          image_link: (row.image_link || '').trim(),
          price: row.price || '',
          sale_price: row.sale_price || '',
          brand: (row.brand || '').trim(),
          link: (row.link || '').trim(),
          color: (row.color || '').trim(),
          size: (row.size || '').trim(),
        };
        for (const code of [row.id, row.mpn, row.sku]) {
          if (code && code.trim()) {
            map.set(code.trim().toUpperCase(), product);
          }
        }
      })
      .on('end', () => { productByCode = map; resolve(map.size); })
      .on('error', reject);
  });
}

// كشف هل الـ query بحث بكود منتج (كامل أو جزئي)
// القواعد: لا حروف عربية، فقط [A-Za-z0-9-]، و:
//   A) يحتوي على شرطة "-"  → كود
//   B) يحتوي على حرف + رقم  → كود
//   C) أرقام بحتة بطول 3+  → بريفيكس كود (المستخدم حذف آخر أرقام)
function isProductCodeQuery(q) {
  if (!q) return false;
  const t = q.trim();
  if (t.length < 2 || t.length > 30) return false;
  if (!/^[A-Za-z0-9-]+$/.test(t)) return false; // لاتيني فقط (لا عربي ولا فراغات)
  if (/-/.test(t)) return true;                  // قاعدة A
  if (/[A-Za-z]/.test(t) && /\d/.test(t)) return true; // قاعدة B
  if (/^\d{3,}$/.test(t)) return true;           // قاعدة C
  return false;
}

// بحث في قاموس الأكواد: مطابقة كاملة أو بريفيكس (حتى 30 نتيجة)
function lookupByCode(query) {
  const code = query.trim().toUpperCase();
  const exact = productByCode.get(code);
  if (exact) return [{ code, product: exact }];

  const seen = new Set();
  const matches = [];
  for (const [k, v] of productByCode.entries()) {
    if (!k.startsWith(code)) continue;
    const dedupeKey = v.link || v.title;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    matches.push({ code: k, product: v });
    if (matches.length >= 30) break;
  }
  return matches;
}

// Keywords for detecting accessories (الملحقات)
const ACCESSORY_KEYWORDS = [
  'وعاء', 'سلة', 'غطاء', 'كيس', 'فلتر', 'ملحق', 'قطعة غيار',
  'حشوة', 'مخلب', 'ملعقة', 'مقشطة', 'فرشاة', 'سن', 'شفرة',
  'ورق', 'بطانة', 'حامل', 'سدادة', 'صينية', 'رف داخلي',
  // إضافات لتفادي ظهور الإكسسوارات الصغيرة بدلاً من الجهاز الرئيسي
  'درج', 'علبة', 'علب', 'حاوية', 'مفصلة', 'مقبض', 'زاوية', 'أنبوب',
  'خرطوم', 'سلك', 'موزّع', 'موزع', 'منفاخ',
  // shipping/storage and dish-rack accessories
  'شنطة', 'نشاف', 'نشافة', 'استاند', 'منشفة',
  'يدوي', 'يدوية', 'يدويه',
];

// كلمات تدل على جهاز كهربائي (لو موجودة في البحث = جهاز 100%)

// قسم 1: كلمات "نوع الجهاز" العامة (تُحذف من الموضوع لأنها بادئة)
// مثال: "ماكينة قهوة" → نشيل "ماكينة" → الموضوع "قهوة"
const GENERIC_DEVICE_WORDS = [
  'ماكينة', 'مكينة', 'مكنة',
  'آلة', 'الة',
  'جهاز',
  'صانعة', 'صانع',
];

// قسم 2: أسماء أجهزة محددة (تبقى في الموضوع لأنها الاسم الفعلي للجهاز)
// مثال: "غسالة ملابس" → الموضوع "غسالة ملابس" (نبحث عن "غسال")
const SPECIFIC_DEVICE_NAMES = [
  'ثلاجة', 'ثلاجات',
  'غسالة', 'غسالات',
  'نشافة', 'نشافات',
  'فرن', 'أفران', 'افران',
  'خلاط', 'خلاطات',
  'مكواة', 'مكاوي',
  'مكنسة', 'مكانس',
  'محمصة', 'محمصات',
  'دفاية', 'مدفأة', 'مدافئ',
  'سخان', 'سخانات',
  'مكيف', 'مكيفات',
  'مروحة', 'مراوح',
  'قلاية', 'قلايات',
  'شواية', 'شوايات',
  'ميكروويف',
  'طباخ', 'طبّاخ',
  'مبرد', 'مبردات',
  'مطحنة', 'مطاحن',
  'عصارة', 'عصارات',
  'عجانة', 'عجانات',
  'غلاية', 'غلايات',
  'محضّر', 'محضر',
];

// قائمة موحدة لكشف أنواع البحث (للفحص السريع)
const DEVICE_INDICATORS = [...GENERIC_DEVICE_WORDS, ...SPECIFIC_DEVICE_NAMES];

// 🎯 KIND_HINTS — يربط كلمة البحث الأساسية بـ product_kind المتوقع
// عند البحث "فرن"، المستخدم يبي appliance (الجهاز)، مو cookware (الأواني)
// نستخدم هذي الخريطة لترتيب النتائج: المنتجات بـ kind المتوقع تأتي أولاً
const KIND_HINTS = {
  // Appliances (الأجهزة الكهربائية)
  'فرن': 'appliance',
  'ثلاجة': 'appliance',
  'غسالة': 'appliance',
  'نشافة': 'appliance',
  'مكيف': 'appliance',
  'مكنسة': 'appliance',
  'مكواة': 'appliance',
  'خلاط': 'appliance',
  'محضر': 'appliance',
  'مطحنة': 'appliance',
  'عصارة': 'appliance',
  'قلاية': 'appliance',
  'محمصة': 'appliance',
  'ميكروويف': 'appliance',
  'بوتاجاز': 'appliance',
  'شواية': 'appliance',
  'دفاية': 'appliance',
  'سخان': 'appliance',
  'مدفأة': 'appliance',
  'مروحة': 'appliance',
  'صانعة': 'appliance',
  'محضّر': 'appliance',
  'عجانة': 'appliance',
  'غلاية': 'appliance',
  'طباخ': 'appliance',
  'مبرد': 'appliance',
  'موقد': 'appliance',
  // Thermoses
  'ترامس': 'thermos',
  'ترمس': 'thermos',
  'فاكيوم': 'thermos',
  'ثرموس': 'thermos',
  // Serveware
  'فنجال': 'serveware',
  'فنجان': 'serveware',
  'فناجين': 'serveware',
  'فناجيل': 'serveware',
  'كوب': 'serveware',
  'أكواب': 'serveware',
  'كاسة': 'serveware',
  'بيالة': 'serveware',
  'بيالات': 'serveware',
  'صحن': 'serveware',
  'صحون': 'serveware',
  'طبق': 'serveware',
  'أطباق': 'serveware',
  'دلة': 'serveware',
  'دلال': 'serveware',
  'إبريق': 'serveware',
  'ابريق': 'serveware',
  'صينية': 'serveware',
  'طوفرية': 'serveware',
  // Cookware (أدوات الطبخ)
  'قدر': 'cookware',
  'حلة': 'cookware',
  'مقلاة': 'cookware',
  'طاسة': 'cookware',
  'وعاء': 'cookware',
  'سلطانية': 'cookware',
  // Kitchen tools
  'سكين': 'kitchen_tool',
  'سكاكين': 'kitchen_tool',
  'ملعقة': 'kitchen_tool',
  'ملاعق': 'kitchen_tool',
  'شوكة': 'kitchen_tool',
  'مبشرة': 'kitchen_tool',
  // Storage
  'علبة': 'storage',
  'علب': 'storage',
  'حافظة': 'storage',
};

// نُرجع الـ kind المتوقع للبحث (أو null لو الكلمة عامة)
function getExpectedKind(query) {
  if (!query) return null;
  const words = query.toLowerCase().trim().split(/\s+/);
  for (const w of words) {
    const normalized = normalizeArabicText ? normalizeArabicText(w) : w;
    if (KIND_HINTS[w]) return KIND_HINTS[w];
    if (KIND_HINTS[normalized]) return KIND_HINTS[normalized];
  }
  return null;
}

function extractPrice(priceStr) {
  if (!priceStr) return 0;
  const match = String(priceStr).match(/[\d.]+/);
  return match ? parseFloat(match[0]) : 0;
}

function getDiscountInfo(price, salePrice) {
  const original = extractPrice(price);
  const sale = extractPrice(salePrice);
  
  if (original > 0 && sale > 0 && sale < original) {
    const percentage = Math.round(((original - sale) / original) * 100);
    return {
      hasDiscount: true,
      originalPrice: price,
      salePrice: salePrice,
      discountPercentage: percentage,
    };
  }
  
  return {
    hasDiscount: false,
    originalPrice: price,
    salePrice: null,
    discountPercentage: 0,
  };
}

// كشف نوع البحث بـ AI
async function classifySearchType(query) {
  // ⚡ فحص سريع وحاسم: لو البحث يحتوي على كلمة تدل على جهاز
  // (ماكينة/آلة/جهاز/صانعة أو اسم جهاز محدد) → نصنّفه كجهاز فوراً بدون استدعاء AI
  const queryPadded = ' ' + (query || '').toLowerCase().trim() + ' ';
  const matchedIndicator = DEVICE_INDICATORS.find(word => {
    // مطابقة بحدود الكلمات (مسافة قبل وبعد) لتجنب المطابقات الجزئية
    const regex = new RegExp(`\\s${word}\\s`, 'u');
    return regex.test(queryPadded);
  });
  
  if (matchedIndicator) {
    console.log(`⚡ Quick classify: "${query}" → device (matched: "${matchedIndicator}")`);
    return {
      type: 'device',
      excludeAccessories: true,
      preferHomeElec: true,
      deviceKeyword: query,
    };
  }
  
  // كاش
  const cacheKey = (query || '').toLowerCase().trim();
  const cached = classifyCache.get(cacheKey);
  if (cached) return cached;

  // إذا ما لقينا نمط واضح، نستخدم AI للتصنيف
  try {
    const prompt = `حلّل البحث وحدّد نوعه:

البحث: "${query}"

الأنواع المحتملة:
1. "device" - جهاز كهربائي رئيسي (قلاية هوائية، ثلاجة، غسالة، ماكينة قهوة، فرن، خلاط، إلخ)
2. "accessory" - ملحق أو قطعة غيار (وعاء، سلة، فلتر، غطاء، إلخ)
3. "kitchenware" - أدوات مطبخ غير كهربائية (فناجين، صحون، أكواب، طناجر، إلخ)
4. "general" - بحث عام أو غير محدد

أعد JSON فقط:
{
  "type": "device/accessory/kitchenware/general",
  "excludeAccessories": true/false,
  "preferHomeElec": true/false,
  "deviceKeyword": "الكلمة الأساسية للجهاز (إن وجدت)"
}

ملاحظات:
- excludeAccessories = true لو النوع "device" (نستبعد الملحقات من النتائج)
- preferHomeElec = true لو النوع "device" (نفضّل ماركة home elec)
- deviceKeyword: الكلمة الأساسية في البحث (مثال: "قلاية هوائية" → "قلاية هوائية")`;

    const text = await cohereChat({ prompt, jsonMode: true, temperature: 0.3 });
    const result = JSON.parse(text);
    classifyCache.set(cacheKey, result);
    return result;
  } catch (error) {
    console.error('Search classification error:', error.message);
    return { type: 'general', excludeAccessories: false, preferHomeElec: false, deviceKeyword: '' };
  }
}

// 🧠 wrapper موحّد لـ Cohere chat — يستبدل OpenAI chat
const COHERE_CHAT_MODEL = 'command-r-08-2024';
const COHERE_VISION_MODEL = 'command-a-vision-07-2025';

async function cohereChat({ prompt, history = [], jsonMode = true, temperature = 0.3, maxTokens }) {
  // 🔄 dispatch chain: Local → Cohere → OpenAI fallback (يضمن استمرار العمل)
  if (USE_LOCAL_LLM) {
    try { return await localChat({ prompt, history, jsonMode, temperature }); }
    catch (e) { console.warn('Local LLM failed → fallback:', e.message); }
  }

  if (cohere) {
    try {
      const chatHistory = history.slice(-6).map(m => ({
        role: m.role === 'user' ? 'USER' : 'CHATBOT',
        message: typeof m.content === 'string' ? m.content : (m.content?.reply || ''),
      }));
      const response = await cohere.chat({
        model: COHERE_CHAT_MODEL,
        message: prompt,
        chatHistory: chatHistory.length > 0 ? chatHistory : undefined,
        responseFormat: jsonMode ? { type: 'json_object' } : undefined,
        temperature,
        maxTokens,
      });
      return response.text;
    } catch (e) {
      console.warn('Cohere failed → OpenAI:', e.message);
    }
  }

  if (!openai) throw new Error('No LLM provider configured');
  const messages = [
    ...history.slice(-6).map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: typeof m.content === 'string' ? m.content : (m.content?.reply || ''),
    })),
    { role: 'user', content: prompt },
  ];
  const completion = await openai.chat.completions.create({
    model: 'gpt-4.1-nano',
    messages,
    temperature,
    response_format: jsonMode ? { type: 'json_object' } : undefined,
    max_tokens: maxTokens,
  });
  return completion.choices[0].message.content;
}

// ⚡ دالة embedding مع كاش + dispatch بين Local/Cohere/OpenAI
async function getQueryEmbedding(query) {
  const key = (query || '').toLowerCase().trim();
  const cached = embeddingCache.get(key);
  if (cached) return cached;

  let emb;
  if (USE_LOCAL_EMBED) {
    emb = await localEmbed(query);
  } else if (USE_COHERE) {
    const res = await cohere.embed({
      texts: [query],
      model: COHERE_EMBED_MODEL,
      inputType: 'search_query',
    });
    emb = res.embeddings[0];
  } else {
    const res = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
    });
    emb = res.data[0].embedding;
  }

  embeddingCache.set(key, emb);
  return emb;
}

// فحص هل المنتج ملحق أو جهاز
// 🎯 يفحص هل المنتج ملحق
// query (اختياري): إذا الـ query يحوي accessory keyword → لا نعتبر المنتج ملحقاً
// (المستخدم طلبه صراحة، مثل: "شنطة ترامس" يبي شناطات، ما يبي يستبعدها)
function isAccessory(title, deviceKeyword, query = '') {
  if (!title) return false;
  const titleLower = title.toLowerCase().trim();
  const firstWords = titleLower.split(/\s+/).slice(0, 3);
  const matchedAccessory = firstWords.find(w => ACCESSORY_KEYWORDS.includes(w));
  if (!matchedAccessory) return false;
  // ✨ الحل الجذري: إذا الـ query يطلب هذا النوع من الـ accessory صراحة، لا نستبعده
  if (query) {
    const queryWords = query.toLowerCase().split(/\s+/);
    if (queryWords.includes(matchedAccessory)) return false;
  }
  return true;
}

// أجهزة كبيرة — أي مقاس "X مل" أو "X لتر" حيث X<10، أو "اطفال" يُستبعد
const LARGE_APPLIANCE_WORDS = new Set([
  'ثلاجة', 'ثلاجات',
  'غسالة', 'غسالات',
  'نشافة', 'نشافات', 'مجفف', 'مجففة',
  'فرن', 'أفران', 'افران',
  'مكيف', 'مكيفات',
  'ميكروويف',
  'سخان', 'سخانة',
]);

function queryIsLargeAppliance(query) {
  if (!query) return false;
  const words = query.trim().split(/\s+/);
  const hasLarge = words.some(w => LARGE_APPLIANCE_WORDS.has(w));
  if (!hasLarge) return false;
  // إذا الـ query نفسه يحتوي إشارات "صغير" → المستخدم يريد منتجات صغيرة، نُعطّل الفلتر
  // مثل: "ثلاجة اطفال" / "ثلاجة 1 لتر" / "ثلاجة 600 مل"
  const q = query.toLowerCase();
  if (q.includes('اطفال') || q.includes('أطفال')) return false;
  if (/\d+\s*مل(?:\s|$)/.test(q)) return false;
  const m = q.match(/(\d+(?:\.\d+)?)\s*لتر/);
  if (m && parseFloat(m[1]) < 10) return false;
  return true;
}

// منتج "صغير" (لا يطابق توقّع الجهاز الكبير): "اطفال" أو مقاسات أقل من 10 لتر/مل
// \b لا تعمل مع العربية في JavaScript، فنعتمد على فحص الكلمات يدوياً
function isUndersizedForLargeAppliance(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  // كلمة "اطفال/أطفال" → ترمس أطفال، ليس جهاز
  if (t.includes('اطفال') || t.includes('أطفال')) return true;
  // مقاس بالميليلتر = صغير جداً (مثل "600 مل")
  if (/\d+\s*مل(?:\s|$)/.test(t)) return true;
  // "X لتر" حيث X < 10
  const m = t.match(/(\d+(?:\.\d+)?)\s*لتر/);
  if (m && parseFloat(m[1]) < 10) return true;
  return false;
}

// 🎯 استخراج "موضوع البحث" بإزالة كلمات الأجهزة العامة فقط
// نشيل فقط الكلمات العامة (ماكينة/آلة/جهاز/صانعة) ونحتفظ بأسماء الأجهزة المحددة
// مثال: "ماكينة قهوة" → "قهوة" (نشيل "ماكينة")
// مثال: "غسالة ملابس" → "غسالة ملابس" (لا نشيل "غسالة" لأنها اسم الجهاز نفسه)
// كلمات Modifier تُستبعد من الموضوع (لون/مادة/صفة)
// لأنها تُطبَّق كفلتر منفصل (modifier filter / color field) وليست جزءاً من اسم المنتج
const SUBJECT_MODIFIERS = [
  // ألوان
  'احمر','أحمر','حمراء',
  'ابيض','أبيض','بيضاء',
  'اسود','أسود','سوداء',
  'ازرق','أزرق','زرقاء',
  'اصفر','أصفر','صفراء',
  'اخضر','أخضر','خضراء',
  'بني','بنية',
  'وردي','وردية',
  'برتقالي','برتقالية',
  'رمادي','رمادية',
  'بنفسجي','بنفسجية',
  'ذهبي','ذهبية',
  'فضي','فضية',
  'نحاسي','نحاسية',
  // مواد
  'إستيل','استيل','ستيل','ستانلس',
  'زجاج','زجاجي','زجاجية',
  'بلاستيك','بلاستيكي','بلاستيكية',
  'سيراميك',
  'خشب','خشبي','خشبية',
  'جرانيت','ميلامين',
  // مصدر طاقة
  'كهربائي','كهربائية','كهرباء',
  'يدوي','يدوية','يدويه',
  'لاسلكي','لاسلكية',
  // نوع تشغيل
  'بخار','بخاري','بخارية',
  'هوائي','هوائية',
  'إنفرتر','انفرتر',
  // صفات عامة
  'صغير','صغيرة','كبير','كبيرة','متوسط','متوسطة',
  'جديد','جديدة','أصلي','اصلي','أصلية','اصلية',
  'مميز','مميزة','فاخر','فاخرة',
  'منزلي','منزلية',
  // تصميم
  'مدمج','مدمجة','سبلت','شباك','متنقل','بابين','مفرد','طقم',
];

function extractSubject(query) {
  if (!query) return '';
  // طبّع كلمات الـ strip list (يوحد الألف بأشكاله: آ/أ/إ → ا)
  const wordsToStrip = new Set([...GENERIC_DEVICE_WORDS, ...SUBJECT_MODIFIERS].map(w => normalizeArabicText(w)));
  // قسّم الـ query، طبّع كل كلمة قبل المقارنة، حتى نلتقط "ألة"/"آلة"/"الة" كنفس الكلمة
  const filtered = query.toLowerCase().trim().split(/\s+/).filter(w => {
    if (!w) return false;
    if (/^\d+(\.\d+)?$/.test(w)) return false;
    if (/^(لتر|مل|كجم|كيلو|واط|بار|انش|سم|متر)$/.test(w)) return false;
    const normalized = normalizeArabicText(w);
    if (wordsToStrip.has(normalized)) return false;
    return true;
  });
  return filtered.join(' ');
}


// 🔤 تطبيع النص العربي (توحيد الحروف المتشابهة وإزالة التشكيل)
function normalizeArabicText(text) {
  if (!text) return '';
  return text.toLowerCase()
    .replace(/[آأإ]/g, 'ا')         // توحيد أشكال الألف
    .replace(/ى/g, 'ي')              // ألف مقصورة → ياء
    .replace(/[ًٌٍَُِّْ]/g, '')        // إزالة التشكيل
    .replace(/ء/g, '')                // إزالة الهمزة المنفردة (شواء → شوا)
    .replace(/ة/g, 'ه');              // التاء المربوطة → هاء (شواية → شوايه)
}

// 🌱 استخراج جذر الكلمة (إزالة اللواحق الشائعة)
// مثال: "ثلاجات" → "ثلاج"، "منزلية" → "منزل"، "ماكينة" → "ماكين"
function normalizeArabicWord(word) {
  let w = normalizeArabicText(word);
  // إزالة بادئة "ال" التعريفية (لو الكلمة أطول من 4 حروف)
  if (w.startsWith('ال') && w.length > 4) w = w.substring(2);
  // إزالة اللواحق الشائعة (الأطول أولاً)
  const suffixes = ['ات', 'ين', 'ون', 'ها', 'ية', 'ة', 'ه'];
  for (const suffix of suffixes) {
    if (w.endsWith(suffix) && w.length > suffix.length + 2) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w;
}

// 🌤️ تحديد الموسم الحالي (السعودية): يُستخدم لـ seasonal boost في الـ ranking
// نُرجع التصنيف الموسمي الأبرز للشهر الحالي (يطابق قيم product_seasonal من التصنيف)
function getCurrentSeason() {
  const m = new Date().getMonth() + 1; // 1-12
  // الصيف: مايو-سبتمبر (مكيفات، مراوح، عصارات، ثلاجات، آيس)
  if (m >= 5 && m <= 9) return 'summer';
  // الشتاء: ديسمبر-فبراير (مدافئ، مكاوي بخار، شاي/قهوة ساخنة)
  if (m === 12 || m === 1 || m === 2) return 'winter';
  // أغسطس-سبتمبر: عودة مدارس (مع الصيف، نُعطي الأولوية للصيف)
  return null;
}

// 🎯 خريطة المُحدِّدات: كلمة في الاستعلام → ما يجب أن يحتويه عنوان المنتج
// مثال: query="عصارة كهربائية" → لازم العنوان يحتوي كهرب|واط (مش يدوي/بلاستيك)
const MODIFIER_RULES = {
  // مصدر الطاقة
  'كهربائية': { require: /كهرب|واط|watt|electric|أوتوماتيك|اوتوماتيك/i, exclude: null },
  'كهربائي':  { require: /كهرب|واط|watt|electric|أوتوماتيك|اوتوماتيك/i, exclude: null },
  'كهرباء':   { require: /كهرب|واط|watt|electric/i, exclude: null },
  'يدوية':    { require: /يدوي/i, exclude: /كهرب|واط|electric|أوتوماتيك/i },
  'يدوي':     { require: /يدوي/i, exclude: /كهرب|واط|electric|أوتوماتيك/i },
  'لاسلكية':  { require: /لاسلكي|بطاري|cordless/i, exclude: null },
  'لاسلكي':   { require: /لاسلكي|بطاري|cordless/i, exclude: null },
  // نوع التشغيل
  'بخار':     { require: /بخار|steam/i, exclude: null },
  'بخارية':   { require: /بخار|steam/i, exclude: null },
  'بخاري':    { require: /بخار|steam/i, exclude: null },
  'هوائية':   { require: /هوائي|هواء/i, exclude: null },
  'هوائي':    { require: /هوائي|هواء/i, exclude: null },
  'إنفرتر':   { require: /إنفرتر|انفرتر|inverter/i, exclude: null },
  'انفرتر':   { require: /إنفرتر|انفرتر|inverter/i, exclude: null },
  'إنفرارد':  { require: /إنفرارد|انفرارد|infrared/i, exclude: null },
  // المادة
  'إستيل':    { require: /إستيل|استيل|ستيل|ستانلس|stainless|steel/i, exclude: null },
  'استيل':    { require: /إستيل|استيل|ستيل|ستانلس|stainless|steel/i, exclude: null },
  'زجاج':     { require: /زجاج|كريستال|glass|crystal/i, exclude: null },
  'زجاجية':   { require: /زجاج|glass/i, exclude: null },
  'زجاجي':    { require: /زجاج|glass/i, exclude: null },
  'بلاستيك':  { require: /بلاستيك|plastic/i, exclude: null },
  'سيراميك':  { require: /سيراميك|ceramic/i, exclude: null },
  'خشب':      { require: /خشب|wood/i, exclude: null },
  'خشبي':     { require: /خشب|wood/i, exclude: null },
  'خشبية':    { require: /خشب|wood/i, exclude: null },
  'جرانيت':   { require: /جرانيت|granite/i, exclude: null },
  'ميلامين':  { require: /ميلامين|melamine/i, exclude: null },
  // التصميم
  'بابين':    { require: /بابين|2 باب|بابان|دبل/i, exclude: null },
  'مدمج':     { require: /مدمج|built\s*in|بلت/i, exclude: null },
  'مدمجة':    { require: /مدمج|built\s*in|بلت/i, exclude: null },
  'سبلت':     { require: /سبلت|split/i, exclude: null },
  'شباك':     { require: /شباك|window/i, exclude: null },
  'متنقل':    { require: /متنقل|portable|محمول/i, exclude: null },
  // الحجم/السعة (يبقى للـ subject filter)
  // المنتج فردي/طقم
  'طقم':      { require: /طقم|set/i, exclude: null },
  'مفرد':     { require: /مفرد|قطعة|واحد|single/i, exclude: /طقم/i },
};

// يطبّق فلاتر المُحدِّدات على قائمة المنتجات بناءً على الـ query
// يحافظ على القائمة الأصلية لو الفلتر يطرد كل النتائج (لتجنب 0 نتائج)
function applyModifierFilters(query, products) {
  if (!query || !products || products.length === 0) return products;
  const tokens = query.toLowerCase().trim().split(/\s+/);
  let current = products;
  for (const tok of tokens) {
    const rule = MODIFIER_RULES[tok];
    if (!rule) continue;
    const filtered = current.filter(p => {
      const title = (p.title || '').toLowerCase();
      if (rule.require && !rule.require.test(title)) return false;
      if (rule.exclude && rule.exclude.test(title)) return false;
      return true;
    });
    // نطبّق فقط إذا الفلتر يبقي على عدد معقول (>= 1)
    if (filtered.length >= 1) {
      current = filtered;
      console.log(`🔧 Modifier "${tok}": ${products.length} → ${current.length} products`);
    }
  }
  return current;
}

// 🎯 فحص ذكي: هل عنوان المنتج يطابق "موضوع" البحث؟
// يستخدم تطبيع عربي + مطابقة بالجذر + قواعد ذكية للكلمات المتعددة
// ✨ يُرجع score من 0-1 يمثل نسبة تطابق كلمات الموضوع مع العنوان
// 1.0 = كل الكلمات موجودة، 0.5 = نصف الكلمات، 0 = لا شيء
function scoreSubjectMatch(title, subject) {
  if (!title || !subject) return 0;
  // 🎯 تطابق على مستوى الكلمة (stem-equality)، ليس substring
  // يمنع false positives مثل "قلايز" يطابق "قلاي" (stem لـ قلاية)
  const titleWords = normalizeArabicText(title).split(/\s+/).filter(w => w.length >= 2);
  const titleStems = new Set(titleWords.map(w => normalizeArabicWord(w)));
  // أيضاً نضيف الكلمات الكاملة كاحتياط (للأرقام والأسماء غير العربية)
  titleWords.forEach(w => titleStems.add(w));

  const subjectWords = subject.split(/\s+/).filter(w => w.length >= 2);
  if (subjectWords.length === 0) return 0;
  const subjectStems = subjectWords.map(w => normalizeArabicWord(w));

  let matched = 0;
  for (const stem of subjectStems) {
    if (titleStems.has(stem)) matched++;
  }
  return matched / subjectStems.length;
}

// للتوافق: يُرجع true لو السكور >= threshold معين
function titleMatchesSubject(title, subject, minScore = 1.0) {
  return scoreSubjectMatch(title, subject) >= minScore;
}

app.get('/', (req, res) => {
  res.json({ message: 'Backend is running!' });
});

app.get('/test-elastic', async (req, res) => {
  try {
    const info = await esClient.info();
    const count = await esClient.count({ index: INDEX_NAME });
    res.json({
      success: true,
      cluster: info.cluster_name,
      version: info.version.number,
      products_count: count.count,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/test-openai', async (req, res) => {
  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: 'test',
    });
    res.json({
      success: true,
      embedding_size: response.data[0].embedding.length,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📚 قاموس Intent سريع — أنواع فرعية لكل جهاز شائع
// يُلغي الحاجة لاستدعاء LLM (~1.5s) ويُرجع الاقتراحات في <1ms
const INTENT_DICTIONARY = {
  'ثلاجة': [
    { title: 'ثلاجة بابين', description: 'ثلاجات بفريزر علوي/سفلي', icon: 'fridge', searchQuery: 'ثلاجة بابين' },
    { title: 'ثلاجة 4 أبواب', description: 'ثلاجات بأربعة أبواب', icon: 'fridge', searchQuery: 'ثلاجة 4 أبواب' },
    { title: 'ثلاجة إنفرتر', description: 'موفّرة للطاقة', icon: 'sparkles', searchQuery: 'ثلاجة إنفرتر' },
    { title: 'ثلاجة صغيرة', description: 'للمساحات الضيقة', icon: 'home', searchQuery: 'ثلاجة صغيرة' },
  ],
  'غسالة': [
    { title: 'غسالة ملابس', description: 'لغسيل الملابس', icon: 'home', searchQuery: 'غسالة ملابس' },
    { title: 'غسالة صحون', description: 'لغسيل الأطباق', icon: 'kitchen', searchQuery: 'غسالة صحون' },
    { title: 'غسالة أوتوماتيك', description: 'تشغيل أوتوماتيكي كامل', icon: 'sparkles', searchQuery: 'غسالة أوتوماتيك' },
    { title: 'غسالة حوضين', description: 'بحوضين منفصلين', icon: 'home', searchQuery: 'غسالة حوضين' },
  ],
  'نشافة': [
    { title: 'نشافة ملابس', description: 'مجفف الملابس', icon: 'home', searchQuery: 'نشافة ملابس' },
    { title: 'نشافة كهربائية', description: 'تعمل بالكهرباء', icon: 'sparkles', searchQuery: 'نشافة كهربائية' },
    { title: 'نشافة غاز', description: 'تعمل بالغاز', icon: 'fire', searchQuery: 'نشافة غاز' },
  ],
  'فرن': [
    { title: 'فرن كهربائي', description: 'فرن يعمل بالكهرباء', icon: 'fire', searchQuery: 'فرن كهربائي' },
    { title: 'فرن غاز', description: 'فرن يعمل بالغاز', icon: 'fire', searchQuery: 'فرن غاز' },
    { title: 'فرن مدمج', description: 'مدمج بالخزانة', icon: 'home', searchQuery: 'فرن مدمج' },
    { title: 'ميكروويف فرن', description: 'بوظيفة الميكروويف', icon: 'sparkles', searchQuery: 'ميكروويف فرن' },
  ],
  // 'مكواة' — الكتالوج فيه منتج واحد فقط، نتركها للاستخراج الإحصائي/LLM
  'مكنسة': [
    { title: 'مكنسة كهربائية', description: 'تعمل بالكهرباء', icon: 'sparkles', searchQuery: 'مكنسة كهربائية' },
    { title: 'مكنسة لاسلكية', description: 'بدون سلك', icon: 'home', searchQuery: 'مكنسة لاسلكية' },
    { title: 'مكنسة روبوت', description: 'روبوت أوتوماتيكي', icon: 'tool', searchQuery: 'مكنسة روبوت' },
    { title: 'مكنسة بخار', description: 'تعمل بالبخار', icon: 'fire', searchQuery: 'مكنسة بخار' },
  ],
  'قلاية': [
    { title: 'قلاية هوائية', description: 'بدون زيت', icon: 'fire', searchQuery: 'قلاية هوائية' },
    { title: 'قلاية زيت', description: 'تقليدية', icon: 'kitchen', searchQuery: 'قلاية زيت' },
    { title: 'قلاية دبل', description: 'بمقصورتين', icon: 'sparkles', searchQuery: 'قلاية دبل' },
  ],
  'خلاط': [
    { title: 'خلاط كهربائي', description: 'بقاعدة', icon: 'kitchen', searchQuery: 'خلاط كهربائي' },
    { title: 'خلاط يدوي', description: 'يد قابض', icon: 'tool', searchQuery: 'خلاط يدوي' },
    { title: 'خلاط بالمطحنة', description: 'مع مطحنة', icon: 'kitchen', searchQuery: 'خلاط بالمطحنة' },
  ],
  'ميكروويف': [
    { title: 'ميكروويف عادي', description: 'بدون شواية', icon: 'sparkles', searchQuery: 'ميكروويف' },
    { title: 'ميكروويف مع شواية', description: 'بوظيفة الشواية', icon: 'fire', searchQuery: 'ميكروويف مع شواية' },
    { title: 'ميكروويف مدمج', description: 'مدمج بالخزانة', icon: 'home', searchQuery: 'ميكروويف مدمج' },
  ],
  'ترامس': [
    { title: 'طقم ترامس', description: 'طقم كامل', icon: 'gift', searchQuery: 'طقم ترامس' },
    { title: 'ترامس خشبي', description: 'تشطيب خشبي', icon: 'home', searchQuery: 'ترامس خشبي' },
    { title: 'ترامس فضي', description: 'تشطيب فضي', icon: 'sparkles', searchQuery: 'ترامس فضي' },
    { title: 'شنطة ترامس', description: 'حقيبة حفظ', icon: 'package', searchQuery: 'شنطة ترامس' },
  ],
  'ترمس': [
    { title: 'ترمس 1 لتر', description: 'سعة لتر', icon: 'cup', searchQuery: 'ترمس 1 لتر' },
    { title: 'ترمس استيل', description: 'فولاذ مقاوم', icon: 'sparkles', searchQuery: 'ترمس استيل' },
    { title: 'ترمس مفرد', description: 'قطعة واحدة', icon: 'cup', searchQuery: 'ترمس مفرد' },
    { title: 'طقم ترامس', description: 'طقم كامل', icon: 'gift', searchQuery: 'طقم ترامس' },
  ],
  'صحون': [
    { title: 'طقم صحون', description: 'طقم كامل', icon: 'gift', searchQuery: 'طقم صحون' },
    { title: 'صحون عشاء', description: 'لطعام الرئيسي', icon: 'kitchen', searchQuery: 'صحون عشاء' },
    { title: 'صحون ميلامين', description: 'ميلامين', icon: 'home', searchQuery: 'صحون ميلامين' },
    { title: 'صحون زجاج', description: 'زجاجية', icon: 'sparkles', searchQuery: 'صحون زجاج' },
  ],
  'قدر': [
    { title: 'قدر ضغط', description: 'بالضغط', icon: 'fire', searchQuery: 'قدر ضغط' },
    { title: 'قدر كهربائي', description: 'كهربائي', icon: 'sparkles', searchQuery: 'قدر كهربائي' },
    { title: 'طقم قدور', description: 'طقم كامل', icon: 'gift', searchQuery: 'طقم قدور' },
  ],
  'مكيف': [
    { title: 'مكيف سبليت', description: 'وحدتين منفصلتين', icon: 'home', searchQuery: 'مكيف سبليت' },
    { title: 'مكيف شباك', description: 'وحدة واحدة للشباك', icon: 'home', searchQuery: 'مكيف شباك' },
    { title: 'مكيف متنقل', description: 'محمول', icon: 'package', searchQuery: 'مكيف متنقل' },
  ],
  'سخان': [
    { title: 'سخان ماء', description: 'للمياه', icon: 'fire', searchQuery: 'سخان ماء' },
    { title: 'سخان فوري', description: 'فوري بدون خزان', icon: 'sparkles', searchQuery: 'سخان فوري' },
    { title: 'سخان مركزي', description: 'مركزي للمنزل', icon: 'home', searchQuery: 'سخان مياه مركزي' },
  ],
  'شواية': [
    { title: 'شواية كهربائية', description: 'كهربائية', icon: 'fire', searchQuery: 'شواية كهربائية' },
    { title: 'شواية دجاج', description: 'للدجاج', icon: 'kitchen', searchQuery: 'شواية دجاج' },
  ],
  'محمصة': [
    { title: 'محمصة خبز', description: 'للخبز/التوست', icon: 'kitchen', searchQuery: 'محمصة خبز' },
    { title: 'محمصة ساندويش', description: 'ساندويش/شواية', icon: 'fire', searchQuery: 'محمصة ساندويش' },
  ],
  'ساندويش': [
    { title: 'ساندويش ميكر', description: 'ساندويش بسيط', icon: 'kitchen', searchQuery: 'ساندويش ميكر' },
    { title: 'ساندويش بشواية', description: 'مع شواية', icon: 'fire', searchQuery: 'ساندويش شواية' },
    { title: 'ساندويش دبل', description: 'مزدوج', icon: 'sparkles', searchQuery: 'ساندويش دبل' },
  ],
  'كاسات': [
    { title: 'طقم كاسات', description: 'طقم كامل', icon: 'gift', searchQuery: 'طقم كاسات' },
    { title: 'كاسات زجاج', description: 'زجاجية', icon: 'sparkles', searchQuery: 'كاسات زجاج' },
    { title: 'كاسات حراري', description: 'مقاومة للحرارة', icon: 'fire', searchQuery: 'كاسات حراري' },
  ],
  'فناجين': [
    { title: 'طقم فناجين', description: 'طقم كامل', icon: 'gift', searchQuery: 'طقم فناجين' },
    { title: 'فناجين قهوة', description: 'للقهوة العربية', icon: 'coffee', searchQuery: 'فناجين قهوة' },
    { title: 'فناجين تركي', description: 'قهوة تركية', icon: 'coffee', searchQuery: 'فناجين تركي' },
  ],
  'دلال': [
    { title: 'دلال قهوة', description: 'للقهوة العربية', icon: 'coffee', searchQuery: 'دلال قهوة' },
    { title: 'دلة كهربائية', description: 'كهربائية', icon: 'sparkles', searchQuery: 'دلة كهربائية' },
    { title: 'طقم دلال', description: 'طقم كامل', icon: 'gift', searchQuery: 'طقم دلال' },
  ],
  'عجانة': [
    { title: 'عجانة 10 لتر', description: 'سعة كبيرة للعائلات', icon: 'gift', searchQuery: 'عجانة 10 لتر' },
    { title: 'عجانة متعددة', description: '3*1 أو 4*1 أو 5*1', icon: 'sparkles', searchQuery: 'عجانة متعددة' },
    { title: 'عجانة بخاصية التخمير', description: 'تخمير سريع', icon: 'fire', searchQuery: 'عجانة بخاصية التخمير' },
    { title: 'عجانة 5 لتر', description: 'السعة الأكثر شيوعاً', icon: 'home', searchQuery: 'عجانة 5 لتر' },
  ],
  'خفاقة': [
    { title: 'خفاقة كهربائية', description: 'بقاعدة', icon: 'kitchen', searchQuery: 'خفاقة كهربائية' },
    { title: 'خفاقة يدوية', description: 'يدوية', icon: 'tool', searchQuery: 'خفاقة يدوية' },
    { title: 'خفاقة بيض', description: 'لخفق البيض', icon: 'kitchen', searchQuery: 'خفاقة بيض' },
  ],
  'محضر': [
    { title: 'محضّر طعام', description: 'لجميع الاستخدامات', icon: 'kitchen', searchQuery: 'محضّر طعام' },
    { title: 'محضّر متعدد', description: 'متعدد الوظائف', icon: 'sparkles', searchQuery: 'محضّر متعدد' },
    { title: 'محضّر صغير', description: 'حجم صغير', icon: 'home', searchQuery: 'محضّر صغير' },
  ],
  'شفاط': [
    { title: 'شفاط مطبخ', description: 'للمطبخ', icon: 'home', searchQuery: 'شفاط مطبخ' },
    { title: 'شفاط جاز', description: 'لـ الغازات والروائح', icon: 'fire', searchQuery: 'شفاط جاز' },
    { title: 'شفاط زجاجي', description: 'تصميم زجاجي', icon: 'sparkles', searchQuery: 'شفاط زجاجي' },
    { title: 'شفاط مدمج', description: 'مدمج بالخزانة', icon: 'home', searchQuery: 'شفاط مدمج' },
  ],
  // 'بوتاجاز' — الكتالوج لا يحتوي بوتاجاز حقيقي، نتركها بدون اقتراحات
  'موقد': [
    { title: 'موقد غاز', description: 'يعمل بالغاز', icon: 'fire', searchQuery: 'موقد غاز' },
    { title: 'موقد كهربائي', description: 'يعمل بالكهرباء', icon: 'sparkles', searchQuery: 'موقد كهربائي' },
    { title: 'موقد إنفرارد', description: 'بأشعة تحت الحمراء', icon: 'fire', searchQuery: 'موقد إنفرارد' },
  ],
  'إبريق': [
    { title: 'إبريق ماء', description: 'لتقديم الماء', icon: 'cup', searchQuery: 'إبريق ماء' },
    { title: 'إبريق شاي', description: 'للشاي', icon: 'cup', searchQuery: 'إبريق شاي' },
    { title: 'إبريق كهربائي', description: 'غلاية كهربائية', icon: 'sparkles', searchQuery: 'إبريق كهربائي' },
    { title: 'إبريق زجاج', description: 'زجاجي', icon: 'sparkles', searchQuery: 'إبريق زجاج' },
  ],
  'غلاية': [
    { title: 'غلاية كهربائية', description: 'كهربائية', icon: 'fire', searchQuery: 'غلاية كهربائية' },
    { title: 'غلاية إستيل', description: 'فولاذ', icon: 'sparkles', searchQuery: 'غلاية إستيل' },
    { title: 'غلاية زجاج', description: 'زجاجية شفافة', icon: 'sparkles', searchQuery: 'غلاية زجاج' },
  ],
  'عصارة': [
    { title: 'عصارة كهربائية', description: 'كهربائية', icon: 'sparkles', searchQuery: 'عصارة كهربائية' },
    { title: 'عصارة برتقال', description: 'للحمضيات', icon: 'kitchen', searchQuery: 'عصارة برتقال' },
    { title: 'عصارة بطيئة', description: 'كولد بريس', icon: 'sparkles', searchQuery: 'عصارة بطيئة' },
    { title: 'عصارة ليمون', description: 'يدوية للليمون', icon: 'tool', searchQuery: 'عصارة ليمون' },
  ],
  'مقلاة': [
    { title: 'مقلاة طبخ', description: 'للطبخ اليومي', icon: 'kitchen', searchQuery: 'مقلاة طبخ' },
    { title: 'مقلاة ضد الخدش', description: 'مقاومة للخدش', icon: 'sparkles', searchQuery: 'مقلاة ضد الخدش' },
    { title: 'مقلاة جرانيت', description: 'طلاء جرانيت', icon: 'home', searchQuery: 'مقلاة جرانيت' },
    { title: 'مقلاة إستيل', description: 'فولاذ مقاوم', icon: 'sparkles', searchQuery: 'مقلاة إستيل' },
  ],
  'حلة': [
    { title: 'حلة ضغط', description: 'بالضغط', icon: 'fire', searchQuery: 'حلة ضغط' },
    { title: 'حلة كهربائية', description: 'كهربائية', icon: 'sparkles', searchQuery: 'حلة كهربائية' },
    { title: 'طقم حلل', description: 'طقم كامل', icon: 'gift', searchQuery: 'طقم حلل' },
  ],
  // 'مدفأة' — الكتالوج فيه منتج واحد فقط، نتركها للاستخراج الإحصائي
  'مروحة': [
    { title: 'مروحة عمودية', description: 'مع عمود', icon: 'home', searchQuery: 'مروحة عمودية' },
    { title: 'مروحة سقف', description: 'للسقف', icon: 'home', searchQuery: 'مروحة سقف' },
    { title: 'مروحة طاولة', description: 'صغيرة للطاولة', icon: 'home', searchQuery: 'مروحة طاولة' },
    { title: 'مروحة ريموت', description: 'بريموت كنترول', icon: 'sparkles', searchQuery: 'مروحة ريموت' },
  ],
  'ميزان': [
    { title: 'ميزان مطبخ', description: 'لوزن الطعام', icon: 'kitchen', searchQuery: 'ميزان مطبخ' },
    { title: 'ميزان إلكتروني', description: 'رقمي', icon: 'sparkles', searchQuery: 'ميزان إلكتروني' },
    { title: 'ميزان جسم', description: 'لوزن الجسم', icon: 'home', searchQuery: 'ميزان جسم' },
  ],
  'مطحنة': [
    { title: 'مطحنة قهوة', description: 'للقهوة', icon: 'coffee', searchQuery: 'مطحنة قهوة' },
    { title: 'مطحنة بهارات', description: 'للبهارات', icon: 'kitchen', searchQuery: 'مطحنة بهارات' },
    { title: 'مطحنة كهربائية', description: 'كهربائية', icon: 'sparkles', searchQuery: 'مطحنة كهربائية' },
  ],
  'سلاطة': [
    { title: 'سلطانية كبيرة', description: 'حجم كبير', icon: 'kitchen', searchQuery: 'سلطانية كبيرة' },
    { title: 'سلطانية تقديم', description: 'للتقديم', icon: 'gift', searchQuery: 'سلطانية تقديم' },
  ],
  'صينية': [
    { title: 'صينية تقديم', description: 'للتقديم', icon: 'gift', searchQuery: 'صينية تقديم' },
    { title: 'صينية فرن', description: 'مقاومة للحرارة', icon: 'fire', searchQuery: 'صينية فرن' },
    { title: 'صواني', description: 'طقم صواني', icon: 'kitchen', searchQuery: 'صواني' },
  ],
  'سكاكين': [
    { title: 'طقم سكاكين', description: 'طقم كامل', icon: 'gift', searchQuery: 'طقم سكاكين' },
    { title: 'سكاكين إستيل', description: 'فولاذ', icon: 'sparkles', searchQuery: 'سكاكين إستيل' },
    { title: 'سكاكين مطبخ', description: 'للمطبخ', icon: 'kitchen', searchQuery: 'سكاكين مطبخ' },
  ],
  'طاولة': [
    { title: 'طاولة طعام', description: 'سفرة', icon: 'home', searchQuery: 'طاولة طعام' },
    { title: 'طاولة قهوة', description: 'صغيرة', icon: 'coffee', searchQuery: 'طاولة قهوة' },
    { title: 'طاولة جانبية', description: 'جانبية', icon: 'home', searchQuery: 'طاولة جانبية' },
  ],
  'مفرش': [
    { title: 'مفرش طاولة', description: 'للطاولة', icon: 'home', searchQuery: 'مفرش طاولة' },
    { title: 'مفرش سفرة', description: 'للسفرة', icon: 'home', searchQuery: 'مفرش سفرة' },
    { title: 'مفرش بلاستيك', description: 'بلاستيكي', icon: 'home', searchQuery: 'مفرش بلاستيك' },
  ],
};
// مرادفات (نوحّدها للقاموس)
const INTENT_ALIASES = {
  'ثلاجات': 'ثلاجة', 'غسالات': 'غسالة', 'أفران': 'فرن', 'افران': 'فرن',
  'مكاوي': 'مكواة', 'مكانس': 'مكنسة', 'قلايات': 'قلاية', 'خلاطات': 'خلاط',
  'مكيفات': 'مكيف', 'سخانات': 'سخان', 'شوايات': 'شواية', 'مجفف': 'نشافة',
  'دلة': 'دلال',
  'عجانات': 'عجانة', 'عجان': 'عجانة',
  'خفاقات': 'خفاقة',
  'محضّر': 'محضر', 'محضّرات': 'محضر',
  'شفاطات': 'شفاط',
  'بوتاجازات': 'بوتاجاز',
  'مواقد': 'موقد',
  'أباريق': 'إبريق', 'اباريق': 'إبريق', 'ابريق': 'إبريق',
  'غلايات': 'غلاية',
  'عصارات': 'عصارة',
  'مقالي': 'مقلاة', 'مقالاة': 'مقلاة',
  'حلل': 'حلة',
  'مدفآت': 'مدفأة',
  'مراوح': 'مروحة',
  'موازين': 'ميزان',
  'مطاحن': 'مطحنة',
  'سلطانية': 'سلاطة', 'سلطانيات': 'سلاطة',
  'صواني': 'صينية',
  'سكين': 'سكاكين',
  'طاولات': 'طاولة',
  'مفارش': 'مفرش',
};

function getDictionaryIntent(query) {
  if (!query) return null;
  const q = query.toLowerCase().trim();
  // 1) لو الـ query كامل = مفتاح بالقاموس (multi-word مثل "ميني بان كيك") → استخدمه
  if (INTENT_DICTIONARY[q]) {
    return {
      isAmbiguous: true,
      message: 'اختر النوع اللي تبيه:',
      suggestions: INTENT_DICTIONARY[q],
    };
  }
  const words = q.split(/\s+/);
  // 2) لو 3+ كلمات وما لقينا مفتاح كامل، البحث محدد بالفعل
  if (words.length >= 3) return null;
  // 3) نبحث عن كلمة أساسية في القاموس
  for (const w of words) {
    const root = INTENT_ALIASES[w] || w;
    if (INTENT_DICTIONARY[root]) {
      if (words.length > 1) return null;
      return {
        isAmbiguous: true,
        message: 'اختر النوع اللي تبيه:',
        suggestions: INTENT_DICTIONARY[root],
      };
    }
  }
  return null;
}

// 🧮 استخراج Intent إحصائي من عناوين المنتجات (أي بحث غير موجود في القاموس)
const STATISTICAL_INTENT_STOPWORDS = new Set([
  'و', 'في', 'من', 'إلى', 'الى', 'على', 'عن', 'مع', 'ل', 'هذا', 'هذه', 'ذلك',
  'الـ', 'ال', 'أو', 'او', 'أم', 'بـ', 'كـ', 'فـ',
  'لتر', 'مل', 'كيلو', 'واط', 'قدم', 'سم', 'مم', 'إنش',
  'سعة', 'مقاس', 'حجم', 'وزن', 'كبير', 'كبيرة', 'صغير', 'صغيرة', 'متوسط', 'متوسطة',
  'أبيض', 'ابيض', 'أسود', 'اسود', 'فضي', 'ذهبي', 'رمادي', 'بني', 'أحمر', 'احمر',
  'أزرق', 'ازرق', 'أخضر', 'اخضر', 'وردي', 'زيتي', 'بيج', 'كحلي', 'كريمي',
  // كلمات عامة لا تشكل تصنيف لوحدها
  'طقم', 'كوب', 'زجاج', 'حبة', 'حبات', 'قطعة', 'قطع', 'حبتين',
  'جديد', 'جديدة', 'مع', 'بـ', 'ضد',
]);
const ARABIC_STEM_SUFFIXES = ['ات', 'ين', 'ون', 'ها', 'ية', 'ة', 'ه'];

function statWordKey(w) {
  let s = w.replace(/[ً-ٟ]/g, '')
           .replace(/[إأآا]/g, 'ا').replace(/[ىي]/g, 'ي').replace(/ة/g, 'ه');
  for (const suf of ARABIC_STEM_SUFFIXES) {
    if (s.length > suf.length + 2 && s.endsWith(suf)) { s = s.slice(0, -suf.length); break; }
  }
  return s;
}

function getStatisticalIntent(query, products) {
  if (!query || !products || products.length < 8) return null;
  const q = query.toLowerCase().trim();
  const queryWords = q.split(/\s+/);
  if (queryWords.length >= 3) return null;
  const queryStems = new Set(queryWords.map(statWordKey).filter(s => s.length >= 2));

  // brand words من المنتجات نفسها — نستبعدها (الماركات ليست تصنيفات)
  const brandSet = new Set();
  for (const p of products.slice(0, 50)) {
    const b = (p.brand || '').toLowerCase().trim();
    if (b) b.split(/\s+/).forEach(w => { if (w.length >= 2) brandSet.add(w); });
  }

  const titles = products.slice(0, 30).map(p => (p.title || '').toLowerCase());
  const wordCount = new Map();         // stem → count
  const wordOriginal = new Map();      // stem → most common original word
  const bigramCount = new Map();

  for (const t of titles) {
    const tokens = t.split(/\s+/).filter(w => w.length >= 2 && !/^[\d.,\-]+$/.test(w));

    const seenU = new Set();
    for (const w of tokens) {
      const key = statWordKey(w);
      if (queryStems.has(key)) continue;
      if (STATISTICAL_INTENT_STOPWORDS.has(w) || brandSet.has(w)) continue;
      if (key.length < 2) continue;
      if (seenU.has(key)) continue;
      seenU.add(key);
      wordCount.set(key, (wordCount.get(key) || 0) + 1);
      // نحتفظ بالكلمة الأصلية الأطول (غالباً الجمع الكامل غير المقطوع)
      const prev = wordOriginal.get(key);
      if (!prev || w.length > prev.length) wordOriginal.set(key, w);
    }
    // bigrams حيث الكلمتان ليستا ماركة/stopword، ولا تكون كلتاهما من الاستعلام
    for (let i = 0; i < tokens.length - 1; i++) {
      const a = tokens[i], b = tokens[i + 1];
      if (STATISTICAL_INTENT_STOPWORDS.has(a) || STATISTICAL_INTENT_STOPWORDS.has(b)) continue;
      if (brandSet.has(a) || brandSet.has(b)) continue;
      const sa = statWordKey(a), sb = statWordKey(b);
      if (sa.length < 2 || sb.length < 2) continue;
      if (queryStems.has(sa) && queryStems.has(sb)) continue;
      if (/^[\d.,\-]+$/.test(a) || /^[\d.,\-]+$/.test(b)) continue;
      // لو bigram يبدأ بكلمة الاستعلام، نتجاهله (الاستعلام نفسه + كلمة → سنبني هذا أدناه من الـ unigrams)
      if (queryStems.has(sa) || queryStems.has(sb)) continue;
      const k = `${a} ${b}`;
      bigramCount.set(k, (bigramCount.get(k) || 0) + 1);
    }
  }

  const topBigrams = [...bigramCount.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]);
  const topUnigrams = [...wordCount.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]);

  const suggestions = [];
  const usedKeys = new Set();
  const bigramStems = new Set();

  // bigrams: عبارة من كلمتين غير الاستعلام → نضع: "<query> <bigram>"
  for (const [phrase] of topBigrams) {
    if (suggestions.length >= 4) break;
    const k = phrase.split(/\s+/).map(statWordKey).join('|');
    if (usedKeys.has(k)) continue;
    usedKeys.add(k);
    phrase.split(/\s+/).map(statWordKey).forEach(s => bigramStems.add(s));
    const full = `${query} ${phrase}`;
    suggestions.push({ title: full, description: phrase, icon: 'sparkles', searchQuery: full });
  }
  // unigrams: كلمة واحدة → "<query> <originalWord>"
  for (const [stem] of topUnigrams) {
    if (suggestions.length >= 4) break;
    if (usedKeys.has(stem) || bigramStems.has(stem)) continue;
    usedKeys.add(stem);
    const display = wordOriginal.get(stem) || stem;
    const full = `${query} ${display}`;
    suggestions.push({ title: full, description: display, icon: 'sparkles', searchQuery: full });
  }

  if (suggestions.length < 2) return null;
  return { isAmbiguous: true, message: 'اختر النوع اللي تبيه:', suggestions };
}

// 🛡️ يتحقق من كل اقتراح intent ضد كتالوج المتجر
// لو الاقتراح يرجّع < 3 منتجات حقيقية → احذفه
// لو بقي < 2 → أرجع isAmbiguous=false (نخفي chips)
// يضمن إن المستخدم لما يضغط chip ما يلقى صفحة فاضية
async function validateIntentSuggestions(intentResult, query) {
  if (!intentResult || !intentResult.suggestions || intentResult.suggestions.length === 0) {
    return intentResult;
  }
  const MIN_PRODUCTS = 2;
  const validated = [];
  for (const s of intentResult.suggestions) {
    if (!s.searchQuery) continue;
    // ما نتحقق من نفس الـ query الأصلي (يرجع نتائج كثيرة بطبيعته)
    if (s.searchQuery.toLowerCase().trim() === (query || '').toLowerCase().trim()) continue;
    try {
      const cnt = await quickCountForQuery(s.searchQuery);
      if (cnt >= MIN_PRODUCTS) {
        validated.push(s);
      } else {
        console.log(`  intent rejected: "${s.searchQuery}" (${cnt} products in catalog)`);
      }
    } catch {
      // لو فشل ES، نحتفظ بالاقتراح (لا نخسره بسبب خطأ شبكة)
      validated.push(s);
    }
  }
  if (validated.length < 2) {
    return { isAmbiguous: false, message: '', suggestions: [] };
  }
  return { ...intentResult, suggestions: validated };
}

async function detectIntent(query, sampleProducts) {
  const cacheKey = (query || '').toLowerCase().trim();
  const cached = intentCache.get(cacheKey);
  if (cached) return cached;

  // ⚡ مسار سريع 1: قاموس Intent — لا LLM، <1ms
  const dictResult = getDictionaryIntent(query);
  if (dictResult) {
    const validated = await validateIntentSuggestions(dictResult, query);
    intentCache.set(cacheKey, validated);
    return validated;
  }

  // ⚡ مسار سريع 2: استخراج إحصائي من عناوين النتائج — لا LLM، ~5ms
  const statResult = getStatisticalIntent(query, sampleProducts);
  if (statResult) {
    const validated = await validateIntentSuggestions(statResult, query);
    intentCache.set(cacheKey, validated);
    return validated;
  }

  try {
    const productExamples = sampleProducts.slice(0, 40).map(p => p.title).join('\n');

    const prompt = `أنت خبير في تحليل البحث في متجر سعودي يبيع أدوات منزلية وأجهزة كهربائية.

البحث: "${query}"

عناوين المنتجات الفعلية في النتائج:
${productExamples}

🎯 المهمة:
اقترح 4 تركيبات بحث محسّنة تساعد المستخدم في تحديد ما يريده بالضبط.

🥇 الأولوية الأولى — تصنيف وظيفي/فئوي (الأهم):
إذا كانت كلمة البحث تحتمل **أنواع/فئات مختلفة جوهرياً**، اعرض الفئات أولاً وليس الماركات.

أمثلة على التصنيف الوظيفي الذي يجب اقتراحه دائماً:
- "غسالة" → ["غسالة ملابس", "غسالة صحون"] (نوعان جوهرياً مختلفان)
- "فرن" → ["فرن كهربائي", "فرن غاز", "ميكروويف فرن"]
- "خلاط" → ["خلاط كهربائي", "خلاط يدوي"]
- "مكواة" → ["مكواة بخار", "مكواة جافة"]
- "مكنسة" → ["مكنسة كهربائية", "مكنسة يدوية", "مكنسة روبوت"]
- "ميكروويف" → ["ميكروويف عادي", "ميكروويف مع شواية"]
- "ثلاجة" → ["ثلاجة بابين", "ثلاجة بأربعة أبواب", "ثلاجة صغيرة"]
- "قدر" → ["قدر ضغط", "قدر كهربائي", "طقم قدور"]
- "ترامس" → ["طقم ترامس", "شنطة ترامس", "ترمس مفرد"]

🥈 الأولوية الثانية — تركيبات من العناوين الفعلية:
إذا الكلمة محددة جداً ولا تحتمل تصنيفات متعددة، استخدم العناوين أعلاه لاستخراج تركيبات (مثل: طقم/مفرد، حجم، مادة).

❌ لا تقترح ماركات (سامسونج، ميديا، LG...) كاقتراحات أساسية — الماركات تظهر كفلاتر منفصلة.

🎯 منهجية إلزامية (اتبعها بالترتيب):

الخطوة 1 — حدّد المحور:
اقرأ الـ 40 عنوان فعلياً. حدّد محور تمييز واحد يتكرر فيها.
أمثلة محاور:
  - مصدر الطاقة (كهربائي / يدوي / بطارية)
  - طريقة التسخين (هوائية بدون زيت / زيت تقليدي)
  - الحجم (صغير / كبير / دبل)
  - نوع التحميل (أمامي / علوي)
  - الوظيفة (ملابس / صحون)
  - المادة (زجاج / ستيل / بلاستيك)
  - شكل المنتج (مدمج / منفصل / متنقل)

الخطوة 2 — استخرج قيم متعارضة من العناوين:
على نفس المحور، استخرج 2-3 قيم متعارضة موجودة فعلياً في العناوين.
"متعارضة" = منتج واحد لا يقدر يحقّق قيمتين منها في نفس الوقت.

الخطوة 3 — تحقّق من الحصرية:
لو منتج يقدر يطابق اقتراحين في نفس الوقت → الاقتراحات على محاور مختلطة
→ ارفضها وارجع للخطوة 1.

الخطوة 4 — تحقّق من التواجد:
كل قيمة لازم تكون مذكورة (أو مشتقة) من 3+ عناوين على الأقل من الـ 40 عنوان.
لو ما لقيت قيمتين على نفس المحور بهالشرط → أرجع isAmbiguous=false.

❌ ممنوع تخترع قيم من معرفتك العامة. القيم لازم تنبع من الـ 40 عنوان فقط.

⚠️ قواعد إضافية:
1. كل اقتراح يحتوي على كلمة "${query}" (أو جذرها) + كلمة وصفية
2. ركّز على التمييز الوظيفي (ما هو نوع المنتج) لا الماركة
3. searchQuery قصير (2-4 كلمات)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ مثال خطأ — محاور مختلطة:
البحث: "ميني بان كيك"
السيء:
  - "ميني بان كيك كهربائية" (محور: مصدر الطاقة)
  - "ميني بان كيك قابل للحمل" (محور: قابلية النقل)
السبب: منتج واحد ممكن يكون كهربائي وقابل للحمل في نفس الوقت → محاور مختلطة.

✅ الصح:
لو الـ 40 عنوان فيها أحجام مختلفة موجودة فعلياً:
  - "ميني بان كيك 7 قوالب"
  - "ميني بان كيك 12 قالب"
لو ما فيها محور متعارض واضح → isAmbiguous=false.

❌ مثال خطأ — صياغات لنفس الشي:
البحث: "ميني بان كيك"
السيء:
  - "آلة ميني بان كيك"
  - "جهاز ميني بان كيك"
  - "ماكينة ميني بان كيك"
السبب: نفس المعنى بكلمات مرادفة، لا تساعد المستخدم في التمييز.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔍 متى isAmbiguous = true؟
- إذا الكلمة تحتمل أنواع جوهرياً مختلفة (غسالة/فرن/خلاط/مكواة...)
- isAmbiguous = false → فقط لو البحث محدد بالكامل (مثل "غسالة ملابس سامسونج 8 كيلو")

اختر أيقونة لكل اقتراح من: coffee, kitchen, package, gift, home, fridge, fire, sparkles, cart, heart, cup, tool

أعد JSON فقط:
{
  "isAmbiguous": true/false,
  "message": "اختر النوع اللي تبيه:",
  "suggestions": [
    {"title": "اسم مختصر للنوع", "description": "وصف قصير", "icon": "أيقونة", "searchQuery": "التركيبة الكاملة"}
  ]
}

إذا محدد بالكامل: {"isAmbiguous": false, "message": "", "suggestions": []}`;

    const text = await cohereChat({ prompt, jsonMode: true, temperature: 0.7 });
    const result = JSON.parse(text);

    // ━━━ Layer 1: Dedup الصياغات المكررة (آلة/جهاز/ماكينة لنفس الشي) ━━━
    if (result.suggestions && result.suggestions.length > 1) {
      const querySigs = new Set(query.toLowerCase().split(/\s+/).map(w => normalizeArabicWord(w)));
      const seen = [];
      const unique = [];
      for (const s of result.suggestions) {
        if (!s.searchQuery) continue;
        const sigWords = s.searchQuery.toLowerCase().split(/\s+/)
          .map(w => normalizeArabicWord(w))
          .filter(w => w.length >= 2 && !querySigs.has(w));
        const sig = sigWords.sort().join('|');
        if (!seen.includes(sig)) { seen.push(sig); unique.push(s); }
      }
      const meaningful = unique.filter(s => {
        const sigWords = s.searchQuery.toLowerCase().split(/\s+/)
          .map(w => normalizeArabicWord(w))
          .filter(w => w.length >= 2 && !querySigs.has(w));
        return sigWords.length > 0;
      });
      result.suggestions = meaningful;
    }

    // ━━━ Layer 2: Catalog validation عبر helper موحّد ━━━
    const validatedResult = await validateIntentSuggestions(result, query);
    intentCache.set(cacheKey, validatedResult);
    return validatedResult;
  } catch (error) {
    console.error('Intent error:', error.message);
    return { isAmbiguous: false, message: '', suggestions: [] };
  }
}

function extractBrands(products, query) {
  const brandCounts = {};
  
  // الطبقة 1: استخراج كلمات البحث المهمة (طول >= 2 حروف)
  const queryWords = (query || '').toLowerCase().split(/\s+/).filter(w => w.length >= 2);
  
  // الطبقة 2: فلترة المنتجات التي تحتوي على كلمة من البحث في العنوان
  let relevantProducts = products;
  if (queryWords.length > 0) {
    const filtered = products.filter(p => {
      if (!p.title) return false;
      const titleLower = p.title.toLowerCase();
      return queryWords.some(w => titleLower.includes(w));
    });
    
    // استخدم الفلترة فقط إذا فيه عدد كافٍ من المنتجات
    if (filtered.length >= 5) {
      relevantProducts = filtered;
    }
  }
  
  // الطبقة 3: خذ فقط أعلى 50 منتج (الأكثر صلة حسب kNN score)
  relevantProducts = relevantProducts.slice(0, 50);
  
  // عدّ الماركات
  relevantProducts.forEach(p => {
    if (p.brand && p.brand.trim()) {
      const brand = p.brand.trim();
      brandCounts[brand] = (brandCounts[brand] || 0) + 1;
    }
  });
  
  // الطبقة 4: لا تُظهر إلا الماركات التي عندها 2 منتج على الأقل (تستبعد الضوضاء)
  return Object.entries(brandCounts)
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([brand]) => brand);
}

// 📏 توحيد قيم الـ size: "5 لتر" / "5 L" / "5L" / "5 ليتر" → "5 لتر"
function normalizeSize(raw) {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase()
    // توحيد L / ليتر → لتر
    .replace(/\bl\b/g, 'لتر')
    .replace(/ليتر/g, 'لتر')
    .replace(/litre|liter/g, 'لتر')
    // توحيد kg / كجم / كغم → كيلو
    .replace(/\bkg\b/g, 'كيلو')
    .replace(/كجم|كغم|كج\b/g, 'كيلو')
    // توحيد ml / ميليلتر → مل
    .replace(/\bml\b/g, 'مل')
    .replace(/ميليلتر|ملي\s*لتر/g, 'مل')
    // توحيد cm / سنتيمتر → سم
    .replace(/\bcm\b/g, 'سم')
    .replace(/سنتيمتر|سنتي/g, 'سم')
    // توحيد w / وات → واط
    .replace(/\bw\b/g, 'واط')
    .replace(/وات\b/g, 'واط')
    // توحيد قدم3/قدم مكعب → قدم
    .replace(/قدم\s*مكعب|قدم3/g, 'قدم')
    .replace(/\s+/g, ' ')
    .trim();
  // إعادة بشكل قياسي "<number> <unit>" لو ممكن
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(لتر|مل|كيلو|واط|قدم|سم|بوصة|إنش)$/);
  if (m) return `${m[1]} ${m[2]}`;
  return s;
}

// 📏 توحيد اللون
function normalizeColor(raw) {
  if (!raw) return null;
  let c = String(raw).trim();
  // توحيد أبيض/ابيض، أسود/اسود، …
  c = c.replace(/^ال/, '');
  return c;
}

// 📦 binning ديناميكي للقيم الرقمية في النطاقات (لما تكون القيم متفرّقة)
// مثال: ثلاجات بأحجام 168L, 252L, 330L, 463L → يجمعها في buckets 100-200, 200-300, 300-400, 400-500
function binNumericSizes(numericValues, unit) {
  if (numericValues.length === 0) return [];
  const sorted = [...numericValues].sort((a, b) => a - b);
  const min = sorted[0], max = sorted[sorted.length - 1];

  // اختيار حجم الـ bucket ديناميكياً حسب النطاق
  let bucketSize;
  if (unit === 'لتر') {
    if (max < 10) bucketSize = 1;          // عجانات صغيرة
    else if (max < 50) bucketSize = 10;
    else if (max < 200) bucketSize = 50;
    else if (max < 600) bucketSize = 100;  // ثلاجات
    else bucketSize = 200;
  } else if (unit === 'واط') {
    bucketSize = max < 500 ? 100 : max < 2000 ? 500 : 1000;
  } else if (unit === 'كيلو') {
    bucketSize = max < 20 ? 2 : 5;
  } else if (unit === 'قدم') {
    bucketSize = max < 10 ? 2 : 5;
  } else if (unit === 'سم' || unit === 'بوصة') {
    bucketSize = max < 30 ? 5 : 10;
  } else if (unit === 'مل') {
    bucketSize = max < 1000 ? 200 : 500;
  } else {
    bucketSize = Math.max(1, Math.round((max - min) / 6));
  }

  // group بالـ bucket
  const buckets = new Map();
  for (const v of numericValues) {
    const bStart = Math.floor(v / bucketSize) * bucketSize;
    const bEnd = bStart + bucketSize;
    const key = `${bStart}-${bEnd} ${unit}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }

  // ارجع الـ top 6 buckets (مرتبة رقمياً، وعندها ≥1 منتج)
  return [...buckets.entries()]
    .sort((a, b) => {
      const na = parseFloat(a[0]);
      const nb = parseFloat(b[0]);
      return na - nb;
    })
    .slice(0, 6)
    .map(([k]) => k);
}

// مستخرج فلاتر حتمي — يدعم binning للقيم المتفرّقة + fallback لاستخراج من العناوين
function extractStructuredFilters(products) {
  const sizeRaw = [];        // كل قيم size موحّدة
  const numericByUnit = new Map(); // unit → [numbers]
  const colorMap = new Map();

  // 1️⃣ نقرأ من حقل p.size (المهيكل) أولاً
  for (const p of products.slice(0, 200)) {
    const sz = normalizeSize(p.size);
    if (sz) {
      sizeRaw.push(sz);
      const m = sz.match(/^(\d+(?:\.\d+)?)\s*(لتر|مل|كيلو|واط|قدم|سم|بوصة|إنش)$/);
      if (m) {
        const unit = m[2];
        if (!numericByUnit.has(unit)) numericByUnit.set(unit, []);
        numericByUnit.get(unit).push(parseFloat(m[1]));
      }
    }
    const cl = normalizeColor(p.color);
    if (cl) {
      const e = colorMap.get(cl) || { display: cl, count: 0 };
      e.count++;
      colorMap.set(cl, e);
    }
  }

  // 2️⃣ fallback: لو ما فيه size structured كافي، نستخرج من العناوين
  if (sizeRaw.length < 3) {
    for (const p of products.slice(0, 200)) {
      const t = (p.title || '').toLowerCase();
      for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(لتر|مل|كيلو|واط|قدم|سم|بوصة|إنش)/g)) {
        const unit = m[2];
        if (!numericByUnit.has(unit)) numericByUnit.set(unit, []);
        numericByUnit.get(unit).push(parseFloat(m[1]));
      }
    }
  }

  // 3️⃣ اختر الوحدة الأكثر تكراراً
  let bestUnit = null, bestCount = 0;
  for (const [unit, arr] of numericByUnit.entries()) {
    if (arr.length > bestCount) { bestCount = arr.length; bestUnit = unit; }
  }

  let sizes = [];
  if (bestUnit && bestCount >= 3) {
    const values = numericByUnit.get(bestUnit);
    // عدّ القيم الفريدة
    const valCount = new Map();
    for (const v of values) valCount.set(v, (valCount.get(v) || 0) + 1);

    // لو فيه قيم تتكرر ≥2، اعرضها مباشرة (sizes منفصلة مثل: 5 لتر، 10 لتر)
    const repeated = [...valCount.entries()].filter(([, c]) => c >= 2);
    if (repeated.length >= 2) {
      sizes = repeated
        .sort((a, b) => a[0] - b[0])
        .slice(0, 8)
        .map(([v]) => `${v} ${bestUnit}`);
    } else {
      // قيم متفرّقة (مثل ثلاجات 168/252/330/463 لتر) → بنّ في نطاقات
      sizes = binNumericSizes(values, bestUnit);
    }
  }

  // الألوان: ≥2 تكرار
  const colors = [...colorMap.values()]
    .filter(e => e.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map(e => e.display);

  const titleByUnit = {
    'لتر': 'ايش السعة اللي تناسبك؟',
    'مل':  'ايش السعة اللي تناسبك؟ (مل)',
    'كيلو': 'ايش الوزن اللي تناسبك؟',
    'واط': 'ايش الواط اللي تحتاجه؟',
    'قدم': 'ايش المقاس اللي تناسبك؟',
    'سم':  'ايش المقاس اللي تناسبك؟ (سم)',
    'بوصة': 'ايش المقاس اللي تناسبك؟ (بوصة)',
    'إنش': 'ايش المقاس اللي تناسبك؟',
  };
  const sizesTitle = sizes.length > 0 ? (titleByUnit[bestUnit] || 'ايش الحجم اللي يناسبك؟') : '';

  return { sizesTitle, sizes, colors };
}

async function generateSmartFilters(query, products) {
  const cacheKey = (query || '').toLowerCase().trim();
  const cached = smartFiltersCache.get(cacheKey);
  if (cached) return cached;

  // ⚡ المسار الحتمي: استخراج من حقلي size + color المهيكلين (لا LLM)
  const { sizesTitle, sizes, colors } = extractStructuredFilters(products);

  // الفلتر الثالث: لو فيه ألوان كافية → استخدمها، وإلا LLM للماركة/المادة/النوع
  let thirdTitle = '', thirdOptions = [];
  if (colors.length >= 2) {
    thirdTitle = 'ايش اللون اللي تفضّله؟';
    thirdOptions = colors;
  } else {
    // LLM fallback للفلتر الثالث فقط
    try {
      const productTitles = products.slice(0, 30).map(p => p.title).join('\n');
      const prompt = `حلّل العناوين أدناه واقترح فلتر ثالث مفيد غير الأحجام والألوان.
البحث: "${query}"
العناوين:
${productTitles}

اختر واحد:
- نوع المنتج (تركي/عربي/إسبريسو…)
- المادة (ستانلس/زجاج/سيراميك…)
- الميزة (ديجيتال/ميكانيكي/أوتوماتيك…)

أعد JSON: {"thirdTitle":"السؤال","thirdOptions":["خيار1","خيار2","خيار3"]}
⚠️ لا تخترع. اختر فقط من العناوين.`;
      const text = await cohereChat({ prompt, jsonMode: true, temperature: 0.3, maxTokens: 200 });
      const result = JSON.parse(text);
      thirdTitle = result.thirdTitle || '';
      thirdOptions = (result.thirdOptions || []).slice(0, 6);
    } catch (e) { /* fail silent */ }
  }

  const output = { sizesTitle, sizes, thirdTitle, thirdOptions };
  smartFiltersCache.set(cacheKey, output);
  return output;
}

async function generateRelatedSearches(query, products) {
  const cacheKey = (query || '').toLowerCase().trim();
  const cached = relatedSearchesCache.get(cacheKey);
  if (cached) return cached;
  try {
    // نرسل 40 عنواناً مع تنوع كافي ليرى الـ AI ما الموجود فعلاً
    const productExamples = products.slice(0, 40).map(p => p.title).join('\n');

    const prompt = `أنت محرك اقتراحات لمتجر أدوات منزلية سعودي.

بحث العميل: "${query}"

عناوين منتجات من المتجر:
${productExamples}

🎯 المهمة: اقترح 6 منتجات **مكمّلة** أو **مشابهة** قد يحتاجها العميل.
الاقتراحات يجب أن تكون منتجات أخرى يبيعها المتجر (تظهر في العناوين أو منتجات مماثلة).

📌 قواعد صارمة:
- كل اقتراح: اسم منتج بسيط، 1-3 كلمات (مثلاً "ميكروويف"، "فناجين قهوة"، "خلاط")
- يجب أن يكون **اسم منتج** يبيعه المتجر، ليس وصفاً أو نصيحة
- لا تبدأ بكلمات: "أفضل"، "نصائح"، "كيفية"، "مقارنة"، "أنواع"
- منتجات مكمّلة: لو بحث "ماكينة قهوة" → اقترح "فناجين"، "مطحنة قهوة"، "دلال قهوة"
- منتجات مشابهة: لو بحث "ثلاجة" → اقترح "فريزر"، "ميكروويف"، "ثلاجة صغيرة"

أمثلة اقتراحات صحيحة (للإلهام):
- بحث "قلاية" → ["قلاية هوائية", "فرن كهربائي", "ميكروويف", "شواية", "ملاعق قلي"]
- بحث "ترامس" → ["فناجين قهوة", "أكواب شاي", "صينية تقديم", "دلة قهوة"]
- بحث "محضر طعام" → ["خلاط", "عجانة", "مطحنة", "قلاية هوائية"]

أعد JSON فقط: {"relatedSearches": [{"icon": "emoji", "query": "اسم منتج بسيط"}]}`;

    const text = await cohereChat({ prompt, jsonMode: true, temperature: 0.7 });
    const result = JSON.parse(text);
    const raw = result.relatedSearches || [];

    // ✅ validation: حد طول + كلمة معنوية واحدة من كتالوج المتجر الكامل
    // نستخدم catalogVocab (2,676 كلمة فريدة من 9,299 منتج) بدل 40 عنوان فقط
    const STOP_WORDS = new Set(['نصائح','صيانة','مقارنات','أفضل','أنواع','استخدام','كيفية','تنظيف','اختيار','مع','من','في','إلى']);
    const queryLower = (query || '').toLowerCase().trim();
    const validated = raw.filter(s => {
      if (!s.query) return false;
      const q = s.query.trim();
      const words = q.split(/\s+/).filter(w => w.length >= 2);
      if (words.length === 0 || words.length > 4 || q.length > 35) return false;
      if (words.some(w => STOP_WORDS.has(w))) return false;
      // ❌ لا يكون نفس البحث الأصلي
      if (q.toLowerCase() === queryLower) return false;
      // ✅ على الأقل كلمة واحدة (normalized) موجودة في كتالوج المتجر الكامل
      const hasVocabMatch = words.some(w => {
        const norm = normalizeArabicWord(w);
        return catalogVocab.has(norm) || catalogVocab.has(normalizeArabicText(w));
      });
      return hasVocabMatch;
    });
    // إذا فيه أكثر من 6 ناجحة، خذ أول 6
    const finalValidated = validated.slice(0, 6);

    relatedSearchesCache.set(cacheKey, finalValidated);
    return finalValidated;
  } catch (error) {
    console.error('Related searches error:', error.message);
    return [];
  }
}

// ────────────────────────────────────────────────────────────
// 🎯 AI Summary — الحل الجذري:
//
// المشكلة القديمة: LLM يختار نفس المنتج 3 مرات لما الأسعار متقاربة،
//                  أو candidates كلها بنفس السعر بألوان مختلفة.
//
// الحل الجذري (4 طبقات حماية):
// 1) Pre-process candidates: dedupe by (canonical title), بحيث المنتجات
//    اللي تختلف فقط في اللون (نفس الاسم) تُعدّ نسخة واحدة.
// 2) Force diversity: اختار 3 candidates من نطاقات سعرية مختلفة فعلياً
//    (الثلث الأرخص، الثلث المتوسط، الثلث الأعلى). لو القائمة كلها نفس
//    السعر، نُعيد فقط الأرخص بدون "bestValue/premium" (صادق بدل مزيّف).
// 3) Strict prompt: يطلب صراحة أن تكون 3 منتجات DISTINCT بـ titles مختلفة.
// 4) Post-validation: لو الـ LLM رجّع duplicates، نستبدل بـ candidates
//    من الـ pool بدون استدعاء LLM ثاني.
// ────────────────────────────────────────────────────────────

// عنوان كانوني (لإزالة الـ duplicates اللي تختلف فقط في اللون/سايز التافه)
function canonicalTitle(title) {
  if (!title) return '';
  let t = String(title).trim().toLowerCase()
    // ألوان شائعة
    .replace(/\b(أبيض|ابيض|أسود|اسود|فضي|ذهبي|رمادي|بني|أحمر|احمر|أزرق|ازرق|أخضر|اخضر|وردي|زيتي|بيج|كحلي|كريمي|روز|جولد)\b/g, '')
    // الصفات التزيينية
    .replace(/\b(جديد|جديدة|مميز|مميزة|فاخر|فاخرة)\b/g, '')
    // مسافات زائدة
    .replace(/\s+/g, ' ').trim();
  return t;
}

async function generateAISummary(query, products, preferHomeElec) {
  const cacheKey = `${(query || '').toLowerCase().trim()}|${preferHomeElec ? '1' : '0'}`;
  const cached = aiSummaryCache.get(cacheKey);
  if (cached) return cached;
  try {
    // 1️⃣ تحضير المنتجات مع الأسعار الفعلية
    let productsWithDetails = products.slice(0, 30).map(p => {
      const discount = getDiscountInfo(p.price, p.sale_price);
      const effectivePrice = discount.hasDiscount ? extractPrice(p.sale_price) : extractPrice(p.price);
      return { title: p.title, price: p.price, sale_price: p.sale_price, effectivePrice, brand: p.brand, image_link: p.image_link, link: p.link, product_kind: p.product_kind };
    }).filter(p => p.effectivePrice > 0);

    // 🎯 فلتر صارم لـ AI Summary: نأخذ فقط المنتجات اللي تطابق الموضوع perfectly
    // يمنع التوصيات لمنتجات غير ذات صلة (مثل "شيال قلايز" يظهر لبحث "قلاية")
    const aiSubject = extractSubject(query);
    if (aiSubject) {
      const scored = productsWithDetails.map(p => ({ p, score: scoreSubjectMatch(p.title, aiSubject) }));
      const perfectMatches = scored.filter(x => x.score >= 0.999).map(x => x.p);
      if (perfectMatches.length >= 3) {
        productsWithDetails = perfectMatches;
      } else {
        productsWithDetails = scored.filter(x => x.score >= 0.5).sort((a, b) => b.score - a.score).map(x => x.p);
      }
    }

    // 🎯 Kind filter: لو البحث يحدد kind (فرن→appliance، سكين→kitchen_tool)
    // نُبقي فقط المنتجات اللي تطابق الـ kind المتوقع.
    // يمنع "زبدية فرن" يظهر كـ "أرخص فرن" في توصيات بحث "فرن"
    const expectedKindForSummary = getExpectedKind(query);
    if (expectedKindForSummary) {
      const matching = productsWithDetails.filter(p => p.product_kind === expectedKindForSummary);
      if (matching.length >= 3) {
        productsWithDetails = matching;
      }
      // لو أقل من 3، ما نطبّق (نتجنب 0 توصيات)
    }

    if (productsWithDetails.length === 0) return null;

    // 2️⃣ Dedupe by canonical title — المنتجات اللي تختلف فقط في اللون تُعدّ نسخة واحدة
    const byCanonical = new Map();
    for (const p of productsWithDetails) {
      const key = canonicalTitle(p.title);
      if (!key) continue;
      const existing = byCanonical.get(key);
      // نختار النسخة الأرخص لكل canonical title (يمكن نُغيّرها للأكثر شعبية لاحقاً)
      if (!existing || p.effectivePrice < existing.effectivePrice) byCanonical.set(key, p);
    }
    const uniqueProducts = [...byCanonical.values()].sort((a, b) => a.effectivePrice - b.effectivePrice);

    // 3️⃣ التحقق من تنوّع الأسعار — لو كلها نفس السعر تقريباً، ما نُعطي 3 مزيّفة
    const minPrice = uniqueProducts[0].effectivePrice;
    const maxPrice = uniqueProducts[uniqueProducts.length - 1].effectivePrice;
    const priceSpread = maxPrice - minPrice;
    const priceSpreadPct = minPrice > 0 ? priceSpread / minPrice : 0;

    // لو عدد المنتجات الفريدة <3 أو الانتشار السعري <10%، نُرجع أرخص فقط (صدق بدل اختلاق)
    if (uniqueProducts.length < 3 || priceSpreadPct < 0.10) {
      const cheapest = uniqueProducts[0];
      const discount = getDiscountInfo(cheapest.price, cheapest.sale_price);
      const single = {
        title: cheapest.title, image_link: cheapest.image_link, link: cheapest.link, brand: cheapest.brand,
        price: discount.hasDiscount ? cheapest.sale_price : cheapest.price,
        originalPrice: discount.hasDiscount ? cheapest.price : null,
        discountPercentage: discount.discountPercentage,
        hasDiscount: discount.hasDiscount,
        marketing: 'الأفضل قيمة في هذه الفئة',
        pros: ['سعر ممتاز', 'متوفر الآن'],
      };
      const output = {
        summary: `وجدنا ${uniqueProducts.length} منتج بسعر مشابه. أنصح بهذا:`,
        recommendations: { cheapest: single, bestValue: null, premium: null },
        totalProducts: products.length, priceRange: { min: minPrice, max: maxPrice },
        topBrands: [...new Set(products.map(p => p.brand).filter(b => b))].slice(0, 5),
      };
      aiSummaryCache.set(cacheKey, output);
      return output;
    }

    // 4️⃣ Force diversity: اختر من الثلث الأرخص + المتوسط + الأعلى
    const third = Math.max(1, Math.floor(uniqueProducts.length / 3));
    const cheapBucket = uniqueProducts.slice(0, third);
    const midBucket = uniqueProducts.slice(third, third * 2);
    const premiumBucket = uniqueProducts.slice(third * 2);
    // candidate pool: 3 من كل bucket مع الحفاظ على التنوّع
    const candidatePool = [
      ...cheapBucket.slice(0, 3),
      ...midBucket.slice(0, 3),
      ...premiumBucket.slice(-3),
    ];

    const homeElecInstruction = preferHomeElec
      ? '\n📌 للأفضل قيمة والأرقى، فضّل ماركة "home elec" إن وُجدت في القائمة.'
      : '';

    // 5️⃣ Strict prompt — يصرّح بوضوح أن المنتجات الثلاثة DISTINCT
    const prompt = `اختر 3 منتجات مختلفة من القائمة للبحث "${query}".

⚠️ شرط صارم: يجب أن تكون الـ 3 منتجات **مختلفة تماماً** (titles مختلفة، ليست نسخاً بألوان).
- الأرخص: من الأرقام السفلية في السعر
- الأفضل قيمة: من النطاق المتوسط — توازن سعر/ميزات
- الأرقى: من الأرقام العلوية — أعلى مواصفات${homeElecInstruction}

المنتجات (مرتّبة بالسعر تصاعدياً):
${candidatePool.map((p, i) => `${i + 1}. ${p.title} — ${p.effectivePrice}ر.س`).join('\n')}

أعد JSON فقط:
{
  "summary": "ملخّص سطر واحد",
  "recommendations": {
    "cheapest": {"title": "الاسم الكامل بالضبط", "marketing": "جملة تسويقية 🔥", "pros": ["م1","م2"]},
    "bestValue": {"title": "الاسم الكامل بالضبط (مختلف عن cheapest)", "marketing": "...⭐", "pros": ["م1","م2"]},
    "premium": {"title": "الاسم الكامل بالضبط (مختلف عن السابقَين)", "marketing": "...👑", "pros": ["م1","م2"]}
  }
}`;

    const text = await cohereChat({ prompt, jsonMode: true, temperature: 0.4, maxTokens: 700 });
    const aiResult = JSON.parse(text);

    // 6️⃣ findProduct: matching حازم بأولوية للكلمات الأولى
    const findProduct = (title) => {
      if (!title) return null;
      const t = title.trim();
      // exact, prefix-20, prefix-10, first-3-words
      return productsWithDetails.find(p => p.title === t)
          || productsWithDetails.find(p => p.title.includes(t.substring(0, 20)))
          || productsWithDetails.find(p => p.title.includes(t.substring(0, 10)))
          || productsWithDetails.find(p => p.title.includes(t.split(/\s+/).slice(0, 3).join(' ')));
    };

    const enrichRec = (rec) => {
      if (!rec || !rec.title) return null;
      const product = findProduct(rec.title);
      if (!product) return null;
      const discount = getDiscountInfo(product.price, product.sale_price);
      return {
        title: product.title, image_link: product.image_link, link: product.link, brand: product.brand,
        price: discount.hasDiscount ? product.sale_price : product.price,
        originalPrice: discount.hasDiscount ? product.price : null,
        discountPercentage: discount.discountPercentage,
        hasDiscount: discount.hasDiscount,
        marketing: rec.marketing || '',
        pros: rec.pros || [],
        _canonical: canonicalTitle(product.title),
      };
    };

    let cheapest = enrichRec(aiResult.recommendations?.cheapest);
    let bestValue = enrichRec(aiResult.recommendations?.bestValue);
    let premium = enrichRec(aiResult.recommendations?.premium);

    // 7️⃣ Post-validation: لو فيه duplicates بـ canonical title، استبدل من candidatePool
    const used = new Set();
    const replaceIfDuplicate = (rec, fallbackBucket, marketing, pros) => {
      if (!rec || used.has(rec._canonical)) {
        // ابحث عن بديل في الـ bucket المناسب لم يُستخدم
        const alt = fallbackBucket.find(p => !used.has(canonicalTitle(p.title)));
        if (!alt) return null;
        const discount = getDiscountInfo(alt.price, alt.sale_price);
        const altRec = {
          title: alt.title, image_link: alt.image_link, link: alt.link, brand: alt.brand,
          price: discount.hasDiscount ? alt.sale_price : alt.price,
          originalPrice: discount.hasDiscount ? alt.price : null,
          discountPercentage: discount.discountPercentage,
          hasDiscount: discount.hasDiscount,
          marketing, pros,
          _canonical: canonicalTitle(alt.title),
        };
        used.add(altRec._canonical);
        return altRec;
      }
      used.add(rec._canonical);
      return rec;
    };

    cheapest  = replaceIfDuplicate(cheapest,  cheapBucket,   'صفقة لا تفوّت! 🔥', ['أقل سعر', 'متوفر']);
    bestValue = replaceIfDuplicate(bestValue, midBucket,     'توازن مثالي بين السعر والميزات ⭐', ['سعر معقول', 'مواصفات جيدة']);
    premium   = replaceIfDuplicate(premium,   [...premiumBucket].reverse(), 'تجربة فاخرة 👑', ['أعلى مواصفات', 'جودة استثنائية']);

    // إزالة الـ _canonical من الإخراج
    [cheapest, bestValue, premium].forEach(r => { if (r) delete r._canonical; });

    const output = {
      summary: aiResult.summary || `وجدنا ${uniqueProducts.length} منتج مناسب — توصياتنا:`,
      recommendations: { cheapest, bestValue, premium },
      totalProducts: products.length,
      priceRange: { min: minPrice, max: maxPrice },
      topBrands: [...new Set(products.map(p => p.brand).filter(b => b))].slice(0, 5),
    };
    aiSummaryCache.set(cacheKey, output);
    return output;
  } catch (error) {
    console.error('AI Summary error:', error.message);
    return null;
  }
}

app.post('/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Message required' });
    }

    const queryEmbedding = await getQueryEmbedding(message);

    const searchResult = await esClient.search({
      index: INDEX_NAME,
      size: 10,
      _source: ['title', 'price', 'sale_price', 'brand', 'link', 'image_link', 'color', 'size'],
      knn: {
        field: 'embedding',
        query_vector: queryEmbedding,
        k: 10,
        num_candidates: 100,
      },
    });

    const relatedProducts = searchResult.hits.hits.map(hit => {
      const discount = getDiscountInfo(hit._source.price, hit._source.sale_price);
      return {
        title: hit._source.title,
        price: discount.hasDiscount ? hit._source.sale_price : hit._source.price,
        originalPrice: discount.hasDiscount ? hit._source.price : null,
        discountPercentage: discount.discountPercentage,
        hasDiscount: discount.hasDiscount,
        brand: hit._source.brand,
        link: hit._source.link,
        image_link: hit._source.image_link,
        color: hit._source.color,
        size: hit._source.size,
      };
    });

    const productsContext = relatedProducts.slice(0, 5).map((p, i) => {
      const priceText = p.hasDiscount 
        ? `${p.price} (الأصلي: ${p.originalPrice}, خصم ${p.discountPercentage}%)`
        : `${p.price}`;
      return `${i + 1}. ${p.title} - ${priceText} - ${p.brand || 'غير محدد'}`;
    }).join('\n');

    const systemPrompt = `أنت مساعد تسوق ذكي لـ "قصر الأواني".
ودود، مختصر (2-3 جمل)، عربية فصحى بسيطة.
لو السؤال عن جهاز كهربائي، فضّل ماركة "home elec".

المنتجات:
${productsContext}

أعد JSON:
{
  "reply": "ردك",
  "quickReplies": ["سؤال1", "سؤال2", "سؤال3"],
  "suggestedProduct": null أو {"title": "اسم"}
}`;

    // دمج systemPrompt مع الـ user message + استخدام history مع cohereChat
    const fullPrompt = `${systemPrompt}\n\nرسالة المستخدم: ${message}`;
    const text = await cohereChat({
      prompt: fullPrompt,
      history,
      jsonMode: true,
      temperature: 0.7,
    });
    const aiResult = JSON.parse(text);

    let enrichedProduct = null;
    if (aiResult.suggestedProduct && aiResult.suggestedProduct.title) {
      const found = relatedProducts.find(p => 
        p.title === aiResult.suggestedProduct.title || 
        p.title.includes(aiResult.suggestedProduct.title.substring(0, 20))
      );
      if (found) enrichedProduct = found;
    }

    res.json({
      success: true,
      reply: aiResult.reply || 'عذراً، حدث خطأ.',
      quickReplies: aiResult.quickReplies || [],
      suggestedProduct: enrichedProduct,
    });

  } catch (error) {
    console.error('Chat error:', error.message);
    res.status(500).json({ success: false, message: 'Chat failed', error: error.message });
  }
});

// ⚡ مولّد كاش عام: LRU + TTL
function makeCache(maxEntries, ttlMs) {
  const map = new Map();
  return {
    get(key) {
      const e = map.get(key);
      if (!e) return undefined;
      if (Date.now() - e.t > ttlMs) { map.delete(key); return undefined; }
      map.delete(key);
      map.set(key, e);
      return e.v;
    },
    set(key, value) {
      if (map.size >= maxEntries) {
        const firstKey = map.keys().next().value;
        map.delete(firstKey);
      }
      map.set(key, { v: value, t: Date.now() });
    },
    size() { return map.size; },
    clear() { map.clear(); },
    // للحفظ على القرص: نمرّر كل الـ entries غير منتهية الصلاحية
    entries() {
      const out = [];
      const now = Date.now();
      for (const [k, e] of map.entries()) {
        if (now - e.t <= ttlMs) out.push([k, e]);
      }
      return out;
    },
  };
}

// كاشات متعددة الطبقات
const responseCache = makeCache(5000, 24 * 60 * 60 * 1000);  // response كامل — 24 ساعة، 5000 قيد
const translationCache = makeCache(500, 24 * 60 * 60 * 1000);  // ترجمة Arabic→English للـ CLIP
const embeddingCache = makeCache(800, 30 * 60 * 1000);      // embeddings — 30 دقيقة
const classifyCache = makeCache(500, 30 * 60 * 1000);       // تصنيف نوع البحث
const aiSummaryCache = makeCache(300, 30 * 60 * 1000);
const intentCache = makeCache(300, 30 * 60 * 1000);
const smartFiltersCache = makeCache(300, 30 * 60 * 1000);
const relatedSearchesCache = makeCache(300, 30 * 60 * 1000);

// كاش للتصحيح الإملائي (هل تقصد...) — يبقى للتوافق الخلفي
const typoCache = new Map();
const TYPO_CACHE_MAX = 500;

// كشف الأخطاء الإملائية بـ GPT
// يرجع نص التصحيح أو null
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📚 Catalog Vocabulary — مفردات حقيقية من عناوين المنتجات
// يُبنى مرة واحدة عند بدء السيرفر، ويُستخدم لتصحيح الإملاء
// بأقرب كلمة موجودة فعلاً في الكتالوج (لا LLM hallucination)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// vocab: Map<normalizedWord, { display: rawWord, count: int }>
const catalogVocab = new Map();
const CATALOG_STOPWORDS = new Set([
  'مع','من','إلى','الى','على','عن','في','هذا','هذه','ذلك','الـ','ال','و','أو','او','أم',
  'بـ','كـ','فـ','لـ','هو','هي','نحن','هم','هن','أنت','انت','أنا','انا',
]);

function normalizeArab(w) {
  // تطبيع: تشكيل، همزات، تاء مربوطة
  return w.replace(/[ً-ٟ]/g, '')
          .replace(/[إأآا]/g, 'ا')
          .replace(/[ىي]/g, 'ي')
          .replace(/ة/g, 'ه');
}

// 🔍 Autocomplete corpus — عبارات 2-3 كلمات من عناوين المنتجات
// مرتّبة بالتكرار، تُستخدم في /suggest endpoint للاقتراحات أثناء الكتابة
const autocompletePhrases = []; // [{ phrase, count, norm }]
const AUTOCOMPLETE_STOPWORDS = new Set([
  'مع', 'من', 'في', 'على', 'إلى', 'الى', 'عن', 'و', 'أو', 'او',
  'هذا', 'هذه', 'الـ', 'ال', 'بـ', 'لـ', 'بدون', 'مع',
  'لتر', 'مل', 'كيلو', 'كجم', 'واط', 'قدم', 'سم', 'مم', 'إنش', 'بوصة',
]);

function buildAutocompleteCorpus() {
  autocompletePhrases.length = 0;
  const counts = new Map();   // phrase → count
  const norms = new Map();    // phrase → normalized
  const usedNorms = new Set();

  for (const [, product] of productByCode) {
    const title = (product.title || '').toLowerCase();
    if (!title) continue;
    // tokens
    const tokens = title.split(/\s+/)
      .map(t => t.replace(/[،.,!?:;"'()\[\]{}\-_/]/g, '').trim())
      .filter(t => t.length >= 2);

    // 2-grams و 3-grams بدون stopwords في الأول
    for (let i = 0; i < tokens.length; i++) {
      if (AUTOCOMPLETE_STOPWORDS.has(tokens[i])) continue;
      if (/^\d+(?:\.\d+)?$/.test(tokens[i])) continue; // أرقام لوحدها مش مفيدة
      // 2-gram
      if (i + 1 < tokens.length && tokens[i + 1].length >= 2 && !/^\d+(?:\.\d+)?$/.test(tokens[i + 1])) {
        const phrase = `${tokens[i]} ${tokens[i + 1]}`;
        counts.set(phrase, (counts.get(phrase) || 0) + 1);
      }
      // 3-gram
      if (i + 2 < tokens.length && tokens[i + 1].length >= 2 && tokens[i + 2].length >= 2 &&
          !/^\d+(?:\.\d+)?$/.test(tokens[i + 1]) && !/^\d+(?:\.\d+)?$/.test(tokens[i + 2])) {
        const phrase = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
        counts.set(phrase, (counts.get(phrase) || 0) + 1);
      }
    }
  }

  // نأخذ فقط العبارات اللي تكررت ≥ 2 مرات (تفاديا للضوضاء)
  for (const [phrase, count] of counts) {
    if (count >= 2) {
      const norm = normalizeArab(phrase);
      // dedup by normalized form (نُبقي الأكثر تكراراً)
      if (!usedNorms.has(norm)) {
        usedNorms.add(norm);
        autocompletePhrases.push({ phrase, count, norm });
      } else {
        const existing = autocompletePhrases.find(p => p.norm === norm);
        if (existing && count > existing.count) {
          existing.phrase = phrase;
          existing.count = count;
        }
      }
    }
  }
  // sort by count DESC للوصول السريع للأكثر شيوعاً
  autocompletePhrases.sort((a, b) => b.count - a.count);
  console.log(`🔍 Autocomplete corpus: ${autocompletePhrases.length} عبارة (2-3 كلمات)`);
}

// /suggest endpoint — اقتراحات إكمال أثناء الكتابة
function getAutocompleteSuggestions(prefix, limit = 8) {
  if (!prefix || prefix.trim().length < 2) return [];
  const p = prefix.toLowerCase().trim();
  const pNorm = normalizeArab(p);
  const matches = [];
  for (const item of autocompletePhrases) {
    if (matches.length >= limit) break;
    // مطابقة: العبارة تبدأ بـ prefix (بعد normalization)
    if (item.norm.startsWith(pNorm)) {
      matches.push(item.phrase);
    }
  }
  return matches;
}

function buildCatalogVocab() {
  catalogVocab.clear();
  let processed = 0;
  for (const [, product] of productByCode) {
    const title = (product.title || '').toLowerCase();
    if (!title) continue;
    processed++;
    // tokenize: عربي/إنجليزي + أرقام مع وحدات
    const words = title.split(/\s+/).filter(w => w.length >= 3);
    for (const w of words) {
      // ننظف من علامات الترقيم
      const clean = w.replace(/[،.,!?:;"'()\[\]{}\-_/]/g, '').trim();
      if (clean.length < 3) continue;
      if (CATALOG_STOPWORDS.has(clean)) continue;
      // الأرقام لوحدها ليست مفيدة كـ vocab
      if (/^\d+(?:\.\d+)?$/.test(clean)) continue;
      const norm = normalizeArab(clean);
      const e = catalogVocab.get(norm) || { display: clean, count: 0, displayCount: 0 };
      e.count++;
      // ⭐ معايير تفضيل الـ display:
      //   1) ينتهي بـ ة بدلاً من ه (الإملاء العربي الفصيح: قلاية لا قلايه)
      //   2) يحتوي همزة (أ/إ/آ) بدل ا فقط (أبيض > ابيض)
      //   3) أطول
      //   4) أكثر تكراراً
      const currentEndsTa = e.display.endsWith('ة');
      const newEndsTa = clean.endsWith('ة');
      const currentHasHamza = /[أإآ]/.test(e.display);
      const newHasHamza = /[أإآ]/.test(clean);

      let preferNew = false;
      if (newEndsTa && !currentEndsTa) preferNew = true;
      else if (newEndsTa === currentEndsTa && newHasHamza && !currentHasHamza) preferNew = true;
      else if (newEndsTa === currentEndsTa && newHasHamza === currentHasHamza && clean.length > e.display.length) preferNew = true;

      if (preferNew) { e.display = clean; e.displayCount = 1; }
      else if (clean === e.display) e.displayCount++;
      catalogVocab.set(norm, e);
    }
  }
  console.log(`📚 Catalog vocab: ${catalogVocab.size} كلمة فريدة من ${processed} منتج`);
}

// Levenshtein distance — تطبيق نظيف بـ DP كاملة
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,     // حذف
        dp[i][j - 1] + 1,     // إدراج
        dp[i - 1][j - 1] + cost  // استبدال
      );
    }
  }
  return dp[m][n];
}

// يصحّح كلمة واحدة من المفردات الحقيقية في الكتالوج
// يُرجع أفضل تصحيح واحد (الـ behavior الأصلي) — للاستخدام السريع
function findClosestCatalogWord(word) {
  const cands = findCatalogCandidates(word);
  if (cands.length === 0) return null;
  return cands[0];
}

// يُرجع جميع المرشحين المرتّبين (للسماح بالتجربة المتعدّدة عند الحاجة)
// أول عنصر هو الأفضل (exact إن وُجد، وإلا أقرب بحسب distance+count)
function findCatalogCandidates(word, maxCount = 5) {
  const lower = word.toLowerCase();
  const norm = normalizeArab(lower);
  const maxDistance = norm.length <= 4 ? 1 : norm.length <= 6 ? 2 : 3;

  const exactEntry = catalogVocab.get(norm);
  const candidates = [];

  // 1) exact match (لو موجود)
  if (exactEntry) {
    candidates.push({
      word: exactEntry.display,
      distance: 0,
      count: exactEntry.count,
      isExactSpelling: exactEntry.display.toLowerCase() === lower,
    });
  }

  // 2) كل الـ fuzzy candidates ضمن maxDistance
  // adjustedDistance يضيف penalty عند اختلاف أول/آخر حرف — يفضّل التصحيحات اللي تحافظ على الحروف الطرفية
  // مثال: \"غسلة\" → \"غسالة\" (أول حرف محفوظ) أفضل من \"سلة\" (أول حرف ضائع) رغم تساوي levenshtein
  const fuzzy = [];
  const queryFirst = norm[0];
  const queryLast = norm[norm.length - 1];
  for (const [vocabWord, entry] of catalogVocab) {
    if (vocabWord === norm) continue;
    if (Math.abs(vocabWord.length - norm.length) > maxDistance) continue;
    const d = levenshtein(norm, vocabWord);
    if (d <= maxDistance) {
      const firstPenalty = vocabWord[0] !== queryFirst ? 0.5 : 0;
      const lastPenalty = vocabWord[vocabWord.length - 1] !== queryLast ? 0.3 : 0;
      const adjustedDistance = d + firstPenalty + lastPenalty;
      fuzzy.push({ word: entry.display, distance: d, adjustedDistance, count: entry.count, isExactSpelling: false });
    }
  }
  fuzzy.sort((a, b) => a.adjustedDistance - b.adjustedDistance || b.count - a.count);

  // 3) دمج: لو exact نادر (count ≤ 2) ولدينا بديل قريب جداً ≥ 5x count → نُفضّل البديل أولاً
  if (exactEntry && fuzzy.length > 0) {
    const exactCount = exactEntry.count;
    const topFuzzy = fuzzy[0];
    if (topFuzzy.distance === 1 && exactCount <= 2 && topFuzzy.count >= exactCount * 5 && topFuzzy.count >= 5) {
      // نُفضّل الـ fuzzy في الترتيب
      candidates.unshift(...fuzzy.splice(0, 1));
    }
  }
  candidates.push(...fuzzy);

  return candidates.slice(0, maxCount);
}

// يصحّح استعلام كامل — يُرجع التصحيح "الأفضل" (الأول من المرشحين)
function catalogTypoCorrect(query) {
  const allCorrections = catalogTypoCorrectionCandidates(query, 1);
  return allCorrections[0] || null;
}

// يُرجع جميع التصحيحات الممكنة (cartesian product للمرشحين)
// مرتّبة حسب إجمالي count للكلمات المصحّحة
function catalogTypoCorrectionCandidates(query, maxResults = 5) {
  if (!query) return [];
  const words = query.trim().split(/\s+/).filter(w => w.length >= 2);
  if (words.length === 0) return [];

  // 🛡️ كلمات معروفة لا تحتاج تصحيح (device-words + modifiers)
  // يمنع "آلة" تتحوّل لـ "إلك" (brand) أو "كهربائي" يتحول لمنتج آخر
  const KNOWN_WORDS = new Set(
    [...GENERIC_DEVICE_WORDS, ...SUBJECT_MODIFIERS, ...SPECIFIC_DEVICE_NAMES]
      .map(w => normalizeArabicText(w))
  );

  // لكل كلمة: ابحث عن مرشحين متعدّدين (للكلمات اللي فيها typo)
  const wordCandidates = words.map(w => {
    // لو الكلمة معروفة (جهاز/modifier)، احتفظ بها كما هي بدون تصحيح
    if (KNOWN_WORDS.has(normalizeArabicText(w))) {
      return [{ word: w, isExactSpelling: true, count: 0 }];
    }
    const cands = findCatalogCandidates(w, 3);
    if (cands.length === 0) return [{ word: w, isExactSpelling: true, count: 0 }];
    if (cands[0].isExactSpelling) return [cands[0]];
    return cands.slice(0, 3);
  });

  // cartesian product مع scoring مرجّح
  // cost لكل كلمة:
  //   - exact spelling match: 0 (لا تصحيح)
  //   - canonical normalization (نفس normalized لكن إملاء مختلف): 0.5
  //   - fuzzy distance N: N (دائماً > 0)
  const combinations = [];
  const buildCombo = (idx, current, totalCost, totalCount) => {
    if (idx >= wordCandidates.length) {
      const hasChanges = current.some((c, i) => c.toLowerCase() !== words[i].toLowerCase());
      if (hasChanges) {
        combinations.push({ corrected: current.join(' '), cost: totalCost, count: totalCount });
      }
      return;
    }
    for (const cand of wordCandidates[idx]) {
      let wordCost;
      if (cand.isExactSpelling) wordCost = 0;
      else if (cand.distance === 0) wordCost = 0.5;   // canonical normalization
      else wordCost = (cand.adjustedDistance != null ? cand.adjustedDistance : cand.distance);
      buildCombo(idx + 1, [...current, cand.word], totalCost + wordCost, totalCount + (cand.count || 0));
    }
  };
  buildCombo(0, [], 0, 0);

  // sort: أقل cost أولاً (distance أهم)، ثم أعلى count عند تساوي cost
  const seen = new Set();
  const unique = [];
  for (const c of combinations) {
    if (seen.has(c.corrected)) continue;
    seen.add(c.corrected);
    unique.push(c);
  }
  unique.sort((a, b) => a.cost - b.cost || b.count - a.count);
  return unique.slice(0, maxResults).map(c => ({ corrected: c.corrected, hasChanges: true }));
}

// 🔍 Quick count: عدد المنتجات المطابقة لاستعلام (للتحقق من جودة typo correction)
async function quickCountForQuery(query) {
  try {
    const result = await esClient.search({
      index: INDEX_NAME,
      size: 0,
      query: {
        multi_match: {
          query, fields: ['title^2', 'brand'],
          fuzziness: '0',  // بدون fuzzy — match صارم
          operator: 'and', // كل الكلمات مطلوبة
        },
      },
      track_total_hits: 50,
    });
    return result.hits.total.value || 0;
  } catch { return 0; }
}

// 🪄 بناء 3 اقتراحات تصحيحية ديناميكية من الكتالوج
// لما المستخدم يكتب نص فيه typo، نعرض 3 خيارات حقيقية بدل intent chips التصنيفية
async function buildCorrectionSuggestions(correctedQuery, products) {
  const suggestions = [];
  const used = new Set();
  const addIfNew = (title, description, icon = 'sparkles') => {
    const key = title.replace(/\s+/g, ' ').trim().toLowerCase();
    if (used.has(key) || suggestions.length >= 3) return;
    used.add(key);
    suggestions.push({ title, description: description || title, icon, searchQuery: title });
  };

  // 1️⃣ النص المصحح كاملاً (الأهم)
  addIfNew(correctedQuery, 'النص المصحح', 'sparkles');

  // 2️⃣ متغيرات من قاموس categories لو الـ corrected query يطابقها
  const dictResult = getDictionaryIntent(correctedQuery);
  if (dictResult && dictResult.suggestions) {
    for (const s of dictResult.suggestions) {
      addIfNew(s.searchQuery || s.title, s.description, s.icon);
      if (suggestions.length >= 3) break;
    }
  }

  // 3️⃣ لو ما زلنا أقل من 3، نضيف من الـ statistical (bigrams من المنتجات الحقيقية)
  if (suggestions.length < 3) {
    const statResult = getStatisticalIntent(correctedQuery, products);
    if (statResult && statResult.suggestions) {
      for (const s of statResult.suggestions) {
        addIfNew(s.searchQuery || s.title, s.description, s.icon);
        if (suggestions.length >= 3) break;
      }
    }
  }

  return suggestions;
}

// 🧠 detectTypo — يبحث عن أقرب كلمة في كتالوج المنتجات الحقيقية
// المنهج: catalog vocab أولاً (دقة 100% — لا hallucination)، LLM فقط كـ fallback
// يعمل حتى لو فيه نتائج fuzzy للاستعلام الأصلي (يقارن: هل التصحيح أكثر دقة؟)
async function detectTypo(query, originalCount = null) {
  const key = (query || '').trim().toLowerCase();
  if (key.length < 2) return null;
  if (typoCache.has(key)) return typoCache.get(key);

  try {
    if (originalCount === null) originalCount = await quickCountForQuery(query);

    // 0) لو الكويري الأصلي يعطي نتائج كافية (5+)، فهو صحيح — لا نقترح تصحيحاً
    // هذا يمنع الـ false positives مثل: \"غسالة\" (50 نتيجة) → \"غلاية\" (خطأ)
    if (originalCount >= 5) {
      typoCache.set(key, null);
      return null;
    }

    // 1) ⭐ المسار الأساسي: تصحيح من كتالوج المنتجات الحقيقي
    // المرشحون مرتّبون مسبقاً حسب cost (Levenshtein) من catalogTypoCorrectionCandidates
    // نأخذ أوّل مرشح يحقّق الشرط: count كافٍ. نحتفظ بالترتيب (لا نُعيد الفرز).
    const candidates = catalogTypoCorrectionCandidates(query, 5);
    if (candidates.length > 0) {
      // فحص كل candidate بالـ ES count
      for (const c of candidates) {
        const cnt = await quickCountForQuery(c.corrected);
        if (cnt >= Math.max(originalCount, 1)) {
          console.log(`✓ catalog typo: "${query}" (${originalCount}) → "${c.corrected}" (${cnt})`);
          typoCache.set(key, c.corrected);
          return c.corrected;
        }
        console.log(`  candidate rejected: "${c.corrected}" (${cnt})`);
      }
    }

    // 2) إذا الكتالوج ما لقى وresults كافية، لا نلجأ لـ LLM (الـ fuzzy match يكفي)
    if (originalCount >= 5) {
      typoCache.set(key, null);
      return null;
    }

    // 3) Fallback LLM: فقط لو original<5 والكتالوج فشل
    const prompt = `مدقق إملائي لمتجر أدوات منزلية سعودي.
البحث: "${query}" (يرجع ${originalCount} نتائج فقط)
اقترح تصحيحاً واحداً فقط من كلمات شائعة في متاجر سعودية.

JSON: {"hasTypo": true|false, "correction": "..."}`;
    const text = await cohereChat({ prompt, jsonMode: true, temperature: 0, maxTokens: 80 });
    const result = JSON.parse(text);

    let correction = null;
    if (result.hasTypo && result.correction && typeof result.correction === 'string') {
      const c = result.correction.trim();
      if (c && c.toLowerCase() !== key) {
        const correctedCount = await quickCountForQuery(c);
        if (correctedCount > Math.max(originalCount, 0) + 2) {
          correction = c;
          console.log(`✓ LLM typo: "${query}" → "${c}" (${correctedCount})`);
        }
      }
    }

    if (typoCache.size >= TYPO_CACHE_MAX) {
      const firstKey = typoCache.keys().next().value;
      typoCache.delete(firstKey);
    }
    typoCache.set(key, correction);
    return correction;
  } catch (error) {
    console.error('Typo detection error:', error.message);
    return null;
  }
}

// أنشئ تنسيق: ياخذ منتج/بحث أساسي ويرتّب 9 منتجات في 3 صفوف متناسقة
app.post('/tansiq', async (req, res) => {
  try {
    const { context, message, history = [] } = req.body;

    if (!context || !context.query) {
      return res.status(400).json({ success: false, message: 'Context required' });
    }

    const baseQuery = message ? `${context.query} ${message}` : context.query;

    // 1. embedding واحد + بحث kNN واحد للحصول على 30 مرشّح
    const queryEmbedding = await getQueryEmbedding(baseQuery);

    const searchRes = await esClient.search({
      index: INDEX_NAME,
      size: 30,
      _source: ['title', 'image_link', 'price', 'sale_price', 'brand', 'link', 'color', 'size', 'product_kind'],
      knn: {
        field: 'embedding',
        query_vector: queryEmbedding,
        k: 30,
        num_candidates: 200,
      },
    });

    const candidates = searchRes.hits.hits.map((hit, idx) => ({
      idx,
      hit,
      title: hit._source.title,
      color: hit._source.color || '',
      size: hit._source.size || '',
    }));

    if (candidates.length === 0) {
      return res.json({ success: true, reply: 'ما لقيت منتجات للتنسيق', rows: [] });
    }

    // 2. استدعاء واحد لـ GPT لتنظيم المرشّحين في 3 صفوف
    const historyText = history.slice(-4).map(m =>
      `${m.role === 'user' ? 'المستخدم' : 'المساعد'}: ${typeof m.content === 'string' ? m.content : (m.content.reply || '')}`
    ).join('\n');

    const prompt = `أنت خبير تنسيق منتجات لمتجر "قصر الأواني" السعودي.

🎯 المهمة:
نظّم 9 منتجات من القائمة أدناه في 3 صفوف متناسقة (3 منتجات لكل صف).

السياق:
- البحث الأساسي: "${context.query}"${context.product ? `\n- المنتج المرجع: ${context.product.title}${context.product.color ? ` (لون: ${context.product.color})` : ''}` : ''}
${message ? `- طلب المستخدم الحالي: ${message}` : ''}
${historyText ? `\nالمحادثة السابقة:\n${historyText}` : ''}

المنتجات المتاحة (مرقّمة من 0):
${candidates.map(c => `${c.idx}. ${c.title}${c.color ? ` [${c.color}]` : ''}${c.size ? ` (${c.size})` : ''}`).join('\n')}

📌 قواعد التنسيق:
- الصف الأول: المنتجات الأساسية الأقرب لـ "${context.query}" (3 منتجات رئيسية)
- الصف الثاني: منتجات مكمّلة من نفس الستايل/اللون أو من فئة مرتبطة
- الصف الثالث: إضافات تكمّل التنسيق الكامل
- اختر منتجات متناسقة في اللون/الستايل قدر الإمكان
- لا تكرر منتج في صفين
- استخدم indices من القائمة فقط (0-${candidates.length - 1})

اختر أيقونة لكل صف من: ✨ 🎨 ☕ 🍵 🏠 🍳 🎁 💎 🌟

أعد JSON فقط:
{
  "reply": "وصف قصير للتنسيق (جملة واحدة ودودة)",
  "rows": [
    {"title": "عنوان الصف", "icon": "emoji", "productIndices": [n, n, n]},
    {"title": "...", "icon": "...", "productIndices": [...]},
    {"title": "...", "icon": "...", "productIndices": [...]}
  ],
  "quickReplies": ["اقتراح تعديل1", "اقتراح تعديل2", "اقتراح تعديل3"]
}`;

    const aiText = await cohereChat({ prompt, jsonMode: true, temperature: 0.7 });
    const aiResult = JSON.parse(aiText);

    const buildProduct = (hit) => {
      const discount = getDiscountInfo(hit._source.price, hit._source.sale_price);
      return {
        title: hit._source.title,
        image_link: hit._source.image_link,
        price: discount.hasDiscount ? hit._source.sale_price : hit._source.price,
        originalPrice: discount.hasDiscount ? hit._source.price : null,
        discountPercentage: discount.discountPercentage,
        hasDiscount: discount.hasDiscount,
        brand: hit._source.brand,
        link: hit._source.link,
        color: hit._source.color || '',
        size: hit._source.size || '',
      };
    };

    const usedIndices = new Set();
    const rows = (aiResult.rows || []).slice(0, 3).map(row => {
      const products = (row.productIndices || [])
        .filter(i => typeof i === 'number' && i >= 0 && i < candidates.length && !usedIndices.has(i))
        .slice(0, 3)
        .map(i => { usedIndices.add(i); return buildProduct(candidates[i].hit); });
      return {
        title: row.title || '',
        icon: row.icon || '✨',
        products,
      };
    }).filter(r => r.products.length > 0);

    res.json({
      success: true,
      reply: aiResult.reply || '',
      quickReplies: aiResult.quickReplies || [],
      rows,
    });
  } catch (error) {
    console.error('Tansiq error:', error.message);
    res.status(500).json({ success: false, message: 'Tansiq failed', error: error.message });
  }
});

// تحميل صورة من URL وتحويلها إلى base64
async function fetchImageAsBase64(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch failed: ${r.status}`);
  const buf = await r.arrayBuffer();
  const mimeType = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
  return { mimeType, data: Buffer.from(buf).toString('base64') };
}

// توليد بـ Gemini Nano Banana (gemini-2.5-flash-image) — يقبل صور المنتجات كمدخلات
async function generateWithGemini(prompt, items) {
  if (!gemini) throw new Error('GEMINI_API_KEY not configured');

  const imageParts = [];
  for (const p of items) {
    if (p.image_link) {
      try {
        const img = await fetchImageAsBase64(p.image_link);
        imageParts.push({ inlineData: img });
      } catch (e) {
        console.warn(`Failed to fetch image ${p.image_link}: ${e.message}`);
      }
    }
  }

  const response = await gemini.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents: [{ role: 'user', parts: [{ text: prompt }, ...imageParts] }],
  });

  const parts = response.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      const mt = part.inlineData.mimeType || 'image/png';
      return `data:${mt};base64,${part.inlineData.data}`;
    }
  }
  return null;
}

// توليد صورة تنسيق منزلي للمنتجات المختارة (تصميم في بيت)
app.post('/tansiq-compose', async (req, res) => {
  try {
    const { products = [] } = req.body;
    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ success: false, message: 'products array required' });
    }

    const items = products.slice(0, 3);

    const itemsDescription = items
      .map((p, i) => `${i + 1}. ${p.title || ''}${p.color ? ` (color: ${p.color})` : ''}${p.size ? ` (size: ${p.size})` : ''}`)
      .join('\n');

    const geminiPrompt = `You are compositing real products from the ${items.length} attached image${items.length > 1 ? 's' : ''} into a single interior scene.

╔════════════════════════════════════════════════════════════════╗
║  ABSOLUTE NON-NEGOTIABLE RULES — VIOLATION = FAILURE           ║
╠════════════════════════════════════════════════════════════════╣
║  1. DO NOT change, alter, redesign, recolor, retexture, or     ║
║     restyle any product in the attached images. EVER.          ║
║  2. Each product in the output MUST be a pixel-accurate copy   ║
║     of the source: SAME exact shape, SAME exact colors,        ║
║     SAME exact materials, SAME exact proportions,              ║
║     SAME exact patterns, SAME exact branding/logos/text.       ║
║  3. DO NOT swap a product for a "similar looking" one.         ║
║     DO NOT generate a variation. DO NOT improve, modernize,    ║
║     simplify, or stylize the product.                          ║
║  4. DO NOT add, remove, or modify any handle, lid, spout,      ║
║     decoration, label, or detail on the product.               ║
║  5. DO NOT change the product's color even slightly — not      ║
║     darker, not lighter, not warmer, not cooler.               ║
║  6. The ONLY things you may do:                                ║
║       • Reposition products in 3D space within the scene       ║
║       • Adjust lighting & shadows ON the products to match     ║
║         the scene (without changing their intrinsic color)     ║
║       • Build a background environment AROUND the products     ║
║  7. If you cannot place a product without modifying it, keep   ║
║     it visible AS-IS in its exact original form.               ║
║                                                                ║
║  8. ⚠️ REALISTIC PROPORTIONS — STRICTLY ENFORCE:               ║
║     Each product MUST appear at its real-world physical size   ║
║     RELATIVE to the other products in the scene.               ║
║     Examples of correct scale:                                 ║
║       • A thermos (1L) is MUCH LARGER than a small cup/فنجان   ║
║       • A coffee cup is SMALLER than a teapot                  ║
║       • A serving tray is LARGER than the items on it          ║
║       • Small accessories (saucers, spoons) are SMALLEST       ║
║     DO NOT enlarge small accessories (cups, saucers, plates)   ║
║     to make them more visible. Respect physical reality.       ║
║     If a product is small in real life, render it small —      ║
║     even if that makes it less prominent in the composition.   ║
║                                                                ║
║  9. CAMERA PERSPECTIVE: Use a single consistent viewpoint and  ║
║     focal length. All products share the same camera distance  ║
║     and angle. No products should appear "zoomed in" relative  ║
║     to others — they all sit in the same physical space.       ║
║                                                                ║
║ 10. HERO PRODUCT POSITIONING:                                  ║
║     The LARGEST product (e.g., thermos, pitcher) is the HERO   ║
║     and MUST dominate the composition:                         ║
║       • Place HERO in the FOREGROUND CENTER or LEFT-CENTER     ║
║       • HERO should occupy ~50-60% of the vertical frame       ║
║       • Smaller accessories (cups, saucers) go BEHIND the HERO ║
║         OR beside it at the SAME camera distance               ║
║       • DO NOT place small accessories closer to the camera    ║
║         than the hero — this falsely enlarges them             ║
║       • Cups/glasses must visibly look LIKE accessories,       ║
║         not co-equal with the hero                             ║
║                                                                ║
║ 11. EXPLICIT SIZE RATIOS (must be obvious to the eye):         ║
║       • If hero is 1L thermos (~25cm tall) and accessory is    ║
║         a drinking cup (~9cm tall), the cup MUST appear        ║
║         ~1/3 the height of the thermos in the image            ║
║       • A saucer (~2cm tall) MUST appear as a thin disc,       ║
║         not as a deep bowl                                     ║
║       • Tea/coffee cups (~7cm) MUST appear ~1/4 the thermos    ║
║                                                                ║
║ 12. ⚠️ QUANTITY LIMITS FOR SETS — CRITICAL:                    ║
║       • If a product is a SET of cups/glasses/saucers/         ║
║         فناجين/بيالات/كاسات (typically 6+ pieces in catalog),  ║
║         render ONLY 2 pieces visible in the scene              ║
║       • DO NOT render all 6 cups stacked or lined up           ║
║       • The 2 visible pieces should look natural — placed      ║
║         beside the hero, not crowded                           ║
║       • This applies to ANY multi-piece set: cups, glasses,    ║
║         saucers, plates, spoons                                ║
║                                                                ║
║ 13. ⚠️ TRAY/SERVING-PLATE PLACEMENT — CRITICAL:                ║
║       • Trays (صينية/طوفرية/صحن تقديم) MUST lay FLAT,          ║
║         HORIZONTAL on the surface — like a foundation          ║
║       • Other products (thermos, cups, teapot) MUST sit        ║
║         ON TOP of the tray when a tray is present              ║
║       • NEVER lean the tray vertically against a wall          ║
║       • NEVER place the tray behind or beside the products     ║
║       • NEVER show the tray standing upright                   ║
║       • The tray is the BASE; everything else rests on it      ║
╚════════════════════════════════════════════════════════════════╝

Products being composited (informational only — the attached images are the source of truth):
${itemsDescription}

Scene to build AROUND the unchanged products:
- Modern Saudi/Arabian home interior — a coffee corner or majlis sitting area
- Products sit on a marble or warm wooden surface
- Warm cozy lighting, soft natural daylight
- Neutral background palette (whites, beiges, gold accents) — applied to the BACKGROUND ONLY, never to the products
- Subtle ambient props nearby (small plant, folded linen, soft fabric) — they must NOT touch, cover, or overlap any product
- Photorealistic high-end magazine quality
- No text overlays added by you (existing logos/text printed on the products must be preserved exactly as in the source images)
- No people
- No additional/invented products beyond what is in the attached images
- Square 1:1 aspect ratio composition

Final reminder: the product images are SACRED. Treat each as a physical object photographed from a slightly different angle if needed — but never modified, never recolored, never restyled.`;

    const openaiPrompt = `An elegant interior home photograph showing these Saudi/Arabian home products arranged together in a beautifully styled coffee corner or majlis sitting area:

${itemsDescription}

Style: warm cozy lighting, modern Saudi home aesthetic, soft natural light, neutral color palette (whites, beiges, gold accents), products placed on a marble or wooden surface with subtle decorative elements like a small plant or folded linen, muted background. Photorealistic magazine quality, no text overlays, no people.`;

    const errors = [];
    let imageUrl = null;
    let usedModel = null;

    // 1) Try Gemini Nano Banana (best — accepts real product images)
    if (gemini) {
      try {
        imageUrl = await generateWithGemini(geminiPrompt, items);
        if (imageUrl) usedModel = 'gemini-3.1-flash-image-preview (Nano Banana Flash 3.1)';
      } catch (err) {
        errors.push(`gemini: ${err.message}`);
        console.warn('Gemini failed:', err.message);
      }
    }

    // 2) Fallback: OpenAI (text-only, can't preserve real product images)
    if (!imageUrl) {
      const tryOpenAI = async (model, extraParams) => {
        const r = await openai.images.generate({
          model, prompt: openaiPrompt, n: 1, size: '1024x1024', ...extraParams,
        });
        const item = r.data?.[0];
        if (!item) return null;
        if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
        if (item.url) return item.url;
        return null;
      };

      const openaiAttempts = [
        { model: 'gpt-image-1', params: { quality: 'medium' } },
        { model: 'dall-e-3', params: { quality: 'standard' } },
        { model: 'dall-e-2', params: {} },
      ];

      for (const { model, params } of openaiAttempts) {
        try {
          imageUrl = await tryOpenAI(model, params);
          if (imageUrl) { usedModel = model; break; }
        } catch (err) {
          errors.push(`${model}: ${err.message}`);
        }
      }
    }

    if (!imageUrl) {
      return res.status(500).json({
        success: false,
        message: 'Image generation failed for all models',
        errors,
      });
    }

    console.log(`🎨 Tansiq composed with ${usedModel}: ${items.length} products`);
    res.json({ success: true, imageUrl, model: usedModel });
  } catch (error) {
    console.error('Tansiq compose error:', error.message);
    res.status(500).json({ success: false, message: 'Image generation failed', error: error.message });
  }
});

// 📷 Visual Similarity Search — يستخدم image embeddings بدلاً من تحويل الصورة لنص
app.post('/image-search', async (req, res) => {
  try {
    const { image, userCropped } = req.body;
    if (!image || typeof image !== 'string' || !image.startsWith('data:image/')) {
      return res.status(400).json({ success: false, message: 'Valid image data URL required' });
    }

    // 🎯 لو المستخدم قصّ يدوياً: نستخدم embedding عادي ضد الحقل العادي فقط
    // (الحقل focused في الكتالوج عبارة عن multi-region blend — paradigm mismatch مع crop نظيف)
    // الكتالوج clip_image_embedding هو CLIP عادي لصورة المنتج الكاملة (استوديو)
    // والـ crop اليدوي يحاكي نفس النمط → match مباشر
    let knnConfig;
    if (userCropped) {
      console.log('📷 CLIP single embedding (user-cropped, plain field only)...');
      const queryEmb = await clipImageEmbedding(image);
      knnConfig = [
        {
          field: 'clip_image_embedding',
          query_vector: queryEmb,
          k: 30,
          num_candidates: 300,
          boost: 1.0,
        },
      ];
    } else {
      console.log('📷 CLIP dual embedding (full + focused multi-region)...');
      const [queryFull, queryFocused] = await Promise.all([
        clipImageEmbedding(image),
        clipImageEmbeddingFocused(image),
      ]);
      knnConfig = [
        {
          field: 'clip_image_embedding',
          query_vector: queryFull,
          k: 30,
          num_candidates: 200,
          boost: 1.0,
        },
        {
          field: 'clip_image_embedding_focused',
          query_vector: queryFocused,
          k: 30,
          num_candidates: 200,
          boost: 1.2,
        },
      ];
    }

    // 2️⃣ kNN search
    const result = await esClient.search({
      index: INDEX_NAME,
      size: 30,
      _source: ['title', 'image_link', 'price', 'sale_price', 'brand', 'link', 'color', 'size', 'product_kind'],
      knn: knnConfig,
    });

    const products = result.hits.hits.map((hit) => {
      const discount = getDiscountInfo(hit._source.price, hit._source.sale_price);
      return {
        id: hit._id,
        score: hit._score,
        title: hit._source.title,
        image_link: hit._source.image_link,
        price: discount.hasDiscount ? hit._source.sale_price : hit._source.price,
        originalPrice: discount.hasDiscount ? hit._source.price : null,
        discountPercentage: discount.discountPercentage,
        hasDiscount: discount.hasDiscount,
        brand: hit._source.brand,
        link: hit._source.link,
        color: hit._source.color || '',
        size: hit._source.size || '',
      };
    });

    if (products.length === 0) {
      return res.json({
        success: false,
        message: 'لم نجد منتجات مشابهة بصرياً (قد تكون فهرسة الصور لم تكتمل بعد)',
        products: [],
      });
    }

    const topTitle = products[0]?.title || '';
    console.log(`📷 Visual search → ${products.length} similar products | top: ${topTitle.substring(0, 50)}`);

    res.json({
      success: true,
      visualSearch: true,
      query: topTitle,            // backward compat (frontend قد يستخدمها كـ label)
      products,
      count: products.length,
    });
  } catch (error) {
    console.error('Visual search error:', error.message);
    res.status(500).json({ success: false, message: 'فشل البحث البصري', error: error.message });
  }
});

// 🔍 GET /suggest?q=قلا&limit=8 — اقتراحات إكمال أثناء الكتابة
// تعتمد على عبارات حقيقية (2-3 كلمات) من عناوين المنتجات في الكتالوج
app.get('/suggest', (req, res) => {
  const q = (req.query.q || '').toString();
  const limit = Math.min(parseInt(req.query.limit) || 8, 20);
  const suggestions = getAutocompleteSuggestions(q, limit);
  res.json({ success: true, query: q, suggestions });
});

app.get('/search', async (req, res) => {
  const query = req.query.q;
  const limit = parseInt(req.query.limit) || 500;
  const skipIntent = req.query.skipIntent === 'true';
  const skipAI = req.query.skipAI === 'true';  // إذا true: نتخطى ميزات الـ AI (ملخص/intent/filters/related/didYouMean)
  const wantDebug = req.query.debug === '1' || req.query.debug === 'true';
  const debugTrace = wantDebug ? [] : null;
  const traceT0 = wantDebug ? Date.now() : 0;
  const trace = (stage, info = {}) => {
    if (!wantDebug) return;
    debugTrace.push({ stage, t: Date.now() - traceT0, ...info });
  };

  // 🆕 Hard filters (من الـ catalog tagging)
  const filterKind = req.query.kind ? String(req.query.kind).toLowerCase().trim() : null;
  const filterSubtype = req.query.subtype ? String(req.query.subtype).toLowerCase().trim() : null;
  const filterTag = req.query.tag ? String(req.query.tag).toLowerCase().trim() : null;
  const filterMaterial = req.query.material ? String(req.query.material).toLowerCase().trim() : null;

  if (!query || !query.trim()) {
    return res.status(400).json({ success: false, message: 'Search query required' });
  }

  // ⚡ بحث بكود المنتج (كامل أو جزئي): lookup مباشر بدون أي ميزات AI
  if (isProductCodeQuery(query)) {
    const matches = lookupByCode(query);
    console.log(`🔎 Product code search "${query}": ${matches.length} match(es)`);

    const products = matches.map(({ code, product }) => {
      const discount = getDiscountInfo(product.price, product.sale_price);
      return {
        id: code,
        score: 1,
        title: product.title,
        image_link: product.image_link,
        price: discount.hasDiscount ? product.sale_price : product.price,
        originalPrice: discount.hasDiscount ? product.price : null,
        discountPercentage: discount.discountPercentage,
        hasDiscount: discount.hasDiscount,
        brand: product.brand,
        link: product.link,
        color: product.color,
        size: product.size,
      };
    });

    return res.json({
      success: true,
      query,
      searchType: 'product-code',
      total: products.length,
      count: products.length,
      products,
      aiSummary: null,
      intent: { isAmbiguous: false, message: '', suggestions: [] },
      filters: { brands: [], sizes: [], sizesTitle: '', thirdOptions: [], thirdTitle: '' },
      relatedSearches: [],
      didYouMean: null,
    });
  }

  // ⚡ كاش الاستجابة الكاملة — الـ hit يجيب الرد فوراً
  const responseCacheKey = `v3|${query.toLowerCase().trim()}|${limit}|${skipIntent ? '1' : '0'}|${skipAI ? '1' : '0'}|k=${filterKind || ''}|s=${filterSubtype || ''}|t=${filterTag || ''}|m=${filterMaterial || ''}`;
  const cachedResponse = responseCache.get(responseCacheKey);
  if (cachedResponse) {
    console.log(`⚡ Response cache hit: "${query}"`);
    return res.json(cachedResponse);
  }

  try {
    // 1+2+3. التصنيف + BGE embedding + CLIP text embedding بالتوازي
    // 🎯 استخدم الـ subject المُنظّف للـ embeddings (يمنع color/material من تشويش kNN)
    const embedSubject = extractSubject(query) || query;
    const clipTextPromise = (async () => {
      try {
        const englishQuery = await translateForClip(embedSubject);
        const emb = await clipTextEmbedding(englishQuery);
        return emb;
      } catch (e) {
        console.warn(`⚠️  CLIP text embedding failed: ${e.message} — fallback to BGE only`);
        return null;
      }
    })();
    const [searchType, queryEmbedding, clipQueryVec] = await Promise.all([
      classifySearchType(query),
      getQueryEmbedding(embedSubject),
      clipTextPromise,
    ]);
    console.log(`Search "${query}" → embed:"${embedSubject}" | type:${searchType.type}${clipQueryVec ? ' | CLIP ✓' : ''}`);
    trace('classify', { query, subject: embedSubject, type: searchType.type, hasCLIP: !!clipQueryVec });

    // 3. Hybrid Search: BM25 (نص) + BGE-M3 (دلالي) + CLIP (بصري) — knn array
    // CLIP boost أعلى لأنه يميّز شكل المنتج (ثلاجة كبيرة vs ترمس صغير مسمّى ثلاجة)
    const knnConfig = [
      {
        field: 'embedding',
        query_vector: queryEmbedding,
        k: limit,
        num_candidates: Math.min(limit * 2, 1000),
        boost: 1.5,
      },
    ];
    if (clipQueryVec) {
      // device queries (ثلاجة/غسالة/قلاية…) تحتاج CLIP أقوى لأن الاسم النصي
      // قد يتطابق مع منتجات صغيرة مسمّاة باسم الجهاز (ترامس 1 لتر اسمها "ثلاجة")
      const clipBoost = searchType.type === 'device' ? 3.5 : 1.5;
      knnConfig.push({
        field: 'clip_image_embedding',
        query_vector: clipQueryVec,
        k: limit,
        num_candidates: Math.min(limit * 2, 1000),
        boost: clipBoost,
      });
    }

    // 🌤️ Seasonal boost — يرفع ×1.15 المنتجات الموسمية الحالية
    const currentSeason = getCurrentSeason();
    const baseQuery = {
      multi_match: {
        query,
        fields: ['title^2', 'brand', 'color', 'size'],
        fuzziness: 'AUTO',
        operator: 'or',
        minimum_should_match: '50%',
      },
    };
    const finalQuery = currentSeason
      ? {
          function_score: {
            query: baseQuery,
            functions: [
              { filter: { term: { product_seasonal: currentSeason } }, weight: 1.15 },
            ],
            score_mode: 'multiply',
            boost_mode: 'multiply',
          },
        }
      : baseQuery;

    const result = await esClient.search({
      index: INDEX_NAME,
      size: limit,
      _source: ['title', 'image_link', 'price', 'sale_price', 'brand', 'link', 'color', 'size', 'product_kind', 'product_subtype', 'product_tags', 'product_material', 'product_seasonal'],
      query: finalQuery,
      knn: knnConfig,
    });

    let products = result.hits.hits.map((hit) => {
      const discount = getDiscountInfo(hit._source.price, hit._source.sale_price);
      return {
        id: hit._id,
        score: hit._score,
        title: hit._source.title,
        image_link: hit._source.image_link,
        price: discount.hasDiscount ? hit._source.sale_price : hit._source.price,
        originalPrice: discount.hasDiscount ? hit._source.price : null,
        discountPercentage: discount.discountPercentage,
        hasDiscount: discount.hasDiscount,
        brand: hit._source.brand,
        link: hit._source.link,
        color: hit._source.color || '',
        size: hit._source.size || '',
        // الحقول الجديدة (قد تكون undefined للمنتجات غير المصنّفة بعد)
        product_kind: hit._source.product_kind || null,
        product_subtype: hit._source.product_subtype || null,
        product_tags: hit._source.product_tags || [],
        product_material: hit._source.product_material || null,
      };
    });

    // 3.5. ⭐ Rerank: محلي (BGE-Reranker via transformers.js) أو cloud (Cohere)
    // top 15 بدل 30 — تسريع ~50% بدون فقد ملحوظ للجودة (top 15 هي العمود الفقري للنتائج)
    if (products.length > 1) {
      try {
        const topN = Math.min(products.length, 15);
        const candidates = products.slice(0, topN);
        const docs = candidates.map(p => {
          const parts = [p.title || ''];
          if (p.color) parts.push(`اللون: ${p.color}`);
          if (p.size) parts.push(`الحجم: ${p.size}`);
          if (p.brand) parts.push(`الماركة: ${p.brand}`);
          return parts.join(' | ');
        });

        let reordered;
        // ⭐ نفضّل دائماً local rerank (مفتوح المصدر)، ثم Cohere كـ fallback
        try {
          const scored = await localRerank(query, docs);
          reordered = scored.map(s => candidates[s.index]);
          console.log(`⭐ Local Rerank (BGE) top ${topN}`);
        } catch (localErr) {
          if (USE_COHERE) {
            const rerankRes = await cohere.v2.rerank({
              query, documents: docs, model: COHERE_RERANK_MODEL, topN,
            });
            reordered = rerankRes.results.map(r => candidates[r.index]);
            console.log(`⭐ Cohere v2 Rerank top ${topN}`);
          } else {
            reordered = candidates;
            console.warn('Rerank skipped:', localErr.message);
          }
        }
        products = [...reordered, ...products.slice(topN)];
      } catch (e) {
        console.warn('Rerank failed (continuing with kNN order):', e.message);
      }
    }

    // 4. Filter accessories — صارم: درج/شنطة/نشاف ليست عناصر رئيسية
    {
      const before = products.length;
      products = products.filter(p => !isAccessory(p.title, searchType.deviceKeyword, query));
      if (products.length !== before) {
        console.log(`Filtered accessories: ${before} → ${products.length}`);
        trace('accessory_filter', { before, after: products.length });
      }
    }

    // 4.1. لو البحث عن جهاز كبير (ثلاجة/غسالة/فرن…)، نستبعد الترامس الصغيرة دائماً
    // صارم: لا fallback. لو 0 نتائج فهو الأصدق من عرض ترمس 1 لتر للباحث عن "ثلاجة"
    if (queryIsLargeAppliance(query)) {
      const beforeCount = products.length;
      products = products.filter(p => !isUndersizedForLargeAppliance(p.title));
      if (products.length !== beforeCount) console.log(`Filtered undersized: ${beforeCount} → ${products.length}`);
    }

    // 4.5. 🎯 فلترة بـ "موضوع البحث" - صارم: لو 0 منتجات، نرجع قائمة فاضية
    // (عرض "فرن" لبحث "بوتاجاز" يُضلّل العميل أكثر من "لا نتائج")
    {
      const subject = extractSubject(query);
      if (subject) {
        const beforeCount = products.length;
        // 🎯 Scoring ذكي: كل منتج يحصل على score 0-1 حسب نسبة تطابق الكلمات
        const scored = products.map(p => ({ p, score: scoreSubjectMatch(p.title, subject) }))
                              .filter(x => x.score > 0);
        scored.sort((a, b) => b.score - a.score);
        const perfectMatches = scored.filter(x => x.score >= 0.999);
        if (perfectMatches.length >= 3) {
          products = perfectMatches.map(x => x.p);
          console.log(`🎯 Subject "${subject}" (strict): ${beforeCount} → ${products.length}`);
          trace('subject_filter', { subject, mode: 'strict', before: beforeCount, after: products.length });
        } else if (scored.length > 0) {
          products = scored.map(x => x.p);
          console.log(`🎯 Subject "${subject}" (scored): ${beforeCount} → ${products.length}`);
          trace('subject_filter', { subject, mode: 'scored', before: beforeCount, after: products.length });
        } else {
          products = [];
          console.log(`🎯 Subject "${subject}": ${beforeCount} → 0`);
          trace('subject_filter', { subject, mode: 'zero', before: beforeCount, after: 0 });
        }
      }

      // 🎯 Kind-based reranking: ارفع المنتجات اللي product_kind يطابق نية البحث
      // مثلاً "فرن" → appliance يطلع أولاً، cookware/accessory ينزل
      const expectedKind = getExpectedKind(query);
      if (expectedKind && products.length > 0) {
        const matching = [];
        const rest = [];
        for (const p of products) {
          if (p.product_kind === expectedKind) matching.push(p);
          else rest.push(p);
        }
        if (matching.length > 0 && rest.length > 0) {
          products = [...matching, ...rest];
          console.log(`🎯 Kind "${expectedKind}": ${matching.length} matched, ${rest.length} demoted`);
          trace('kind_rerank', { kind: expectedKind, matching: matching.length, demoted: rest.length });
        }
      }
    }

    // 4.6. 🔧 فلترة المُحدِّدات: كهربائية/يدوية/إستيل/زجاج/خشبي/بخار/...
    {
      const before = products.length;
      products = applyModifierFilters(query, products);
      if (products.length !== before) {
        console.log(`🔧 Modifiers applied: ${before} → ${products.length}`);
      }
    }

    // 4.7. 🔁 إزالة التكرار: نفس العنوان لا يظهر مرتين
    {
      const seen = new Set();
      const before = products.length;
      products = products.filter(p => {
        const key = (p.title || '').trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (products.length !== before) console.log(`🔁 Dedup: ${before} → ${products.length}`);
    }

    // 4.8. 🏷️ Hard filters من catalog tagging — يطبّق فقط على المنتجات المصنّفة
    // (لا يحذف المنتجات غير المصنّفة لتجنب فقدان النتائج أثناء التصنيف)
    if (filterKind) {
      const before = products.length;
      products = products.filter(p => !p.product_kind || p.product_kind === filterKind);
      console.log(`🏷️ kind=${filterKind}: ${before} → ${products.length}`);
    }
    if (filterSubtype) {
      const before = products.length;
      products = products.filter(p => !p.product_subtype || p.product_subtype === filterSubtype);
      console.log(`🏷️ subtype=${filterSubtype}: ${before} → ${products.length}`);
    }
    if (filterTag) {
      const before = products.length;
      products = products.filter(p => !p.product_tags || p.product_tags.length === 0 || p.product_tags.includes(filterTag));
      console.log(`🏷️ tag=${filterTag}: ${before} → ${products.length}`);
    }
    if (filterMaterial) {
      const before = products.length;
      products = products.filter(p => !p.product_material || p.product_material === filterMaterial);
      console.log(`🏷️ material=${filterMaterial}: ${before} → ${products.length}`);
    }

    // 4.9. 🚫 استبعاد الإكسسوارات تلقائياً لو الـ query عن "آلة/ماكينة/صانعة/جهاز" + اسم
    // (هذي تكمّل ACCESSORY_KEYWORDS بشكل أذكى لما يكتمل تصنيف الـ catalog)
    {
      const qLower = (query || '').toLowerCase();
      // 🎯 كشف نية الجهاز: query فيه آلة/ماكينة/صانعة/جهاز أو اسم جهاز محدد
      const isExplicitAppliance = /(?:^|\s)(آلة|الة|ماكينة|صانعة|جهاز)(?:\s|$)/.test(qLower);
      const isApplianceIntent = isExplicitAppliance
        || SPECIFIC_DEVICE_NAMES.some(w => qLower.includes(w));

      if (isApplianceIntent && !filterKind) {
        const before = products.length;
        if (isExplicitAppliance) {
          // 🎯 صراحة طلب "آلة/ماكينة X" → فقط appliances الحقيقية
          const ALLOWED_FOR_APPLIANCE_INTENT = new Set(['appliance', null, undefined, '']);
          const filtered = products.filter(p => ALLOWED_FOR_APPLIANCE_INTENT.has(p.product_kind));
          if (filtered.length >= 1) products = filtered;
          if (products.length !== before) console.log(`🎯 explicit appliance intent: ${before} → ${products.length}`);
        } else {
          // اسم جهاز ضمني (ثلاجة/غسالة...) — يكفي استبعاد accessory
          products = products.filter(p => p.product_kind !== 'accessory');
          if (products.length !== before) console.log(`🚫 excluded accessories: ${before} → ${products.length}`);
        }
      }
    }

    // 5. Reorder: put home elec first if preferred
    if (searchType.preferHomeElec) {
      const homeElecProducts = products.filter(p => 
        p.brand && p.brand.toLowerCase().includes('home elec')
      );
      const otherProducts = products.filter(p => 
        !p.brand || !p.brand.toLowerCase().includes('home elec')
      );
      products = [...homeElecProducts, ...otherProducts];
    }

    // 6. Extract brands (with smart filtering)
    const allBrands = extractBrands(products, query);

    // 7. Run AI features in parallel (يُتخطّى عند skipAI=true)
    let aiSummary = null, intent = { isAmbiguous: false, message: '', suggestions: [] },
        smartFilters = { sizesTitle: '', sizes: [], thirdTitle: '', thirdOptions: [] },
        relatedSearches = [], didYouMean = null;

    // 🔤 تصحيح إملائي مُوحَّد: catalog vocab أولاً، LLM كـ fallback
    // ملاحظة: لا نمرر products.length (لأنه بعد fuzzy+filters). detectTypo
    // يحسب strict count داخلياً لمقارنة عادلة (strict vs strict)
    const correctedQuery = await detectTypo(query);

    // 🔁 إعادة بحث ذكي: لو فيه typo والنتائج الأصلية قليلة (<5)، نُعيد البحث بالـ corrected
    // وندمج النتائج، بحيث المنتجات تظهر دائماً حتى لو المستخدم كتب خطأ
    if (correctedQuery && products.length < 5) {
      try {
        const reSearchEmbedding = await getQueryEmbedding(correctedQuery);
        const reSearchClip = await clipTextEmbedding(await translateForClip(correctedQuery)).catch(() => null);
        const reSearchKnn = [{ field: 'embedding', query_vector: reSearchEmbedding, k: limit, num_candidates: Math.min(limit * 2, 1000), boost: 1.5 }];
        if (reSearchClip) reSearchKnn.push({ field: 'clip_image_embedding', query_vector: reSearchClip, k: limit, num_candidates: Math.min(limit * 2, 1000), boost: 1.5 });
        const reSearchResult = await esClient.search({
          index: INDEX_NAME, size: limit,
          _source: ['title', 'image_link', 'price', 'sale_price', 'brand', 'link', 'color', 'size', 'product_kind', 'product_subtype', 'product_tags', 'product_material'],
          query: { multi_match: { query: correctedQuery, fields: ['title^2', 'brand', 'color', 'size'], fuzziness: 'AUTO', operator: 'or', minimum_should_match: '50%' } },
          knn: reSearchKnn,
        });
        const corrProducts = reSearchResult.hits.hits.map((hit) => {
          const discount = getDiscountInfo(hit._source.price, hit._source.sale_price);
          return {
            id: hit._id, score: hit._score, title: hit._source.title, image_link: hit._source.image_link,
            price: discount.hasDiscount ? hit._source.sale_price : hit._source.price,
            originalPrice: discount.hasDiscount ? hit._source.price : null,
            discountPercentage: discount.discountPercentage, hasDiscount: discount.hasDiscount,
            brand: hit._source.brand, link: hit._source.link, color: hit._source.color || '', size: hit._source.size || '',
            product_kind: hit._source.product_kind || null, product_subtype: hit._source.product_subtype || null,
            product_tags: hit._source.product_tags || [], product_material: hit._source.product_material || null,
          };
        });
        // طبّق نفس فلاتر النص الأصلي على النتائج الجديدة
        let filteredCorr = corrProducts.filter(p => !isAccessory(p.title, searchType.deviceKeyword, query));
        if (queryIsLargeAppliance(correctedQuery)) {
          filteredCorr = filteredCorr.filter(p => !isUndersizedForLargeAppliance(p.title));
        }
        const corrSubject = extractSubject(correctedQuery);
        if (corrSubject) filteredCorr = filteredCorr.filter(p => titleMatchesSubject(p.title, corrSubject));
        filteredCorr = applyModifierFilters(correctedQuery, filteredCorr);
        // dedup
        const seen = new Set();
        filteredCorr = filteredCorr.filter(p => { const k = (p.title||'').toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
        if (filteredCorr.length > products.length) {
          console.log(`🔁 re-search with "${correctedQuery}": ${products.length} → ${filteredCorr.length} products`);
          products = filteredCorr;
        }
      } catch (e) {
        console.warn('typo re-search failed:', e.message);
      }
    }

    // ⚡ intent سريع:
    // - لو في typo: نعرض 3 اقتراحات تصحيحية ديناميكية (بدل intent chips التصنيفية)
    // - لو لا typo: نعرض intent chips العادي (categories من القاموس أو إحصائي)
    const intentQuery = correctedQuery || query;
    if (!skipIntent) {
      if (correctedQuery) {
        // 🪄 typo detected → 3 correction suggestions
        const corr = await buildCorrectionSuggestions(correctedQuery, products);
        if (corr.length > 0) {
          intent = {
            isAmbiguous: true,
            message: 'هل تقصد أحد هذي:',
            suggestions: corr,
          };
        }
      } else if (products.length >= 5) {
        // الحالة العادية (لا typo) → intent chips التصنيفية
        const dictResult = getDictionaryIntent(intentQuery);
        if (dictResult) {
          intent = dictResult;
        } else {
          const statResult = getStatisticalIntent(intentQuery, products);
          if (statResult) intent = statResult;
        }
      }
    }

    if (!skipAI) {
      // intent: لو نجح القاموس أو الإحصائي، نتخطى LLM. نمرّر النص المصحح إن وُجد
      const intentPromise = (skipIntent || intent.isAmbiguous)
        ? Promise.resolve(intent)
        : detectIntent(intentQuery, products);

      // didYouMean: لو عندنا تصحيح من خطوة detectTypo السابقة، نستخدمه (لا نستدعي LLM مرتين)
      const typoPromise = correctedQuery ? Promise.resolve(correctedQuery) : detectTypo(query, products.length);

      [aiSummary, intent, smartFilters, relatedSearches, didYouMean] = await Promise.all([
        generateAISummary(intentQuery, products.map(p => ({
          title: p.title,
          price: p.originalPrice || p.price,
          sale_price: p.hasDiscount ? p.price : p.originalPrice,
          brand: p.brand,
          image_link: p.image_link,
          link: p.link,
          product_kind: p.product_kind,
        })), searchType.preferHomeElec),
        intentPromise,
        generateSmartFilters(intentQuery, products),
        generateRelatedSearches(intentQuery, products),
        typoPromise,
      ]);
    }

    const finalResponse = {
      success: true,
      query: query,
      searchType: searchType.type,
      total: result.hits.total.value,
      count: products.length,
      products: products,
      aiSummary: aiSummary,
      intent: intent,
      filters: {
        brands: allBrands,
        sizesTitle: smartFilters.sizesTitle,
        sizes: smartFilters.sizes,
        thirdTitle: smartFilters.thirdTitle,
        thirdOptions: smartFilters.thirdOptions,
      },
      relatedSearches: relatedSearches,
      didYouMean: didYouMean,
    };
    if (wantDebug) {
      trace('response_ready', { totalProducts: finalResponse.products?.length || 0, topTitle: finalResponse.products?.[0]?.title?.slice(0, 60) });
      finalResponse.debug = { trace: debugTrace, totalMs: Date.now() - traceT0 };
    }
    responseCache.set(responseCacheKey, finalResponse);
    // 📊 Log queries with few results (catalog gaps)
    logQuery(query, products.length, { searchType: searchType.type, total: result.hits.total.value });
    res.json(finalResponse);

  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Search failed',
      error: error.message,
    });
  }
});

// 🧠 /search/ai — ميزات الذكاء فقط (للـ Lazy Loading): يستدعى بالتوازي مع /search?skipAI=true
app.get('/search/ai', async (req, res) => {
  const query = req.query.q;
  const skipIntent = req.query.skipIntent === 'true';

  if (!query || !query.trim()) {
    return res.status(400).json({ success: false, message: 'Query required' });
  }

  // كود منتج: لا AI features
  if (isProductCodeQuery(query)) {
    return res.json({
      success: true,
      aiSummary: null,
      intent: { isAmbiguous: false, message: '', suggestions: [] },
      filters: { sizesTitle: '', sizes: [], thirdTitle: '', thirdOptions: [] },
      relatedSearches: [],
      didYouMean: null,
    });
  }

  // كاش
  const cacheKey = `ai|${query.toLowerCase().trim()}|${skipIntent ? '1' : '0'}`;
  const cached = responseCache.get(cacheKey);
  if (cached) {
    console.log(`⚡ AI cache hit: "${query}"`);
    return res.json(cached);
  }

  try {
    // نحتاج بعض المنتجات كسياق للـ AI — kNN سريع top 40
    // نفس CLIP signal كـ /search لتطابق النتائج
    const clipTextPromise = (async () => {
      try {
        const englishQuery = await translateForClip(query);
        return await clipTextEmbedding(englishQuery);
      } catch { return null; }
    })();

    const [searchType, queryEmbedding, clipQueryVec] = await Promise.all([
      classifySearchType(query),
      getQueryEmbedding(query),
      clipTextPromise,
    ]);

    const knnAi = [{ field: 'embedding', query_vector: queryEmbedding, k: 40, num_candidates: 200, boost: 1.5 }];
    if (clipQueryVec) {
      const clipBoost = searchType.type === 'device' ? 3.5 : 1.5;
      knnAi.push({ field: 'clip_image_embedding', query_vector: clipQueryVec, k: 40, num_candidates: 200, boost: clipBoost });
    }

    // Hybrid query (BM25 + kNN) — مثل /search تماماً لضمان تطابق النتائج
    const result = await esClient.search({
      index: INDEX_NAME,
      size: 40,
      _source: ['title', 'image_link', 'price', 'sale_price', 'brand', 'link', 'color', 'size', 'product_kind'],
      query: {
        multi_match: {
          query,
          fields: ['title^2', 'brand', 'color', 'size'],
          fuzziness: 'AUTO',
          operator: 'or',
          minimum_should_match: '50%',
        },
      },
      knn: knnAi,
    });

    let products = result.hits.hits.map((hit) => {
      const discount = getDiscountInfo(hit._source.price, hit._source.sale_price);
      return {
        id: hit._id,
        title: hit._source.title,
        image_link: hit._source.image_link,
        price: discount.hasDiscount ? hit._source.sale_price : hit._source.price,
        originalPrice: discount.hasDiscount ? hit._source.price : null,
        discountPercentage: discount.discountPercentage,
        hasDiscount: discount.hasDiscount,
        brand: hit._source.brand,
        link: hit._source.link,
        color: hit._source.color || '',
        size: hit._source.size || '',
        product_kind: hit._source.product_kind,
      };
    });

    // فلاتر صارمة لـ AI summary — صارمة بدون fallback
    // (إذا فلتر يزرّع كل النتائج، نُرجع AI summary فاضي بدل اختيار من ضوضاء)
    products = products.filter(p => !isAccessory(p.title, searchType.deviceKeyword, query));
    if (queryIsLargeAppliance(query)) {
      products = products.filter(p => !isUndersizedForLargeAppliance(p.title));
    }
    {
      const subject = extractSubject(query);
      if (subject) {
        // ⚠️ صارم: لا fallback. لو 0 منتجات تطابق الـ subject، نُرجع 0 (أصدق من ضوضاء)
        products = products.filter(p => titleMatchesSubject(p.title, subject));
      }
    }
    // 🎯 Kind-based filter لـ /search/ai (للتوصيات الذكية)
    // لو "فرن" → نُبقي فقط appliance (يمنع زبدية فرن من الظهور كأرخص فرن)
    {
      const expectedKind = getExpectedKind(query);
      if (expectedKind) {
        const before = products.length;
        const matching = products.filter(p => p.product_kind === expectedKind);
        if (matching.length >= 3) {
          products = matching;
          console.log(`🎯 AI Kind "${expectedKind}": ${before} → ${products.length}`);
        }
      }
    }
    // 🔧 فلتر المُحدِّدات (كهربائية/يدوية/إستيل/زجاج/خشبي/بخار…)
    products = applyModifierFilters(query, products);
    // 🔁 إزالة تكرار العناوين
    {
      const seen = new Set();
      products = products.filter(p => {
        const k = (p.title || '').trim().toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });
    }

    // 🔤 تصحيح إملائي موحَّد
    const correctedQuery = await detectTypo(query);
    const effectiveQuery = correctedQuery || query;

    // ⚡ intent: لو typo نعرض 3 corrections، وإلا categories العادية
    let intentResolved;
    if (skipIntent) {
      intentResolved = { isAmbiguous: false, message: '', suggestions: [] };
    } else if (correctedQuery) {
      const corr = await buildCorrectionSuggestions(correctedQuery, products);
      intentResolved = corr.length > 0
        ? { isAmbiguous: true, message: 'هل تقصد أحد هذي:', suggestions: corr }
        : { isAmbiguous: false, message: '', suggestions: [] };
    } else {
      const rawIntent = getDictionaryIntent(effectiveQuery) || getStatisticalIntent(effectiveQuery, products) || null;
      // Catalog validation: تأكد كل اقتراح يطابق 3+ منتجات
      intentResolved = rawIntent ? await validateIntentSuggestions(rawIntent, effectiveQuery) : null;
    }
    const intentPromise = intentResolved && intentResolved.suggestions && intentResolved.suggestions.length >= 2
      ? Promise.resolve(intentResolved)
      : detectIntent(effectiveQuery, products);

    const [aiSummary, intent, smartFilters, relatedSearches] = await Promise.all([
      generateAISummary(effectiveQuery, products.map(p => ({
        title: p.title,
        price: p.originalPrice || p.price,
        sale_price: p.hasDiscount ? p.price : p.originalPrice,
        brand: p.brand,
        image_link: p.image_link,
        link: p.link,
      })), searchType.preferHomeElec),
      intentPromise,
      generateSmartFilters(effectiveQuery, products),
      generateRelatedSearches(effectiveQuery, products),
    ]);
    const didYouMean = correctedQuery;

    const aiResponse = {
      success: true,
      aiSummary,
      intent,
      filters: {
        sizesTitle: smartFilters.sizesTitle,
        sizes: smartFilters.sizes,
        thirdTitle: smartFilters.thirdTitle,
        thirdOptions: smartFilters.thirdOptions,
      },
      relatedSearches,
      didYouMean,
    };

    responseCache.set(cacheKey, aiResponse);
    res.json(aiResponse);
  } catch (error) {
    console.error('AI enrichment error:', error.message);
    res.status(500).json({ success: false, message: 'AI enrichment failed', error: error.message });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🛠️  Admin endpoints — إضافة منتج + إدارة الـ caches
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// مفتاح بسيط (اختياري): ضع ADMIN_KEY في .env لمنع الوصول العام
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🔒 Admin Security — Option B من proposal:
// HMAC signed tokens (15 min write / 1 h read) + 3/min rate limit + audit log
// التفاصيل: docs/admin-security-proposal.md
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const crypto = require('crypto');
const ADMIN_SECRET = process.env.ADMIN_SECRET || process.env.ADMIN_KEY || '';
const ADMIN_AUDIT_LOG = path.join(__dirname, 'data', 'admin-audit.jsonl');
const ADMIN_WRITE_TTL = 15 * 60;     // 15 دقيقة للعمليات الكتابية
const ADMIN_READ_TTL = 60 * 60;      // 1 ساعة للقراءة فقط
const ADMIN_RATE_WRITE = { max: 3, windowMs: 60_000 };  // 3/min على write
const ADMIN_RATE_READ = { max: 30, windowMs: 60_000 };  // 30/min على read

function signAdminToken(scope = 'write', ttlSec = ADMIN_WRITE_TTL) {
  if (!ADMIN_SECRET) throw new Error('ADMIN_SECRET not configured');
  const payload = {
    exp: Math.floor(Date.now() / 1000) + ttlSec,
    scope,
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', ADMIN_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifyAdminToken(token) {
  if (!ADMIN_SECRET || !token) return { ok: false, reason: 'missing' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [b64, sig] = parts;
  const expected = crypto.createHmac('sha256', ADMIN_SECRET).update(b64).digest('base64url');
  if (sig.length !== expected.length) return { ok: false, reason: 'bad_sig' };
  let same = false;
  try { same = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); }
  catch { return { ok: false, reason: 'bad_sig' }; }
  if (!same) return { ok: false, reason: 'bad_sig' };
  let payload;
  try { payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')); }
  catch { return { ok: false, reason: 'bad_payload' }; }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}

// Rate limit per-IP (in-memory). يضبط window و max حسب write vs read
const adminRateBuckets = new Map(); // ip:scope -> [timestamps]
function rateLimitCheck(ip, scope, policy) {
  const key = `${ip}:${scope}`;
  const now = Date.now();
  const bucket = (adminRateBuckets.get(key) || []).filter(t => now - t < policy.windowMs);
  if (bucket.length >= policy.max) return false;
  bucket.push(now);
  adminRateBuckets.set(key, bucket);
  return true;
}

function auditLog(entry) {
  try { fs.appendFileSync(ADMIN_AUDIT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); }
  catch (e) { /* fail silent */ }
}

function getIp(req) {
  return ((req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
    .toString().split(',')[0].trim());
}

// Middleware factory: مع scope (write أو read)
// 🔐 Default dashboard credentials (يمكن override من .env)
const DASHBOARD_USER = process.env.DASHBOARD_USER || '12345';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || '12345';

// POST /admin/dashboard/login — يصدق اليوزر/الباسوورد ويرجع admin-key للجلسة
app.post('/admin/dashboard/login', express.json(), (req, res) => {
  const { username, password } = req.body || {};
  if (username === DASHBOARD_USER && password === DASHBOARD_PASS) {
    // الكي ببساطة هو نفس DASHBOARD_PASS — يُستخدم لتحقق الـ admin endpoints
    res.json({ success: true, key: DASHBOARD_PASS });
  } else {
    res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' });
  }
});

function adminAuth(scope = 'write') {
  const policy = scope === 'read' ? ADMIN_RATE_READ : ADMIN_RATE_WRITE;
  return (req, res, next) => {
    const ip = getIp(req);

    // Dev mode: لو ما فيه ADMIN_SECRET، نسمح من localhost فقط
    if (!ADMIN_SECRET) {
      const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (!isLocal) {
        auditLog({ ip, path: req.path, scope, result: 'denied_no_secret_remote' });
        return res.status(401).json({ success: false, message: 'ADMIN_SECRET not configured' });
      }
      auditLog({ ip, path: req.path, scope, result: 'allowed_localhost_dev' });
      return next();
    }

    if (!rateLimitCheck(ip, scope, policy)) {
      auditLog({ ip, path: req.path, scope, result: 'rate_limited' });
      return res.status(429).json({ success: false, message: `Rate limit ${policy.max}/min` });
    }

    // Token via Authorization: Bearer ...
    const auth = req.header('Authorization') || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const token = bearer || req.header('X-Admin-Token') || req.query.token;

    if (token) {
      const v = verifyAdminToken(token);
      if (!v.ok) {
        auditLog({ ip, path: req.path, scope, result: 'invalid_token', reason: v.reason });
        return res.status(401).json({ success: false, message: `Token ${v.reason}` });
      }
      // scope check — read scope can't do write, write can do both
      if (scope === 'write' && v.payload.scope !== 'write') {
        auditLog({ ip, path: req.path, scope, result: 'insufficient_scope', tokenScope: v.payload.scope });
        return res.status(403).json({ success: false, message: 'Token scope is read-only' });
      }
      auditLog({ ip, path: req.path, scope, result: 'allowed_token', tokenScope: v.payload.scope });
      return next();
    }

    // Fallback: static X-Admin-Key (للتوافق فقط — deprecated)
    const staticKey = req.header('X-Admin-Key') || req.query.key;
    if (staticKey && staticKey === ADMIN_SECRET) {
      auditLog({ ip, path: req.path, scope, result: 'allowed_static_key_deprecated' });
      return next();
    }

    auditLog({ ip, path: req.path, scope, result: 'unauthorized' });
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  };
}

// POST /admin/token — يصدر token. scope=write (default) أو scope=read
app.post('/admin/token', (req, res) => {
  const ip = getIp(req);
  const provided = req.header('X-Bootstrap-Secret') || req.body?.secret;
  const scope = (req.body?.scope === 'read') ? 'read' : 'write';
  const ttl = scope === 'read' ? ADMIN_READ_TTL : ADMIN_WRITE_TTL;

  if (!ADMIN_SECRET) return res.status(500).json({ success: false, message: 'ADMIN_SECRET not configured' });

  // Rate limit حتى على إصدار التوكن (يمنع brute force على bootstrap)
  if (!rateLimitCheck(ip, 'token', { max: 5, windowMs: 60_000 })) {
    auditLog({ ip, path: '/admin/token', result: 'rate_limited' });
    return res.status(429).json({ success: false, message: 'Rate limit' });
  }

  if (provided !== ADMIN_SECRET) {
    auditLog({ ip, path: '/admin/token', result: 'bad_bootstrap' });
    return res.status(401).json({ success: false, message: 'Bad bootstrap secret' });
  }

  const token = signAdminToken(scope, ttl);
  auditLog({ ip, path: '/admin/token', result: 'issued', scope, ttl });
  res.json({ success: true, token, scope, expiresIn: ttl });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📊 Analytics — تسجيل كل الأحداث للتقارير
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const ZERO_RESULTS_LOG = path.join(__dirname, 'data', 'zero-results.jsonl');
const SEARCH_EVENTS_LOG = path.join(__dirname, 'data', 'search-events.jsonl');
const CLICK_EVENTS_LOG = path.join(__dirname, 'data', 'click-events.jsonl');
const TANSIQ_EVENTS_LOG = path.join(__dirname, 'data', 'tansiq-events.jsonl');
const CART_EVENTS_LOG = path.join(__dirname, 'data', 'cart-events.jsonl');

function logEvent(filePath, entry) {
  try {
    fs.appendFileSync(filePath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) { /* fail silent */ }
}

function logQuery(query, count, meta = {}) {
  // 1) سجّل كل بحث في search-events (للتقارير الشاملة)
  logEvent(SEARCH_EVENTS_LOG, { query: (query || '').trim(), count, ...meta });
  // 2) سجّل في zero-results لو ≤ 3 منتجات (للـ dashboard القديم)
  if (count <= 3) {
    try {
      fs.appendFileSync(ZERO_RESULTS_LOG, JSON.stringify({
        ts: new Date().toISOString(), query: (query || '').trim(), count, ...meta,
      }) + '\n');
    } catch {}
  }
}

function readJsonl(filePath, sinceMs) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (!sinceMs || new Date(obj.ts).getTime() >= sinceMs) out.push(obj);
    } catch { /* skip */ }
  }
  return out;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📈 Tracking endpoints — يستدعيها الـ frontend عند تفاعل المستخدم
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// POST /track/click — منتج تم النقر عليه
app.post('/track/click', (req, res) => {
  const { query, productId, productTitle, position, sessionId, source } = req.body || {};
  logEvent(CLICK_EVENTS_LOG, {
    query: (query || '').trim(),
    productId, productTitle,
    position: Number.isFinite(position) ? position : null,
    sessionId, source,
  });
  res.json({ success: true });
});

// POST /track/tansiq — تنسيق تم إنشاؤه
app.post('/track/tansiq', (req, res) => {
  const { products, sessionId, query } = req.body || {};
  logEvent(TANSIQ_EVENTS_LOG, {
    products: Array.isArray(products) ? products.slice(0, 20).map(p => ({
      id: p.id, title: p.title, link: p.link,
    })) : [],
    query: (query || '').trim(),
    sessionId,
  });
  res.json({ success: true });
});

// POST /track/cart — إضافة منتج للسلة
app.post('/track/cart', (req, res) => {
  const { productId, productTitle, fromTansiq, fromSearch, sessionId } = req.body || {};
  logEvent(CART_EVENTS_LOG, {
    productId, productTitle,
    fromTansiq: !!fromTansiq,
    fromSearch: (fromSearch || '').trim(),
    sessionId,
  });
  res.json({ success: true });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📊 Analytics aggregation — للـ dashboard
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /admin/analytics/search-report?days=7
app.get('/admin/analytics/search-report', adminAuth('read'), (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 7, 90);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  const searches = readJsonl(SEARCH_EVENTS_LOG, since);
  const clicks = readJsonl(CLICK_EVENTS_LOG, since);

  // تجميع البحوث بالـ query
  const byQuery = new Map();
  for (const e of searches) {
    const key = (e.query || '').toLowerCase().trim();
    if (!key) continue;
    const g = byQuery.get(key) || {
      query: e.query, searches: 0, totalResultCount: 0, zeroResultCount: 0,
      clicks: 0, totalClickPosition: 0, clickPositions: [],
    };
    g.searches++;
    g.totalResultCount += e.count || 0;
    if ((e.count || 0) === 0) g.zeroResultCount++;
    byQuery.set(key, g);
  }

  // اضافة الـ clicks بكل query
  for (const c of clicks) {
    const key = (c.query || '').toLowerCase().trim();
    if (!key || !byQuery.has(key)) continue;
    const g = byQuery.get(key);
    g.clicks++;
    if (Number.isFinite(c.position)) {
      g.totalClickPosition += c.position;
      g.clickPositions.push(c.position);
    }
  }

  // ترتيب + معايرة الـ difficulty
  const topQueries = [...byQuery.values()].map(g => {
    const avgResultCount = g.searches > 0 ? Math.round(g.totalResultCount / g.searches) : 0;
    const avgClickPosition = g.clicks > 0 ? +(g.totalClickPosition / g.clicks).toFixed(1) : null;
    const ctr = g.searches > 0 ? +((g.clicks / g.searches) * 100).toFixed(1) : 0;
    const zeroRate = g.searches > 0 ? +((g.zeroResultCount / g.searches) * 100).toFixed(1) : 0;

    // 🎯 صعوبة الوصول للمنتج:
    //   - easy: CTR عالي ومتوسط position منخفض (<5)
    //   - medium: CTR متوسط أو position 5-15
    //   - hard: CTR منخفض (<5%) أو position >15 أو zeroRate عالي
    let difficulty = 'medium';
    if (zeroRate > 50) difficulty = 'hard';
    else if (avgClickPosition && avgClickPosition <= 5 && ctr >= 20) difficulty = 'easy';
    else if (avgClickPosition && avgClickPosition > 15) difficulty = 'hard';
    else if (ctr < 5 && g.searches >= 3) difficulty = 'hard';

    return {
      query: g.query,
      searches: g.searches,
      avgResultCount,
      clicks: g.clicks,
      ctr,
      zeroRate,
      avgClickPosition,
      difficulty,
    };
  }).sort((a, b) => b.searches - a.searches).slice(0, 200);

  // إحصائيات عامة لمواقع النقر
  const allPositions = clicks.filter(c => Number.isFinite(c.position)).map(c => c.position);
  const totalClicks = allPositions.length;
  const earlyClicks = allPositions.filter(p => p <= 5).length;
  const midClicks = allPositions.filter(p => p > 5 && p <= 15).length;
  const lateClicks = allPositions.filter(p => p > 15).length;

  // 🏆 أكثر المنتجات نقراً في نتائج البحث
  const productClicks = new Map();
  for (const c of clicks) {
    const key = c.productTitle || c.productId;
    if (!key) continue;
    const g = productClicks.get(key) || {
      title: c.productTitle, productId: c.productId,
      clicks: 0, totalPosition: 0, queries: new Set(),
    };
    g.clicks++;
    if (Number.isFinite(c.position)) g.totalPosition += c.position;
    if (c.query) g.queries.add(c.query);
    productClicks.set(key, g);
  }
  const topClickedProducts = [...productClicks.values()]
    .map(p => ({
      title: p.title, productId: p.productId, clicks: p.clicks,
      avgPosition: p.clicks > 0 ? +(p.totalPosition / p.clicks).toFixed(1) : 0,
      queryCount: p.queries.size,
      sampleQueries: [...p.queries].slice(0, 3),
    }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 100);

  res.json({
    success: true,
    windowDays: days,
    totalSearches: searches.length,
    uniqueQueries: byQuery.size,
    totalClicks,
    clickPositionDistribution: {
      early: { count: earlyClicks, pct: totalClicks ? +(earlyClicks / totalClicks * 100).toFixed(1) : 0 },
      mid: { count: midClicks, pct: totalClicks ? +(midClicks / totalClicks * 100).toFixed(1) : 0 },
      late: { count: lateClicks, pct: totalClicks ? +(lateClicks / totalClicks * 100).toFixed(1) : 0 },
    },
    topQueries,
    topClickedProducts,
  });
});

// GET /admin/analytics/tansiq-report?days=7
app.get('/admin/analytics/tansiq-report', adminAuth('read'), (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 7, 90);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  const tansiqs = readJsonl(TANSIQ_EVENTS_LOG, since);
  const carts = readJsonl(CART_EVENTS_LOG, since);

  // المنتجات اللي ظهرت في تنسيقات
  const productAppearances = new Map();
  for (const t of tansiqs) {
    for (const p of (t.products || [])) {
      const key = p.title || p.id;
      if (!key) continue;
      const g = productAppearances.get(key) || { title: p.title, id: p.id, link: p.link, appearances: 0, cartAdds: 0 };
      g.appearances++;
      productAppearances.set(key, g);
    }
  }

  // ربط الـ cart adds مع منتجات الـ tansiq
  let tansiqCartAdds = 0;
  for (const c of carts) {
    if (!c.fromTansiq) continue;
    tansiqCartAdds++;
    const key = c.productTitle || c.productId;
    if (productAppearances.has(key)) {
      productAppearances.get(key).cartAdds++;
    }
  }

  const topProducts = [...productAppearances.values()]
    .sort((a, b) => b.appearances - a.appearances)
    .slice(0, 50);

  const totalAppearances = [...productAppearances.values()].reduce((s, p) => s + p.appearances, 0);
  const conversionRate = tansiqs.length > 0 ? +((tansiqCartAdds / tansiqs.length) * 100).toFixed(1) : 0;

  res.json({
    success: true,
    windowDays: days,
    totalTansiqs: tansiqs.length,
    uniqueProductsInTansiq: productAppearances.size,
    totalProductAppearances: totalAppearances,
    cartAddsFromTansiq: tansiqCartAdds,
    conversionRate,
    topProducts,
  });
});

// GET /admin/tagged-stats — إحصائيات تقدّم تصنيف الكتالوج
app.get('/admin/tagged-stats', adminAuth('read'), async (req, res) => {
  try {
    const total = await esClient.count({ index: INDEX_NAME });
    const tagged = await esClient.count({
      index: INDEX_NAME,
      query: { exists: { field: 'tagged_at' } },
    });
    const aggs = await esClient.search({
      index: INDEX_NAME,
      size: 0,
      aggs: {
        kinds: { terms: { field: 'product_kind', size: 20 } },
        materials: { terms: { field: 'product_material', size: 20 } },
        seasonal: { terms: { field: 'product_seasonal', size: 10 } },
        topSubtypes: { terms: { field: 'product_subtype', size: 30 } },
      },
    });
    res.json({
      success: true,
      total: total.count,
      tagged: tagged.count,
      untagged: total.count - tagged.count,
      pctComplete: total.count > 0 ? ((tagged.count / total.count) * 100).toFixed(1) : '0',
      kindDistribution: aggs.aggregations.kinds.buckets.map(b => ({ kind: b.key, count: b.doc_count })),
      materialDistribution: aggs.aggregations.materials.buckets.map(b => ({ material: b.key, count: b.doc_count })),
      seasonalDistribution: aggs.aggregations.seasonal.buckets.map(b => ({ seasonal: b.key, count: b.doc_count })),
      topSubtypes: aggs.aggregations.topSubtypes.buckets.map(b => ({ subtype: b.key, count: b.doc_count })),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /admin/analytics/zero-results?days=7&maxResults=3&limit=100
// يرجع أكثر الاستعلامات فشلاً (count <= maxResults) خلال فترة محددة
app.get('/admin/analytics/zero-results', adminAuth('read'), (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 7, 90);
  const maxResults = Math.max(0, Math.min(parseInt(req.query.maxResults) || 3, 20));
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const entries = readJsonl(ZERO_RESULTS_LOG, since).filter(e => (e.count ?? 0) <= maxResults);

  const grouped = new Map();
  for (const e of entries) {
    const key = (e.query || '').toLowerCase().trim();
    if (!key) continue;
    const g = grouped.get(key) || {
      query: e.query, occurrences: 0, lastResultCount: e.count,
      lastSeen: e.ts, firstSeen: e.ts, searchTypes: new Set(),
    };
    g.occurrences++;
    if (e.searchType) g.searchTypes.add(e.searchType);
    if (new Date(e.ts).getTime() > new Date(g.lastSeen).getTime()) {
      g.lastSeen = e.ts;
      g.lastResultCount = e.count;
    }
    if (new Date(e.ts).getTime() < new Date(g.firstSeen).getTime()) g.firstSeen = e.ts;
    grouped.set(key, g);
  }
  const top = [...grouped.values()]
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, limit)
    .map(g => ({ ...g, searchTypes: [...g.searchTypes] }));

  res.json({
    success: true,
    windowDays: days,
    threshold: `count <= ${maxResults}`,
    totalLowResultEvents: entries.length,
    uniqueQueries: grouped.size,
    top,
  });
});

// 🎛️ GET /admin/dashboard — صفحة Dashboard الرئيسية
// Login + Hub فيه أيقونتين: تقرير البحث / تقرير التنسيقات
app.get('/admin/dashboard', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QasrAlawani — لوحة التقارير</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,Segoe UI,Tahoma,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;color:#222}
  .wrap{max-width:1200px;margin:0 auto;padding:24px}

  /* Login */
  .login{display:flex;align-items:center;justify-content:center;min-height:100vh}
  .login-card{background:white;border-radius:20px;padding:40px;box-shadow:0 20px 60px rgba(0,0,0,.3);width:380px;text-align:center}
  .login-card h1{font-size:1.6rem;margin-bottom:8px;color:#5a4fcf}
  .login-card p{color:#666;margin-bottom:24px;font-size:.9rem}
  .login-card input{width:100%;padding:14px 18px;border:2px solid #e5e7eb;border-radius:12px;font-size:1rem;outline:none;margin-bottom:14px;font-family:inherit}
  .login-card input:focus{border-color:#5a4fcf}
  .login-card button{width:100%;padding:14px;background:linear-gradient(135deg,#667eea,#764ba2);color:white;border:none;border-radius:12px;font-size:1rem;font-weight:600;cursor:pointer;font-family:inherit}
  .login-card .err{color:#c0392b;font-size:.85rem;margin-top:10px;display:none}

  /* Hub */
  .hub-header{background:white;border-radius:16px;padding:20px 24px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center}
  .hub-header h1{font-size:1.4rem;color:#5a4fcf}
  .hub-header .logout{background:#f5f7fa;border:none;padding:8px 16px;border-radius:8px;cursor:pointer;color:#555}
  .hub-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:20px}
  .hub-card{background:white;border-radius:20px;padding:36px;cursor:pointer;transition:transform .2s,box-shadow .2s;border:2px solid transparent}
  .hub-card:hover{transform:translateY(-4px);box-shadow:0 16px 40px rgba(0,0,0,.15);border-color:#5a4fcf}
  .hub-card .ic{font-size:3.5rem;margin-bottom:16px}
  .hub-card h2{font-size:1.4rem;margin-bottom:8px;color:#2c3e50}
  .hub-card p{color:#666;font-size:.95rem;line-height:1.5}

  /* Report */
  .report-bar{background:white;border-radius:16px;padding:16px 20px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
  .report-bar h1{font-size:1.3rem;color:#5a4fcf}
  .report-bar .controls{display:flex;gap:10px;align-items:center}
  .report-bar select,.report-bar button{padding:8px 14px;border:1px solid #e5e7eb;border-radius:8px;font-family:inherit;cursor:pointer;background:white}
  .report-bar .back{background:#f5f7fa;color:#5a4fcf;font-weight:600}

  .kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:20px}
  .kpi{background:white;border-radius:14px;padding:18px;text-align:center}
  .kpi .val{font-size:2rem;font-weight:700;color:#5a4fcf;font-variant-numeric:tabular-nums}
  .kpi .lbl{color:#666;font-size:.85rem;margin-top:4px}

  .charts-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:18px;margin-bottom:20px}
  .chart-card{background:white;border-radius:16px;padding:20px}
  .chart-card h3{margin-bottom:14px;color:#2c3e50;font-size:1rem}

  table{width:100%;background:white;border-radius:16px;border-collapse:collapse;overflow:hidden}
  th{background:#5a4fcf;color:white;padding:12px;text-align:right;font-size:.85rem;font-weight:600}
  td{padding:10px 12px;border-bottom:1px solid #eee;font-size:.9rem}
  tr:hover{background:#fafafa}
  .badge{display:inline-block;padding:2px 10px;border-radius:6px;font-size:.78rem;font-weight:600}
  .b-easy{background:#d4edda;color:#155724}
  .b-medium{background:#fff3cd;color:#856404}
  .b-hard{background:#ffe0e0;color:#c0392b}
  .num{color:#5a4fcf;font-weight:600;font-variant-numeric:tabular-nums}

  .empty{text-align:center;padding:60px;background:white;border-radius:16px;color:#999}
</style>
</head><body>

<div id="login" class="login">
  <form class="login-card" id="loginForm">
    <h1>🔐 لوحة التقارير</h1>
    <p>قصر الأواني — أدخل بيانات الدخول</p>
    <input type="text" id="user" placeholder="اليوزر" autocomplete="off">
    <input type="password" id="pwd" placeholder="كلمة المرور" autocomplete="off">
    <button type="submit">دخول</button>
    <div class="err" id="loginErr">بيانات الدخول غير صحيحة</div>
  </form>
</div>

<div id="app" style="display:none">
  <div class="wrap">

    <!-- HUB -->
    <div id="view-hub">
      <div class="hub-header">
        <h1>📊 لوحة التقارير — قصر الأواني</h1>
        <button class="logout" onclick="logout()">خروج</button>
      </div>
      <div class="hub-grid">
        <div class="hub-card" onclick="openSearch()">
          <div class="ic">🔍</div>
          <h2>تقرير البحث</h2>
          <p>الكلمات الأكثر بحثاً، صعوبة الوصول إلى المنتج، توزيع نقرات العملاء على نتائج البحث.</p>
        </div>
        <div class="hub-card" onclick="openTansiq()">
          <div class="ic">🎨</div>
          <h2>تقرير التنسيقات</h2>
          <p>المنتجات الأكثر تنسيقاً، نسبة إضافة المنتجات للسلة، أداء التنسيقات.</p>
        </div>
      </div>
    </div>

    <!-- SEARCH REPORT -->
    <div id="view-search" style="display:none">
      <div class="report-bar">
        <h1>🔍 تقرير البحث</h1>
        <div class="controls">
          <select id="searchDays" onchange="loadSearch()">
            <option value="1">آخر 24 ساعة</option>
            <option value="7" selected>آخر 7 أيام</option>
            <option value="30">آخر 30 يوم</option>
            <option value="90">آخر 90 يوم</option>
          </select>
          <button class="back" onclick="show('hub')">⬅ رجوع</button>
        </div>
      </div>
      <div id="search-content"></div>
    </div>

    <!-- TANSIQ REPORT -->
    <div id="view-tansiq" style="display:none">
      <div class="report-bar">
        <h1>🎨 تقرير التنسيقات</h1>
        <div class="controls">
          <select id="tansiqDays" onchange="loadTansiq()">
            <option value="1">آخر 24 ساعة</option>
            <option value="7" selected>آخر 7 أيام</option>
            <option value="30">آخر 30 يوم</option>
            <option value="90">آخر 90 يوم</option>
          </select>
          <button class="back" onclick="show('hub')">⬅ رجوع</button>
        </div>
      </div>
      <div id="tansiq-content"></div>
    </div>

  </div>
</div>

<script>
let ADMIN_KEY = sessionStorage.getItem('admin_key') || '';

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const user = document.getElementById('user').value;
  const pwd = document.getElementById('pwd').value;
  try {
    const r = await fetch('/admin/dashboard/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pwd }),
    });
    const j = await r.json();
    if (!r.ok || !j.success) {
      document.getElementById('loginErr').style.display = 'block';
      return;
    }
    ADMIN_KEY = j.key;
    sessionStorage.setItem('admin_key', j.key);
    document.getElementById('login').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    show('hub');
  } catch { document.getElementById('loginErr').style.display = 'block'; }
});

// لو فيه session سابق
if (ADMIN_KEY) {
  fetch('/admin/tagged-stats', { headers: { 'X-Admin-Key': ADMIN_KEY } }).then(r => {
    if (r.status === 200) {
      document.getElementById('login').style.display = 'none';
      document.getElementById('app').style.display = 'block';
      show('hub');
    }
  });
}

function logout() {
  sessionStorage.removeItem('admin_key');
  ADMIN_KEY = '';
  location.reload();
}

function show(view) {
  document.getElementById('view-hub').style.display = view === 'hub' ? 'block' : 'none';
  document.getElementById('view-search').style.display = view === 'search' ? 'block' : 'none';
  document.getElementById('view-tansiq').style.display = view === 'tansiq' ? 'block' : 'none';
}

function openSearch() { show('search'); loadSearch(); }
function openTansiq() { show('tansiq'); loadTansiq(); }

async function loadSearch() {
  const days = document.getElementById('searchDays').value;
  const target = document.getElementById('search-content');
  target.innerHTML = '<div class="empty">⏳ جاري التحميل...</div>';
  const r = await fetch('/admin/analytics/search-report?days=' + days, { headers: { 'X-Admin-Key': ADMIN_KEY } });
  const j = await r.json();
  if (!j.success) { target.innerHTML = '<div class="empty">خطأ في التحميل</div>'; return; }

  const dist = j.clickPositionDistribution;
  target.innerHTML = \`
    <div class="kpi-grid">
      <div class="kpi"><div class="val">\${j.totalSearches}</div><div class="lbl">عمليات بحث</div></div>
      <div class="kpi"><div class="val">\${j.uniqueQueries}</div><div class="lbl">استعلام فريد</div></div>
      <div class="kpi"><div class="val">\${j.totalClicks}</div><div class="lbl">نقرات منتجات</div></div>
      <div class="kpi"><div class="val">\${dist.early.pct}%</div><div class="lbl">نقر على المراكز 1-5</div></div>
    </div>

    <div class="charts-grid">
      <div class="chart-card">
        <h3>توزيع مراكز النقر</h3>
        <canvas id="posChart"></canvas>
      </div>
      <div class="chart-card">
        <h3>صعوبة الوصول إلى المنتج</h3>
        <canvas id="diffChart"></canvas>
      </div>
    </div>

    <h3 style="color:white;margin:10px 0">أكثر الاستعلامات (Top 100)</h3>
    <table>
      <thead><tr>
        <th>الاستعلام</th><th>عدد البحث</th><th>متوسط النتائج</th><th>نقرات</th><th>CTR</th>
        <th>متوسط مركز النقر</th><th>0 نتائج %</th><th>صعوبة الوصول</th>
      </tr></thead>
      <tbody>
        \${j.topQueries.slice(0,100).map(q => \`<tr>
          <td><strong>\${escape(q.query)}</strong></td>
          <td class="num">\${q.searches}</td>
          <td class="num">\${q.avgResultCount}</td>
          <td class="num">\${q.clicks}</td>
          <td class="num">\${q.ctr}%</td>
          <td class="num">\${q.avgClickPosition ?? '—'}</td>
          <td class="num">\${q.zeroRate}%</td>
          <td><span class="badge b-\${q.difficulty}">\${diffLabel(q.difficulty)}</span></td>
        </tr>\`).join('')}
      </tbody>
    </table>

    <h3 style="color:white;margin:24px 0 10px">🏆 أكثر المنتجات نقراً</h3>
    <table>
      <thead><tr>
        <th>المنتج</th><th>عدد النقرات</th><th>متوسط مركز ظهوره</th><th>استعلامات وصلت إليه</th><th>أمثلة</th>
      </tr></thead>
      <tbody>
        \${(j.topClickedProducts||[]).slice(0,100).map(p => \`<tr>
          <td><strong>\${escape(p.title || p.productId || '')}</strong></td>
          <td class="num">\${p.clicks}</td>
          <td class="num">\${p.avgPosition || '—'}</td>
          <td class="num">\${p.queryCount}</td>
          <td>\${(p.sampleQueries||[]).map(q => '<span class="badge b-medium" style="margin:2px">' + escape(q) + '</span>').join(' ')}</td>
        </tr>\`).join('') || '<tr><td colspan="5" style="text-align:center;color:#999">لا توجد نقرات مسجّلة بعد</td></tr>'}
      </tbody>
    </table>
  \`;

  new Chart(document.getElementById('posChart'), {
    type: 'doughnut',
    data: {
      labels: ['أول 5 (سهل)', 'مراكز 6-15', 'مراكز 16+'],
      datasets: [{ data: [dist.early.count, dist.mid.count, dist.late.count],
        backgroundColor: ['#27ae60', '#f39c12', '#c0392b'] }],
    },
    options: { plugins: { legend: { position: 'bottom' } } },
  });

  const diffCounts = { easy: 0, medium: 0, hard: 0 };
  j.topQueries.forEach(q => diffCounts[q.difficulty]++);
  new Chart(document.getElementById('diffChart'), {
    type: 'bar',
    data: {
      labels: ['سهل', 'متوسط', 'صعب'],
      datasets: [{ data: [diffCounts.easy, diffCounts.medium, diffCounts.hard],
        backgroundColor: ['#27ae60', '#f39c12', '#c0392b'] }],
    },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
  });
}

async function loadTansiq() {
  const days = document.getElementById('tansiqDays').value;
  const target = document.getElementById('tansiq-content');
  target.innerHTML = '<div class="empty">⏳ جاري التحميل...</div>';
  const r = await fetch('/admin/analytics/tansiq-report?days=' + days, { headers: { 'X-Admin-Key': ADMIN_KEY } });
  const j = await r.json();
  if (!j.success) { target.innerHTML = '<div class="empty">خطأ</div>'; return; }

  if (j.totalTansiqs === 0) {
    target.innerHTML = '<div class="empty">لا توجد تنسيقات بعد. ابدأ بإنشاء تنسيق من مشروع التنسيقات لترى البيانات هنا.</div>';
    return;
  }

  target.innerHTML = \`
    <div class="kpi-grid">
      <div class="kpi"><div class="val">\${j.totalTansiqs}</div><div class="lbl">تنسيق</div></div>
      <div class="kpi"><div class="val">\${j.uniqueProductsInTansiq}</div><div class="lbl">منتج فريد في التنسيقات</div></div>
      <div class="kpi"><div class="val">\${j.cartAddsFromTansiq}</div><div class="lbl">إضافة للسلة من تنسيق</div></div>
      <div class="kpi"><div class="val">\${j.conversionRate}%</div><div class="lbl">معدّل التحويل</div></div>
    </div>

    <h3 style="color:white;margin-bottom:10px">المنتجات الأكثر تنسيقاً</h3>
    <table>
      <thead><tr><th>المنتج</th><th>ظهور في تنسيقات</th><th>إضافة للسلة</th><th>التحويل</th></tr></thead>
      <tbody>
        \${j.topProducts.slice(0, 50).map(p => {
          const cr = p.appearances > 0 ? ((p.cartAdds / p.appearances) * 100).toFixed(1) : 0;
          return \`<tr>
            <td><strong>\${escape(p.title || p.id)}</strong></td>
            <td class="num">\${p.appearances}</td>
            <td class="num">\${p.cartAdds}</td>
            <td class="num">\${cr}%</td>
          </tr>\`;
        }).join('')}
      </tbody>
    </table>
  \`;
}

function escape(s) { return String(s || '').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c])); }
function diffLabel(d) { return d === 'easy' ? 'سهل' : d === 'hard' ? 'صعب' : 'متوسط'; }
</script>

</body></html>`);
});

// GET /admin/analytics/zero-results.html — dashboard HTML بسيط
app.get('/admin/analytics/zero-results.html', adminAuth('read'), (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 7, 90);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const entries = readJsonl(ZERO_RESULTS_LOG, since);

  const grouped = new Map();
  for (const e of entries) {
    const key = (e.query || '').toLowerCase().trim();
    if (!key) continue;
    const g = grouped.get(key) || { query: e.query, occurrences: 0, lastResultCount: e.count, lastSeen: e.ts };
    g.occurrences++;
    if (new Date(e.ts).getTime() > new Date(g.lastSeen).getTime()) {
      g.lastSeen = e.ts;
      g.lastResultCount = e.count;
    }
    grouped.set(key, g);
  }
  const top = [...grouped.values()].sort((a, b) => b.occurrences - a.occurrences).slice(0, 100);

  const html = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>Zero-Results Dashboard — آخر ${days} يوم</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Arial;background:#f7f7fa;padding:20px;color:#222}
  h1{margin:0 0 8px;color:#5a4fcf}
  .meta{color:#666;margin-bottom:20px;font-size:14px}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  th{background:#5a4fcf;color:#fff;padding:12px;text-align:right;font-weight:600;font-size:14px}
  td{padding:10px 12px;border-bottom:1px solid #eee;font-size:14px}
  tr:hover{background:#fafafa}
  .num{color:#5a4fcf;font-weight:600;font-variant-numeric:tabular-nums}
  .empty{text-align:center;padding:40px;color:#999}
  .badge{background:#ffe0e0;color:#c0392b;padding:2px 8px;border-radius:4px;font-size:12px}
  .badge-warn{background:#fff3cd;color:#856404}
  .badge-ok{background:#d4edda;color:#155724}
</style></head><body>
<h1>📊 Zero-Results Dashboard</h1>
<div class="meta">آخر ${days} يوم · إجمالي الأحداث: ${entries.length} · استعلامات فريدة: ${grouped.size}</div>
${top.length === 0 ? '<div class="empty">لا توجد استعلامات بنتائج قليلة بعد. الـ logging يعمل لكن لم يتم تسجيل شيء حتى الآن.</div>' :
`<table>
<thead><tr><th>الاستعلام</th><th>عدد المرات</th><th>آخر عدد نتائج</th><th>آخر ظهور</th></tr></thead>
<tbody>${top.map(g => `<tr>
  <td><strong>${g.query.replace(/</g, '&lt;')}</strong></td>
  <td><span class="num">${g.occurrences}</span></td>
  <td>${g.lastResultCount === 0 ? '<span class="badge">0</span>' : g.lastResultCount <= 3 ? `<span class="badge-warn badge">${g.lastResultCount}</span>` : `<span class="badge-ok badge">${g.lastResultCount}</span>`}</td>
  <td>${new Date(g.lastSeen).toLocaleString('ar-SA')}</td>
</tr>`).join('')}</tbody></table>`}
<div style="margin-top:20px;color:#666;font-size:13px">
  💡 الاستعلامات الـ top هنا غالباً تعني: <br>
  &nbsp;&nbsp;• فجوة في الكتالوج (المنتج غير موجود)<br>
  &nbsp;&nbsp;• مرادف غير معروف للنظام (يحتاج إضافة)<br>
  &nbsp;&nbsp;• خطأ إملائي شائع<br>
</div>
</body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// 🐛 DEBUG endpoint للتحقق من vocab + typo correction
app.get('/admin/debug-typo', adminAuth('read'), async (req, res) => {
  const q = req.query.q || '';
  const words = q.split(/\s+/).filter(w => w.length >= 2);
  const wordDebug = words.map(w => {
    const lower = w.toLowerCase();
    const norm = normalizeArab(lower);
    const exact = catalogVocab.get(norm);
    const closest = findClosestCatalogWord(w);
    return { word: w, norm, exactInVocab: !!exact, exactDisplay: exact?.display, exactCount: exact?.count, closest };
  });
  const correction = catalogTypoCorrect(q);
  const strictCount = await quickCountForQuery(q);
  let correctedStrictCount = null;
  if (correction) correctedStrictCount = await quickCountForQuery(correction.corrected);
  res.json({
    query: q,
    strictCount,
    catalogVocabSize: catalogVocab.size,
    wordDebug,
    correction,
    correctedStrictCount,
  });
});

// POST /admin/token — DEFERRED. انظر docs/admin-security-proposal.md للقرار

// POST /admin/clear-cache — يمسح كل الـ caches في الذاكرة + الملف
app.post('/admin/clear-cache', adminAuth('write'), (req, res) => {
  try {
    responseCache.clear?.();
    embeddingCache.clear?.();
    classifyCache.clear?.();
    aiSummaryCache.clear?.();
    intentCache.clear?.();
    smartFiltersCache.clear?.();
    relatedSearchesCache.clear?.();
    translationCache.clear?.();
    try { fs.unlinkSync(CACHE_FILE); } catch {}
    res.json({ success: true, message: 'All caches cleared' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// POST /admin/add-product — يضيف منتج جديد مع embeddings كاملة
// Body: { title, image_link, price, sale_price?, brand?, link, color?, size?, id?, mpn?, sku? }
app.post('/admin/add-product', adminAuth('write'), async (req, res) => {
  try {
    const p = req.body || {};
    const required = ['title', 'image_link', 'link'];
    for (const k of required) {
      if (!p[k] || !String(p[k]).trim()) {
        return res.status(400).json({ success: false, message: `${k} is required` });
      }
    }

    const normalized = {
      title: String(p.title).trim(),
      image_link: String(p.image_link).trim(),
      price: String(p.price || '').trim(),
      sale_price: String(p.sale_price || '').trim(),
      brand: String(p.brand || '').trim(),
      link: String(p.link).trim(),
      color: String(p.color || '').trim(),
      size: String(p.size || '').trim(),
    };

    // 1) BGE-M3 (نصي)
    const titleEmbed = await getQueryEmbedding(normalized.title);

    // 2) CLIP (بصري) — إن فشل، نكمل بدونها
    let clipEmbed = null;
    try { clipEmbed = await clipImageEmbedding(normalized.image_link); }
    catch (e) { console.warn(`CLIP failed for new product: ${e.message}`); }

    const doc = { ...normalized, embedding: titleEmbed };
    if (clipEmbed) doc.clip_image_embedding = clipEmbed;

    // ID مستقر من الـ link
    const docId = Buffer.from(normalized.link).toString('base64').slice(0, 32).replace(/[^a-zA-Z0-9]/g, '');

    await esClient.index({ index: INDEX_NAME, id: docId, document: doc, refresh: 'wait_for' });

    // تحديث الـ in-memory CSV catalog
    const codes = [p.id, p.mpn, p.sku].filter(c => c && String(c).trim());
    for (const code of codes) {
      productByCode.set(String(code).trim().toUpperCase(), normalized);
    }

    // امسح الـ response cache كي يظهر المنتج في البحوث المحفوظة
    responseCache.clear?.();

    res.json({
      success: true,
      id: docId,
      clipEmbedded: !!clipEmbed,
      message: 'تمت إضافة المنتج وفهرسته. سيظهر فوراً في البحث.',
    });
  } catch (e) {
    console.error('add-product error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// POST /admin/reload-csv — يعيد تحميل CSV (بعد تعديل الملف يدوياً)
app.post('/admin/reload-csv', adminAuth('write'), async (req, res) => {
  try {
    const n = await loadProductCatalog();
    res.json({ success: true, productsLoaded: n });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 💾 Persistent Cache على القرص: يحفظ responseCache كل 5 دقائق + عند الإغلاق
const CACHE_FILE = path.join(__dirname, 'data', 'response-cache.json');
const CACHE_SAVE_INTERVAL_MS = 5 * 60 * 1000;

function saveCacheToDisk() {
  try {
    const entries = responseCache.entries();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(entries));
    console.log(`💾 Saved ${entries.length} cache entries to disk`);
  } catch (e) {
    console.warn('Cache save failed:', e.message);
  }
}

function loadCacheFromDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return 0;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const entries = JSON.parse(raw);
    let loaded = 0;
    const now = Date.now();
    for (const [k, e] of entries) {
      if (e && e.t && (now - e.t < 24 * 60 * 60 * 1000)) {
        responseCache.set(k, e.v);
        loaded++;
      }
    }
    return loaded;
  } catch (e) {
    console.warn('Cache load failed:', e.message);
    return 0;
  }
}

app.listen(PORT, () => {
  console.log(`\nServer running on port ${PORT}`);
  console.log(`URL: http://localhost:${PORT}`);
  console.log(`Search: http://localhost:${PORT}/search?q=coffee`);
  console.log(`Chat: POST http://localhost:${PORT}/chat\n`);

  loadProductCatalog()
    .then(count => {
      console.log(`📦 Loaded ${count} product codes for direct lookup`);
      buildCatalogVocab();
      buildAutocompleteCorpus();
    })
    .catch(err => console.error('❌ Failed to load product catalog:', err.message));

  const loaded = loadCacheFromDisk();
  if (loaded > 0) console.log(`💾 Restored ${loaded} cached responses from disk`);

  setInterval(saveCacheToDisk, CACHE_SAVE_INTERVAL_MS);
});

process.on('SIGINT', () => { saveCacheToDisk(); process.exit(0); });
process.on('SIGTERM', () => { saveCacheToDisk(); process.exit(0); });






