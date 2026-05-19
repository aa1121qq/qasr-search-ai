require('dotenv').config();
const { Client } = require('@elastic/elasticsearch');
const { CohereClient } = require('cohere-ai');

const esClient = new Client({
  node: process.env.ELASTIC_ENDPOINT,
  auth: { apiKey: process.env.ELASTIC_API_KEY },
});
const cohere = new CohereClient({ token: process.env.COHERE_API_KEY });

const INDEX_NAME = process.env.INDEX_NAME || 'products_cohere';
const CONCURRENCY = 1;            // حفاظاً على حد Cohere Trial (~100/min)
const SCROLL_SIZE = 100;          // أصغر = scroll context يبقى حي
const SCROLL_TIMEOUT = '30m';
const COHERE_MODEL = 'embed-v4.0';
const MAX_RETRIES = 4;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchImageAsDataUrl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  const mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
  const b64 = Buffer.from(buf).toString('base64');
  return `data:${mime};base64,${b64}`;
}

async function embedImage(dataUrl, retries = 0) {
  try {
    const response = await cohere.embed({
      model: COHERE_MODEL,
      inputType: 'image',
      embeddingTypes: ['float'],
      images: [dataUrl],
    });
    const float = response.embeddings?.float?.[0] || response.embeddings?.[0];
    if (!float) throw new Error('No embedding returned');
    return float;
  } catch (e) {
    const msg = String(e?.message || e);
    const is429 = msg.includes('429') || msg.includes('rate') || msg.includes('Too Many');
    if (is429 && retries < MAX_RETRIES) {
      const wait = Math.pow(2, retries) * 1000 + Math.random() * 500;
      await sleep(wait);
      return embedImage(dataUrl, retries + 1);
    }
    throw e;
  }
}

async function processProduct(hit) {
  const id = hit._id;
  const src = hit._source;
  if (!src.image_link) return { id, status: 'skip-no-url' };

  try {
    const dataUrl = await fetchImageAsDataUrl(src.image_link);
    const emb = await embedImage(dataUrl);
    await esClient.update({
      index: INDEX_NAME,
      id,
      doc: { image_embedding: emb },
    });
    return { id, status: 'ok' };
  } catch (e) {
    return { id, status: 'fail', error: e.message };
  }
}

async function main() {
  const start = Date.now();
  let processed = 0;
  let ok = 0, fail = 0, skip = 0;

  console.log(`📁 Index: ${INDEX_NAME} | Model: ${COHERE_MODEL} | Concurrency: ${CONCURRENCY}`);

  // عدد المنتجات اللي ما عندها image_embedding بعد
  const total = (await esClient.count({
    index: INDEX_NAME,
    query: { bool: { must_not: { exists: { field: 'image_embedding' } } } },
  })).count;
  console.log(`🎯 Products without image embedding: ${total}\n`);
  if (total === 0) { console.log('Nothing to do!'); return; }

  // scroll عبر كل المنتجات اللي تحتاج embedding
  let resp = await esClient.search({
    index: INDEX_NAME,
    scroll: SCROLL_TIMEOUT,
    size: SCROLL_SIZE,
    _source: ['image_link', 'title'],
    query: { bool: { must_not: { exists: { field: 'image_embedding' } } } },
  });

  while (resp.hits.hits.length > 0) {
    const hits = resp.hits.hits;
    // batch بـ CONCURRENCY متوازي
    for (let i = 0; i < hits.length; i += CONCURRENCY) {
      const batch = hits.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(processProduct));
      results.forEach(r => {
        if (r.status === 'ok') ok++;
        else if (r.status === 'fail') fail++;
        else skip++;
      });
      processed += batch.length;
      const pct = ((processed / total) * 100).toFixed(1);
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      process.stdout.write(`\r📊 ${processed}/${total} (${pct}%) | ✓${ok} ✗${fail} ⊘${skip} | ${elapsed}s`);
    }

    resp = await esClient.scroll({ scroll_id: resp._scroll_id, scroll: SCROLL_TIMEOUT });
  }

  console.log(`\n\n🎉 اكتمل!`);
  console.log(`   ⏱️  ${((Date.now() - start) / 60000).toFixed(1)} دقيقة`);
  console.log(`   ✓ نجاح: ${ok}`);
  console.log(`   ✗ فشل: ${fail}`);
  console.log(`   ⊘ تجاوز: ${skip}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
