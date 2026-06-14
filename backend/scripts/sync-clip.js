require('dotenv').config({ path: '/root/qasr/backend/.env.bak.cloud' });
const { Client } = require('@elastic/elasticsearch');

const cloudClient = new Client({
  node: process.env.ELASTIC_ENDPOINT,
  auth: { apiKey: process.env.ELASTIC_API_KEY },
});
const localClient = new Client({ node: 'http://localhost:9200' });

const INDEX = 'products_local';
const SCROLL = '30m';
const SIZE = 100;

async function main() {
  console.log('🎯 Syncing CLIP embeddings from Cloud → Local');
  const total = (await cloudClient.count({
    index: INDEX,
    query: { exists: { field: 'clip_image_embedding' } },
  })).count;
  console.log('Total to sync:', total);

  const start = Date.now();
  let processed = 0, ok = 0, fail = 0;

  let resp = await cloudClient.search({
    index: INDEX,
    scroll: SCROLL,
    size: SIZE,
    _source: ['clip_image_embedding', 'clip_image_embedding_focused'],
    query: { exists: { field: 'clip_image_embedding' } },
  });

  while (resp.hits.hits.length > 0) {
    const ops = [];
    for (const hit of resp.hits.hits) {
      const doc = {};
      if (hit._source.clip_image_embedding) doc.clip_image_embedding = hit._source.clip_image_embedding;
      if (hit._source.clip_image_embedding_focused) doc.clip_image_embedding_focused = hit._source.clip_image_embedding_focused;
      if (Object.keys(doc).length > 0) {
        ops.push({ update: { _index: INDEX, _id: hit._id } });
        ops.push({ doc });
      }
    }
    if (ops.length > 0) {
      try {
        const bulk = await localClient.bulk({ operations: ops, refresh: false });
        const errors = bulk.items.filter(i => i.update?.error);
        ok += bulk.items.length - errors.length;
        fail += errors.length;
        if (errors.length > 0 && fail < 5) console.error('Err:', errors[0].update.error.reason);
      } catch (e) {
        fail += ops.length / 2;
        console.error('Bulk fail:', e.message);
      }
    }
    processed += resp.hits.hits.length;
    const pct = ((processed / total) * 100).toFixed(1);
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    process.stdout.write(`\r📊 ${processed}/${total} (${pct}%) | ✓${ok} ✗${fail} | ${elapsed}s`);
    resp = await cloudClient.scroll({ scroll_id: resp._scroll_id, scroll: SCROLL });
  }

  await localClient.indices.refresh({ index: INDEX });
  const finalCount = (await localClient.count({
    index: INDEX,
    query: { exists: { field: 'clip_image_embedding' } },
  })).count;
  console.log(`\n\n🎉 Done! ${finalCount} products now have clip embeddings`);
  console.log(`   Time: ${((Date.now() - start) / 1000).toFixed(0)}s`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
