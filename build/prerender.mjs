// ═══════════════════════════════════════════════════════════════════════
// YardiGo build-time prerender
//
// Vercel draait dit script bij elke deploy. We genereren statische HTML
// pagina's per advertentie zodat Google Search Console, Bing en social
// previewers (Facebook/WhatsApp) unieke meta + JSON-LD krijgen.
//
// Output:
//   v/{id}/index.html          detail-page met OG + JSON-LD
//   <type>/<plaats>/index.html stadspagina per soort
//   <type>/index.html          overzicht per soort (alle plaatsen + dit weekend)
//   <type>/dit-weekend/        verkopen van het komende weekend
//   sitemap.xml / sitemap-be.xml  per domein (zelfde bestanden op elk domein)
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

// Default naar www-variant zodat sitemap-URL's matchen met het canonical
// dat we in index.html zetten (https://www.yardigo.nl/). Een mismatch zou
// Google twijfel geven over welke versie van de URL geïndexeerd moet worden.
const BASE_URL = process.env.BASE_URL || 'https://www.yardigo.nl';
const BASE_URL_BE = 'https://www.yardigo.be';
const DEFAULT_OG_IMAGE = BASE_URL + '/og-image.png';

// Canoniek domein per land. Belgische verkopen horen op yardigo.be; NL en
// (zolang yardigo.de nog niet bestaat) DE op yardigo.nl. De statische
// bestanden staan op elk domein, alleen de canonical verschilt.
function baseFor(land) { return land === 'be' ? BASE_URL_BE : BASE_URL; }
function ogLocaleFor(land) { return land === 'be' ? 'nl_BE' : 'nl_NL'; }
const PAGINA_LANDEN = new Set(['nl', 'be', 'de']);

