require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const { Client } = require('@elastic/elasticsearch');
const OpenAI = require('openai');
const { CohereClient } = require('cohere-ai');

// إعداد العملاء
const esClient = new Client({
  node: process.env.ELASTIC_ENDPOINT,
  auth: { apiKey: process.env.ELASTIC_API_KEY },
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const cohere = process.env.COHERE_API_KEY
  ? new CohereClient({ token: process.env.COHERE_API_KEY })
  : null;
const USE_COHERE = !!cohere;
const USE_LOCAL_EMBED = process.env.USE_LOCAL_EMBED === 'true';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'bge-m3';

const INDEX_NAME = process.env.INDEX_NAME || 'products';
const CSV_FILE = path.join(__dirname, '..', 'data', 'products.csv');
const MAX_PRODUCTS = 22000;
const BATCH_SIZE = USE_LOCAL_EMBED ? 32 : 96;
const EMBEDDING_BATCH = BATCH_SIZE;

const PROVIDER = USE_LOCAL_EMBED ? `Ollama/${OLLAMA_EMBED_MODEL} (1024-d)`
  : USE_COHERE ? 'Cohere (1024-d)' : 'OpenAI (1536-d)';
console.log(`📁 Target index: ${INDEX_NAME} | Embedding: ${PROVIDER}`);

// قراءة ملف CSV
function readCSV() {
  return new Promise((resolve, reject) => {
    const products = [];
    fs.createReadStream(CSV_FILE)
      .pipe(parse({ columns: true, skip_empty_lines: true }))
      .on('data', (row) => {
        // فقط المنتجات اللي عندها اسم وصورة
        if (row.title && row.image_link && row.title.trim() && row.image_link.trim()) {
         products.push({
  title: row.title.trim(),
  image_link: row.image_link.trim(),
  price: row.price || '',
  sale_price: row.sale_price || '',
  brand: row.brand || '',
  link: row.link || '',
  color: (row.color || '').trim(),
  size: (row.size || '').trim(),
});
        }
      })
      .on('end', () => resolve(products))
      .on('error', reject);
  });
}

// توليد embedding واحد عبر Ollama
async function ollamaEmbed(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`Ollama embed: HTTP ${res.status}`);
  const data = await res.json();
  return data.embedding;
}

// توليد embeddings — dispatch بين Ollama / Cohere / OpenAI
async function generateEmbeddings(texts) {
  if (USE_LOCAL_EMBED) {
    // Ollama لا يدعم batch endpoint، نسلسل النصوص
    const results = [];
    for (const t of texts) {
      results.push(await ollamaEmbed(t));
    }
    return results;
  }
  if (USE_COHERE) {
    const response = await cohere.embed({
      texts,
      model: 'embed-multilingual-v3.0',
      inputType: 'search_document',
    });
    return response.embeddings;
  }
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  });
  return response.data.map((item) => item.embedding);
}

// رفع دفعة من المنتجات إلى Elasticsearch (Bulk API)
async function bulkIndexProducts(products) {
  const body = products.flatMap((doc) => [
    { index: { _index: INDEX_NAME } },
    doc,
  ]);

  const response = await esClient.bulk({ refresh: false, operations: body });

  if (response.errors) {
    const errorCount = response.items.filter((item) => item.index.error).length;
    console.warn(`⚠️  ${errorCount} منتج فشل رفعه في هذه الدفعة`);
  }
}

// الدالة الرئيسية
async function main() {
  const startTime = Date.now();
  
  console.log('📂 قراءة ملف CSV...');
  const allProducts = await readCSV();
  console.log(`✅ تم قراءة ${allProducts.length} منتج من الملف`);
  
  const products = allProducts.slice(0, MAX_PRODUCTS);
  console.log(`🎯 سيتم فهرسة ${products.length} منتج`);
  console.log(`⏳ بدء المعالجة... (راح ياخذ حوالي 5-10 دقائق)\n`);

  let processed = 0;

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);
    
    try {
      // 1. توليد embeddings للأسماء (دفعة واحدة)
      const titles = batch.map((p) => p.title);
      const embeddings = await generateEmbeddings(titles);

      // 2. دمج المنتجات مع embeddings
      const productsWithEmbeddings = batch.map((product, idx) => ({
        ...product,
        embedding: embeddings[idx],
      }));

      // 3. رفع الدفعة إلى Elasticsearch
      await bulkIndexProducts(productsWithEmbeddings);

      processed += batch.length;
      const percentage = ((processed / products.length) * 100).toFixed(1);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`📊 ${processed}/${products.length} (${percentage}%) - ⏱️  ${elapsed}s`);

    } catch (error) {
      console.error(`❌ خطأ في الدفعة ${i / BATCH_SIZE + 1}:`, error.message);
      // ننتظر شوي ونكمل
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // refresh الـ index عشان النتائج تظهر فوراً
  await esClient.indices.refresh({ index: INDEX_NAME });

  // إحصائيات نهائية
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const count = await esClient.count({ index: INDEX_NAME });
  
  console.log(`\n🎉 اكتملت الفهرسة!`);
  console.log(`   ⏱️  الوقت الكلي: ${totalTime} ثانية (${(totalTime / 60).toFixed(1)} دقيقة)`);
  console.log(`   📦 إجمالي المنتجات في Elasticsearch: ${count.count}`);
  console.log(`   ✅ جاهز للبحث!`);
}

main().catch((err) => {
  console.error('❌ خطأ فادح:', err);
  process.exit(1);
});