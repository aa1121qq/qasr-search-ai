# QasrAlawani Search AI — Project State

> آخر تحديث: 2026-06-03

## 🌐 الروابط

- **Frontend (Live):** https://qasr-search-ai.vercel.app
- **Backend (Live):** https://178-105-152-146.sslip.io
- **GitHub Repo:** https://github.com/aa1121qq/qasr-search-ai
- **Vercel Dashboard:** https://vercel.com/dashboard
- **Hetzner Console:** https://console.hetzner.com

## 🏗️ البنية التحتية

```
👤 الزائر
   ↓
🌐 Vercel (frontend — مجاني)
   ↓ /search, /search/ai, /image-search, /tansiq-compose
☁️ Hetzner CPX22 — IP: 178.105.152.146 ($9.49/شهر)
   ├─ Node.js + Express (port 5000, via PM2)
   ├─ Elasticsearch 9.4.2 (localhost:9200, محلي)
   ├─ Ollama + BGE-M3 (embeddings)
   ├─ @xenova/transformers (CLIP + BGE-Reranker)
   └─ Caddy (HTTPS via sslip.io)
```

## 🔑 الحسابات والخدمات

| الخدمة | الدور | التكلفة الشهرية |
|---|---|---|
| Hetzner | Backend + ES + Ollama | $9.49 |
| Vercel | Frontend | $0 (Hobby) |
| GitHub | Code | $0 |
| OpenAI (GPT-4.1-nano) | Intent/Filters/Summary | ~$3-15 |
| Google Gemini Nano Banana 2 | Tansiq images | ~$5 cap |
| Elastic Cloud | ❌ ألغي بعد النقل المحلي | $0 |

**المجموع المتوقع:** ~$15-25/شهر

## 🔐 كلمات السر المهمة

- **Hetzner SSH:** `ssh root@178.105.152.146` (مع SSH key)
- **Dashboard backend:** `12345` / `12345`
- **Advanced Tansiq mode unlock:** `114141`
- **ADMIN_SECRET / ADMIN_KEY:** `12345`

## 📦 إصدارات النظام

- Ubuntu 26.04 LTS
- Node.js 20
- Elasticsearch 9.4.2
- PM2 cluster mode
- Vercel auto-deploy on git push

## 🧠 نظام البحث (Pipeline)

```
1. Query Classification → device/general
2. Typo Correction (catalog-anchored, محصّن للـ device words)
3. Subject Extraction → BGE-M3 embedding (1024-d, Ollama)
4. Elasticsearch kNN (cosine, 500 candidates)
5. CLIP Visual Re-rank (dual: full + multi-region focused)
6. BGE-Reranker (top 15)
7. Accessory + Subject Scoring (word-level stem equality)
8. Kind-based Reranking (product_kind from tagging)
9. Brand Extraction (top 50, min 2 occurrences)
10. AI Features (parallel): GPT-4.1-nano
    - AI Summary (3 recommendations)
    - Intent suggestions (with catalog validation)
    - Smart filters
    - Related searches
```

## 🎯 ميزات خاصة

### Intent Validation (3 layers)
- Layer 1: Dedup paraphrasings
- Layer 2: Catalog validation (each chip ≥2 products)
- Layer 3: Axis-based prompt + negative few-shots

### Image Search
- 4-region ensemble (full + center60 + tight45 + upper55)
- L2-normalized blend
- Manual cropping UI (ImageCropper.jsx)
- `userCropped: true` flag skips multi-region

### Tansiq (Composition)
- Gemini Nano Banana 2 (Flash 3.1)
- 13 strict rules (preserve colors/sizes, tray flat, 2 cups max from set)
- Caddy timeout 300s
- Fallback chain: gpt-image-1 → dall-e-3 → dall-e-2

### Kind Mapping (40+ keywords)
```
فرن → appliance      |  ترامس → thermos
خلاط → appliance     |  فنجال → serveware
سكين → kitchen_tool  |  قدر → cookware
```