// Datum als YYYY-MM-DD in NL-tijd (Vercel bouwt in UTC).
function dagNL(d = new Date()) { return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
function plusDagen(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

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
  // Via RPC: adres/coördinaten van particuliere verkopen komen er server-side al
  // verborgen/verschoven uit (zie privacy-lockdown.sql).
  // De API geeft maximaal 1000 rijen per keer; daarom in porties ophalen.
  const data = [];
  for (let offset = 0; ; offset += 1000) {
    const url = `${SUPABASE_URL}/rest/v1/rpc/get_listings_seo?limit=1000&offset=${offset}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) {
      console.error('Failed to fetch listings:', res.status, await res.text());
      return [];
    }
    const deel = await res.json();
    data.push(...deel);
    if (deel.length < 1000) break;
  }
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
      updated: l.updated_at ? String(l.updated_at).slice(0, 10) : null,
      land: l.land || 'nl',
      plaats_ok: l.plaats_ok === true,
      organizer_name: l.organizer_name || null,
      organizer_url: l.organizer_url || null,
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
  const country = (sale.land || 'nl').toUpperCase();
  const base = baseFor(sale.land);
  const location = sale.address_hidden
    ? { '@type': 'Place', name: city, address: { '@type': 'PostalAddress', addressLocality: city, addressCountry: country } }
    : {
        '@type': 'Place',
        name: city || 'Locatie',
        address: { '@type': 'PostalAddress', streetAddress: sale.address || '', addressLocality: city || '', addressCountry: country },
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
    isAccessibleForFree: true,
    location,
    image: Array.isArray(sale.photos) && sale.photos.length ? sale.photos.slice(0, 4) : [DEFAULT_OG_IMAGE],
    description: (sale.description || `${typeLabel} in ${city} op ${fmtDate(date)}.`).slice(0, 500),
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR', availability: 'https://schema.org/InStock', url: `${base}/v/${sale.id}` },
    // Alleen de echte organisator; YardiGo is dat niet. Zonder organisator weglaten.
    organizer: sale.organizer_name
      ? { '@type': 'Organization', name: sale.organizer_name, url: sale.organizer_url || undefined }
      : undefined,
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
  const canonical = `${baseFor(sale.land)}/v/${sale.id}`;

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
    .replace(/{{OG_LOCALE}}/g, ogLocaleFor(sale.land))
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

// Generieke "city" values die geen echte stad zijn. Vangnet naast plaats_ok
// (die toetst of de plaatsnaam in de eigen plaatsenlijst staat).
const SKIP_CITIES = new Set(['onbekend','belgie','belgië','vlaanderen','wallonie','wallonië','nederland','frankrijk','duitsland','france','germany','allemagne','deutschland','holland','tbd','test']);

// Groepeer listings per (landing-path, plaats). Alleen plaatsen die echt
// bestaan en in NL/BE/DE liggen. Een groep zonder komende verkopen blijft
// bestaan (geen 404-churn) maar krijgt noindex en gaat niet in de sitemap.
function buildLandingGroupsByCategory(listingsWithCat) {
  const today = dagNL();
  const jaarGeleden = plusDagen(today, -365);
  const groups = new Map();
  for (const l of listingsWithCat) {
    if (!l.city || !l.plaats_ok || !PAGINA_LANDEN.has(l.land)) continue;
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
  for (const [key, g] of groups) {
    g.upcoming = g.sales.filter(s => s.date >= today).sort((a, b) => a.date.localeCompare(b.date));
    g.recent = g.sales.filter(s => s.date < today && s.date >= jaarGeleden).sort((a, b) => b.date.localeCompare(a.date));
    // Niets komend en niets in het afgelopen jaar: geen pagina.
    if (!g.upcoming.length && !g.recent.length) { groups.delete(key); continue; }
    g.indexeren = g.upcoming.length > 0;
    // Land van de groep = meest voorkomende land van de verkopen.
    const tel = {};
    for (const s of g.sales) tel[s.land] = (tel[s.land] || 0) + 1;
    g.land = Object.keys(tel).sort((a, b) => tel[b] - tel[a])[0];
    g.base = baseFor(g.land);
    g.lastmod = g.sales.map(s => s.updated || '').sort().pop() || today;
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

function saleCardsHtml(sales, fallbackCity, { verleden = false } = {}) {
  let html = '<div class="sales-list">';
  for (const s of sales) {
    const loc = s.address_hidden ? (s.city || fallbackCity) : (s.address || s.city || fallbackCity);
    html += `<a class="sale-card" href="/v/${s.id}" data-date="${esc(s.date)}"${verleden ? ' data-past' : ''}>
        <div class="sc-date">📅 ${esc(fmtDate(s.date))}</div>
        <div class="sc-title">${esc(s.title)}</div>
        <div class="sc-loc">📍 ${esc(loc)}</div>
      </a>`;
  }
  return html + '</div>';
}

function statsHtml(items) {
  return items.map(t => `<div class="stat">${t}</div>`).join('');
}

function fillLanding(template, v) {
  return template
    .replace(/{{TITLE_TAG}}/g, esc(v.titleTag))
    .replace(/{{ROBOTS_META}}/g, v.indexeren ? '' : '<meta name="robots" content="noindex,follow">')
    .replace(/{{OG_LOCALE}}/g, v.ogLocale || 'nl_NL')
    .replace(/{{BREADCRUMB_HTML}}/g, v.breadcrumbHtml)
    .replace(/{{STATS_HTML}}/g, v.statsHtml)
    .replace(/{{LIST_TITLE}}/g, esc(v.listTitle))
    .replace(/{{EXTRA_BLOCK}}/g, v.extraHtml || '')
    .replace(/{{TYPE_LABEL_LOWER_SINGULAR}}/g, esc(v.labelSingular))
    .replace(/{{H1}}/g, esc(v.h1))
    .replace(/{{INTRO}}/g, esc(v.intro))
    .replace(/{{META_DESC}}/g, esc(v.metaDesc.slice(0, 200)))
    .replace(/{{CANONICAL}}/g, esc(v.canonical))
    .replace(/{{OG_IMAGE}}/g, esc(DEFAULT_OG_IMAGE))
    .replace(/{{UPCOMING_LIST}}/g, v.listHtml)
    .replace(/{{NEARBY_BLOCK}}/g, v.nearbyHtml || '')
    .replace(/{{JSON_LD}}/g, JSON.stringify(v.jsonLd));
}

function renderLandingHtml(template, group, allGroups) {
  const cityHuman = group.city;
  const labelPlural = group.labelPlural || (group.label.toLowerCase() + 'en');
  const labelSingular = group.labelSingular || group.label.toLowerCase();
  const base = group.base;
  const canonical = `${base}/${group.path}/${group.citySlug}`;
  const heeftKomend = group.upcoming.length > 0;

  const listHtml = heeftKomend
    ? saleCardsHtml(group.upcoming.slice(0, 20), cityHuman)
    : '<div class="empty-box">Er staan nu geen ' + esc(labelPlural) + ' in ' + esc(cityHuman) + ' gepland. Zet in de app een melding aan, dan hoor je het als er een bijkomt.</div>';
  const extraHtml = group.recent.length
    ? `<section><h2>Recent geweest in ${esc(cityHuman)}</h2>${saleCardsHtml(group.recent.slice(0, 10), cityHuman, { verleden: true })}</section>`
    : '';

  // Nabije plaatsen met hetzelfde type; alleen pagina's die geïndexeerd worden.
  let nearbyHtml = '';
  if (group.center) {
    const nearby = [];
    for (const [, other] of allGroups) {
      if (other.path !== group.path || other.citySlug === group.citySlug || !other.center || !other.indexeren) continue;
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

  return fillLanding(template, {
    titleTag: `${group.label} ${cityHuman}: komende verkopen`,
    indexeren: group.indexeren,
    ogLocale: ogLocaleFor(group.land),
    breadcrumbHtml: `<a href="/">Home</a> › <a href="/${group.path}/">${esc(group.label)}</a> › ${esc(cityHuman)}`,
    statsHtml: statsHtml([
      `📅 <strong>${group.upcoming.length}</strong> komende verkopen`,
      `📍 <strong>${esc(cityHuman)}</strong> en omgeving`,
      '🆓 Gratis te bekijken',
    ]),
    listTitle: `Komende ${labelPlural} in ${cityHuman}`,
    listHtml, extraHtml, nearbyHtml, labelSingular,
    h1: `${group.label} ${cityHuman}: komende verkopen op de kaart`,
    intro: `Op zoek naar een ${labelSingular} in ${cityHuman}? Hieronder zie je alle aankomende ${labelPlural} die op YardiGo geplaatst zijn, met datum, tijd en locatie. Klik door voor foto's, route en contact met de organisator.`,
    metaDesc: `Aankomende ${labelPlural} in ${cityHuman} op één plek: datum, tijd, foto's en route. Bekijk welke verkopen er deze week zijn en plaats gratis je eigen.`,
    canonical,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: base + '/' },
            { '@type': 'ListItem', position: 2, name: group.label, item: `${BASE_URL}/${group.path}/` },
            { '@type': 'ListItem', position: 3, name: cityHuman, item: canonical },
          ],
        },
        {
          '@type': 'ItemList',
          name: `${group.label} ${cityHuman}`,
          itemListElement: group.upcoming.slice(0, 10).map((s, i) => ({
            '@type': 'ListItem', position: i + 1, url: `${baseFor(s.land)}/v/${s.id}`, name: s.title,
          })),
        },
      ],
    },
  });
}

