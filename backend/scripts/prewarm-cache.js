require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');

const CSV_FILE = path.join(__dirname, '..', 'data', 'products.csv');
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5000';
const TOP_QUERIES = parseInt(process.env.PREWARM_TOP || '500', 10);
const STOPWORDS = new Set([
  'في', 'من', 'إلى', 'الى', 'على', 'عن', 'مع', 'هذا', 'هذه', 'ذلك',
  'و', 'أو', 'ال', 'الـ', 'أ', 'إ',
  // كلمات وحدات شائعة لا تصنع بحث مفيد
  'لتر', 'مل', 'كجم', 'كيلو', 'سم', 'مم', 'واط', 'قدم', 'مكان', 'برامج',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10',
]);

function tokenize(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[^؀-ۿa-z0-9\s-]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOPWORDS.has(w));
}

async function buildTopQueries() {
  const counter = new Map();
  return new Promise((resolve, reject) => {
    fs.createReadStream(CSV_FILE)
      .pipe(parse({ columns: true, skip_empty_lines: true }))
      .on('data', (row) => {
        const tokens = tokenize(row.title);
        // 1-gram
        for (const t of tokens) counter.set(t, (counter.get(t) || 0) + 1);
        // 2-gram
        for (let i = 0; i < tokens.length - 1; i++) {
          const bi = `${tokens[i]} ${tokens[i + 1]}`;
          counter.set(bi, (counter.get(bi) || 0) + 1);
        }
      })
      .on('end', () => {
        const sorted = [...counter.entries()].sort((a, b) => b[1] - a[1]);
        resolve(sorted.slice(0, TOP_QUERIES).map(([q]) => q));
      })
      .on('error', reject);
  });
}

async function prewarmOne(query) {
  const url = `${BACKEND_URL}/search?q=${encodeURIComponent(query)}&limit=500`;
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const elapsed = Date.now() - start;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.text();
    return elapsed;
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log(`📊 Building top queries from catalog...`);
  const queries = await buildTopQueries();
  console.log(`✅ ${queries.length} top queries identified`);
  console.log(`Examples (first 10):`, queries.slice(0, 10).join(' | '));
  console.log();

  console.log(`🔥 Pre-warming cache (${queries.length} queries, throttled)...`);
  let ok = 0, fail = 0, consecutiveFails = 0;
  const start = Date.now();
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    try {
      const ms = await prewarmOne(q);
      ok++; consecutiveFails = 0;
      const pct = (((i + 1) / queries.length) * 100).toFixed(1);
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      process.stdout.write(`\r📊 ${i + 1}/${queries.length} (${pct}%) | ✓${ok} ✗${fail} | last: ${ms}ms | total: ${elapsed}s`);
    } catch (e) {
      fail++; consecutiveFails++;
      console.error(`\n❌ ${q}: ${e.message}`);
      if (consecutiveFails >= 5) {
        console.log('⚠️  5 فشل متتالٍ — استراحة 30 ثانية لتجنّب rate limit...');
        await sleep(30000);
        consecutiveFails = 0;
      }
    }
    // throttle: 800ms بين الطلبات للأمان مع OpenAI
    await sleep(800);
  }
  console.log(`\n\n🎉 Pre-warm complete!`);
  console.log(`   ⏱️  ${((Date.now() - start) / 60000).toFixed(1)} minutes`);
  console.log(`   ✓ Cached: ${ok}`);
  console.log(`   ✗ Failed: ${fail}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