## 📂 ملفات المشروع المهمة

```
search-app/
├── backend/
│   ├── index.js                    # السيرفر الرئيسي (~4500 سطر)
│   ├── .env                        # المفاتيح والإعدادات (محلي ES)
│   ├── .env.bak.cloud              # نسخة احتياطية Elastic Cloud
│   ├── data/products.csv           # الكتالوج (9,299 منتج)
│   ├── data/response-cache.json    # كاش الاستجابات
│   └── scripts/
│       ├── add-clip-mapping.js
│       ├── embed-clip-images.js
│       ├── embed-clip-images-focused.js
│       ├── migrate-from-cloud.js   # نقل البيانات من Cloud
│       └── sync-clip.js            # نقل CLIP embeddings فقط
├── frontend/
│   └── src/
│       ├── App.jsx                 # المكوّن الرئيسي
│       ├── App.css                 # كل التنسيقات
│       ├── DeveloperMode.jsx       # لوحة المطوّر
│       ├── TansiqDevMode.jsx       # لوحة المطوّر للتنسيق
│       ├── ImageCropper.jsx        # نافذة قصّ الصورة
│       └── Maintenance.jsx         # صفحة الصيانة
├── CLAUDE.md                       # تعليمات Claude للمشروع
└── PROJECT.md                      # هذا الملف
```

## 🚨 الأوامر السريعة

### إعادة تشغيل الـ backend
```bash
ssh root@178.105.152.146 'pm2 restart qasr-backend'
```

### مسح الكاش
```bash
ssh root@178.105.152.146 'pm2 stop qasr-backend && rm /root/qasr/backend/data/response-cache.json && pm2 start qasr-backend'
```

### مراجعة الـ logs
```bash
ssh root@178.105.152.146 'pm2 logs qasr-backend --lines 50 --nostream'
```

### بناء ونشر التحديثات
```powershell
cd C:\Users\DELL\Desktop\search-app
cd frontend
npm run build
cd ..
git add . ; git commit -m "وصف التغيير" ; git push
# Vercel ينشر تلقائياً خلال ~60 ثانية
```

### بدء جلسة Claude جديدة
```powershell
cd C:\Users\DELL\Desktop\search-app
claude
```

## 💡 ملاحظات للجلسات القادمة

عند ما تبدأ جلسة جديدة مع Claude، أعطه السياق:
- "هذا مشروع QasrAlawani — راجع PROJECT.md و CLAUDE.md"
- اذكر إن البحث يشتغل على Hetzner مع Elasticsearch محلي
- اذكر ميزات Intent validation + Kind mapping + Image cropper

## 📊 إحصائيات الكتالوج

- **9,299** منتج
- **9,291** عنده clip_image_embedding
- **9,288** عنده clip_image_embedding_focused
- **2,676** كلمة فريدة في الـ vocabulary
- **8,308** عبارة autocomplete (2-3 كلمات)
- **40+** كلمة مفتاحية في KIND_HINTS

## 🛡️ الحماية المالية

- **Gemini cap:** $5/شهر (Tier 1)
- **OpenAI:** بدون cap (يُنصح بإضافته على platform.openai.com)
- **Hetzner:** شهري ثابت $9.49

## 🔄 سجل التحديثات الأخيرة

- نقل Elasticsearch من Cloud إلى Hetzner (توفير $60/شهر)
- تطبيق Kind-based reranking على /search و /search/ai
- إصلاح حصانة device words من typo correction
- Multi-region image search ensemble (4 مناطق)
- Manual image cropper مع upscaling
- Intent validation 3-layer (axis + negative few-shots + catalog validation)
- Word-level stem equality في Subject Scoring
- GPT-4o-mini → GPT-4.1-nano (33% أرخص)
- Gemini Pro → Nano Banana 2 (50% أسرع، نصف السعر)
