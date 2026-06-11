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
      category: l.category, // behouden voor landing-page grouping
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

// ─── Landing pages (per plaats + type) ──────────────────────────────────

// DB-category → landing-paths (1 category kan meerdere landing-types hebben)
// labelPlural en labelSingular zijn handgekozen want NL-pluralisatie is grillig
// (rommelroutes ipv "rommelrouteen", garageverkopen ipv "garageverkoops").
const CATEGORY_TO_LANDINGS = {
  garagesale: [
    { path: 'opritverkoop', label: 'Opritverkoop', labelPlural: 'opritverkopen', labelSingular: 'opritverkoop' },
    { path: 'garageverkoop', label: 'Garageverkoop', labelPlural: 'garageverkopen', labelSingular: 'garageverkoop' },
  ],
  buurtverkoop: [{ path: 'rommelroute', label: 'Rommelroute', labelPlural: 'rommelroutes', labelSingular: 'rommelroute' }],
  vlooienmarkt: [{ path: 'vlooienmarkt', label: 'Vlooienmarkt', labelPlural: 'vlooienmarkten', labelSingular: 'vlooienmarkt' }],
  rommelmarkt: [{ path: 'rommelmarkt', label: 'Rommelmarkt', labelPlural: 'rommelmarkten', labelSingular: 'rommelmarkt' }],
};

// Slugify: zet "'s-Hertogenbosch" om naar "s-hertogenbosch", "Sint-Maartensdijk" → "sint-maartensdijk"
function slugify(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function distKm(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}

// Groepeer listings per (landing-path, city) en bouw 1 landing-page per groep.
function buildLandingGroups(listings) {
  const groups = new Map(); // key: "path|cityslug" → { path, label, city, sales[], cityCenter? }
  for (const l of listings) {
    if (!l.city) continue;
    // Skip listings zonder geldige datum (we tonen alleen upcoming)
    const landings = CATEGORY_TO_LANDINGS[Object.keys(CATEGORY_TO_TYPE).find(k => CATEGORY_TO_TYPE[k] === l.type)];
    // ↑ Onnodig; we hebben directe mapping nodig van category, niet UI-type
  }
  // Simpeler: gebruik raw category via aparte fetch met category-veld erbij.
  return groups;
}

// Variant die category direct meeneemt — we hebben category nodig voor de mapping
// Generieke "city" values die geen echte stad zijn — overslaan
const SKIP_CITIES = new Set(['onbekend','belgie','belgië','vlaanderen','wallonie','wallonië','nederland','frankrijk','duitsland','france','germany','allemagne','deutschland','holland','tbd','test']);

function buildLandingGroupsByCategory(listingsWithCat) {
  const groups = new Map();
  for (const l of listingsWithCat) {
    if (!l.city) continue;
    const dest = CATEGORY_TO_LANDINGS[l.category];
    if (!dest) continue;
    const citySlug = slugify(l.city);
    if (!citySlug || SKIP_CITIES.has(citySlug) || citySlug.length < 3) continue;
    for (const d of dest) {
      const key = `${d.path}|${citySlug}`;
      if (!groups.has(key)) {
        groups.set(key, {
          path: d.path,
          label: d.label,
          labelPlural: d.labelPlural,
          labelSingular: d.labelSingular,
          city: l.city,
          citySlug,
          sales: [],
        });
      }
      groups.get(key).sales.push(l);
    }
  }
  // Filter: alleen groepen met minstens 1 upcoming verkoop (lastmod-control)
  const today = new Date().toISOString().slice(0, 10);
  for (const [key, g] of groups) {
    const upcoming = g.sales.filter(s => s.date >= today);
    if (!upcoming.length) {
      groups.delete(key);
      continue;
    }
    g.upcoming = upcoming.sort((a, b) => a.date.localeCompare(b.date));
    // Bereken city-center voor "nabij" links
    const validCoords = g.sales.filter(s => s.lat && s.lng);
    if (validCoords.length) {
      g.center = {
        lat: validCoords.reduce((sum, s) => sum + s.lat, 0) / validCoords.length,
        lng: validCoords.reduce((sum, s) => sum + s.lng, 0) / validCoords.length,
      };
    }
  }
  return groups;
}

function renderLandingHtml(template, group, allGroups) {
  const cityHuman = group.city;
  const labelPlural = group.labelPlural || (group.label.toLowerCase() + 'en');
  const labelSingular = group.labelSingular || group.label.toLowerCase();
  const canonical = `${BASE_URL}/${group.path}/${group.citySlug}`;

  const h1 = `${group.label} ${cityHuman} — komende verkopen op de kaart`;
  const intro = `Op zoek naar een ${labelSingular} in ${cityHuman}? Hieronder zie je alle aankomende ${labelPlural} die op YardiGo geplaatst zijn, met datum, tijd en locatie. Klik door voor foto's, route en directe contactopties met de organisator.`;
  const metaDesc = `Aankomende ${labelPlural} in ${cityHuman} op één plek — datum, tijd, foto's en route. Bekijk welke verkopen er deze week zijn en plaats gratis je eigen.`.slice(0, 200);

  // Komende verkopen-blok
  let upcomingHtml = '';
  if (group.upcoming.length) {
    upcomingHtml = '<div class="sales-list">';
    for (const s of group.upcoming.slice(0, 20)) {
      const date = fmtDate(s.date);
      const loc = s.address_hidden ? cityHuman : (s.address || cityHuman);
      upcomingHtml += `<a class="sale-card" href="/v/${s.id}">
        <div class="sc-date">📅 ${esc(date)}</div>
        <div class="sc-title">${esc(s.title)}</div>
        <div class="sc-loc">📍 ${esc(loc)}</div>
      </a>`;
    }
    upcomingHtml += '</div>';
  } else {
    upcomingHtml = '<div class="empty-box">Geen aankomende verkopen — kom binnenkort terug of zet een melding aan via de app.</div>';
  }

  // Nearby links: andere steden met hetzelfde type
  let nearbyHtml = '';
  if (group.center) {
    const nearby = [];
    for (const [, other] of allGroups) {
      if (other.path !== group.path || other.citySlug === group.citySlug || !other.center) continue;
      const d = distKm(group.center, other.center);
      if (d < 50) nearby.push({ city: other.city, slug: other.citySlug, d });
    }
    nearby.sort((a, b) => a.d - b.d);
    if (nearby.length) {
      nearbyHtml = '<section><h2>Andere plaatsen met ' + esc(labelPlural) + ' in de buurt</h2><div class="nearby-grid">';
      for (const n of nearby.slice(0, 12)) {
        nearbyHtml += `<a class="nearby-link" href="/${group.path}/${n.slug}">${esc(n.city)} <span style="color:#9A8E82;font-weight:500;font-size:11px">(${n.d.toFixed(0)} km)</span></a>`;
      }
      nearbyHtml += '</div></section>';
    }
  }

  // JSON-LD: BreadcrumbList + ItemList of Events
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: BASE_URL + '/' },
          { '@type': 'ListItem', position: 2, name: group.label, item: `${BASE_URL}/${group.path}/` },
          { '@type': 'ListItem', position: 3, name: cityHuman, item: canonical },
        ],
      },
      {
        '@type': 'ItemList',
        name: `${group.label} ${cityHuman}`,
        itemListElement: group.upcoming.slice(0, 10).map((s, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: `${BASE_URL}/v/${s.id}`,
          name: s.title,
        })),
      },
    ],
  });

  return template
    .replace(/{{TYPE_PATH}}/g, esc(group.path))
    .replace(/{{TYPE_LABEL}}/g, esc(group.label))
    .replace(/{{TYPE_LABEL_LOWER}}/g, esc(labelPlural))
    .replace(/{{TYPE_LABEL_LOWER_SINGULAR}}/g, esc(labelSingular))
    .replace(/{{CITY}}/g, esc(cityHuman))
    .replace(/{{H1}}/g, esc(h1))
    .replace(/{{INTRO}}/g, esc(intro))
    .replace(/{{META_DESC}}/g, esc(metaDesc))
    .replace(/{{CANONICAL}}/g, esc(canonical))
    .replace(/{{OG_IMAGE}}/g, esc(DEFAULT_OG_IMAGE))
    .replace(/{{UPCOMING_COUNT}}/g, String(group.upcoming.length))
    .replace(/{{UPCOMING_LIST}}/g, upcomingHtml)
    .replace(/{{NEARBY_BLOCK}}/g, nearbyHtml)
    .replace(/{{JSON_LD}}/g, jsonLd);
}

