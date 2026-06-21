/**
 * Apna Kamra — Sitemap Generator (standalone, manual)
 * -----------------------------------------------------
 * Generates a complete sitemap.xml from your LIVE site's public API
 * (cities + visible properties) and saves it to sitemap-generated.xml
 * right next to this script. Upload that file to Google Search Console
 * if the live /sitemap.xml route isn't reachable for some reason.
 *
 * Usage:
 *   node generate-sitemap.js
 *
 * Requires no npm install — uses only Node's built-in https module.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const SITE_BASE = 'https://apna-kamra-production.up.railway.app';

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Failed to parse JSON from ' + url)); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log(`Fetching cities and properties from ${SITE_BASE} ...`);

  const cities = await fetchJSON(`${SITE_BASE}/api/cities`);
  console.log(`Found ${cities.length} cities.`);

  let allProperties = [];
  for (const city of cities) {
    const props = await fetchJSON(`${SITE_BASE}/api/properties?city=${city.slug}`);
    allProperties = allProperties.concat(props);
    console.log(`  ${city.name}: ${props.length} properties`);
  }

  const today = new Date().toISOString().split('T')[0];

  const entries = [
    { loc: `${SITE_BASE}/`, priority: '1.0', changefreq: 'daily' },
    { loc: `${SITE_BASE}/list-property.html`, priority: '0.5', changefreq: 'monthly' },
    ...cities.map(c => ({ loc: `${SITE_BASE}/city/${c.slug}`, priority: '0.9', changefreq: 'daily' })),
    ...allProperties.map(p => ({
      loc: `${SITE_BASE}/property/${p.slug}`,
      priority: '0.8',
      changefreq: 'weekly',
      lastmod: p.created_at ? new Date(Number(p.created_at)).toISOString().split('T')[0] : today
    }))
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map(e => `  <url>
    <loc>${e.loc}</loc>
    ${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ''}
    <changefreq>${e.changefreq}</changefreq>
    <priority>${e.priority}</priority>
  </url>`).join('\n')}
</urlset>
`;

  const outPath = path.join(__dirname, 'sitemap-generated.xml');
  fs.writeFileSync(outPath, xml);
  console.log(`\n✅ Done! Wrote ${entries.length} URLs to ${outPath}`);
  console.log('Upload this file to your site (e.g. public/sitemap.xml) or submit its contents directly in Google Search Console.');
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
