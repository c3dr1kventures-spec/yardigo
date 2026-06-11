// ═══════════════════════════════════════════════════════════════════════
// YardiGo build-time prerender
//
// Vercel draait dit script bij elke deploy. We genereren statische HTML
// pagina's per advertentie zodat Google Search Console, Bing en social
// previewers (Facebook/WhatsApp) unieke meta + JSON-LD krijgen.
//
// Output:
//   v/{id}/index.html   — server-rendered detail-page met OG + JSON-LD
//   sitemap.xml         — lijst van alle indexeerbare URLs
//
// Hydration: zodra een echte browser de pagina laadt, redirect het script
// naar / met sessionStorage flag, waardoor de SPA direct het detail opent.
// ═══════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fwehqudhwzcnkcuypuqw.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3ZWhxdWRod3pjbmtjdXlwdXF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzOTQwNzgsImV4cCI6MjA4OTk3MDA3OH0.A5mPApoGySr97niz6QLZGFSDhsfCqOwi-k8v58mHjMI';

const BASE_URL = process.env.BASE_URL || 'https://yardigo.nl';
const DEFAULT_OG_IMAGE = BASE_URL + '/og-image.png';

// DB-category → UI-type mapping (sync met index.html regel ~3833)
const CATEGORY_TO_TYPE = {
  garagesale: 'particulier',
  garageverkoop: 'particulier',
  rommelmarkt: 'evenement',
  vlooienmarkt: 'evenement',
  kofferbakverkoop: 'evenement',
  buurtverkoop: 'buurt',
  overig: 'particulier',
};

const TYPE_LABELS = {
  particulier: 'Opritverkoop',
  buurt: 'Rommelroute',
  evenement: 'Evenement',
};

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch { return iso; }
}

function fmtDateShort(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
  } catch { return iso; }
}

function cityFromAddress(addr, city) {
  if (city) return city;
  if (!addr) return '';
  const parts = String(addr).split(',');
  return parts.length >= 2 ? parts[parts.length - 1].trim() : addr;
}

async function fetchListings() {
  const url = `${SUPABASE_URL}/rest/v1/listings?select=id,title,category,event_subtype,date_start,date_end,time_start,time_end,address,city,latitude,longitude,address_reveal_mode,description,images,confirmation_status,user_id,status&order=date_start.desc&limit=2000`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) {
    console.error('Failed to fetch listings:', res.status, await res.text());
    return [];
  }
  const data = await res.json();
  // Normaliseer naar SPA-shape voor de rest van het script
  return data
    .filter(l => !l.confirmation_status || l.confirmation_status === 'confirmed')
    .filter(l => !l.status || l.status === 'active' || l.status === 'published')
    .map(l => ({
      id: l.id,
      title: l.title,
      type: CATEGORY_TO_TYPE[l.category] || 'particulier',
      event_subtype: l.event_subtype,
      date: l.date_start,
      from: l.time_start ? String(l.time_start).slice(0, 5) : '',
      till: l.time_end ? String(l.time_end).slice(0, 5) : '',
      address: l.address,
      city: l.city,
      lat: l.latitude,
      lng: l.longitude,
      // Adres-vertraging: als reveal_mode "day_before" en de startdatum nog
      // niet in een 24u-venster is, beschouwen we het adres als verborgen.
      address_hidden: l.address_reveal_mode === 'day_before'
        ? (new Date(l.date_start) - Date.now() > 24 * 3600 * 1000)
        : false,
      description: l.description,
      photos: Array.isArray(l.images) ? l.images : [],
      user_id: l.user_id,
    }));
}

function buildJsonLd(sale) {
  const date = sale.date || sale.date_start;
  const from = sale.from_time || sale.from || '09:00';
  const till = sale.till_time || sale.till || '17:00';
  const startISO = date ? `${date}T${from}:00` : undefined;
  const endISO = date ? `${date}T${till}:00` : undefined;
  const typeLabel = sale.event_subtype || TYPE_LABELS[sale.type] || 'Event';
  const city = cityFromAddress(sale.address, sale.city);
  const location = sale.address_hidden
    ? { '@type': 'Place', name: city, address: { '@type': 'PostalAddress', addressLocality: city, addressCountry: 'NL' } }
    : {
        '@type': 'Place',
        name: city || 'Locatie',
        address: { '@type': 'PostalAddress', streetAddress: sale.address || '', addressLocality: city || '', addressCountry: 'NL' },
        geo: sale.lat && sale.lng ? { '@type': 'GeoCoordinates', latitude: sale.lat, longitude: sale.lng } : undefined,
      };
  return {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: sale.title,
    startDate: startISO,
    endDate: endISO,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location,
    image: Array.isArray(sale.photos) && sale.photos.length ? sale.photos.slice(0, 4) : [DEFAULT_OG_IMAGE],
    description: (sale.description || `${typeLabel} in ${city} op ${fmtDate(date)}.`).slice(0, 500),
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR', availability: 'https://schema.org/InStock', url: `${BASE_URL}/v/${sale.id}` },
    organizer: { '@type': 'Organization', name: 'YardiGo', url: BASE_URL },
  };
}