// ─── Overzicht per soort + "dit weekend" ───────────────────────────────
// Eén set per landing-path (rommelmarkt, opritverkoop, ...). Deze pagina's
// tonen NL en BE samen en staan canoniek op yardigo.nl.
function landingTypes() {
  const m = new Map();
  for (const lst of Object.entries(CATEGORY_TO_LANDINGS)) {
    for (const d of lst[1]) {
      if (!m.has(d.path)) m.set(d.path, { ...d, categories: [] });
      m.get(d.path).categories.push(lst[0]);
    }
  }
  return [...m.values()];
}

// Komend weekend: za+zo. Op zaterdag/zondag het lopende weekend.
function weekendRange(today) {
  const dow = new Date(today + 'T12:00:00Z').getUTCDay(); // 0 = zo, 6 = za
  if (dow === 6) return [today, plusDagen(today, 1)];
  if (dow === 0) return [today, today];
  return [plusDagen(today, 6 - dow), plusDagen(today, 7 - dow)];
}

function renderTypeIndexHtml(template, t, listings, groups) {
  const today = dagNL();
  const [za, zo] = weekendRange(today);
  const vanType = listings.filter(l => t.categories.includes(l.category) && l.date >= today && PAGINA_LANDEN.has(l.land));
  const weekend = vanType.filter(l => l.date >= za && l.date <= zo).sort((a, b) => a.date.localeCompare(b.date));
  const plaatsen = [...groups.values()].filter(g => g.path === t.path && g.indexeren)
    .sort((a, b) => b.upcoming.length - a.upcoming.length || a.city.localeCompare(b.city));
  const canonical = `${BASE_URL}/${t.path}/`;

  let grid = '';
  if (plaatsen.length) {
    grid = `<section><h2>Alle plaatsen met ${esc(t.labelPlural)}</h2><div class="nearby-grid">`;
    for (const g of plaatsen) {
      grid += `<a class="nearby-link" href="/${t.path}/${g.citySlug}">${esc(g.city)} <span style="color:#9A8E82;font-weight:500;font-size:11px">(${g.upcoming.length})</span></a>`;
    }
    grid += '</div></section>';
  }

  return fillLanding(template, {
    titleTag: `${t.label} in Nederland en België: alle komende ${t.labelPlural}`,
    indexeren: vanType.length > 0,
    breadcrumbHtml: `<a href="/">Home</a> › ${esc(t.label)}`,
    statsHtml: statsHtml([
      `📅 <strong>${vanType.length}</strong> komende ${esc(t.labelPlural)}`,
      `🗓 <strong>${weekend.length}</strong> dit weekend`,
      `📍 <strong>${plaatsen.length}</strong> plaatsen`,
    ]),
    listTitle: `${t.label} dit weekend`,
    listHtml: weekend.length
      ? saleCardsHtml(weekend.slice(0, 30), '') + (weekend.length > 30 ? `<p style="margin-top:12px"><a href="/${t.path}/dit-weekend" style="color:#E07B39;font-weight:700">Alle ${weekend.length} ${esc(t.labelPlural)} dit weekend →</a></p>` : '')
      : `<div class="empty-box">Dit weekend staan er nog geen ${esc(t.labelPlural)} op YardiGo. Kijk hieronder per plaats wat er later komt.</div>`,
    extraHtml: grid,
    nearbyHtml: '',
    labelSingular: t.labelSingular,
    h1: `${t.label}: alle komende ${t.labelPlural} op de kaart`,
    intro: `Alle ${t.labelPlural} in Nederland en België die op YardiGo staan, met datum, tijd en plaats. Kies hieronder een plaats of kijk wat er dit weekend te doen is.`,
    metaDesc: `Alle komende ${t.labelPlural} in Nederland en België: dit weekend en per plaats, met datum, tijd en route.`,
    canonical,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: BASE_URL + '/' },
        { '@type': 'ListItem', position: 2, name: t.label, item: canonical },
      ],
    },
  });
}

