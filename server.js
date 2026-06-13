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

const TURSO_DATABASE_URL = 'libsql://apna-kamra-princeguptapg0106.aws-ap-south-1.turso.io';
const TURSO_AUTH_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODEzMzMxMTUsImlkIjoiMDE5ZWJmYjItMWQwMS03ZjA0LWJhZGMtZDljZjdmNjk0ZjA2IiwicmlkIjoiOTUxNmY1YzctYTRlZi00ZDZhLTg5ZjMtODkyZDIxODUwNTE2In0.8kNCTwkrkpfTbU7i4YXwijC8Igf1mvdiuc9p2gwN4br6-4diu9gWB88aMobARfgTc8yZoxQUqyHcm6bsTpHEDg';

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
      image TEXT DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS owners (
      mobile TEXT PRIMARY KEY,
      password TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS properties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      city_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      owner_name TEXT DEFAULT '',
      owner_mobile TEXT DEFAULT '',
      description TEXT DEFAULT '',
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
  ], 'write');
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

async function checkAuth(mobile, password) {
  if (mobile === ADMIN_MOBILE && password === ADMIN_PASS) return 'admin';
  if (!mobile || !password) return null;
  const r = await db.execute({
    sql: 'SELECT * FROM owners WHERE mobile=? AND password=?',
    args: [mobile, password]
  });
  if (r.rows.length) return 'owner';
  return null;
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
  if (mobile === ADMIN_MOBILE && password === ADMIN_PASS) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: 'Invalid credentials' });
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
  res.json(r.rows);
}));

app.post('/api/cities', asyncHandler(async (req, res) => {
  const { mobile, password, name, image } = req.body;
  if ((await checkAuth(mobile, password)) !== 'admin') return res.status(401).json({ error: 'unauthorized' });
  if (!name) return res.status(400).json({ error: 'name required' });
  const slug = slugify(name);
  const existing = await db.execute({ sql: 'SELECT id FROM cities WHERE slug=?', args: [slug] });
  if (existing.rows.length) return res.status(400).json({ error: 'city already exists' });
  await db.execute({ sql: 'INSERT INTO cities (name, slug, image) VALUES (?,?,?)', args: [name, slug, image || ''] });
  res.json({ ok: true });
}));

app.put('/api/cities/:id', asyncHandler(async (req, res) => {
  const { mobile, password, name, image } = req.body;
  if ((await checkAuth(mobile, password)) !== 'admin') return res.status(401).json({ error: 'unauthorized' });
  const existing = await db.execute({ sql: 'SELECT * FROM cities WHERE id=?', args: [req.params.id] });
  if (!existing.rows.length) return res.status(404).json({ error: 'not found' });
  const city = existing.rows[0];
  const newName = name !== undefined ? name : city.name;
  const newSlug = name !== undefined ? slugify(name) : city.slug;
  const newImage = image !== undefined ? image : city.image;
  await db.execute({ sql: 'UPDATE cities SET name=?, slug=?, image=? WHERE id=?', args: [newName, newSlug, newImage, req.params.id] });
  res.json({ ok: true });
}));

app.delete('/api/cities/:id', asyncHandler(async (req, res) => {
  const { mobile, password } = req.query;
  if ((await checkAuth(mobile, password)) !== 'admin') return res.status(401).json({ error: 'unauthorized' });
  await db.execute({ sql: 'DELETE FROM cities WHERE id=?', args: [req.params.id] });
  res.json({ ok: true });
}));

