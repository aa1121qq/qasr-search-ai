require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const { Client } = require('@elastic/elasticsearch');
const OpenAI = require('openai');
const { GoogleGenAI } = require('@google/genai');

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

const INDEX_NAME = 'products';

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

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0].message.content);
    classifyCache.set(cacheKey, result);
    return result;
  } catch (error) {
    console.error('Search classification error:', error.message);
    return { type: 'general', excludeAccessories: false, preferHomeElec: false, deviceKeyword: '' };
  }
}

// ⚡ دالة embedding مع كاش
async function getQueryEmbedding(query) {
  const key = (query || '').toLowerCase().trim();
  const cached = embeddingCache.get(key);
  if (cached) return cached;
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: query,
  });
  const emb = res.data[0].embedding;
  embeddingCache.set(key, emb);
  return emb;
}

// فحص هل المنتج ملحق أو جهاز
function isAccessory(title, deviceKeyword) {
  if (!title) return false;
  const titleLower = title.toLowerCase();
  
  // فحص الكلمات المفتاحية للملحقات
  const hasAccessoryKeyword = ACCESSORY_KEYWORDS.some(kw => titleLower.includes(kw));
  
  if (hasAccessoryKeyword) return true;
  
  return false;
}

// 🎯 استخراج "موضوع البحث" بإزالة كلمات الأجهزة العامة فقط
// نشيل فقط الكلمات العامة (ماكينة/آلة/جهاز/صانعة) ونحتفظ بأسماء الأجهزة المحددة
// مثال: "ماكينة قهوة" → "قهوة" (نشيل "ماكينة")
// مثال: "غسالة ملابس" → "غسالة ملابس" (لا نشيل "غسالة" لأنها اسم الجهاز نفسه)
function extractSubject(query) {
  // نضيف مسافة في البداية والنهاية لتسهيل المطابقة بحدود الكلمات
  let subject = ' ' + (query || '').toLowerCase().trim() + ' ';
  
  // إزالة الكلمات العامة فقط (مع مراعاة حدود الكلمات: مسافة/بداية/نهاية)
  // هذا يمنع حذف "الة" من داخل كلمات أخرى مثل "غسالة"
  GENERIC_DEVICE_WORDS.forEach(word => {
    const regex = new RegExp(`(\\s)${word}(\\s)`, 'g');
    subject = subject.replace(regex, ' ');
  });
  
  // تنظيف المسافات الزائدة
  return subject.replace(/\s+/g, ' ').trim();
}

// 🔤 تطبيع النص العربي (توحيد الحروف المتشابهة وإزالة التشكيل)
function normalizeArabicText(text) {
  if (!text) return '';
  return text.toLowerCase()
    .replace(/[آأإ]/g, 'ا')         // توحيد أشكال الألف
    .replace(/ى/g, 'ي')              // ألف مقصورة → ياء
    .replace(/[ًٌٍَُِّْ]/g, '');       // إزالة التشكيل
}

