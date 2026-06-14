require('dotenv').config();
const { Client } = require('@elastic/elasticsearch');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
  console.log('🚀 Loading CLIP (Xenova/clip-vit-base-patch32)...');
  _pipeline = await pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32');
  console.log('✅ CLIP loaded');
  return _pipeline;
}

async function fetchToBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}

async function embedFocused(imageUrl) {
  const featurer = await getPipeline();
  const buf = await fetchToBuffer(imageUrl);
  const meta = await sharp(buf).metadata();
  const side = Math.min(meta.width || 0, meta.height || 0);
  const tmpFull = path.join(os.tmpdir(), 'cfull-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.jpg');
  const tmpCenter = path.join(os.tmpdir(), 'ccenter-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.jpg');
  try {
    await sharp(buf).jpeg().toFile(tmpFull);
    let vCenter = null;
    if (side >= 64) {
      const cropSize = Math.floor(side * 0.6);
      const left = Math.floor(((meta.width || 0) - cropSize) / 2);
      const top = Math.floor(((meta.height || 0) - cropSize) / 2);
      await sharp(buf).extract({ left, top, width: cropSize, height: cropSize }).jpeg().toFile(tmpCenter);
      const outCenter = await featurer(tmpCenter);
      vCenter = Array.from(outCenter.data);
    }
    const outFull = await featurer(tmpFull);
    const vFull = Array.from(outFull.data);
    if (!vCenter) return vFull;  // صورة صغيرة جداً
    const blended = new Array(vFull.length);
    for (let i = 0; i < vFull.length; i++) blended[i] = 0.35 * vFull[i] + 0.65 * vCenter[i];
    let norm = 0;
    for (const x of blended) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < blended.length; i++) blended[i] /= norm;
    return blended;
  } finally {
    try { fs.unlinkSync(tmpFull); } catch {}
    try { fs.unlinkSync(tmpCenter); } catch {}
  }
}

async function main() {
  const start = Date.now();
  await getPipeline();

  const total = (await esClient.count({
    index: INDEX_NAME,
    query: { bool: { must_not: { exists: { field: 'clip_image_embedding_focused' } } } },
  })).count;
  console.log('🎯 Products without focused embedding:', total);
  if (total === 0) { console.log('Nothing to do!'); return; }

  let processed = 0, ok = 0, fail = 0;
  let resp = await esClient.search({
    index: INDEX_NAME,
    scroll: SCROLL_TIMEOUT,
    size: SCROLL_SIZE,
    _source: ['image_link'],
    query: { bool: { must_not: { exists: { field: 'clip_image_embedding_focused' } } } },
  });

  while (resp.hits.hits.length > 0) {
    for (const hit of resp.hits.hits) {
      const src = hit._source;
      processed++;
      if (!src.image_link) { fail++; continue; }
      try {
        const emb = await embedFocused(src.image_link);
        await esClient.update({
          index: INDEX_NAME,
          id: hit._id,
          doc: { clip_image_embedding_focused: emb },
        });
        ok++;
      } catch (e) {
        fail++;
        if (fail < 10) console.error('\n❌ ' + hit._id + ': ' + e.message);
      }
      const pct = ((processed / total) * 100).toFixed(1);
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      process.stdout.write('\r📊 ' + processed + '/' + total + ' (' + pct + '%) | ✓' + ok + ' ✗' + fail + ' | ' + elapsed + 's');
    }
    resp = await esClient.scroll({ scroll_id: resp._scroll_id, scroll: SCROLL_TIMEOUT });
  }

  console.log('\n\n🎉 Done!');
  console.log('   ⏱️  ' + ((Date.now() - start) / 60000).toFixed(1) + ' min');
  console.log('   ✓ ok:', ok);
  console.log('   ✗ fail:', fail);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
