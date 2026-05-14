require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const { Client } = require('@elastic/elasticsearch');
const OpenAI = require('openai');

// إعداد العملاء
const esClient = new Client({
  node: process.env.ELASTIC_ENDPOINT,
  auth: { apiKey: process.env.ELASTIC_API_KEY },
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const INDEX_NAME = 'products';
const CSV_FILE = path.join(__dirname, '..', 'data', 'products.csv');
const MAX_PRODUCTS = 22000; // عدد المنتجات اللي نبي نفهرسها
const BATCH_SIZE = 100;     // عدد المنتجات في كل دفعة
const EMBEDDING_BATCH = 100; // عدد النصوص في كل طلب OpenAI

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

// توليد embeddings من OpenAI (دفعة من النصوص)
async function generateEmbeddings(texts) {
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