// 🌱 استخراج جذر الكلمة (إزالة اللواحق الشائعة)
// مثال: "ثلاجات" → "ثلاج"، "منزلية" → "منزل"، "ماكينة" → "ماكين"
function normalizeArabicWord(word) {
  let w = normalizeArabicText(word);
  
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

// 🎯 فحص ذكي: هل عنوان المنتج يطابق "موضوع" البحث؟
// يستخدم تطبيع عربي + مطابقة بالجذر + قواعد ذكية للكلمات المتعددة
function titleMatchesSubject(title, subject) {
  if (!title || !subject) return false;
  
  const normalizedTitle = normalizeArabicText(title);
  const subjectWords = subject.split(/\s+/).filter(w => w.length >= 2);
  if (subjectWords.length === 0) return false;
  
  // استخراج جذور كلمات الموضوع
  const stems = subjectWords.map(w => normalizeArabicWord(w));
  
  // 1️⃣ كلمة واحدة: يجب أن تطابق (مثلاً "ثلج" أو "قهوة")
  if (stems.length === 1) {
    return normalizedTitle.includes(stems[0]);
  }
  
  // 2️⃣ عدة كلمات + الكلمة الأولى محددة (4+ حروف): الأولى تكفي
  // (مثل: "ثلاجات منزلية" → "ثلاج" يكفي لأنها محددة)
  const firstStem = stems[0];
  if (firstStem.length >= 4) {
    return normalizedTitle.includes(firstStem);
  }
  
  // 3️⃣ الكلمة الأولى قصيرة: نطلب كل الكلمات
  // (مثل: "آيس كريم" → كلتاهما مطلوبتان لتجنب مطابقة "آيس بوكس")
  return stems.every(stem => normalizedTitle.includes(stem));
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

async function detectIntent(query, sampleProducts) {
  const cacheKey = (query || '').toLowerCase().trim();
  const cached = intentCache.get(cacheKey);
  if (cached) return cached;
  try {
    const productExamples = sampleProducts.slice(0, 40).map(p => p.title).join('\n');

    const prompt = `أنت خبير في تحليل البحث في متجر سعودي يبيع أدوات منزلية وأجهزة كهربائية.

البحث: "${query}"

عناوين المنتجات الفعلية في النتائج (هذه هي مصدرك الوحيد):
${productExamples}

🎯 المهمة:
اقترح 4 تركيبات بحث محسّنة، **مبنية حصراً على ما هو موجود في العناوين أعلاه**.

📌 القاعدة الذهبية:
خذ كلمة المستخدم "${query}" وضف لها كلمة (أو كلمتين) **قبلها أو بعدها** من العناوين الفعلية.

أمثلة على المنطق المطلوب:
- بحث "ترامس" → لو العناوين فيها "طقم ترامس"، "شنطة ترامس"، "ترامس ستانلس" → اقترح: ["طقم ترامس", "شنطة ترامس", "ترامس ستانلس"]
- بحث "قدر" → لو العناوين فيها "قدر ضغط"، "طقم قدور"، "قدر بخار" → اقترح: ["قدر ضغط", "طقم قدور", "قدر بخار"]
- بحث "قهوة" → "ماكينة قهوة"، "حبوب قهوة"، "فناجين قهوة"، "قهوة عربية"

⚠️ قواعد صارمة:
1. كل اقتراح يجب أن **يحتوي على كلمة "${query}"** (أو جذرها) + كلمة مضافة من العناوين
2. لا تخترع كلمات غير موجودة في العناوين أعلاه
3. اختر التركيبات الأكثر شيوعاً وتنوّعاً (تركيبات تمثّل أنواع مختلفة)
4. searchQuery يجب أن يكون قصير (2-4 كلمات)

🔍 متى نعرض الاقتراحات؟
- isAmbiguous = true → لو لقيت 3+ تركيبات مختلفة منطقية في العناوين
- isAmbiguous = false → لو البحث محدد جداً (مثلاً "ماكينة قهوة ديلونجي") أو ما لقيت تركيبات واضحة

اختر أيقونة لكل اقتراح من: coffee, kitchen, package, gift, home, fridge, fire, sparkles, cart, heart, cup, tool

أعد JSON فقط:
{
  "isAmbiguous": true/false,
  "message": "اختر النوع اللي تبيه:",
  "suggestions": [
    {"title": "اسم مختصر للتركيبة", "description": "وصف قصير", "icon": "أيقونة", "searchQuery": "التركيبة الكاملة"}
  ]
}

إذا محدد أو ما فيه تركيبات: {"isAmbiguous": false, "message": "", "suggestions": []}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0].message.content);
    intentCache.set(cacheKey, result);
    return result;
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

async function generateSmartFilters(query, products) {
  const cacheKey = (query || '').toLowerCase().trim();
  const cached = smartFiltersCache.get(cacheKey);
  if (cached) return cached;
  try {
    const productTitles = products.slice(0, 50).map(p => p.title).join('\n');
    
    const prompt = `أنت خبير منتجات سعودي. حلّل عناوين المنتجات واستخرج فلترين ذكيين.

البحث: "${query}"

العناوين:
${productTitles}

مهمتك:
1. **الأحجام/المقاسات**: استخرج جميع الأحجام الموجودة في العناوين.
   عنوان السؤال مناسب لنوع البحث.

2. **فلتر ذكي ثالث**: حدّد فلتر مفيد.
   أمثلة:
   - قهوة → "نوع القهوة" (تركية، عربية، إسبريسو)
   - ثلاجة → "اللون" (فضي، أبيض، أسود)
   - أدوات مطبخ → "المادة" (ستانلس، سيراميك)

أعد JSON فقط:
{
  "sizesTitle": "السؤال",
  "sizes": ["خيار1", "خيار2"],
  "thirdTitle": "السؤال الثالث",
  "thirdOptions": ["خيار1", "خيار2"]
}

ملاحظات:
- استخرج فقط ما هو موجود فعلاً
- إذا ما فيه، أعد المصفوفة فاضية []`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0].message.content);
    const output = {
      sizesTitle: result.sizesTitle || 'ايش الحجم اللي يناسبك؟',
      sizes: result.sizes || [],
      thirdTitle: result.thirdTitle || '',
      thirdOptions: result.thirdOptions || [],
    };
    smartFiltersCache.set(cacheKey, output);
    return output;
  } catch (error) {
    console.error('Smart filters error:', error.message);
    return { sizesTitle: '', sizes: [], thirdTitle: '', thirdOptions: [] };
  }
}

async function generateRelatedSearches(query, products) {
  const cacheKey = (query || '').toLowerCase().trim();
  const cached = relatedSearchesCache.get(cacheKey);
  if (cached) return cached;
  try {
    const productExamples = products.slice(0, 10).map(p => p.title).join('\n');

    const prompt = `اقترح 4 بحوث ذات صلة بـ "${query}" لكن مختلفة عنها.

المنتجات:
${productExamples}

مثلاً لو البحث "ماكينة قهوة": اقترح "فناجين قهوة"، "مطحنة قهوة"، "حبوب قهوة"، "دلال قهوة"
كل بحث: 2-4 كلمات + emoji.

أعد JSON: {"relatedSearches": [{"icon": "emoji", "query": "البحث"}]}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0].message.content);
    const output = result.relatedSearches || [];
    relatedSearchesCache.set(cacheKey, output);
    return output;
  } catch (error) {
    console.error('Related searches error:', error.message);
    return [];
  }
}