function renderWeekendHtml(template, t, listings) {
  const today = dagNL();
  const [za, zo] = weekendRange(today);
  const weekend = listings
    .filter(l => t.categories.includes(l.category) && l.date >= za && l.date <= zo && PAGINA_LANDEN.has(l.land))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.city).localeCompare(String(b.city)));
  const canonical = `${BASE_URL}/${t.path}/dit-weekend`;
  // "24 en 25 oktober 2026"; over een maandgrens "31 oktober en 1 november 2026".
  const periode = za === zo ? fmtDate(za)
    : za.slice(0, 7) === zo.slice(0, 7) ? `${Number(za.slice(8))} en ${fmtDate(zo)}`
    : `${fmtDate(za).replace(/ \d{4}$/, '')} en ${fmtDate(zo)}`;

  return fillLanding(template, {
    titleTag: `${t.label} dit weekend: ${periode}`,
    // Altijd indexeren: de URL blijft, de inhoud wisselt per weekend.
    indexeren: true,
    breadcrumbHtml: `<a href="/">Home</a> › <a href="/${t.path}/">${esc(t.label)}</a> › Dit weekend`,
    statsHtml: statsHtml([
      `🗓 <strong>${esc(periode)}</strong>`,
      `📅 <strong>${weekend.length}</strong> ${esc(t.labelPlural)}`,
    ]),
    listTitle: `${t.label} op ${periode}`,
    listHtml: weekend.length
      ? saleCardsHtml(weekend, '')
      : `<div class="empty-box">Dit weekend staan er nog geen ${esc(t.labelPlural)} op YardiGo. Bekijk <a href="/${t.path}/" style="color:#E07B39">alle komende ${esc(t.labelPlural)}</a>.</div>`,
    extraHtml: '',
    nearbyHtml: '',
    labelSingular: t.labelSingular,
    h1: `${t.label} dit weekend`,
    intro: `Welke ${t.labelPlural} zijn er dit weekend (${periode})? Hier staan ze allemaal, in Nederland en België, met tijd en plaats.`,
    metaDesc: `${t.label} dit weekend (${periode}): alle ${t.labelPlural} in Nederland en België met datum, tijd en route.`,
    canonical,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: `${t.label} dit weekend`,
      itemListElement: weekend.slice(0, 30).map((s, i) => ({
        '@type': 'ListItem', position: i + 1, url: `${baseFor(s.land)}/v/${s.id}`, name: s.title,
      })),
    },
  });
}

