require('dotenv').config();
const { Client } = require('@elastic/elasticsearch');

const esClient = new Client({
  node: process.env.ELASTIC_ENDPOINT,
  auth: {
    apiKey: process.env.ELASTIC_API_KEY,
  },
});

const INDEX_NAME = 'products';

async function createIndex() {
  try {
    // التحقق إذا كان الـ index موجود مسبقاً
    const exists = await esClient.indices.exists({ index: INDEX_NAME });

    if (exists) {
      console.log(`⚠️  الـ Index "${INDEX_NAME}" موجود مسبقاً. سيتم حذفه وإعادة إنشاؤه...`);
      await esClient.indices.delete({ index: INDEX_NAME });
      console.log(`🗑️  تم حذف الـ Index القديم.`);
    }

    // إنشاء index جديد
    await esClient.indices.create({
      index: INDEX_NAME,
      mappings: {
        properties: {
          title: { 
            type: 'text',
            analyzer: 'standard'
          },
          image_link: { type: 'keyword' },
          price: { type: 'keyword' },
          sale_price: { type: 'keyword' },
          brand: { type: 'keyword' },
          link: { type: 'keyword' },
          color: { type: 'keyword' },
          size: { type: 'keyword' },
          embedding: {
            type: 'dense_vector',
            dims: 1536,
            index: true,
            similarity: 'cosine'
          }
        }
      }
    });

    console.log(`✅ تم إنشاء Index "${INDEX_NAME}" بنجاح!`);
    console.log(`📋 الحقول:`);
    console.log(`   - title (اسم المنتج)`);
    console.log(`   - image_link (رابط الصورة)`);
    console.log(`   - price (السعر)`);
    console.log(`   - brand (العلامة التجارية)`);
    console.log(`   - link (رابط المنتج)`);
    console.log(`   - embedding (1536 dimension vector)`);

  } catch (error) {
    console.error('❌ خطأ:', error.message);
  }
}

createIndex();