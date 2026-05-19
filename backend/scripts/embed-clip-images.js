require('dotenv').config();
const { Client } = require('@elastic/elasticsearch');

const esClient = new Client({
  node: process.env.ELASTIC_ENDPOINT,
  auth: { apiKey: process.env.ELASTIC_API_KEY },
});

const INDEX_NAME = process.env.INDEX_NAME || 'products_local';
const SCROLL_TIMEOUT = '30m';
const SCROLL_SIZE = 50;

let _pipeline = null;
async function getPipeline() {
  if (_pipeline) return _pipeline;
  const { pipeline, env } = await import('@xenova/transformers');
  env.cacheDir = './models-cache';
  console.log('🚀 Loading CLIP (Xenova/clip-vit-base-patch32, ~150MB)...');
  _pipeline = await pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32');
  console.log('✅ CLIP loaded\n');
  return _pipeline;
}

async function embedOne(imageUrl) {
  const p = await getPipeline();
  const result = await p(imageUrl);
  return Array.from(result.data);
}

async function main() {
  const start = Date.now();
  await getPipeline();

  const total = (await esClient.count({
    index: INDEX_NAME,
    query: { bool: { must_not: { exists: { field: 'clip_image_embedding' } } } },
  })).count;
  console.log(`🎯 Products without CLIP embedding: ${total}`);
  if (total === 0) { console.log('Nothing to do!'); return; }

  let processed = 0, ok = 0, fail = 0;
  let resp = await esClient.search({
    index: INDEX_NAME,
    scroll: SCROLL_TIMEOUT,
    size: SCROLL_SIZE,
    _source: ['image_link', 'title'],
    query: { bool: { must_not: { exists: { field: 'clip_image_embedding' } } } },
  });

  while (resp.hits.hits.length > 0) {
    for (const hit of resp.hits.hits) {
      const src = hit._source;
      processed++;
      if (!src.image_link) { fail++; continue; }
      try {
        const emb = await embedOne(src.image_link);
        await esClient.update({
          index: INDEX_NAME,
          id: hit._id,
          doc: { clip_image_embedding: emb },
        });
        ok++;
      } catch (e) {
        fail++;
        if (fail < 10) console.error(`\n❌ ${hit._id}: ${e.message}`);
      }
      const pct = ((processed / total) * 100).toFixed(1);
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      process.stdout.write(`\r📊 ${processed}/${total} (${pct}%) | ✓${ok} ✗${fail} | ${elapsed}s`);
    }
    resp = await esClient.scroll({ scroll_id: resp._scroll_id, scroll: SCROLL_TIMEOUT });
  }

  console.log(`\n\n🎉 اكتمل CLIP embedding!`);
  console.log(`   ⏱️  ${((Date.now() - start) / 60000).toFixed(1)} دقيقة`);
  console.log(`   ✓ نجاح: ${ok}`);
  console.log(`   ✗ فشل: ${fail}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