function renderSaleHtml(template, sale) {
  const date = sale.date || sale.date_start;
  const from = sale.from_time || sale.from || '';
  const till = sale.till_time || sale.till || '';
  const typeKey = sale.type || 'particulier';
  const typeLabel = sale.event_subtype || TYPE_LABELS[typeKey] || '';
  const city = cityFromAddress(sale.address, sale.city);
  const dateLong = fmtDate(date);
  const dateShort = fmtDateShort(date);
  const time = from && till ? `${from}–${till}` : (from || till);
  const locationStr = sale.address_hidden ? city : (sale.address || city);
  const metaDesc = (sale.description || `${typeLabel} in ${city} op ${dateLong}. Tijden: ${time}. Bekijk foto's, route en wie er nog meer komt op YardiGo.`).slice(0, 200);
  const leadText = (sale.description || `Op ${dateLong} vindt er een ${typeLabel.toLowerCase()} plaats in ${city}. Open YardiGo voor foto's, route en het volledige overzicht.`).slice(0, 400);
  const ogImage = Array.isArray(sale.photos) && sale.photos.length ? sale.photos[0] : DEFAULT_OG_IMAGE;
  const jsonLd = JSON.stringify(buildJsonLd(sale));
  const canonical = `${BASE_URL}/v/${sale.id}`;

  return template
    .replace(/{{LANG}}/g, 'nl')
    .replace(/{{TITLE}}/g, esc(sale.title))
    .replace(/{{DATE}}/g, esc(dateShort))
    .replace(/{{DATE_LONG}}/g, esc(dateLong))
    .replace(/{{TIME}}/g, esc(time || 'tijd t.b.a.'))
    .replace(/{{CITY}}/g, esc(city || ''))
    .replace(/{{LOCATION}}/g, esc(locationStr))
    .replace(/{{META_DESC}}/g, esc(metaDesc))
    .replace(/{{CANONICAL}}/g, esc(canonical))
    .replace(/{{OG_IMAGE}}/g, esc(ogImage))
    .replace(/{{OG_LOCALE}}/g, 'nl_NL')
    .replace(/{{TYPE_KEY}}/g, esc(typeKey))
    .replace(/{{TYPE_LABEL}}/g, esc(typeLabel))
    .replace(/{{LEAD_TEXT}}/g, esc(leadText))
    .replace(/{{JSON_LD}}/g, jsonLd)
    .replace(/{{SALE_ID_JSON}}/g, JSON.stringify(String(sale.id)));
}

function buildSitemap(listings) {
  const now = new Date().toISOString();
  const urls = [
    { loc: BASE_URL + '/', changefreq: 'daily', priority: '1.0' },
    { loc: BASE_URL + '/home', changefreq: 'weekly', priority: '0.8' },
  ];
  for (const l of listings) {
    urls.push({
      loc: `${BASE_URL}/v/${l.id}`,
      lastmod: l.date || now.slice(0, 10),
      changefreq: 'daily',
      priority: '0.7',
    });
  }
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  for (const u of urls) {
    xml += '  <url>\n';
    xml += `    <loc>${u.loc}</loc>\n`;
    if (u.lastmod) xml += `    <lastmod>${u.lastmod}</lastmod>\n`;
    xml += `    <changefreq>${u.changefreq}</changefreq>\n`;
    xml += `    <priority>${u.priority}</priority>\n`;
    xml += '  </url>\n';
  }
  xml += '</urlset>\n';
  return xml;
}

function buildRobotsTxt() {
  return `User-agent: *
Allow: /
Disallow: /admin.html
Disallow: /bevestig.html

Sitemap: ${BASE_URL}/sitemap.xml
`;
}

// ─── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log('→ YardiGo prerender starting…');
  console.log('  base URL:', BASE_URL);

  const template = readFileSync(resolve(__dirname, 'templates/sale-detail.html'), 'utf-8');
  const listings = await fetchListings();
  console.log(`  fetched ${listings.length} listings`);

  // Render alle detail-pagina's
  const outDir = resolve(PROJECT_ROOT, 'v');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  let rendered = 0;
  for (const sale of listings) {
    try {
      const dir = resolve(outDir, String(sale.id));
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const html = renderSaleHtml(template, sale);
      writeFileSync(resolve(dir, 'index.html'), html);
      rendered++;
    } catch (e) {
      console.warn(`  skip ${sale.id}:`, e.message);
    }
  }
  console.log(`  rendered ${rendered} sale-detail pages → /v/{id}/index.html`);

  // Sitemap + robots.txt
  writeFileSync(resolve(PROJECT_ROOT, 'sitemap.xml'), buildSitemap(listings));
  writeFileSync(resolve(PROJECT_ROOT, 'robots.txt'), buildRobotsTxt());
  console.log('  wrote sitemap.xml + robots.txt');

  console.log('✓ Prerender complete');
}

main().catch(e => { console.error('Prerender failed:', e); process.exit(1); });