// ---------------- PROPERTIES (public) ----------------
app.get('/api/properties', asyncHandler(async (req, res) => {
  const { city, minPrice, maxPrice, amenities, sort, q } = req.query;

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
  if ((await checkAuth(mobile, password)) !== 'admin') return res.status(401).json({ error: 'unauthorized' });
  if (!d.name || !d.city_id) return res.status(400).json({ error: 'name and city required' });

  let baseSlug = slugify(d.slug || d.name);
  let slug = baseSlug;
  let i = 1;
  while ((await db.execute({ sql: 'SELECT id FROM properties WHERE slug=?', args: [slug] })).rows.length) {
    slug = `${baseSlug}-${i++}`;
  }

  const result = await db.execute({
    sql: `INSERT INTO properties (slug, city_id, name, owner_name, owner_mobile, description,
            price_single, price_double, price_triple, amenities, images, views, visible, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    args: [
      slug, Number(d.city_id), d.name, d.owner_name || '', d.owner_mobile || '', d.description || '',
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
  const simpleFields = ['name', 'owner_name', 'description', 'price_single', 'price_double', 'price_triple'];
  simpleFields.forEach(f => {
    if (d[f] !== undefined) {
      sets.push(`${f}=?`);
      args.push(f.startsWith('price_') ? (Number(d[f]) || 0) : d[f]);
    }
  });
  if (d.amenities !== undefined) { sets.push('amenities=?'); args.push(JSON.stringify(d.amenities)); }
  if (d.images !== undefined) { sets.push('images=?'); args.push(JSON.stringify(d.images)); }

  if (role === 'admin') {
    if (d.owner_mobile !== undefined) { sets.push('owner_mobile=?'); args.push(d.owner_mobile); }
    if (d.city_id !== undefined) { sets.push('city_id=?'); args.push(Number(d.city_id)); }
    if (d.visible !== undefined) { sets.push('visible=?'); args.push(Number(d.visible)); }
  }

  if (!sets.length) return res.json({ ok: true });
  args.push(req.params.id);
  await db.execute({ sql: `UPDATE properties SET ${sets.join(', ')} WHERE id=?`, args });
  res.json({ ok: true });
}));

app.delete('/api/properties/:id', asyncHandler(async (req, res) => {
  const { mobile, password } = req.query;
  if ((await checkAuth(mobile, password)) !== 'admin') return res.status(401).json({ error: 'unauthorized' });
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
  if ((await checkAuth(mobile, password)) !== 'admin') return res.status(401).json({ error: 'unauthorized' });
  const r = await db.execute(`
    SELECT p.*, c.name as city_name FROM properties p JOIN cities c ON c.id=p.city_id
    ORDER BY p.created_at DESC
  `);
  res.json(r.rows.map(rowToProperty));
}));

app.get('/api/admin/owners', asyncHandler(async (req, res) => {
  const { mobile, password } = req.query;
  if ((await checkAuth(mobile, password)) !== 'admin') return res.status(401).json({ error: 'unauthorized' });
  const r = await db.execute('SELECT mobile FROM owners ORDER BY mobile');
  res.json(r.rows);
}));

app.post('/api/admin/owners', asyncHandler(async (req, res) => {
  const { mobile, password, new_mobile, new_password } = req.body;
  if ((await checkAuth(mobile, password)) !== 'admin') return res.status(401).json({ error: 'unauthorized' });
  if (!new_mobile || !new_password) return res.status(400).json({ error: 'mobile and password required' });
  const existing = await db.execute({ sql: 'SELECT mobile FROM owners WHERE mobile=?', args: [new_mobile] });
  if (existing.rows.length) return res.status(400).json({ error: 'owner already exists' });
  await db.execute({ sql: 'INSERT INTO owners (mobile, password) VALUES (?,?)', args: [new_mobile, new_password] });
  res.json({ ok: true });
}));

app.delete('/api/admin/owners/:mobile', asyncHandler(async (req, res) => {
  const { mobile, password } = req.query;
  if ((await checkAuth(mobile, password)) !== 'admin') return res.status(401).json({ error: 'unauthorized' });
  await db.execute({ sql: 'DELETE FROM owners WHERE mobile=?', args: [req.params.mobile] });
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
  if ((await checkAuth(mobile, password)) !== 'admin') return res.status(401).json({ error: 'unauthorized' });
  const r = await db.execute('SELECT * FROM leads ORDER BY created_at DESC');
  res.json(r.rows);
}));

app.delete('/api/admin/leads/:id', asyncHandler(async (req, res) => {
  const { mobile, password } = req.query;
  if ((await checkAuth(mobile, password)) !== 'admin') return res.status(401).json({ error: 'unauthorized' });
  await db.execute({ sql: 'DELETE FROM leads WHERE id=?', args: [req.params.id] });
  res.json({ ok: true });
}));

// ---------------- STATIC PAGES ----------------
app.use(express.static(path.join(__dirname, 'public')));

app.get('/property/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'property.html')));
app.get('/city/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'city.html')));
app.get('/owner', (req, res) => res.sendFile(path.join(__dirname, 'public', 'owner.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

const PORT = process.env.PORT || 3000;
initDatabase()
  .then(() => app.listen(PORT, () => console.log(`Apna Kamra running on port ${PORT}`)))
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
