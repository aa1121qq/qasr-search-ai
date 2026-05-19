// 🏷️ Sample classifier — يصنّف 50 منتج فقط
// - يختار 50 منتج متنوع (mix من جميع الفئات)
// - يكتب النتيجة في data/sample_tags.json للمراجعة البشرية
// - لا يكتب في Elasticsearch
//
// الاستخدام:
//   node scripts/sample-tag-products.js
//   ثم راجع data/sample_tags.json قبل تطبيق التصنيف على الكتالوج كاملاً

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
const SAMPLE_SIZE = 50;
const BATCH_SIZE = 10;
const OUTPUT = path.join(__dirname, '..', 'data', 'sample_tags.json');

const VALID_KINDS = ['appliance', 'cookware', 'serveware', 'kitchen_tool', 'storage', 'thermos', 'accessory', 'consumable', 'furniture', 'textile', 'bath', 'decor', 'other'];
const VALID_MATERIALS = ['steel', 'glass', 'plastic', 'ceramic', 'wood', 'granite', 'melamine', 'silicone', 'aluminum', 'cast_iron', 'mixed', 'unknown'];

// ملاحظة: لا نطلب من الـ LLM seasonal — حسب طلب المستخدم، seasonal_tags يُملأ يدوياً
const SYSTEM_PROMPT = `You classify Saudi home-goods products in Arabic.

For each product, output JSON with:
- kind: ONE of [appliance, cookware, serveware, kitchen_tool, storage, thermos, accessory, consumable, furniture, textile, bath, decor, other]
- subtype: short canonical English snake_case identifier (e.g. split_ac, refrigerator_2door, air_fryer, coffee_pot_arabic, knife_set). If unclear → "general".
- tags: array of 3-6 lowercase English tags (e.g. ["electric","large","family"])
- material: ONE of [steel, glass, plastic, ceramic, wood, granite, melamine, silicone, aluminum, cast_iron, mixed, unknown]

Rules:
- "ترمس" or "ترامس" → kind=thermos
- "ثلاجة 1 لتر" or small ml → kind=thermos (mini cooler), NOT appliance
- "وعاء قلاية" / "قالب دونات" → kind=accessory
- "صحن" / "طقم صحون" → kind=serveware
- Air conditioners: split_ac vs desert_cooler vs portable_ac
- Be strict. When in doubt → kind=other.

Output ONLY a JSON object with key "products" containing an array, in input order.`;

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
    max_tokens: 2500,
  });

  const raw = response.choices[0].message.content;
  const parsed = JSON.parse(raw);
  const arr = parsed.products || (Array.isArray(parsed) ? parsed : Object.values(parsed)[0]);
  return Array.isArray(arr) ? arr : [];
}

function sanitize(c) {
  return {
    kind: VALID_KINDS.includes(c.kind) ? c.kind : 'other',
    subtype: (c.subtype || 'general').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40),
    tags: Array.isArray(c.tags) ? c.tags.slice(0, 8).map(t => String(t).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30)).filter(Boolean) : [],
    material: VALID_MATERIALS.includes(c.material) ? c.material : 'unknown',
  };
}

async function main() {
  console.log(`🎯 جلب ${SAMPLE_SIZE} منتج عشوائي من ${INDEX_NAME}`);

  // عينة عشوائية باستخدام ES function_score with random_score
  const sample = await esClient.search({
    index: INDEX_NAME,
    size: SAMPLE_SIZE,
    _source: ['title', 'brand'],
    query: {
      function_score: {
        query: { match_all: {} },
        random_score: { seed: Date.now(), field: '_seq_no' },
      },
    },
  });

  const products = sample.hits.hits.map(h => ({
    id: h._id,
    title: h._source.title,
    brand: h._source.brand || '',
  }));

  console.log(`✓ تم. أصنّف الآن بـ batches من ${BATCH_SIZE}...`);

  const results = [];
  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);
    process.stdout.write(`  batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(products.length / BATCH_SIZE)}... `);
    try {
      const classified = await classifyBatch(batch);
      for (let j = 0; j < batch.length; j++) {
        const c = sanitize(classified[j] || {});
        results.push({
          id: batch[j].id,
          title: batch[j].title,
          brand: batch[j].brand,
          kind: c.kind,
          subtype: c.subtype,
          tags: c.tags,
          material: c.material,
        });
      }
      console.log('✓');
    } catch (e) {
      console.log('✗', e.message);
    }
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\n💾 حُفظت ${results.length} عينة في:\n   ${OUTPUT}`);
  console.log(`\n📋 للمراجعة:`);
  console.log(`   • افتح الملف وراجع الـ kind / subtype / tags لكل منتج`);
  console.log(`   • لو راضي عن النتائج، اطلب تطبيق على الكتالوج كاملاً`);
  console.log(`   • لو فيه قيم خطأ، عدّل الـ prompt في sample-tag-products.js وأعد التشغيل`);

  // ملخص توزيع kinds
  const kindCounts = {};
  results.forEach(r => { kindCounts[r.kind] = (kindCounts[r.kind] || 0) + 1; });
  console.log(`\n📊 توزيع الـ kinds في العينة:`);
  Object.entries(kindCounts).sort((a, b) => b[1] - a[1]).forEach(([k, c]) => {
    console.log(`   ${k.padEnd(15)} ${c}`);
  });
}

main().catch(e => { console.error('❌ Fatal:', e); process.exit(1); });