async function generateAISummary(query, products, preferHomeElec) {
  const cacheKey = `${(query || '').toLowerCase().trim()}|${preferHomeElec ? '1' : '0'}`;
  const cached = aiSummaryCache.get(cacheKey);
  if (cached) return cached;
  try {
    const productsWithDetails = products.slice(0, 30).map(p => {
      const discount = getDiscountInfo(p.price, p.sale_price);
      const effectivePrice = discount.hasDiscount ? extractPrice(p.sale_price) : extractPrice(p.price);
      return {
        title: p.title,
        price: p.price,
        sale_price: p.sale_price,
        effectivePrice: effectivePrice,
        brand: p.brand,
        image_link: p.image_link,
        link: p.link,
      };
    });

    const validProducts = productsWithDetails.filter(p => p.effectivePrice > 0);
    const prices = validProducts.map(p => p.effectivePrice);
    
    const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
    const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;

    const brands = [...new Set(products.map(p => p.brand).filter(b => b))].slice(0, 5);

    const homeElecInstruction = preferHomeElec 
      ? '\n\nمهم جداً: هذا البحث عن جهاز كهربائي. **فضّل ماركة "home elec" قدر الإمكان** في التوصيات، خاصة لـ "الأفضل قيمة" و"الأرقى". لكن لا تختر منتج home elec إذا ما هو موجود في القائمة.'
      : '';

    const prompt = `قدّم 3 توصيات منتجات حسب الميزانية.

البحث: "${query}"
نطاق الأسعار: ${minPrice} - ${maxPrice} ر.س

المنتجات:
${productsWithDetails.map((p, i) => `${i + 1}. ${p.title} - ${p.effectivePrice} ر.س - ${p.brand || 'غير محدد'}`).join('\n')}

اختر 3 منتجات: الأرخص، الأفضل قيمة، الأرقى.
لكل توصية أعد:
- "title": اسم المنتج بالضبط من القائمة
- "marketing": جملة تسويقية قصيرة جذّابة (سطر واحد) تبرز نقطة قوة فريدة للمنتج وتشجّع على الشراء. أمثلة:
  * للأرخص: "صفقة لا تفوّت! نفس الجودة بنصف السعر 🔥"
  * للأفضل قيمة: "الخيار الأكثر طلباً — توازن مثالي بين السعر والميزات ⭐"
  * للأرقى: "تجربة فاخرة لمن يستحق الأفضل 👑"
  (نوّع في الأسلوب، لا تكرر الأمثلة حرفياً)
- "pros": 3 مميزات إيجابية واقعية

${homeElecInstruction}

أعد JSON:
{
  "summary": "ملخّص قصير",
  "recommendations": {
    "cheapest": {"title": "...", "marketing": "...", "pros": ["م1","م2","م3"]},
    "bestValue": {"title": "...", "marketing": "...", "pros": ["م1","م2","م3"]},
    "premium": {"title": "...", "marketing": "...", "pros": ["م1","م2","م3"]}
  }
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      response_format: { type: 'json_object' },
    });

    const aiResult = JSON.parse(response.choices[0].message.content);
    
    const findProduct = (title) => {
      return productsWithDetails.find(p => p.title === title) || productsWithDetails.find(p => p.title.includes(title.substring(0, 20)));
    };

    const enrichRec = (rec) => {
      if (!rec || !rec.title) return null;
      const product = findProduct(rec.title);
      if (!product) return null;
      
      const discount = getDiscountInfo(product.price, product.sale_price);
      return {
        title: product.title,
        image_link: product.image_link,
        link: product.link,
        brand: product.brand,
        price: discount.hasDiscount ? product.sale_price : product.price,
        originalPrice: discount.hasDiscount ? product.price : null,
        discountPercentage: discount.discountPercentage,
        hasDiscount: discount.hasDiscount,
        marketing: rec.marketing || '',
        pros: rec.pros || [],
      };
    };

    const output = {
      summary: aiResult.summary,
      recommendations: {
        cheapest: enrichRec(aiResult.recommendations?.cheapest),
        bestValue: enrichRec(aiResult.recommendations?.bestValue),
        premium: enrichRec(aiResult.recommendations?.premium),
      },
      totalProducts: products.length,
      priceRange: { min: minPrice, max: maxPrice },
      topBrands: brands,
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

    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: message,
    });
    const queryEmbedding = embeddingResponse.data[0].embedding;

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

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-6).map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: typeof m.content === 'string' ? m.content : m.content.reply || ''
      })),
      { role: 'user', content: message }
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messages,
      temperature: 0.7,
      response_format: { type: 'json_object' },
    });

    const aiResult = JSON.parse(response.choices[0].message.content);

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
      // touch للـ LRU
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
  };
}

// كاشات متعددة الطبقات
const responseCache = makeCache(150, 5 * 60 * 1000);        // response كامل — 5 دقائق
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
async function detectTypo(query) {
  const key = (query || '').trim().toLowerCase();
  if (key.length < 2) return null;

  if (typoCache.has(key)) return typoCache.get(key);

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `أنت مدقق إملائي لمتجر إلكتروني سعودي يبيع أدوات منزلية وأجهزة كهربائية.

البحث: "${query}"

افحص: هل فيه خطأ إملائي واضح؟

أمثلة على أخطاء يجب تصحيحها:
- "كفوة" → "قهوة"
- "تلاجه" → "ثلاجة"
- "غصاله" → "غسالة"
- "ميكرويف" → "ميكروويف"
- "قلايه هوائيه" → "قلاية هوائية"

قواعد مهمة:
- صحّح فقط الأخطاء الإملائية الواضحة، لا تغيّر معنى البحث
- إذا الكلمة صحيحة → hasTypo = false
- إذا الكلمة بحث صحيح أصلاً (حتى لو اختصار) → hasTypo = false

أعد JSON: {"hasTypo": true/false, "correction": "النص المصحح إن وجد، أو فارغ"}`
      }],
      temperature: 0,
      response_format: { type: 'json_object' },
      max_tokens: 100,
    });

    const result = JSON.parse(response.choices[0].message.content);
    let correction = null;
    if (result.hasTypo && result.correction && typeof result.correction === 'string') {
      const c = result.correction.trim();
      if (c && c.toLowerCase() !== key) correction = c;
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
    const embRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: baseQuery,
    });

    const searchRes = await esClient.search({
      index: INDEX_NAME,
      size: 30,
      _source: ['title', 'image_link', 'price', 'sale_price', 'brand', 'link', 'color', 'size'],
      knn: {
        field: 'embedding',
        query_vector: embRes.data[0].embedding,
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

    const aiRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      response_format: { type: 'json_object' },
    });

    const aiResult = JSON.parse(aiRes.choices[0].message.content);

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
    model: 'gemini-2.5-flash-image',
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
        if (imageUrl) usedModel = 'gemini-2.5-flash-image (Nano Banana)';
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

app.post('/image-search', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image || typeof image !== 'string' || !image.startsWith('data:image/')) {
      return res.status(400).json({ success: false, message: 'Valid image data URL required' });
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `حدّد المنتج الرئيسي في الصورة واكتب وصفاً قصيراً (2-4 كلمات) باللغة العربية مناسب للبحث عنه في متجر إلكتروني سعودي يبيع أدوات منزلية وأجهزة كهربائية.

أمثلة:
- صورة ماكينة قهوة → "ماكينة قهوة"
- صورة فنجان شاي → "فنجان شاي"
- صورة قلاية هوائية → "قلاية هوائية"
- صورة ثلاجة → "ثلاجة"

إذا ما قدرت تحدّد المنتج، أعد query فاضي.

أعد JSON فقط: {"query": "وصف المنتج", "confidence": "high/medium/low"}`
          },
          { type: 'image_url', image_url: { url: image } }
        ]
      }],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(response.choices[0].message.content);
    const extractedQuery = (result.query || '').trim();

    if (!extractedQuery) {
      return res.json({ success: false, message: 'لم نتمكن من التعرّف على المنتج في الصورة', query: '' });
    }

    console.log(`📷 Image search → "${extractedQuery}" (confidence: ${result.confidence || 'unknown'})`);
    res.json({ success: true, query: extractedQuery, confidence: result.confidence });
  } catch (error) {
    console.error('Image search error:', error.message);
    res.status(500).json({ success: false, message: 'Image analysis failed', error: error.message });
  }
});

app.get('/search', async (req, res) => {
  const query = req.query.q;
  const limit = parseInt(req.query.limit) || 500;
  const skipIntent = req.query.skipIntent === 'true';

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
  const responseCacheKey = `${query.toLowerCase().trim()}|${limit}|${skipIntent ? '1' : '0'}`;
  const cachedResponse = responseCache.get(responseCacheKey);
  if (cachedResponse) {
    console.log(`⚡ Response cache hit: "${query}"`);
    return res.json(cachedResponse);
  }

  try {
    // 1+2. تشغيل التصنيف + الـ embedding بالتوازي (مستقلين)
    const [searchType, queryEmbedding] = await Promise.all([
      classifySearchType(query),
      getQueryEmbedding(query),
    ]);
    console.log(`Search "${query}" classified as: ${searchType.type} (excludeAccessories: ${searchType.excludeAccessories}, preferHomeElec: ${searchType.preferHomeElec})`);

    // 3. Search Elasticsearch
    const result = await esClient.search({
      index: INDEX_NAME,
      size: limit,
      _source: ['title', 'image_link', 'price', 'sale_price', 'brand', 'link', 'color', 'size'],
      knn: {
        field: 'embedding',
        query_vector: queryEmbedding,
        k: limit,
        num_candidates: Math.min(limit * 2, 1000),
      },
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
      };
    });

    // 4. Filter out accessories if searching for a device
    if (searchType.excludeAccessories) {
      const beforeCount = products.length;
      products = products.filter(p => !isAccessory(p.title, searchType.deviceKeyword));
      console.log(`Filtered accessories: ${beforeCount} → ${products.length} products`);
    }

    // 4.5. 🎯 فلترة بـ "موضوع البحث" - تطبق لجميع أنواع البحث للضمان
    // مثال: "غسالة ملابس" → موضوع "غسالة ملابس" → نطلب فقط منتجات فيها "غسال"
    {
      const subject = extractSubject(query);
      if (subject) {
        const beforeCount = products.length;
        const filtered = products.filter(p => titleMatchesSubject(p.title, subject));
        if (filtered.length >= 1) {
          products = filtered;
          console.log(`🎯 Filtered by subject "${subject}": ${beforeCount} → ${products.length} products`);
        } else {
          console.log(`⚠️ No products match subject "${subject}", keeping original list`);
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

    // 7. Run AI features in parallel
    const [aiSummary, intent, smartFilters, relatedSearches, didYouMean] = await Promise.all([
      generateAISummary(query, products.map(p => ({
        title: p.title,
        price: p.originalPrice || p.price,
        sale_price: p.hasDiscount ? p.price : p.originalPrice,
        brand: p.brand,
        image_link: p.image_link,
        link: p.link,
      })), searchType.preferHomeElec),
      skipIntent ? Promise.resolve({ isAmbiguous: false, message: '', suggestions: [] }) : detectIntent(query, products),
      generateSmartFilters(query, products),
      generateRelatedSearches(query, products),
      detectTypo(query),
    ]);

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
    responseCache.set(responseCacheKey, finalResponse);
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

app.listen(PORT, () => {
  console.log(`\nServer running on port ${PORT}`);
  console.log(`URL: http://localhost:${PORT}`);
  console.log(`Search: http://localhost:${PORT}/search?q=coffee`);
  console.log(`Chat: POST http://localhost:${PORT}/chat\n`);

  loadProductCatalog()
    .then(count => console.log(`📦 Loaded ${count} product codes for direct lookup`))
    .catch(err => console.error('❌ Failed to load product catalog:', err.message));
});
