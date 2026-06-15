const express = require('express');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');
const multer = require('multer');
const { createClient } = require('@libsql/client');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ---------------- CONFIG (hardcoded as requested) ----------------
const ADMIN_MOBILE = '9983798590';
const ADMIN_PASS = 'passtemp';

const R2_ACCOUNT_ID = '96a1a10ac8eb5b5ec6f47a5ea3882873';
const R2_ACCESS_KEY_ID = '40069aaf88203e813fa608762a8a8ee4';
const R2_SECRET_ACCESS_KEY = 'b29a65ed0eb4e841cff34edfaa5d4be5fad5e268fef54940c1f9a4038ac0a4fd';
const R2_BUCKET_NAME = 'lms';
const R2_PUBLIC_URL = 'https://pub-d97a4f82b1804020a1c6d95656eb5649.r2.dev';

const TURSO_DATABASE_URL = 'file:lms.db';
const TURSO_AUTH_TOKEN = undefined;

// ---------------- DATABASE (Turso / libSQL) ----------------
const db = createClient({
  url: TURSO_DATABASE_URL,
  authToken: TURSO_AUTH_TOKEN,
});

async function initDatabase() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS cities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      image TEXT DEFAULT '',
      localities TEXT DEFAULT '[]'
    )`,
    `CREATE TABLE IF NOT EXISTS owners (
      mobile TEXT PRIMARY KEY,
      password TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS admins (
      mobile TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      created_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS properties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      city_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      owner_name TEXT DEFAULT '',
      owner_mobile TEXT DEFAULT '',
      description TEXT DEFAULT '',
      locality TEXT DEFAULT '',
      map_link TEXT DEFAULT '',
      price_single INTEGER DEFAULT 0,
      price_double INTEGER DEFAULT 0,
      price_triple INTEGER DEFAULT 0,
      amenities TEXT DEFAULT '[]',
      images TEXT DEFAULT '[]',
      views INTEGER DEFAULT 0,
      visible INTEGER DEFAULT 1,
      created_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT DEFAULT '',
      mobile TEXT NOT NULL,
      message TEXT DEFAULT '',
      created_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )`,
  ], 'write');

  // migrations for existing databases (ignore errors if column already exists)
  const migrations = [
    'ALTER TABLE cities ADD COLUMN localities TEXT DEFAULT \'[]\'',
    'ALTER TABLE properties ADD COLUMN locality TEXT DEFAULT \'\'',
    'ALTER TABLE properties ADD COLUMN map_link TEXT DEFAULT \'\''
  ];
  for (const sql of migrations) {
    try { await db.execute(sql); } catch (e) { /* column likely already exists */ }
  }

  console.log('✅ Turso database initialized');
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ---- Native AWS SigV4 PUT to Cloudflare R2 (no SDK dependency) ----
function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

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

    const canonicalRequest = [
      'PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)
    ].join('\n');

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
      res.on('data', (c) => body += c);
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

function r2Request(method, key, buffer) {
  return new Promise((resolve, reject) => {
    const region = 'auto';
    const service = 's3';
    const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const payload = buffer || Buffer.alloc(0);
    const payloadHash = sha256Hex(payload);
    const canonicalUri = `/${R2_BUCKET_NAME}/${key}`;
    const contentType = 'application/json';

    let canonicalHeaders, signedHeaders;
    if (method === 'PUT') {
      canonicalHeaders =
        `content-type:${contentType}\n` +
        `host:${host}\n` +
        `x-amz-content-sha256:${payloadHash}\n` +
        `x-amz-date:${amzDate}\n`;
      signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
    } else {
      canonicalHeaders =
        `host:${host}\n` +
        `x-amz-content-sha256:${payloadHash}\n` +
        `x-amz-date:${amzDate}\n`;
      signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    }

    const canonicalRequest = [
      method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)
    ].join('\n');

    const kDate = hmac('AWS4' + R2_SECRET_ACCESS_KEY, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, 'aws4_request');
    const signature = hmac(kSigning, stringToSign).toString('hex');

    const authorization = `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const headers = {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'Authorization': authorization
    };
    if (method === 'PUT') {
      headers['Content-Type'] = contentType;
      headers['Content-Length'] = payload.length;
    }

    const options = { method, hostname: host, path: canonicalUri, headers };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else reject(new Error(`R2 ${method} failed: ${res.statusCode} ${body.toString()}`));
      });
    });
    req.on('error', reject);
    if (method === 'PUT') req.write(payload);
    req.end();
  });
}

