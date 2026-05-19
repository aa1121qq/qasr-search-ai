require('dotenv').config();
const { Client } = require('@elastic/elasticsearch');

const esClient = new Client({
  node: process.env.ELASTIC_ENDPOINT,
  auth: { apiKey: process.env.ELASTIC_API_KEY },
});

const INDEX_NAME = process.env.INDEX_NAME || 'products';

async function addImageEmbeddingField() {
  console.log(`📁 Adding image_embedding field to: ${INDEX_NAME}`);
  try {
    await esClient.indices.putMapping({
      index: INDEX_NAME,
      properties: {
        image_embedding: {
          type: 'dense_vector',
          dims: 1536,
          index: true,
          similarity: 'cosine',
        },
      },
    });
    console.log('✅ image_embedding field added (1536-d, cosine)');
  } catch (e) {
    console.error('❌ Failed:', e.message);
    process.exit(1);
  }
}

addImageEmbeddingField();