function buildSitemap(listings, landingGroups) {
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
  if (landingGroups) {
    for (const [, g] of landingGroups) {
      urls.push({
        loc: `${BASE_URL}/${g.path}/${g.citySlug}`,
        lastmod: now.slice(0, 10),
        changefreq: 'weekly',
        priority: '0.8',
      });
    }
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

  // ─── Landing pages per (type, plaats) ───────────────────────────────
  const landingTemplate = readFileSync(resolve(__dirname, 'templates/landing.html'), 'utf-8');
  const landingGroups = buildLandingGroupsByCategory(listings);
  console.log(`  building ${landingGroups.size} landing pages…`);
  let landingsRendered = 0;
  for (const [, g] of landingGroups) {
    try {
      const dir = resolve(PROJECT_ROOT, g.path, g.citySlug);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const html = renderLandingHtml(landingTemplate, g, landingGroups);
      writeFileSync(resolve(dir, 'index.html'), html);
      landingsRendered++;
    } catch (e) {
      console.warn(`  skip landing ${g.path}/${g.citySlug}:`, e.message);
    }
  }
  console.log(`  rendered ${landingsRendered} landing pages`);

  // Sitemap + robots.txt
  writeFileSync(resolve(PROJECT_ROOT, 'sitemap.xml'), buildSitemap(listings, landingGroups));
  writeFileSync(resolve(PROJECT_ROOT, 'robots.txt'), buildRobotsTxt());
  console.log('  wrote sitemap.xml + robots.txt');

  console.log('✓ Prerender complete');
}

main().catch(e => { console.error('Prerender failed:', e); process.exit(1); });
