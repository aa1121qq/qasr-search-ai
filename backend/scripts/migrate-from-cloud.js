require('dotenv').config();
const { Client } = require('@elastic/elasticsearch');

// Source: Elastic Cloud
const cloudClient = new Client({
  node: process.env.ELASTIC_ENDPOINT,
  auth: { apiKey: process.env.ELASTIC_API_KEY },
});
// Destination: Local Elasticsearch
const localClient = new Client({ node: 'http://localhost:9200' });

const SOURCE_INDEX = process.env.INDEX_NAME || 'products_local';
const DEST_INDEX = 'products_local';

async function main() {
  console.log('🔍 Source:', process.env.ELASTIC_ENDPOINT);
  console.log('🎯 Destination: http://localhost:9200');
  console.log('📦 Index:', SOURCE_INDEX, '->', DEST_INDEX);

  // 1) Get source mapping
  console.log('\n📋 Getting source mapping...');
  const mappingResp = await cloudClient.indices.getMapping({ index: SOURCE_INDEX });
  const mapping = mappingResp[SOURCE_INDEX].mappings;
  console.log('   Source has', Object.keys(mapping.properties).length, 'fields');

  // 2) Create destination index
  console.log('\n🏗️  Creating local index...');
  const exists = await localClient.indices.exists({ index: DEST_INDEX });
  if (exists) {
    console.log('   Index exists, deleting...');
    await localClient.indices.delete({ index: DEST_INDEX });
  }
  await localClient.indices.create({
    index: DEST_INDEX,
    settings: {
      number_of_shards: 1,
      number_of_replicas: 0,
    },
    mappings: mapping,
  });
  console.log('   ✅ Index created');

  // 3) Bulk migrate documents via scroll
  console.log('\n📥 Migrating documents...');
  const total = (await cloudClient.count({ index: SOURCE_INDEX })).count;
  console.log('   Total to migrate:', total);

  const start = Date.now();
  let processed = 0, ok = 0, fail = 0;
  const SCROLL = '30m';
  const SIZE = 100;

  let resp = await cloudClient.search({
    index: SOURCE_INDEX,
    scroll: SCROLL,
    size: SIZE,
    query: { match_all: {} },
  });

  while (resp.hits.hits.length > 0) {
    const ops = [];
    for (const hit of resp.hits.hits) {
      ops.push({ index: { _index: DEST_INDEX, _id: hit._id } });
      ops.push(hit._source);
    }
    try {
      const bulk = await localClient.bulk({ operations: ops, refresh: false });
      const errors = bulk.items.filter(i => i.index?.error);
      ok += bulk.items.length - errors.length;
      fail += errors.length;
      if (errors.length > 0 && fail < 5) console.error('   Errors:', errors.slice(0, 2).map(e => e.index.error.reason).join('; '));
    } catch (e) {
      fail += ops.length / 2;
      console.error('   Bulk failed:', e.message);
    }
    processed += resp.hits.hits.length;
    const pct = ((processed / total) * 100).toFixed(1);
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    process.stdout.write(`\r   📊 ${processed}/${total} (${pct}%) | ✓${ok} ✗${fail} | ${elapsed}s`);
    resp = await cloudClient.scroll({ scroll_id: resp._scroll_id, scroll: SCROLL });
  }

  // Refresh once
  await localClient.indices.refresh({ index: DEST_INDEX });
  const finalCount = (await localClient.count({ index: DEST_INDEX })).count;
  console.log(`\n\n🎉 Done! Final count: ${finalCount}`);
  console.log(`   ⏱️  ${((Date.now() - start) / 60000).toFixed(1)} min`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