function getFromR2(key) {
  return r2Request('GET', key, null);
}
function putToR2(key, buffer) {
  return r2Request('PUT', key, buffer);
}

// ---- List objects in R2 bucket (signed ListObjectsV2) ----
function listR2(prefix) {
  return new Promise((resolve, reject) => {
    const region = 'auto';
    const service = 's3';
    const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(Buffer.alloc(0));

    const queryParams = { 'list-type': '2', 'prefix': prefix, 'max-keys': '200' };
    const canonicalQueryString = Object.keys(queryParams).sort()
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
      .join('&');

    const canonicalUri = `/${R2_BUCKET_NAME}`;
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

    const canonicalRequest = [
      'GET', canonicalUri, canonicalQueryString, canonicalHeaders, signedHeaders, payloadHash
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

    const kDate = hmac('AWS4' + R2_SECRET_ACCESS_KEY, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, 'aws4_request');
    const signature = hmac(kSigning, stringToSign).toString('hex');

    const authorization = `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const options = {
      method: 'GET',
      hostname: host,
      path: `${canonicalUri}?${canonicalQueryString}`,
      headers: {
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        'Authorization': authorization
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`R2 list failed: ${res.statusCode} ${body}`));
        const items = [];
        const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
        let m;
        while ((m = contentsRegex.exec(body))) {
          const block = m[1];
          const key = (block.match(/<Key>(.*?)<\/Key>/) || [])[1];
          const size = (block.match(/<Size>(.*?)<\/Size>/) || [])[1];
          const lastModified = (block.match(/<LastModified>(.*?)<\/LastModified>/) || [])[1];
          if (key) items.push({ key, size: Number(size) || 0, last_modified: lastModified });
        }
        resolve(items);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function checkAuth(mobile, password) {
  if (mobile === ADMIN_MOBILE && password === ADMIN_PASS) return 'super';
  if (!mobile || !password) return null;
  const a = await db.execute({
    sql: 'SELECT * FROM admins WHERE mobile=? AND password=?',
    args: [mobile, password]
  });
  if (a.rows.length) return 'admin';
  const r = await db.execute({
    sql: 'SELECT * FROM owners WHERE mobile=? AND password=?',
    args: [mobile, password]
  });
  if (r.rows.length) return 'owner';
  return null;
}

// 'super' = hardcoded main admin (full access incl. backups & sub-admin management)
// 'admin' = sub-admin (everything except backups & sub-admin management)
function isAdminRole(role) {
  return role === 'super' || role === 'admin';
}

// ---- fetch a URL's body as a Buffer (used to download backups from R2) ----
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`Fetch failed: ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// ---------------- BACKUP / RESTORE (logical JSON dump to R2) ----------------
const BACKUP_KEY = 'apnakamra-backups/latest.json';

async function exportAllData() {
  const [cities, owners, admins, properties, leads] = await Promise.all([
    db.execute('SELECT * FROM cities'),
    db.execute('SELECT * FROM owners'),
    db.execute('SELECT * FROM admins'),
    db.execute('SELECT * FROM properties'),
    db.execute('SELECT * FROM leads'),
  ]);
  return {
    exported_at: Date.now(),
    cities: cities.rows,
    owners: owners.rows,
    admins: admins.rows,
    properties: properties.rows,
    leads: leads.rows,
  };
}

async function backupNow() {
  const data = await exportAllData();
  const buf = Buffer.from(JSON.stringify(data, null, 2));
  // overwrite latest.json directly via signed R2 API (always fresh, no CDN cache issues)
  await putToR2(BACKUP_KEY, buf);
  await putToR2(`apnakamra-backups/history/${data.exported_at}.json`, buf);
  await db.execute({
    sql: `INSERT INTO meta (key, value) VALUES ('last_backup_at', ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    args: [String(data.exported_at)]
  });
  return data.exported_at;
}

async function restoreFromBackup(key) {
  const backupKey = key || BACKUP_KEY;
  let buf;
  try {
    buf = await getFromR2(backupKey);
  } catch (e) {
    throw new Error('No backup found on R2 yet. Click "Backup Now" first, then restore can be used after data loss.');
  }
  const data = JSON.parse(buf.toString('utf8'));

  const statements = [
    'DELETE FROM cities', 'DELETE FROM owners', 'DELETE FROM admins', 'DELETE FROM properties', 'DELETE FROM leads'
  ];
  await db.batch(statements, 'write');

  const inserts = [];
  for (const c of data.cities || []) {
    inserts.push({ sql: 'INSERT INTO cities (id,name,slug,image,localities) VALUES (?,?,?,?,?)', args: [c.id, c.name, c.slug, c.image, c.localities || '[]'] });
  }
  for (const o of data.owners || []) {
    inserts.push({ sql: 'INSERT INTO owners (mobile,password) VALUES (?,?)', args: [o.mobile, o.password] });
  }
  for (const a of data.admins || []) {
    inserts.push({ sql: 'INSERT INTO admins (mobile,password,created_at) VALUES (?,?,?)', args: [a.mobile, a.password, a.created_at] });
  }
  for (const p of data.properties || []) {
    inserts.push({
      sql: `INSERT INTO properties (id,slug,city_id,name,owner_name,owner_mobile,description,locality,map_link,
              price_single,price_double,price_triple,amenities,images,views,visible,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [p.id, p.slug, p.city_id, p.name, p.owner_name, p.owner_mobile, p.description, p.locality || '', p.map_link || '',
        p.price_single, p.price_double, p.price_triple, p.amenities, p.images, p.views, p.visible, p.created_at]
    });
  }
  for (const l of data.leads || []) {
    inserts.push({ sql: 'INSERT INTO leads (id,name,mobile,message,created_at) VALUES (?,?,?,?,?)', args: [l.id, l.name, l.mobile, l.message, l.created_at] });
  }
  if (inserts.length) await db.batch(inserts, 'write');

  return data.exported_at;
}

function slugify(str) {
  return String(str).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function rowToProperty(r) {
  let amenities = [];
  let images = [];
  try { amenities = JSON.parse(r.amenities || '[]'); } catch (e) {}
  try { images = JSON.parse(r.images || '[]'); } catch (e) {}
  const prices = [r.price_single, r.price_double, r.price_triple].filter(v => v && v > 0);
  const lowest_price = prices.length ? Math.min(...prices) : 0;
  return { ...r, amenities, images, lowest_price };
}

function asyncHandler(fn) {
  return (req, res) => fn(req, res).catch(err => {
    console.error(err);
    res.status(500).json({ error: err.message || 'server error' });
  });
}

// ---------------- AUTH ----------------
app.post('/api/admin/login', asyncHandler(async (req, res) => {
  const { mobile, password } = req.body;
  const role = await checkAuth(mobile, password);
  if (!isAdminRole(role)) return res.status(401).json({ ok: false, error: 'Invalid credentials' });
  res.json({ ok: true, role });
}));

app.post('/api/owner/login', asyncHandler(async (req, res) => {
  const { mobile, password } = req.body;
  const r = await db.execute({ sql: 'SELECT * FROM owners WHERE mobile=? AND password=?', args: [mobile, password] });
  if (!r.rows.length) return res.status(401).json({ ok: false, error: 'Invalid credentials' });
  res.json({ ok: true });
}));

// ---------------- UPLOAD (R2) ----------------
app.post('/api/upload', upload.single('file'), asyncHandler(async (req, res) => {
  const { mobile, password } = req.query;
  if (!(await checkAuth(mobile, password))) return res.status(401).json({ error: 'unauthorized' });
  if (!req.file) return res.status(400).json({ error: 'no file' });

  const extMatch = req.file.originalname.match(/\.[a-zA-Z0-9]+$/);
  const ext = extMatch ? extMatch[0] : '.jpg';
  const key = `apnakamra/${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;

  try {
    await uploadToR2(key, req.file.buffer, req.file.mimetype);
    res.json({ url: `${R2_PUBLIC_URL}/${key}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'upload failed', detail: e.message });
  }
}));

// ---------------- CITIES ----------------
app.get('/api/cities', asyncHandler(async (req, res) => {
  const r = await db.execute('SELECT * FROM cities ORDER BY name');
  res.json(r.rows.map(c => ({ ...c, localities: (() => { try { return JSON.parse(c.localities || '[]'); } catch (e) { return []; } })() })));
}));

app.post('/api/cities', asyncHandler(async (req, res) => {
  const { mobile, password, name, image, localities } = req.body;
  if (!isAdminRole(await checkAuth(mobile, password))) return res.status(401).json({ error: 'unauthorized' });
  if (!name) return res.status(400).json({ error: 'name required' });
  const slug = slugify(name);
  const existing = await db.execute({ sql: 'SELECT id FROM cities WHERE slug=?', args: [slug] });
  if (existing.rows.length) return res.status(400).json({ error: 'city already exists' });
  await db.execute({ sql: 'INSERT INTO cities (name, slug, image, localities) VALUES (?,?,?,?)', args: [name, slug, image || '', JSON.stringify(localities || [])] });
  res.json({ ok: true });
}));

app.put('/api/cities/:id', asyncHandler(async (req, res) => {
  const { mobile, password, name, image, localities } = req.body;
  if (!isAdminRole(await checkAuth(mobile, password))) return res.status(401).json({ error: 'unauthorized' });
  const existing = await db.execute({ sql: 'SELECT * FROM cities WHERE id=?', args: [req.params.id] });
  if (!existing.rows.length) return res.status(404).json({ error: 'not found' });
  const city = existing.rows[0];
  const newName = name !== undefined ? name : city.name;
  const newSlug = name !== undefined ? slugify(name) : city.slug;
  const newImage = image !== undefined ? image : city.image;
  const newLocalities = localities !== undefined ? JSON.stringify(localities) : city.localities;
  await db.execute({ sql: 'UPDATE cities SET name=?, slug=?, image=?, localities=? WHERE id=?', args: [newName, newSlug, newImage, newLocalities, req.params.id] });
  res.json({ ok: true });
}));

app.delete('/api/cities/:id', asyncHandler(async (req, res) => {
  const { mobile, password } = req.query;
  if (!isAdminRole(await checkAuth(mobile, password))) return res.status(401).json({ error: 'unauthorized' });
  await db.execute({ sql: 'DELETE FROM cities WHERE id=?', args: [req.params.id] });
  res.json({ ok: true });
}));

// ---------------- PROPERTIES (public) ----------------
app.get('/api/properties', asyncHandler(async (req, res) => {
  const { city, minPrice, maxPrice, amenities, sort, q, locality } = req.query;

  const r = await db.execute(`
    SELECT p.*, c.name as city_name, c.slug as city_slug
    FROM properties p JOIN cities c ON c.id = p.city_id
    WHERE p.visible = 1
  `);
  let rows = r.rows.map(rowToProperty);

  if (city) rows = rows.filter(row => row.city_slug === city);
  if (q) {
    const ql = q.toLowerCase();
    rows = rows.filter(row => row.name.toLowerCase().includes(ql));
  }
  if (minPrice) rows = rows.filter(row => row.lowest_price >= Number(minPrice));
  if (maxPrice) rows = rows.filter(row => row.lowest_price > 0 && row.lowest_price <= Number(maxPrice));

  if (amenities) {
    const need = amenities.split(',').filter(Boolean);
    rows = rows.filter(row => need.every(a => row.amenities.includes(a)));
  }

  if (locality) {
    const need = locality.split(',').filter(Boolean);
    rows = rows.filter(row => need.includes(row.locality || 'Other'));
  }

  if (sort === 'price_asc') rows.sort((a, b) => (a.lowest_price || 999999) - (b.lowest_price || 999999));
  else if (sort === 'price_desc') rows.sort((a, b) => b.lowest_price - a.lowest_price);
  else if (sort === 'popular') rows.sort((a, b) => b.views - a.views);
  else rows.sort((a, b) => b.created_at - a.created_at);

  rows = rows.map(({ owner_mobile, ...rest }) => rest);
  res.json(rows);
}));

app.get('/api/properties/:slug', asyncHandler(async (req, res) => {
  const r = await db.execute({
    sql: `SELECT p.*, c.name as city_name, c.slug as city_slug
          FROM properties p JOIN cities c ON c.id = p.city_id
          WHERE p.slug = ?`,
    args: [req.params.slug]
  });
  if (!r.rows.length) return res.status(404).json({ error: 'not found' });
  const { owner_mobile, ...rest } = rowToProperty(r.rows[0]);
  res.json(rest);
}));

app.get('/api/properties/:slug/contact', asyncHandler(async (req, res) => {
  const r = await db.execute({ sql: 'SELECT owner_mobile, owner_name FROM properties WHERE slug=?', args: [req.params.slug] });
  if (!r.rows.length) return res.status(404).json({ error: 'not found' });
  res.json({ owner_mobile: r.rows[0].owner_mobile, owner_name: r.rows[0].owner_name });
}));

// ---------------- PROPERTIES (admin / owner write) ----------------
app.post('/api/properties', asyncHandler(async (req, res) => {
  const { mobile, password, ...d } = req.body;
  if (!isAdminRole(await checkAuth(mobile, password))) return res.status(401).json({ error: 'unauthorized' });
  if (!d.name || !d.city_id) return res.status(400).json({ error: 'name and city required' });

  let baseSlug = slugify(d.slug || d.name);
  let slug = baseSlug;
  let i = 1;
  while ((await db.execute({ sql: 'SELECT id FROM properties WHERE slug=?', args: [slug] })).rows.length) {
    slug = `${baseSlug}-${i++}`;
  }

  const result = await db.execute({
    sql: `INSERT INTO properties (slug, city_id, name, owner_name, owner_mobile, description, locality, map_link,
            price_single, price_double, price_triple, amenities, images, views, visible, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    args: [
      slug, Number(d.city_id), d.name, d.owner_name || '', d.owner_mobile || '', d.description || '',
      d.locality || '', d.map_link || '',
      Number(d.price_single) || 0, Number(d.price_double) || 0, Number(d.price_triple) || 0,
      JSON.stringify(d.amenities || []), JSON.stringify(d.images || []),
      d.visible === undefined ? 1 : Number(d.visible), Date.now()
    ]
  });
  res.json({ ok: true, id: Number(result.lastInsertRowid), slug });
}));

app.put('/api/properties/:id', asyncHandler(async (req, res) => {
  const { mobile, password, ...d } = req.body;
  const role = await checkAuth(mobile, password);
  if (!role) return res.status(401).json({ error: 'unauthorized' });

  const existing = await db.execute({ sql: 'SELECT * FROM properties WHERE id=?', args: [req.params.id] });
  if (!existing.rows.length) return res.status(404).json({ error: 'not found' });
  const prop = existing.rows[0];
  if (role === 'owner' && prop.owner_mobile !== mobile) return res.status(403).json({ error: 'forbidden' });

  const sets = [];
  const args = [];
  const simpleFields = ['name', 'owner_name', 'description', 'price_single', 'price_double', 'price_triple', 'locality', 'map_link'];
  simpleFields.forEach(f => {
    if (d[f] !== undefined) {
      sets.push(`${f}=?`);
      args.push(f.startsWith('price_') ? (Number(d[f]) || 0) : d[f]);
    }
  });
  if (d.amenities !== undefined) { sets.push('amenities=?'); args.push(JSON.stringify(d.amenities)); }
  if (d.images !== undefined) { sets.push('images=?'); args.push(JSON.stringify(d.images)); }

  if (isAdminRole(role)) {
    if (d.owner_mobile !== undefined) { sets.push('owner_mobile=?'); args.push(d.owner_mobile); }
    if (d.city_id !== undefined) { sets.push('city_id=?'); args.push(Number(d.city_id)); }
    if (d.visible !== undefined) { sets.push('visible=?'); args.push(Number(d.visible)); }
    if (d.views !== undefined) { sets.push('views=?'); args.push(Number(d.views) || 0); }
  }

  if (!sets.length) return res.json({ ok: true });
  args.push(req.params.id);
  await db.execute({ sql: `UPDATE properties SET ${sets.join(', ')} WHERE id=?`, args });
  res.json({ ok: true });
}));

app.delete('/api/properties/:id', asyncHandler(async (req, res) => {
  const { mobile, password } = req.query;
  if (!isAdminRole(await checkAuth(mobile, password))) return res.status(401).json({ error: 'unauthorized' });
  await db.execute({ sql: 'DELETE FROM properties WHERE id=?', args: [req.params.id] });
  res.json({ ok: true });
}));

// ---------------- OWNER PANEL ----------------
app.get('/api/owner/properties', asyncHandler(async (req, res) => {
  const { mobile, password } = req.query;
  if ((await checkAuth(mobile, password)) !== 'owner') return res.status(401).json({ error: 'unauthorized' });
  const r = await db.execute({
    sql: `SELECT p.*, c.name as city_name FROM properties p JOIN cities c ON c.id=p.city_id
          WHERE p.owner_mobile=? ORDER BY p.created_at DESC`,
    args: [mobile]
  });
  res.json(r.rows.map(rowToProperty));
}));

// ---------------- ADMIN PANEL ----------------
app.get('/api/admin/properties', asyncHandler(async (req, res) => {
  const { mobile, password } = req.query;
  if (!isAdminRole(await checkAuth(mobile, password))) return res.status(401).json({ error: 'unauthorized' });
  const r = await db.execute(`
    SELECT p.*, c.name as city_name FROM properties p JOIN cities c ON c.id=p.city_id
    ORDER BY p.created_at DESC
  `);
  res.json(r.rows.map(rowToProperty));
}));

app.get('/api/admin/owners', asyncHandler(async (req, res) => {
  const { mobile, password } = req.query;
  if (!isAdminRole(await checkAuth(mobile, password))) return res.status(401).json({ error: 'unauthorized' });
  const r = await db.execute('SELECT mobile FROM owners ORDER BY mobile');
  res.json(r.rows);
}));

app.post('/api/admin/owners', asyncHandler(async (req, res) => {
  const { mobile, password, new_mobile, new_password } = req.body;
  if (!isAdminRole(await checkAuth(mobile, password))) return res.status(401).json({ error: 'unauthorized' });
  if (!new_mobile || !new_password) return res.status(400).json({ error: 'mobile and password required' });
  const existing = await db.execute({ sql: 'SELECT mobile FROM owners WHERE mobile=?', args: [new_mobile] });
  if (existing.rows.length) return res.status(400).json({ error: 'owner already exists' });
  await db.execute({ sql: 'INSERT INTO owners (mobile, password) VALUES (?,?)', args: [new_mobile, new_password] });
  res.json({ ok: true });
}));

app.delete('/api/admin/owners/:mobile', asyncHandler(async (req, res) => {
  const { mobile, password } = req.query;
  if (!isAdminRole(await checkAuth(mobile, password))) return res.status(401).json({ error: 'unauthorized' });
  await db.execute({ sql: 'DELETE FROM owners WHERE mobile=?', args: [req.params.mobile] });
  res.json({ ok: true });
}));

// ---------------- SUB-ADMINS (managed only by the main super admin) ----------------
app.get('/api/admin/subadmins', asyncHandler(async (req, res) => {
  const { mobile, password } = req.query;
  if ((await checkAuth(mobile, password)) !== 'super') return res.status(401).json({ error: 'unauthorized' });
  const r = await db.execute('SELECT mobile, created_at FROM admins ORDER BY created_at DESC');
  res.json(r.rows);
}));

app.post('/api/admin/subadmins', asyncHandler(async (req, res) => {
  const { mobile, password, new_mobile, new_password } = req.body;
  if ((await checkAuth(mobile, password)) !== 'super') return res.status(401).json({ error: 'unauthorized' });
  if (!new_mobile || !new_password) return res.status(400).json({ error: 'mobile and password required' });
  if (new_mobile === ADMIN_MOBILE) return res.status(400).json({ error: 'cannot override the main super admin' });
  const existing = await db.execute({ sql: 'SELECT mobile FROM admins WHERE mobile=?', args: [new_mobile] });
  if (existing.rows.length) return res.status(400).json({ error: 'admin already exists' });
  await db.execute({ sql: 'INSERT INTO admins (mobile, password, created_at) VALUES (?,?,?)', args: [new_mobile, new_password, Date.now()] });
  res.json({ ok: true });
}));

app.delete('/api/admin/subadmins/:mobile', asyncHandler(async (req, res) => {
  const { mobile, password } = req.query;
  if ((await checkAuth(mobile, password)) !== 'super') return res.status(401).json({ error: 'unauthorized' });
  await db.execute({ sql: 'DELETE FROM admins WHERE mobile=?', args: [req.params.mobile] });
  res.json({ ok: true });
}));

// ---------------- IMPRESSIONS ----------------
app.post('/api/impressions', asyncHandler(async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.json({ ok: true });
  const statements = ids
    .filter(id => Number.isInteger(id) || /^\d+$/.test(id))
    .map(id => ({ sql: 'UPDATE properties SET views = views + 1 WHERE id = ?', args: [Number(id)] }));
  if (statements.length) await db.batch(statements, 'write');
  res.json({ ok: true });
}));

// ---------------- LEADS ----------------
app.post('/api/leads', asyncHandler(async (req, res) => {
  const { name, mobile, message } = req.body;
  if (!mobile) return res.status(400).json({ error: 'mobile required' });
  await db.execute({
    sql: 'INSERT INTO leads (name, mobile, message, created_at) VALUES (?,?,?,?)',
    args: [name || '', mobile, message || '', Date.now()]
  });
  res.json({ ok: true });
}));

app.get('/api/admin/leads', asyncHandler(async (req, res) => {
  const { mobile, password } = req.query;
  if (!isAdminRole(await checkAuth(mobile, password))) return res.status(401).json({ error: 'unauthorized' });
  const r = await db.execute('SELECT * FROM leads ORDER BY created_at DESC');
  res.json(r.rows);
}));

app.delete('/api/admin/leads/:id', asyncHandler(async (req, res) => {
  const { mobile, password } = req.query;
  if (!isAdminRole(await checkAuth(mobile, password))) return res.status(401).json({ error: 'unauthorized' });
  await db.execute({ sql: 'DELETE FROM leads WHERE id=?', args: [req.params.id] });
  res.json({ ok: true });
}));

// ---------------- BACKUP / RESTORE ----------------
app.get('/api/admin/backup-status', asyncHandler(async (req, res) => {
  const { mobile, password } = req.query;
  if ((await checkAuth(mobile, password)) !== 'super') return res.status(401).json({ error: 'unauthorized' });
  const r = await db.execute({ sql: "SELECT value FROM meta WHERE key='last_backup_at'", args: [] });
  res.json({ last_backup_at: r.rows.length ? Number(r.rows[0].value) : null, backup_url: `${R2_PUBLIC_URL}/${BACKUP_KEY}` });
}));

app.post('/api/admin/backup', asyncHandler(async (req, res) => {
  const { mobile, password } = req.body;
  if ((await checkAuth(mobile, password)) !== 'super') return res.status(401).json({ error: 'unauthorized' });
  const ts = await backupNow();
  res.json({ ok: true, last_backup_at: ts });
}));

app.get('/api/admin/backups', asyncHandler(async (req, res) => {
  const { mobile, password } = req.query;
  if ((await checkAuth(mobile, password)) !== 'super') return res.status(401).json({ error: 'unauthorized' });
  let items = [];
  try { items = await listR2('apnakamra-backups/history/'); } catch (e) { items = []; }
  items.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));
  res.json({ backups: items });
}));

app.post('/api/admin/restore', asyncHandler(async (req, res) => {
  const { mobile, password, key } = req.body;
  if ((await checkAuth(mobile, password)) !== 'super') return res.status(401).json({ error: 'unauthorized' });
  const ts = await restoreFromBackup(key);
  res.json({ ok: true, restored_from: ts });
}));

// ---------------- STATIC PAGES ----------------
app.use(express.static(path.join(__dirname, 'public')));

app.get('/property/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'property.html')));
app.get('/city/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'city.html')));
app.get('/owner', (req, res) => res.sendFile(path.join(__dirname, 'public', 'owner.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

const PORT = process.env.PORT || 3000;
initDatabase()
  .then(async () => {
    // If the local DB is empty (fresh deploy), try restoring from the last R2 backup
    try {
      const r = await db.execute('SELECT COUNT(*) as c FROM properties');
      const count = Number(r.rows[0].c || 0);
      if (count === 0) {
        const ts = await restoreFromBackup();
        console.log(`✅ Restored data from latest backup (taken ${new Date(ts).toLocaleString()})`);
      }
    } catch (e) {
      console.log('ℹ️  No existing backup to restore from yet:', e.message);
    }

    app.listen(PORT, () => console.log(`Apna Kamra running on port ${PORT}`));

    // Auto-backup every 60 minutes, but only if there's actual data (avoid overwriting a good backup with empty data)
    setInterval(async () => {
      try {
        const r = await db.execute('SELECT COUNT(*) as c FROM properties');
        if (Number(r.rows[0].c || 0) === 0) return;
        await backupNow();
        console.log('✅ Auto-backup uploaded to R2');
      } catch (e) {
        console.error('Backup failed:', e.message);
      }
    }, 60 * 60 * 1000);
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
