require('dotenv').config();
const { Client } = require('@elastic/elasticsearch');

const esClient = new Client({
  node: process.env.ELASTIC_ENDPOINT,
  auth: { apiKey: process.env.ELASTIC_API_KEY },
});

const INDEX_NAME = process.env.INDEX_NAME || 'products_local';

async function addClipField() {
  console.log(`📁 Adding clip_image_embedding (512-d) to: ${INDEX_NAME}`);
  try {
    await esClient.indices.putMapping({
      index: INDEX_NAME,
      properties: {
        clip_image_embedding: {
          type: 'dense_vector',
          dims: 512,
          index: true,
          similarity: 'cosine',
        },
      },
    });
    console.log('✅ clip_image_embedding field added');
  } catch (e) {
    console.error('❌ Failed:', e.message);
    process.exit(1);
  }
}

addClipField();
