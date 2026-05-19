// إضافة حقول التصنيف للفهرس: product_kind + product_tags + product_subtype + seasonal
require('dotenv').config();
const { Client } = require('@elastic/elasticsearch');

const esClient = new Client({
  node: process.env.ELASTIC_ENDPOINT,
  auth: { apiKey: process.env.ELASTIC_API_KEY },
});

const INDEX_NAME = process.env.INDEX_NAME || 'products_local';

async function main() {
  console.log(`📁 إضافة حقول التصنيف إلى ${INDEX_NAME}`);
  await esClient.indices.putMapping({
    index: INDEX_NAME,
    properties: {
      product_kind: { type: 'keyword' },        // appliance / accessory / cookware / serveware / kitchen_tool / storage / consumable / furniture / bath / decor
      product_subtype: { type: 'keyword' },     // split_ac / refrigerator_2door / air_fryer / ...
      product_tags: { type: 'keyword' },        // array من tags إضافية
      product_material: { type: 'keyword' },    // steel / glass / plastic / ceramic / wood / granite / melamine
      product_seasonal: { type: 'keyword' },    // summer / winter / ramadan / school / wedding / null
      tagged_at: { type: 'date' },              // متى صُنّف
    },
  });
  console.log('✅ تم. الحقول الجديدة:');
  console.log('   - product_kind, product_subtype, product_tags');
  console.log('   - product_material, product_seasonal, tagged_at');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
