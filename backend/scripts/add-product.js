#!/usr/bin/env node
// إضافة منتج جديد (واحد أو أكثر) إلى Elasticsearch
// مع توليد embeddings: BGE-M3 (نصي) + CLIP (بصري)
//
// الاستخدام:
//   node scripts/add-product.js --json '{"title":"...","image_link":"...","price":"...","brand":"...","link":"..."}'
//   node scripts/add-product.js --file products.json    # ملف يحتوي object أو array
//
// ملاحظات:
// - يحدّث المنتج إذا كان موجوداً بنفس الـ link (upsert)
// - يحدّث data/products.csv لإضافة المنتج (للبحث بالكود)
// - بعد التشغيل، أعد تشغيل السيرفر (nodemon يفعل ذلك تلقائياً عند تعديل index.js)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('@elastic/elasticsearch');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const esClient = new Client({
  node: process.env.ELASTIC_ENDPOINT,
  auth: { apiKey: process.env.ELASTIC_API_KEY },
});

const INDEX_NAME = process.env.INDEX_NAME || 'products_local';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'bge-m3';
const CSV_FILE = path.join(__dirname, '..', 'data', 'products.csv');

// 1) BGE-M3 embedding (نصي عربي)
async function bgeEmbed(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`Ollama: HTTP ${res.status}`);
  const j = await res.json();
  return j.embedding;
}

// 2) CLIP embedding (بصري للصورة)
let _clipPipeline = null;
async function clipImageEmbed(imageUrl) {
  if (!_clipPipeline) {
    const { pipeline, env } = await import('@xenova/transformers');
    env.cacheDir = path.join(__dirname, '..', 'models-cache');
    console.log('🚀 Loading CLIP...');
    _clipPipeline = await pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32');
    console.log('✅ CLIP loaded');
  }
  const result = await _clipPipeline(imageUrl);
  return Array.from(result.data);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let json = null, file = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && args[i + 1]) { json = args[i + 1]; i++; }
    else if (args[i] === '--file' && args[i + 1]) { file = args[i + 1]; i++; }
  }
  return { json, file };
}

function normalizeProduct(p) {
  return {
    title: (p.title || '').trim(),
    image_link: (p.image_link || '').trim(),
    price: (p.price || '').toString(),
    sale_price: (p.sale_price || '').toString(),
    brand: (p.brand || '').trim(),
    link: (p.link || '').trim(),
    color: (p.color || '').trim(),
    size: (p.size || '').trim(),
    id: (p.id || '').toString().trim(),
    mpn: (p.mpn || '').toString().trim(),
    sku: (p.sku || '').toString().trim(),
  };
}

function validateProduct(p) {
  const errs = [];
  if (!p.title) errs.push('title مطلوب');
  if (!p.image_link) errs.push('image_link مطلوب');
  if (!p.link) errs.push('link مطلوب (للـ deduplication)');
  return errs;
}

async function appendToCSV(products) {
  let rows = [];
  let columns;
  if (fs.existsSync(CSV_FILE)) {
    const existing = fs.readFileSync(CSV_FILE, 'utf8');
    const parsed = parse(existing, { columns: true, skip_empty_lines: true });
    columns = Object.keys(parsed[0] || {});
    if (columns.length === 0) {
      columns = ['title', 'image_link', 'price', 'sale_price', 'brand', 'link', 'color', 'size', 'id', 'mpn', 'sku'];
    }
    rows = parsed;
  } else {
    columns = ['title', 'image_link', 'price', 'sale_price', 'brand', 'link', 'color', 'size', 'id', 'mpn', 'sku'];
  }
  const existingLinks = new Set(rows.map(r => (r.link || '').trim()));
  let appended = 0;
  for (const p of products) {
    if (existingLinks.has(p.link)) continue;
    const row = {};
    for (const c of columns) row[c] = p[c] !== undefined ? p[c] : '';
    rows.push(row);
    appended++;
  }
  if (appended > 0) {
    const out = stringify(rows, { header: true, columns });
    fs.writeFileSync(CSV_FILE, out, 'utf8');
    console.log(`📝 CSV: أضيف ${appended} سطر`);
  } else {
    console.log('📝 CSV: لا جديد (links موجودة مسبقاً)');
  }
}

async function indexOne(p) {
  console.log(`\n📦 [${p.title.substring(0, 50)}]`);
  console.log('   ⏳ توليد BGE-M3 embedding (نصي)...');
  const titleEmbed = await bgeEmbed(p.title);
  console.log(`   ✓ ${titleEmbed.length}-d`);

  let clipEmbed = null;
  if (p.image_link) {
    try {
      console.log('   ⏳ توليد CLIP embedding (بصري)...');
      clipEmbed = await clipImageEmbed(p.image_link);
      console.log(`   ✓ ${clipEmbed.length}-d`);
    } catch (e) {
      console.warn(`   ⚠️  فشل CLIP: ${e.message} (المنتج سيُفهرس بدون visual embedding)`);
    }
  }

  const doc = {
    title: p.title,
    image_link: p.image_link,
    price: p.price,
    sale_price: p.sale_price,
    brand: p.brand,
    link: p.link,
    color: p.color,
    size: p.size,
    embedding: titleEmbed,
  };
  if (clipEmbed) doc.clip_image_embedding = clipEmbed;

  // ID = هاش بسيط للـ link (إذا متاح) أو timestamp
  const docId = p.link ? Buffer.from(p.link).toString('base64').slice(0, 32).replace(/[^a-zA-Z0-9]/g, '') : `prod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await esClient.index({ index: INDEX_NAME, id: docId, document: doc, refresh: 'wait_for' });
  console.log(`   ✅ مفهرس في ${INDEX_NAME} (id: ${docId})`);
  return docId;
}

async function main() {
  const { json, file } = parseArgs();
  if (!json && !file) {
    console.error('استخدام:');
    console.error('  node scripts/add-product.js --json \'{...}\'');
    console.error('  node scripts/add-product.js --file products.json');
    process.exit(1);
  }
  let data;
  if (file) {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    data = JSON.parse(json);
  }
  const rawList = Array.isArray(data) ? data : [data];
  const products = rawList.map(normalizeProduct);

  // تحقق
  for (let i = 0; i < products.length; i++) {
    const errs = validateProduct(products[i]);
    if (errs.length > 0) {
      console.error(`❌ المنتج ${i + 1}: ${errs.join('، ')}`);
      process.exit(1);
    }
  }

  console.log(`🎯 إضافة ${products.length} منتج إلى ${INDEX_NAME}\n`);
  const start = Date.now();

  for (const p of products) {
    try { await indexOne(p); }
    catch (e) { console.error(`❌ فشل: ${p.title} — ${e.message}`); }
  }

  await appendToCSV(products);

  console.log(`\n🎉 اكتمل في ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log('💡 ملاحظة: امسح الـ response cache لظهور المنتج الجديد فوراً في البحوث المخزّنة:');
  console.log('   curl -X POST http://localhost:5000/admin/clear-cache');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
