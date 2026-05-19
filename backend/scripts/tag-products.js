// 🏷️ تصنيف المنتجات بـ LLM (gpt-4o-mini) في batches
// - يقرأ من ES كل المنتجات التي لا تحتوي tagged_at
// - يصنّفها 20 منتج في كل LLM call (لخفض التكلفة 20x)
// - يحدّث ES مع الحقول الجديدة
// - resumable: لو توقف، يكمل من المنتجات غير المصنّفة

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('@elastic/elasticsearch');
const OpenAI = require('openai');

const esClient = new Client({
  node: process.env.ELASTIC_ENDPOINT,
  auth: { apiKey: process.env.ELASTIC_API_KEY },
});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const INDEX_NAME = process.env.INDEX_NAME || 'products_local';
const BATCH_SIZE = 20;          // عدد المنتجات في كل LLM call
const CONCURRENT_BATCHES = 5;   // عدد الـ batches بالتوازي
const SCROLL_TIMEOUT = '30m';
const PROGRESS_FILE = path.join(__dirname, '..', 'data', 'tag-progress.json');

// قاموس التصنيفات الصالحة — الـ LLM يجب أن يختار من هذي
const VALID_KINDS = [
  'appliance',      // أجهزة كهربائية رئيسية (ثلاجة، غسالة، فرن، مكنسة، قلاية…)
  'cookware',       // أدوات طبخ على النار (قدر، مقلاة، حلة، طاجن)
  'serveware',      // تقديم (صحون، أكواب، صواني، فناجين، دلال)
  'kitchen_tool',   // أدوات يدوية (سكاكين، مبشرة، فتاحة، مغرفة)
  'storage',        // حفظ (حافظات، علب، شنط، برطمانات)
  'thermos',        // ترامس وترموسات
  'accessory',      // ملحقات (وعاء قلاية، قالب، فلتر، قطعة غيار)
  'consumable',     // مستهلكات (أكياس، فلاتر مياه)
  'furniture',      // أثاث (طاولات، كراسي)
  'textile',        // مفارش، مناديل، فوط
  'bath',           // حمام
  'decor',          // ديكور
  'other',
];

const VALID_MATERIALS = ['steel', 'glass', 'plastic', 'ceramic', 'wood', 'granite', 'melamine', 'silicone', 'aluminum', 'cast_iron', 'mixed', 'unknown'];

// ملاحظة: product_seasonal لا يُملأ من الـ LLM — يُملأ يدوياً من المستخدم
// (طلب صريح: قرارات الموسمية بشرية، ليست AI)

const SYSTEM_PROMPT = `You classify Saudi home-goods products in Arabic.

For each product, output JSON with:
- kind: ONE of [appliance, cookware, serveware, kitchen_tool, storage, thermos, accessory, consumable, furniture, textile, bath, decor, other]
- subtype: a short canonical English snake_case identifier (e.g. split_ac, refrigerator_2door, air_fryer, coffee_pot_arabic, knife_set, food_container). If no clear subtype, use "general".
- tags: array of 3-6 lowercase English tags describing the product (e.g. ["electric","large","family","silver"])
- material: ONE of [steel, glass, plastic, ceramic, wood, granite, melamine, silicone, aluminum, cast_iron, mixed, unknown]

Rules:
- "ترمس" or "ترامس" → kind=thermos
- "ثلاجة 1 لتر" or small ml → kind=thermos (it's a mini cooler), NOT appliance
- "وعاء قلاية" / "قالب دونات" → kind=accessory
- "صحن"/"طقم صحون" → kind=serveware
- Air conditioners that are misc fans/coolers → mark separately: split_ac vs desert_cooler vs portable_ac
- Be strict. When in doubt → kind=other.

Output ONLY a JSON array, one object per product, in the same order as input.`;

