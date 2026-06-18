/**
 * Apna Kamra — Bulk Import Script
 * ---------------------------------
 * Usage:
 *   1. Put your scraped listings array into data.json (same folder as this file)
 *   2. Set BASE_URL below to wherever your server is running (e.g. http://localhost:3000
 *      or https://apna-kamra.up.railway.app)
 *   3. Set CITY_NAME / CITY_FALLBACK below if you want everything to go into one city,
 *      or leave AUTO_DETECT_CITY = true to extract the city from each listing's "location" field
 *   4. Run:  node import-data.js
 *
 * What it does for each listing:
 *   - Skips adId, pageTitle, sourceUrl entirely
 *   - Extracts city + locality from "location" (e.g. "Galleria DLF-IV, GURGAON,HARYANA" -> city=Gurgaon, locality=Galleria DLF-IV)
 *   - Auto-detects which of our amenity tags apply (from the JSON amenities[] + description hashtags)
 *   - Downloads every image from its source URL and re-uploads it to your R2 bucket
 *   - Creates the property via your existing /api/properties endpoint (admin auth)
 *   - Leaves owner_name empty, price_double/price_triple empty (fill later in admin panel)
 *
 * It prints a clear log line per item, including the property number/slug it was saved as,
 * and a final summary of everything imported / skipped / failed.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// ---------------- CONFIG ----------------
const BASE_URL = 'http://localhost:3000';      // change to your deployed URL if needed
const ADMIN_MOBILE = '9983798590';
const ADMIN_PASS = 'passtemp';

const AUTO_DETECT_CITY = true;                  // extract city from "location" field
const FORCE_CITY_NAME = '';                     // if set, every item uses this city instead

const DATA_FILE = path.join(__dirname, 'data.json');

// ---------------- R2 CONFIG (same as server.js) ----------------
const R2_ACCOUNT_ID = '96a1a10ac8eb5b5ec6f47a5ea3882873';
const R2_ACCESS_KEY_ID = '40069aaf88203e813fa608762a8a8ee4';
const R2_SECRET_ACCESS_KEY = 'b29a65ed0eb4e841cff34edfaa5d4be5fad5e268fef54940c1f9a4038ac0a4fd';
const R2_BUCKET_NAME = 'lms';
const R2_PUBLIC_URL = 'https://pub-d97a4f82b1804020a1c6d95656eb5649.r2.dev';

// ---------------- AMENITY MAPPING ----------------
const AMENITIES = [
  "WiFi", "AC", "Power Backup", "Food/Meals", "Laundry", "Parking",
  "CCTV", "Geyser", "TV", "Fridge", "Housekeeping", "Attached Bathroom",
  "Lift", "Daily Cleaning"
];

const AMENITY_KEYWORDS = [
  { re: /\bwi[\s-]?fi\b/i, tag: 'WiFi' },
  { re: /(^|[^a-z])ac(\b|[^a-z])/i, tag: 'AC' },
  { re: /power\s*backup|powerbackup|inverter|generator/i, tag: 'Power Backup' },
  { re: /meals?\s*include\s*yes|hygienic\s*foods?|food|tiffin|meal/i, tag: 'Food/Meals' },
  { re: /laundry|washing[\s_]?machine|clotheswashing/i, tag: 'Laundry' },
  { re: /parking/i, tag: 'Parking' },
  { re: /cctv|security\s*camera/i, tag: 'CCTV' },
  { re: /geyser/i, tag: 'Geyser' },
  { re: /\bled\b|\btv\b|television/i, tag: 'TV' },
  { re: /fridge|refrigerator/i, tag: 'Fridge' },
  { re: /housekeeping|brooming|mopping|\bcleaning\b/i, tag: 'Housekeeping' },
  { re: /attached\s*bathroom|personal\s*bathroom/i, tag: 'Attached Bathroom' },
  { re: /\blift\b|elevator/i, tag: 'Lift' },
  { re: /daily\s*cleaning|regular\s*floor\s*cleaning|everyday\s*room\s*cleaning/i, tag: 'Daily Cleaning' },
];

function autoMapAmenities(item) {
  const text = [
    ...(Array.isArray(item.amenities) ? item.amenities : []),
    item.description || '',
    item.title || '',
    item.pageTitle || ''
  ].join(' ');
  const found = new Set();
  AMENITY_KEYWORDS.forEach(({ re, tag }) => { if (re.test(text)) found.add(tag); });
  if (/meals?\s*include\s*no/i.test(text)) found.delete('Food/Meals');
  return Array.from(found);
}

// "Galleria DLF-IV, GURGAON,HARYANA" -> { city: "Gurgaon", locality: "Galleria DLF-IV" }
// "Area, DELHI" -> { city: "Delhi", locality: "Area" }
function extractLocation(location) {
  if (!location) return { city: '', locality: '' };
  const parts = location.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return { city: '', locality: '' };
  if (parts.length === 1) return { city: titleCase(parts[0]), locality: '' };

  const last = parts[parts.length - 1].toUpperCase();
  const lastIsCityState = (last === 'DELHI' || last === 'NEW DELHI' || last === 'CHANDIGARH');

  let city, locality;
  if (lastIsCityState) {
    city = parts[parts.length - 1];
    locality = parts.slice(0, parts.length - 1).join(', ');
  } else {
    city = parts[parts.length - 2];
    locality = parts.slice(0, parts.length - 2).join(', ');
  }
  return { city: titleCase(city), locality };
}

function titleCase(s) {
  return String(s).replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.substr(1).toLowerCase());
}

function slugify(str) {
  return String(str).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ---------------- HTTP HELPERS ----------------
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchBuffer(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function apiRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + urlPath);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' }
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);

    const lib = url.protocol === 'https:' ? https : require('http');
    const req = lib.request(opts, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(chunks); } catch (e) { parsed = { raw: chunks }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---------------- R2 UPLOAD (native SigV4, same as server.js) ----------------
function sha256Hex(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }

function uploadToR2(key, buffer, contentType) {
  return new Promise((resolve, reject) => {
    const region = 'auto';
    const service = 's3';
    const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const payloadHash = sha256Hex(buffer);
    const canonicalUri = `/${R2_BUCKET_NAME}/${key}`;
    const canonicalHeaders =
      `content-type:${contentType}\n` +
      `host:${host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';

    const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

    const kDate = hmac('AWS4' + R2_SECRET_ACCESS_KEY, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, 'aws4_request');
    const signature = hmac(kSigning, stringToSign).toString('hex');

    const authorization = `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const options = {
      method: 'PUT',
      hostname: host,
      path: canonicalUri,
      headers: {
        'Content-Type': contentType,
        'Content-Length': buffer.length,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        'Authorization': authorization
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
        else reject(new Error(`R2 upload failed: ${res.statusCode} ${body}`));
      });
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

async function importImage(url) {
  const buf = await fetchBuffer(url);
  let ext = '.jpg';
  const m = url.split('?')[0].match(/\.[a-zA-Z0-9]+$/);
  if (m) ext = m[0].toLowerCase();
  let contentType = 'image/jpeg';
  if (ext === '.png') contentType = 'image/png';
  else if (ext === '.webp') contentType = 'image/webp';
  else if (ext === '.gif') contentType = 'image/gif';

  const key = `apnakamra/import/${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
  await uploadToR2(key, buf, contentType);
  return `${R2_PUBLIC_URL}/${key}`;
}

// ---------------- MAIN ----------------
async function main() {
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`❌ ${DATA_FILE} not found. Put your JSON array in data.json next to this script.`);
    process.exit(1);
  }

  const items = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!Array.isArray(items) || !items.length) {
    console.error('❌ data.json must contain a non-empty array of listings.');
    process.exit(1);
  }

  console.log(`Loaded ${items.length} listings from data.json`);
  console.log(`Target server: ${BASE_URL}\n`);

  // load existing cities once
  let cities = await apiRequest('GET', '/api/cities');
  const cityCache = new Map(cities.map(c => [c.name.toLowerCase(), c]));

  async function getOrCreateCity(name) {
    if (!name) name = 'Other';
    const key = name.toLowerCase();
    if (cityCache.has(key)) return cityCache.get(key);
    console.log(`   → city "${name}" not found, creating it...`);
    await apiRequest('POST', '/api/cities', {
      mobile: ADMIN_MOBILE, password: ADMIN_PASS, name, image: '', localities: []
    });
    cities = await apiRequest('GET', '/api/cities');
    const created = cities.find(c => c.name.toLowerCase() === key);
    cityCache.set(key, created);
    return created;
  }

  const results = { saved: [], failed: [], skipped: [] };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const num = i + 1;
    const name = item.name || item.title || `Untitled #${num}`;
    console.log(`\n[${num}/${items.length}] ${name}`);

    try {
      // ---- city/locality ----
      let cityName = FORCE_CITY_NAME;
      let locality = '';
      if (AUTO_DETECT_CITY && !FORCE_CITY_NAME) {
        const extracted = extractLocation(item.location || '');
        cityName = extracted.city || 'Other';
        locality = extracted.locality;
      }
      const city = await getOrCreateCity(cityName);
      console.log(`   city: ${city.name}  locality: ${locality || '(none)'}`);

      // ---- amenities ----
      const amenities = autoMapAmenities(item);
      console.log(`   amenities: ${amenities.join(', ') || '(none detected)'}`);

      // ---- images ----
      const srcImages = Array.isArray(item.images) ? item.images : [];
      const images = [];
      for (let j = 0; j < srcImages.length; j++) {
        const src = srcImages[j];
        try {
          process.stdout.write(`   image ${j + 1}/${srcImages.length}: downloading... `);
          const newUrl = await importImage(src);
          images.push(newUrl);
          console.log('done');
        } catch (e) {
          console.log('FAILED (' + e.message + ')');
        }
      }

      // ---- create property ----
      const payload = {
        mobile: ADMIN_MOBILE, password: ADMIN_PASS,
        name,
        city_id: city.id,
        owner_name: '',
        owner_mobile: item.phone || '',
        description: item.description || '',
        locality,
        map_link: item.mapLink || '',
        price_single: Number(item.price) || 0,
        price_double: 0,
        price_triple: 0,
        amenities,
        images,
        visible: 1
      };

      const res = await apiRequest('POST', '/api/properties', payload);
      console.log(`   ✅ SAVED as property #${res.id}  →  /property/${res.slug}`);
      results.saved.push({ num, name, id: res.id, slug: res.slug, images: images.length, totalImages: srcImages.length });

    } catch (e) {
      console.log(`   ❌ FAILED: ${e.message}`);
      results.failed.push({ num, name, error: e.message });
    }
  }

  // ---------------- SUMMARY ----------------
  console.log('\n' + '='.repeat(60));
  console.log('IMPORT SUMMARY');
  console.log('='.repeat(60));
  console.log(`Saved:   ${results.saved.length}`);
  console.log(`Failed:  ${results.failed.length}`);
  console.log('');

  if (results.saved.length) {
    console.log('Saved properties:');
    results.saved.forEach(r => {
      console.log(`  #${r.id}  ${r.name}  →  /property/${r.slug}  (images: ${r.images}/${r.totalImages})`);
    });
  }
  if (results.failed.length) {
    console.log('\nFailed items:');
    results.failed.forEach(r => {
      console.log(`  [${r.num}] ${r.name}  —  ${r.error}`);
    });
  }
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