// ─── Sitemaps + robots ─────────────────────────────────────────────────
// Eén sitemap per domein. Omdat dezelfde bestanden op elk domein staan, is
// https://www.yardigo.be/sitemap-be.xml gewoon bereikbaar.
function buildSitemaps(listings, landingGroups, types) {
  const today = dagNL();
  const per = { [BASE_URL]: [], [BASE_URL_BE]: [] };
  per[BASE_URL].push({ loc: BASE_URL + '/', lastmod: today, changefreq: 'daily', priority: '1.0' });
  per[BASE_URL].push({ loc: BASE_URL + '/home', changefreq: 'weekly', priority: '0.8' });
  per[BASE_URL_BE].push({ loc: BASE_URL_BE + '/', lastmod: today, changefreq: 'daily', priority: '1.0' });
  for (const l of listings) {
    const b = baseFor(l.land);
    per[b].push({ loc: `${b}/v/${l.id}`, lastmod: l.updated || undefined, changefreq: 'weekly', priority: '0.7' });
  }
  for (const [, g] of landingGroups) {
    if (!g.indexeren) continue;
    per[g.base].push({ loc: `${g.base}/${g.path}/${g.citySlug}`, lastmod: g.lastmod, changefreq: 'daily', priority: '0.8' });
  }
  for (const t of types) {
    per[BASE_URL].push({ loc: `${BASE_URL}/${t.path}/`, lastmod: today, changefreq: 'daily', priority: '0.8' });
    per[BASE_URL].push({ loc: `${BASE_URL}/${t.path}/dit-weekend`, lastmod: today, changefreq: 'daily', priority: '0.8' });
  }
  const xml = urls => {
    let x = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
    for (const u of urls) {
      x += `  <url>\n    <loc>${u.loc}</loc>\n`;
      if (u.lastmod) x += `    <lastmod>${u.lastmod}</lastmod>\n`;
      x += `    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>\n`;
    }
    return x + '</urlset>\n';
  };
  return { nl: xml(per[BASE_URL]), be: xml(per[BASE_URL_BE]), aantallen: { nl: per[BASE_URL].length, be: per[BASE_URL_BE].length } };
}

function buildRobotsTxt() {
  return `User-agent: *
Allow: /
Disallow: /admin.html
Disallow: /bevestig.html
Disallow: /tg

Sitemap: ${BASE_URL}/sitemap.xml
Sitemap: ${BASE_URL_BE}/sitemap-be.xml
`;
}

function schrijfPagina(relDir, html) {
  const dir = resolve(PROJECT_ROOT, relDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'index.html'), html);
}

// ─── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log('→ YardiGo prerender starting…');
  console.log('  base URL:', BASE_URL, '+', BASE_URL_BE);

  const template = readFileSync(resolve(__dirname, 'templates/sale-detail.html'), 'utf-8');
  const listings = await fetchListings();
  console.log(`  fetched ${listings.length} listings`);

  let rendered = 0;
  for (const sale of listings) {
    try {
      schrijfPagina(`v/${sale.id}`, renderSaleHtml(template, sale));
      rendered++;
    } catch (e) {
      console.warn(`  skip ${sale.id}:`, e.message);
    }
  }
  console.log(`  rendered ${rendered} sale-detail pages → /v/{id}/index.html`);

  const landingTemplate = readFileSync(resolve(__dirname, 'templates/landing.html'), 'utf-8');
  const landingGroups = buildLandingGroupsByCategory(listings);
  let landingsRendered = 0, noindex = 0;
  for (const [, g] of landingGroups) {
    try {
      schrijfPagina(`${g.path}/${g.citySlug}`, renderLandingHtml(landingTemplate, g, landingGroups));
      landingsRendered++;
      if (!g.indexeren) noindex++;
    } catch (e) {
      console.warn(`  skip landing ${g.path}/${g.citySlug}:`, e.message);
    }
  }
  console.log(`  rendered ${landingsRendered} landing pages (${noindex} noindex)`);

  const types = landingTypes();
  for (const t of types) {
    schrijfPagina(t.path, renderTypeIndexHtml(landingTemplate, t, listings, landingGroups));
    schrijfPagina(`${t.path}/dit-weekend`, renderWeekendHtml(landingTemplate, t, listings));
  }
  console.log(`  rendered ${types.length * 2} overzicht- en weekendpagina's`);

  const sm = buildSitemaps(listings, landingGroups, types);
  writeFileSync(resolve(PROJECT_ROOT, 'sitemap.xml'), sm.nl);
  writeFileSync(resolve(PROJECT_ROOT, 'sitemap-be.xml'), sm.be);
  writeFileSync(resolve(PROJECT_ROOT, 'robots.txt'), buildRobotsTxt());
  console.log(`  wrote sitemap.xml (${sm.aantallen.nl}) + sitemap-be.xml (${sm.aantallen.be}) + robots.txt`);

  console.log('✓ Prerender complete');
}

main().catch(e => { console.error('Prerender failed:', e); process.exit(1); });