async function classifyBatch(products) {
  const userMsg = products.map((p, i) =>
    `${i + 1}. ${p.title}${p.brand ? ` [brand: ${p.brand}]` : ''}`
  ).join('\n');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
    max_tokens: 4000,
  });

  let raw = response.choices[0].message.content;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn('⚠️  JSON parse failed, raw:', raw.substring(0, 300));
    throw e;
  }
  // قد يرجع {"products":[...]} أو [...] مباشرة
  const arr = Array.isArray(parsed) ? parsed : (parsed.products || parsed.results || parsed.classifications || Object.values(parsed)[0]);
  if (!Array.isArray(arr)) throw new Error('LLM did not return array');
  if (arr.length !== products.length) {
    console.warn(`⚠️  expected ${products.length} got ${arr.length}`);
  }
  return arr;
}

function sanitize(c) {
  return {
    product_kind: VALID_KINDS.includes(c.kind) ? c.kind : 'other',
    product_subtype: (c.subtype || 'general').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40),
    product_tags: Array.isArray(c.tags) ? c.tags.slice(0, 8).map(t => String(t).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30)).filter(Boolean) : [],
    product_material: VALID_MATERIALS.includes(c.material) ? c.material : 'unknown',
    // product_seasonal: غير مُملوء من LLM — يُترك null/undefined ليُملأ يدوياً
    tagged_at: new Date().toISOString(),
  };
}

async function main() {
  const start = Date.now();

  // عدد المنتجات غير المصنّفة
  const totalRes = await esClient.count({
    index: INDEX_NAME,
    query: { bool: { must_not: { exists: { field: 'tagged_at' } } } },
  });
  const total = totalRes.count;
  console.log(`🎯 منتجات بحاجة تصنيف: ${total}`);
  if (total === 0) { console.log('Nothing to do!'); return; }

  // نجيب الـ batch الأول
  let resp = await esClient.search({
    index: INDEX_NAME,
    scroll: SCROLL_TIMEOUT,
    size: BATCH_SIZE * CONCURRENT_BATCHES,
    _source: ['title', 'brand'],
    query: { bool: { must_not: { exists: { field: 'tagged_at' } } } },
  });

  let processed = 0, ok = 0, fail = 0;

  while (resp.hits.hits.length > 0) {
    // نقسم لـ batches متوازية
    const allHits = resp.hits.hits;
    const batches = [];
    for (let i = 0; i < allHits.length; i += BATCH_SIZE) {
      batches.push(allHits.slice(i, i + BATCH_SIZE));
    }

    // نشغّلهم بالتوازي
    await Promise.all(batches.map(async (batch) => {
      try {
        const productsForLLM = batch.map(h => ({
          title: h._source.title,
          brand: h._source.brand || '',
        }));
        const classifications = await classifyBatch(productsForLLM);

        // bulk update
        const ops = [];
        for (let i = 0; i < batch.length; i++) {
          const c = classifications[i] || {};
          const tags = sanitize(c);
          ops.push({ update: { _index: INDEX_NAME, _id: batch[i]._id } });
          ops.push({ doc: tags });
        }
        if (ops.length > 0) {
          await esClient.bulk({ operations: ops, refresh: false });
        }
        ok += batch.length;
      } catch (e) {
        fail += batch.length;
        if (fail < 50) console.error(`\n❌ batch failed: ${e.message}`);
      }
      processed += batch.length;
    }));

    const pct = ((processed / total) * 100).toFixed(1);
    const elapsedS = ((Date.now() - start) / 1000).toFixed(0);
    const rate = (processed / parseFloat(elapsedS)).toFixed(1);
    const etaS = ((total - processed) / parseFloat(rate)).toFixed(0);
    process.stdout.write(`\r📊 ${processed}/${total} (${pct}%) | ✓${ok} ✗${fail} | ${elapsedS}s | ${rate}/s | ETA ${etaS}s    `);

    // الـ batch التالي
    resp = await esClient.scroll({ scroll_id: resp._scroll_id, scroll: SCROLL_TIMEOUT });
  }

  console.log(`\n\n🎉 اكتمل!`);
  console.log(`   ⏱️  ${((Date.now() - start) / 60000).toFixed(1)} دقيقة`);
  console.log(`   ✓ نجاح: ${ok}`);
  console.log(`   ✗ فشل: ${fail}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
