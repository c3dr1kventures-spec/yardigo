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
//   <type>/provincie/<slug>/   per provincie (NL + BE)
//   sitemap.xml / sitemap-be.xml  per domein (zelfde bestanden op elk domein)
//   locale/be-nl.html          startpagina yardigo.be/ (via middleware.js)
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
// Geheime sleutel voor get_listings_seo_build (alleen in Vercel-env; zie
// seo-afscherming.sql). Zonder sleutel kan niemand de volledige set ophalen.
const SEO_BUILD_KEY = process.env.SEO_BUILD_KEY || '';
const BASE_URL_BE = 'https://www.yardigo.be';
const DEFAULT_OG_IMAGE = BASE_URL + '/og-image.png';

// Canoniek domein per land. Belgische verkopen horen op yardigo.be; NL en
// (zolang yardigo.de nog niet bestaat) DE op yardigo.nl. De statische
// bestanden staan op elk domein, alleen de canonical verschilt.
function baseFor(land) { return land === 'be' ? BASE_URL_BE : BASE_URL; }
function ogLocaleFor(land) { return land === 'be' ? 'nl_BE' : 'nl_NL'; }
const PAGINA_LANDEN = new Set(['nl', 'be', 'de']);

// Provincie-slugs uit plaatsen.provincie (supabase/data/bouw_provincies.py).
const PROVINCIES = {
  'drenthe': 'Drenthe', 'friesland': 'Friesland', 'gelderland': 'Gelderland', 'groningen': 'Groningen',
  'limburg': 'Limburg', 'noord-brabant': 'Noord-Brabant', 'noord-holland': 'Noord-Holland',
  'utrecht': 'Utrecht', 'zeeland': 'Zeeland', 'zuid-holland': 'Zuid-Holland', 'overijssel': 'Overijssel',
  'flevoland': 'Flevoland',
  'west-vlaanderen': 'West-Vlaanderen', 'oost-vlaanderen': 'Oost-Vlaanderen', 'antwerpen': 'Antwerpen',
  'belgisch-limburg': 'Limburg (België)', 'vlaams-brabant': 'Vlaams-Brabant', 'waals-brabant': 'Waals-Brabant',
  'henegouwen': 'Henegouwen', 'luik': 'Luik', 'namen': 'Namen', 'belgisch-luxemburg': 'Luxemburg (België)',
  'brussel': 'Brussel',
};
const BE_PROVINCIES = new Set(['west-vlaanderen', 'oost-vlaanderen', 'antwerpen', 'belgisch-limburg', 'vlaams-brabant',
  'waals-brabant', 'henegouwen', 'luik', 'namen', 'belgisch-luxemburg', 'brussel']);

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
  if (!SEO_BUILD_KEY) throw new Error('SEO_BUILD_KEY ontbreekt (Vercel-env of lokaal: export SEO_BUILD_KEY=...)');
  // Via RPC: adres/coördinaten van particuliere verkopen komen er server-side al
  // verborgen/verschoven uit (zie privacy-lockdown.sql).
  // De API geeft maximaal 1000 rijen per keer; daarom in porties ophalen.
  const data = [];
  for (let offset = 0; ; offset += 1000) {
    const url = `${SUPABASE_URL}/rest/v1/rpc/get_listings_seo_build?limit=1000&offset=${offset}`;
    // Mislukt ophalen = build laten falen: dan blijft de vorige deploy live
    // in plaats van een site met 0 verkopen en een lege sitemap.
    let deel = null;
    for (let poging = 1; poging <= 3 && !deel; poging++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_sleutel: SEO_BUILD_KEY }),
      });
      if (res.ok) { deel = await res.json(); break; }
      console.warn(`  listings ophalen mislukt (poging ${poging}):`, res.status, (await res.text()).slice(0, 200));
      await new Promise(r => setTimeout(r, 3000 * poging));
    }
    if (!deel) throw new Error('listings ophalen mislukt na 3 pogingen');
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
      provincie: l.provincie || null,
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

// ─── Verkooppagina in de 3.2-stijl (/v/{id}) ──────────────────────────
// Basis is nieuw/verkoop.html (dezelfde pagina die bezoekers krijgen); de build
// vult de inhoud alvast in, zodat Google alles leest. nieuw/verkoop.js maakt
// hem daarna interactief (kaartje, route, agenda, delen, maak er een dag van).
// NIEUWE_SITE: zolang de nieuwe site nog niet op / staat, gaan bezoekers
// (geen bots) door naar de app, zoals voorheen.
const NIEUWE_SITE = false;
const SOORT_LABEL = { oprit: 'Garagesale', route: 'Rommelroute', markt: 'Markt' };

function vervangVerplicht(html, oud, nieuw, wat) {
  if (!html.includes(oud)) throw new Error(`verkooppagina: ${wat} niet gevonden in nieuw/verkoop.html`);
  return html.replace(oud, nieuw);
}

function renderVerkoopHtml(shell, sale, listings) {
  const soort = soortVan(sale);
  const prive = soort !== 'markt';
  const base = baseFor(sale.land);
  const canonical = `${base}/v/${sale.id}`;
  const city = cityFromAddress(sale.address, sale.city);
  const datum = sale.date ? new Date(sale.date + 'T12:00:00Z') : null;
  const dagKort = datum ? datum.toLocaleDateString('nl-NL', { weekday: 'short', timeZone: 'UTC' }).replace('.', '') : '';
  const wanneer = dagEnTijd(sale);
  const waar = prive || sale.address_hidden || !sale.address ? city : sale.address + (city && !sale.address.includes(city) ? ', ' + city : '');
  const fotos = (sale.photos || []).filter(Boolean);
  const beeld = fotos[0] || `/site/img/${soort}.svg`;
  const titel = `${sale.title}, ${fmtDateShort(sale.date)} in ${city}`;
  const metaDesc = (sale.description || `${SOORT_LABEL[soort]} in ${city} op ${wanneer}. Bekijk wat er te koop is, de route en wat er die dag nog meer in de buurt is.`).slice(0, 200);
  const ogImage = fotos[0] || DEFAULT_OG_IMAGE;

  // Maak er een dag van: dezelfde dag, binnen 15 km, garagesales eerst.
  const volgorde = { oprit: 0, route: 1, markt: 2 };
  const dag = listings.filter(l => l.id !== sale.id && l.date === sale.date && l.lat && sale.lat && distKm(sale, l) <= 15 && l.title !== sale.title)
    .sort((a, b) => (volgorde[soortVan(a)] - volgorde[soortVan(b)]) || distKm(sale, a) - distKm(sale, b)).slice(0, 8);

  const meta = `<title>${esc(titel)} | YardiGo</title>
<meta name="description" content="${esc(metaDesc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="event">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:title" content="${esc(titel)}">
<meta property="og:description" content="${esc(metaDesc)}">
<meta property="og:image" content="${esc(ogImage)}">
<meta property="og:site_name" content="YardiGo">
<meta property="og:locale" content="${ogLocaleFor(sale.land)}">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(buildJsonLd(sale)).replace(/</g, '\\u003c')}</script>
<script>try{var h=(location.hostname||'').toLowerCase();if(h==='yardigo.app'||h==='www.yardigo.app'){var rb=document.createElement('meta');rb.name='robots';rb.content='noindex,follow';document.head.appendChild(rb);}}catch(e){}</script>
${NIEUWE_SITE ? '' : `<script>if(!/bot|crawler|spider|crawling/i.test(navigator.userAgent)){try{sessionStorage.setItem('yg-open-sale',${JSON.stringify(String(sale.id))});}catch(e){}location.replace('/?v='+${JSON.stringify(encodeURIComponent(sale.id))});}</script>`}`;

  let h = shell;
  h = h.replace(/<!--[^>]*Testversie[^>]*-->\n?/, '');
  h = vervangVerplicht(h, '<meta name="robots" content="noindex,nofollow">', '', 'noindex');
  h = h.replace(/<title>[^<]*<\/title>\n<meta name="description" content="[^"]*">/, meta);
  h = vervangVerplicht(h, '<body>', `<body data-id="${esc(sale.id)}">`, 'body');
  h = vervangVerplicht(h, 'id="laden" role="status" data-i18n="det.loading">Verkoop laden…</p>', 'id="laden" role="status" hidden></p>', 'laden');
  h = vervangVerplicht(h, '<div class="yg-det__grid" id="inhoud" hidden>', '<div class="yg-det__grid" id="inhoud">', 'inhoud');
  h = vervangVerplicht(h, 'id="galerij" aria-label=""', `id="galerij" aria-label="${esc(sale.title)}"`, 'galerij');
  h = vervangVerplicht(h, '<img id="groot" src="" alt=""', `<img id="groot" src="${esc(beeld)}" alt="${fotos.length ? esc('Foto 1 van ' + fotos.length + ', ' + sale.title) : ''}"`, 'foto');
  if (fotos.length < 2) {
    h = h.replace('id="vorige"', 'id="vorige" hidden').replace('id="volgende"', 'id="volgende" hidden').replace('<span class="yg-item__n yg-num" id="teller"></span>', '<span class="yg-item__n yg-num" id="teller" hidden></span>');
  }
  if (sale.description) {
    h = vervangVerplicht(h, '<section class="yg-det__block" id="over" hidden', '<section class="yg-det__block" id="over"', 'over');
    h = vervangVerplicht(h, '<p class="yg-det__txt" id="tekst"></p>', `<p class="yg-det__txt" id="tekst">${esc(sale.description)}</p>`, 'tekst');
  }
  h = vervangVerplicht(h, '<span class="yg-badge" id="soort"></span>', `<span class="yg-badge yg-badge--${soort}" id="soort">${SOORT_LABEL[soort]}</span>`, 'soort');
  h = vervangVerplicht(h, '<h1 class="yg-det__h1" id="titel"></h1>', `<h1 class="yg-det__h1" id="titel">${esc(sale.title)}</h1>`, 'titel');
  h = vervangVerplicht(h, '<span id="datum-dag"></span><strong id="datum-nr"></strong>', `<span id="datum-dag">${esc(dagKort)}</span><strong id="datum-nr">${datum ? datum.getUTCDate() : ''}</strong>`, 'datum');
  h = vervangVerplicht(h, '<p id="wanneer"></p>', `<p id="wanneer">${esc(wanneer)}</p>`, 'wanneer');
  h = vervangVerplicht(h, '<p id="waar"></p>', `<p id="waar">${esc(waar)}</p>`, 'waar');
  if (prive) {
    h = vervangVerplicht(h, '<p class="yg-meta" id="adres-info"></p>', '<p class="yg-meta" id="adres-info">Het huisnummer zie je met een gratis account in de app.</p>', 'adres-info');
    h = vervangVerplicht(h, '<a class="yg-btn yg-btn--primary" id="route"', '<a class="yg-btn yg-btn--primary" id="route" hidden', 'route');
    h = vervangVerplicht(h, '<p class="yg-meta" id="benadering" hidden', '<p class="yg-meta" id="benadering"', 'benadering');
  } else if (sale.lat && sale.lng) {
    h = vervangVerplicht(h, 'id="route" href="#"', `id="route" href="https://www.google.com/maps/dir/?api=1&amp;destination=${sale.lat.toFixed(5)},${sale.lng.toFixed(5)}"`, 'route-link');
  }
  h = vervangVerplicht(h, 'id="app" href="/"', `id="app" href="/?v=${esc(sale.id)}"`, 'app-link');
  if (dag.length) {
    h = vervangVerplicht(h, '<section class="yg-section" id="dag" hidden', '<section class="yg-section" id="dag"', 'dag');
    h = vervangVerplicht(h, '<ul class="yg-grid" id="dag-lijst"></ul>', '<ul class="yg-grid" id="dag-lijst">' + dag.map(l => {
      const s2 = soortVan(l), f = (l.photos || [])[0];
      return `<li><a class="yg-item" href="/v/${esc(l.id)}"><span class="yg-item__img"><img src="${esc(f || `/site/img/${s2}.svg`)}" alt="" width="320" height="240" loading="lazy"><span class="yg-badge yg-badge--${s2}">${SOORT_LABEL[s2]}</span></span>` +
        `<span class="yg-item__txt"><span class="yg-item__day yg-item__day--${s2}">${esc(dagEnTijd(l))}</span><strong>${esc(l.title)}</strong><span class="yg-meta">${esc(cityFromAddress(l.address, l.city))}, ${Math.round(distKm(sale, l))} km</span></span></a></li>`;
    }).join('') + '</ul>', 'dag-lijst');
  }
  return h;
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
    const ptel = {};
    for (const s of g.sales) if (s.provincie) ptel[s.provincie] = (ptel[s.provincie] || 0) + 1;
    g.provincie = Object.keys(ptel).sort((a, b) => ptel[b] - ptel[a])[0] || null;
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

// Soort voor de kleur van het kaartje (zelfde indeling als de kaart: site/kaart.js).
function soortVan(s) {
  const sub = String(s.event_subtype || '').toLowerCase();
  if (sub === 'rommelroute' || s.type === 'buurt') return 'route';
  return s.type === 'particulier' ? 'oprit' : 'markt';
}
// "zaterdag 31 oktober, 10:00 tot 15:00"
function dagEnTijd(s) {
  if (!s.date) return '';
  const dag = new Date(s.date + 'T12:00:00Z').toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const uur = t => t ? String(Number(t.slice(0, 2))) + t.slice(2, 5) : '';
  return dag + (s.from ? ', ' + uur(s.from) + (s.till ? ' tot ' + uur(s.till) : '') : '');
}

function saleCardsHtml(sales, fallbackCity, { verleden = false } = {}) {
  let html = '<div class="sales-list">';
  for (const s of sales) {
    const loc = s.address_hidden ? (s.city || fallbackCity) : (s.address || s.city || fallbackCity);
    html += `<a class="sale-card" href="/v/${s.id}" data-date="${esc(s.date)}" data-soort="${soortVan(s)}"${verleden ? ' data-past' : ''}>
        <span class="sc-date">${esc(dagEnTijd(s))}</span>
        <span class="sc-title">${esc(s.title)}</span>
        <span class="sc-loc">${esc(loc)}</span>
      </a>`;
  }
  return html + '</div>';
}

// Cijfers bovenaan, zonder emoji (3.2-stijl).
function statsHtml(items) {
  return items.map(t => `<div class="stat">${String(t).replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, '')}</div>`).join('');
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
    breadcrumbHtml: `<a href="/">Home</a> › <a href="/${group.path}/">${esc(group.label)}</a> › `
      + (group.provincie && PROVINCIES[group.provincie] ? `<a href="/${group.path}/provincie/${group.provincie}">${esc(PROVINCIES[group.provincie])}</a> › ` : '')
      + esc(cityHuman),
    statsHtml: statsHtml([
      `<strong>${group.upcoming.length}</strong> komende ${group.upcoming.length === 1 ? 'verkoop' : 'verkopen'}`,
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

  const provs = provincieTelling(t, listings, today);
  if (provs.length) {
    grid = `<section><h2>Per provincie</h2><div class="nearby-grid">`
      + provs.map(([slug, n]) => `<a class="nearby-link" href="/${t.path}/provincie/${slug}">${esc(PROVINCIES[slug])} <span style="color:#9A8E82;font-weight:500;font-size:11px">(${n})</span></a>`).join('')
      + '</div></section>' + grid;
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

// Aantal komende verkopen per provincie voor één soort, grootste eerst.
function provincieTelling(t, listings, today) {
  const tel = {};
  for (const l of listings) {
    if (!t.categories.includes(l.category) || l.date < today || !PROVINCIES[l.provincie]) continue;
    tel[l.provincie] = (tel[l.provincie] || 0) + 1;
  }
  return Object.entries(tel).sort((a, b) => b[1] - a[1]);
}

function renderProvincieHtml(template, t, slug, listings, groups) {
  const today = dagNL();
  const naam = PROVINCIES[slug];
  const land = BE_PROVINCIES.has(slug) ? 'be' : 'nl';
  const base = baseFor(land);
  const komend = listings
    .filter(l => t.categories.includes(l.category) && l.provincie === slug && l.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  const plaatsen = [...groups.values()]
    .filter(g => g.path === t.path && g.provincie === slug && g.indexeren)
    .sort((a, b) => b.upcoming.length - a.upcoming.length || a.city.localeCompare(b.city));
  const canonical = `${base}/${t.path}/provincie/${slug}`;

  let grid = '';
  if (plaatsen.length) {
    grid = `<section><h2>Plaatsen in ${esc(naam)}</h2><div class="nearby-grid">`
      + plaatsen.map(g => `<a class="nearby-link" href="/${t.path}/${g.citySlug}">${esc(g.city)} <span style="color:#9A8E82;font-weight:500;font-size:11px">(${g.upcoming.length})</span></a>`).join('')
      + '</div></section>';
  }

  return fillLanding(template, {
    titleTag: `${t.label} ${naam}: komende ${t.labelPlural}`,
    indexeren: komend.length > 0,
    ogLocale: ogLocaleFor(land),
    breadcrumbHtml: `<a href="/">Home</a> › <a href="/${t.path}/">${esc(t.label)}</a> › ${esc(naam)}`,
    statsHtml: statsHtml([
      `📅 <strong>${komend.length}</strong> komende ${esc(t.labelPlural)}`,
      `📍 <strong>${plaatsen.length}</strong> plaatsen`,
    ]),
    listTitle: `Komende ${t.labelPlural} in ${naam}`,
    listHtml: komend.length
      ? saleCardsHtml(komend.slice(0, 40), '')
      : `<div class="empty-box">Er staan nu geen ${esc(t.labelPlural)} in ${esc(naam)} gepland. Zet in de app een melding aan, dan hoor je het als er een bijkomt.</div>`,
    extraHtml: grid,
    nearbyHtml: '',
    labelSingular: t.labelSingular,
    h1: `${t.label} in ${naam}: komende verkopen`,
    intro: `Alle ${t.labelPlural} in ${naam} die op YardiGo staan, met datum, tijd en plaats. Kies een plaats voor meer details, foto's en route.`,
    metaDesc: `Komende ${t.labelPlural} in ${naam}: datum, tijd, plaats en route. Bekijk wat er bij jou in de buurt is en plaats gratis je eigen.`,
    canonical,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: base + '/' },
            { '@type': 'ListItem', position: 2, name: t.label, item: `${BASE_URL}/${t.path}/` },
            { '@type': 'ListItem', position: 3, name: naam, item: canonical },
          ],
        },
        {
          '@type': 'ItemList',
          name: `${t.label} ${naam}`,
          itemListElement: komend.slice(0, 10).map((s, i) => ({
            '@type': 'ListItem', position: i + 1, url: `${baseFor(s.land)}/v/${s.id}`, name: s.title,
          })),
        },
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
// ─── Kringloop en tweedehands per plaats ───────────────────────────────
// Bron: tabel winkels (OpenStreetMap), via get_winkels_publiek (alleen
// openbare velden). Een pagina per plaats met minstens KRINGLOOP_MIN winkels;
// daaronder winkels binnen KRINGLOOP_KM en wat er de komende twee weken aan
// verkopen in de buurt is, om er een dag van te maken. Mislukt het ophalen,
// dan slaat de build dit deel over (de rest van de site gaat gewoon door).
const KRINGLOOP_MIN = 2;
const KRINGLOOP_KM = 10;
const WINKEL_SOORT = { kringloop: 'Kringloop', tweedehands: 'Tweedehands', antiek: 'Antiek en brocante', goede_doel: 'Goed doel' };
const OSM_DAGEN = { Mo: 'ma', Tu: 'di', We: 'wo', Th: 'do', Fr: 'vr', Sa: 'za', Su: 'zo', PH: 'feestdagen' };

async function fetchWinkels() {
  try {
    // De API geeft maximaal 1000 rijen per keer; daarom in porties.
    const data = [];
    for (let offset = 0; ; offset += 1000) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_winkels_publiek?order=id&limit=1000&offset=${offset}`, {
        method: 'POST',
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const deel = await res.json();
      data.push(...deel);
      if (deel.length < 1000) break;
    }
    return data.map(w => ({ ...w, lat: w.latitude, lng: w.longitude }));
  } catch (e) {
    console.warn('  winkels ophalen mislukt, kringlooppagina\'s overgeslagen:', e.message);
    return null;
  }
}

// OSM-openingstijden leesbaar maken: "Mo-Fr 09:00-17:00; Sa 10:00-16:00" → "ma-vr 09:00-17:00, za 10:00-16:00".
function openingNL(t) {
  if (!t) return '';
  return String(t).replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH)\b/g, d => OSM_DAGEN[d]).replace(/\boff\b/g, 'gesloten').replace(/\s*;\s*/g, ', ');
}

// Zelfde plaats onder andere namen (OSM of GeoNames): samen onder de gangbare naam.
const PLAATS_ALIAS = { 's-gravenhage': 'Den Haag', 'brussels': 'Brussel', 'bruxelles': 'Brussel', 'brussel': 'Brussel', 'antwerp': 'Antwerpen', 'anvers': 'Antwerpen', 'ghent': 'Gent', 'gand': 'Gent', 'bruges': 'Brugge', 'louvain': 'Leuven', 'the-hague': 'Den Haag' };

function buildKringloopGroepen(winkels) {
  const groepen = new Map();
  for (const w of winkels) {
    w.plaats = String(w.plaats || '').replace(/^(Gemeente|Commune de|Stad) /i, '');
    if (PLAATS_ALIAS[slugify(w.plaats)]) w.plaats = PLAATS_ALIAS[slugify(w.plaats)];
    const slug = slugify(w.plaats);
    if (!slug || slug.length < 3 || SKIP_CITIES.has(slug)) continue;
    if (!groepen.has(slug)) groepen.set(slug, { slug, plaats: w.plaats, eigen: [], tel: {} });
    const g = groepen.get(slug);
    g.eigen.push(w);
    g.tel[w.land] = (g.tel[w.land] || 0) + 1;
  }
  for (const [slug, g] of groepen) {
    if (g.eigen.length < KRINGLOOP_MIN) { groepen.delete(slug); continue; }
    g.land = Object.keys(g.tel).sort((a, b) => g.tel[b] - g.tel[a])[0] === 'be' ? 'be' : 'nl';
    g.base = baseFor(g.land);
    g.center = { lat: g.eigen.reduce((t, w) => t + w.lat, 0) / g.eigen.length, lng: g.eigen.reduce((t, w) => t + w.lng, 0) / g.eigen.length };
    const ids = new Set(g.eigen.map(w => w.id));
    g.omgeving = winkels.filter(w => !ids.has(w.id) && distKm(g.center, w) <= KRINGLOOP_KM)
      .map(w => ({ ...w, km: distKm(g.center, w) })).sort((a, b) => a.km - b.km).slice(0, 12);
  }
  return groepen;
}

function winkelKaartjesHtml(lijst, metKm) {
  let html = '<div class="sales-list">';
  for (const w of lijst) {
    const adres = [[w.straat, w.huisnummer].filter(Boolean).join(' '), w.plaats].filter(Boolean).join(', ');
    const tijden = openingNL(w.openingstijden);
    html += `<div class="sale-card" data-soort="winkel">
        <span class="sc-date">${esc(WINKEL_SOORT[w.soort] || 'Tweedehands')}${metKm ? `, ${w.km.toFixed(0)} km` : ''}</span>
        <span class="sc-title">${esc(w.naam || 'Kringloopwinkel')}</span>
        <span class="sc-loc">${esc(adres)}</span>
        ${tijden ? `<span class="sc-loc">Open: ${esc(tijden)}</span>` : ''}
        ${w.website && /^https?:\/\//.test(w.website) ? `<span class="sc-loc"><a href="${esc(w.website)}" rel="nofollow noopener" target="_blank">Website</a></span>` : ''}
      </div>`;
  }
  return html + '</div>';
}

function renderKringloopHtml(template, g, groepen, listings) {
  const canonical = `${g.base}/kringloop/${g.slug}`;
  const vandaag = dagNL(), tot = plusDagen(vandaag, 14);
  const verkopen = listings.filter(l => l.date >= vandaag && l.date <= tot && l.lat && distKm(g.center, l) <= 15)
    .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8);
  const buren = [...groepen.values()].filter(o => o.slug !== g.slug && distKm(g.center, o.center) < 40)
    .map(o => ({ o, d: distKm(g.center, o.center) })).sort((a, b) => a.d - b.d).slice(0, 12);
  let extra = '';
  if (g.omgeving.length) extra += `<section><h2>Ook binnen ${KRINGLOOP_KM} km van ${esc(g.plaats)}</h2>${winkelKaartjesHtml(g.omgeving, true)}</section>`;
  if (verkopen.length) extra += `<section><h2>Maak er een dag van: verkopen in de buurt</h2><p>Garagesales, rommelroutes en rommelmarkten binnen 15 km in de komende twee weken.</p>${saleCardsHtml(verkopen, g.plaats)}</section>`;
  extra += '<p style="font-size:13px;color:#55625A">Winkelgegevens: © OpenStreetMap-bijdragers (ODbL). Klopt er iets niet? Pas het aan op openstreetmap.org.</p>';
  let nearbyHtml = '';
  if (buren.length) {
    nearbyHtml = '<section><h2>Kringloopwinkels in andere plaatsen in de buurt</h2><div class="nearby-grid">'
      + buren.map(({ o, d }) => `<a class="nearby-link" href="/kringloop/${o.slug}">${esc(o.plaats)} <span style="color:#9A8E82;font-weight:500;font-size:11px">(${d.toFixed(0)} km)</span></a>`).join('')
      + '</div></section>';
  }
  const n = g.eigen.length;
  return fillLanding(template, {
    titleTag: `Kringloopwinkels in ${g.plaats}: adressen en openingstijden`,
    indexeren: true,
    ogLocale: ogLocaleFor(g.land),
    breadcrumbHtml: `<a href="/">Home</a> › <a href="/kringloop/">Kringloopwinkels</a> › ${esc(g.plaats)}`,
    statsHtml: statsHtml([
      `🏪 <strong>${n}</strong> winkels in ${esc(g.plaats)}`,
      `📍 <strong>${g.omgeving.length}</strong> binnen ${KRINGLOOP_KM} km`,
      verkopen.length ? `📅 <strong>${verkopen.length}</strong> verkopen in de buurt` : '🆓 Gratis te bekijken',
    ]),
    listTitle: `Kringloop- en tweedehandswinkels in ${g.plaats}`,
    listHtml: winkelKaartjesHtml(g.eigen.sort((a, b) => (a.naam || '').localeCompare(b.naam || '')), false),
    extraHtml: extra, nearbyHtml, labelSingular: 'garagesale',
    h1: `Kringloopwinkels in ${g.plaats}`,
    intro: `Alle ${n} kringloop-, tweedehands-, antiek- en goede-doelenwinkels in ${g.plaats} met adres en openingstijden. Combineer ze met een garagesale of rommelmarkt in de buurt voor een dag snuffelen.`,
    metaDesc: `${n} kringloop- en tweedehandswinkels in ${g.plaats} met adres en openingstijden, plus garagesales en rommelmarkten in de buurt.`,
    canonical,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'BreadcrumbList', itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: g.base + '/' },
          { '@type': 'ListItem', position: 2, name: 'Kringloopwinkels', item: `${BASE_URL}/kringloop/` },
          { '@type': 'ListItem', position: 3, name: g.plaats, item: canonical },
        ] },
        { '@type': 'ItemList', name: `Kringloopwinkels in ${g.plaats}`, itemListElement: g.eigen.slice(0, 20).map((w, i) => ({
          '@type': 'ListItem', position: i + 1,
          item: {
            '@type': 'Store', name: w.naam || 'Kringloopwinkel',
            address: { '@type': 'PostalAddress', streetAddress: [w.straat, w.huisnummer].filter(Boolean).join(' ') || undefined, postalCode: w.postcode || undefined, addressLocality: w.plaats, addressCountry: (w.land || 'nl').toUpperCase() },
            geo: { '@type': 'GeoCoordinates', latitude: w.lat, longitude: w.lng },
            ...(w.openingstijden ? { openingHours: w.openingstijden } : {}),
            ...(w.website && /^https?:\/\//.test(w.website) ? { url: w.website } : {}),
          },
        })) },
      ],
    },
  });
}

function renderKringloopIndexHtml(template, groepen, totaal) {
  const lijst = [...groepen.values()].sort((a, b) => b.eigen.length - a.eigen.length);
  const links = '<div class="nearby-grid">' + lijst.map(g => `<a class="nearby-link" href="/kringloop/${g.slug}">${esc(g.plaats)} <span style="color:#9A8E82;font-weight:500;font-size:11px">(${g.eigen.length})</span></a>`).join('') + '</div>';
  return fillLanding(template, {
    titleTag: 'Kringloopwinkels per plaats in Nederland en België',
    indexeren: true, ogLocale: 'nl_NL',
    breadcrumbHtml: '<a href="/">Home</a> › Kringloopwinkels',
    statsHtml: statsHtml([`🏪 <strong>${totaal}</strong> winkels`, `📍 <strong>${lijst.length}</strong> plaatsen`, '🆓 Gratis te bekijken']),
    listTitle: 'Kies een plaats', listHtml: links,
    extraHtml: '<p style="font-size:13px;color:#55625A">Winkelgegevens: © OpenStreetMap-bijdragers (ODbL).</p>',
    nearbyHtml: '', labelSingular: 'garagesale',
    h1: 'Kringloopwinkels per plaats',
    intro: 'Kringloop-, tweedehands-, antiek- en goede-doelenwinkels in Nederland en België, met adres en openingstijden. Kies je plaats en zie ook welke garagesales en rommelmarkten er in de buurt zijn.',
    metaDesc: `${totaal} kringloop- en tweedehandswinkels in ${lijst.length} plaatsen in Nederland en België, met adres en openingstijden.`,
    canonical: `${BASE_URL}/kringloop/`,
    jsonLd: { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: BASE_URL + '/' },
      { '@type': 'ListItem', position: 2, name: 'Kringloopwinkels', item: `${BASE_URL}/kringloop/` },
    ] },
  });
}

// Eén sitemap per domein. Omdat dezelfde bestanden op elk domein staan, is
// https://www.yardigo.be/sitemap-be.xml gewoon bereikbaar.
function buildSitemaps(listings, landingGroups, types, provPaginas = [], kringloop = null) {
  const today = dagNL();
  const per = { [BASE_URL]: [], [BASE_URL_BE]: [] };
  per[BASE_URL].push({ loc: BASE_URL + '/', lastmod: today, changefreq: 'daily', priority: '1.0' });
  per[BASE_URL_BE].push({ loc: BASE_URL_BE + '/', lastmod: today, changefreq: 'daily', priority: '1.0' });
  per[BASE_URL_BE].push({ loc: BASE_URL_BE + '/fr', lastmod: today, changefreq: 'daily', priority: '0.9' });
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
  for (const p of provPaginas) {
    if (!p.indexeren) continue;
    const b = baseFor(BE_PROVINCIES.has(p.slug) ? 'be' : 'nl');
    per[b].push({ loc: `${b}/${p.t.path}/provincie/${p.slug}`, lastmod: today, changefreq: 'daily', priority: '0.8' });
  }
  if (kringloop) {
    per[BASE_URL].push({ loc: `${BASE_URL}/kringloop/`, lastmod: today, changefreq: 'weekly', priority: '0.7' });
    for (const [, g] of kringloop) per[g.base].push({ loc: `${g.base}/kringloop/${g.slug}`, lastmod: today, changefreq: 'weekly', priority: '0.6' });
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

// Zoekmachines (Google, Bing, Apple, DuckDuckGo) en AI-zoekdiensten die
// bezoekers doorsturen mogen alles lezen. AI-trainingscrawlers en
// SEO-/datascrapers niet: die nemen ons aanbod over zonder iets terug te geven.
// Let op: robots.txt is een verzoek; nette bots houden zich eraan, kwaadwillende niet.
const GEBLOKKEERDE_BOTS = [
  'GPTBot', 'ClaudeBot', 'anthropic-ai', 'CCBot', 'Google-Extended', 'Applebot-Extended',
  'Bytespider', 'meta-externalagent', 'FacebookBot', 'Amazonbot', 'cohere-ai', 'cohere-training-data-crawler',
  'Diffbot', 'ImagesiftBot', 'Omgilibot', 'Omgili', 'Timpibot', 'Webzio-Extended', 'AI2Bot', 'img2dataset',
  'AhrefsBot', 'SemrushBot', 'MJ12bot', 'DotBot', 'DataForSeoBot', 'BLEXBot', 'PetalBot', 'SeekportBot', 'Scrapy',
];

function buildRobotsTxt() {
  return GEBLOKKEERDE_BOTS.map((b) => `User-agent: ${b}\nDisallow: /\n`).join('\n') + `
User-agent: *
Allow: /
Disallow: /admin.html
Disallow: /bevestig.html
Disallow: /tg
Disallow: /herhaal
Disallow: /doe-mee
Disallow: /locale/

Sitemap: ${BASE_URL}/sitemap.xml
Sitemap: ${BASE_URL_BE}/sitemap-be.xml
`;
}

// Nederlandstalige startpagina voor yardigo.be. index.html is één bestand voor alle domeinen
// en had in de ruwe HTML canonical/lang/titel van .nl; JS zette dat pas later
// goed. middleware.js serveert deze variant op yardigo.be/. Frans staat op
// /fr (fr.html). Teksten gelijk aan I18N.nl in index.html.
const BE_STARTPAGINAS = [
  {
    bestand: 'locale/be-nl.html', lang: 'nl-BE', url: BASE_URL_BE + '/', ogLocale: 'nl_BE',
    titel: 'YardiGo: Ontdek garagesales bij jou in de buurt',
    beschrijving: 'Vind rommelmarkten, rommelroutes en garagesales op de kaart. Plan je route, ontdek schatten bij jou om de hoek en plaats gratis je eigen verkoop.',
    ogBeschrijving: 'Vind rommelmarkten, rommelroutes en garagesales op de kaart. Plan je route en plaats gratis je eigen verkoop.',
    twBeschrijving: 'Vind rommelmarkten, rommelroutes en garagesales op de kaart.',
  },
];

function renderBeStartpagina(html, p) {
  const vervang = (re, nieuw) => {
    if (!re.test(html)) throw new Error(`startpagina ${p.bestand}: ${re} niet gevonden in index.html`);
    html = html.replace(re, nieuw);
  };
  vervang(/<html lang="[^"]*">/, `<html lang="${p.lang}">`);
  vervang(/<title>[^<]*<\/title>/, `<title>${esc(p.titel)}</title>`);
  vervang(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(p.beschrijving)}">`);
  vervang(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${p.url}">`);
  vervang(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${p.url}">`);
  vervang(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(p.titel)}">`);
  vervang(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(p.ogBeschrijving)}">`);
  vervang(/<meta property="og:locale" content="[^"]*">/, `<meta property="og:locale" content="${p.ogLocale}">`);
  vervang(/<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${esc(p.titel)}">`);
  vervang(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${esc(p.twBeschrijving)}">`);
  return html;
}

function schrijfBeStartpaginas() {
  const index = readFileSync(resolve(PROJECT_ROOT, 'index.html'), 'utf-8');
  mkdirSync(resolve(PROJECT_ROOT, 'locale'), { recursive: true });
  for (const p of BE_STARTPAGINAS) writeFileSync(resolve(PROJECT_ROOT, p.bestand), renderBeStartpagina(index, p));
  console.log(`  wrote Belgische startpagina → /locale/be-nl.html`);
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
  schrijfBeStartpaginas();

  const shell = readFileSync(resolve(PROJECT_ROOT, 'nieuw/verkoop.html'), 'utf-8');
  const listings = await fetchListings();
  console.log(`  fetched ${listings.length} listings`);

  let rendered = 0;
  for (const sale of listings) {
    try {
      schrijfPagina(`v/${sale.id}`, renderVerkoopHtml(shell, sale, listings));
      rendered++;
    } catch (e) {
      console.warn(`  skip ${sale.id}:`, e.message);
    }
  }
  console.log(`  rendered ${rendered} verkooppagina's (3.2) → /v/{id}/index.html`);

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

  // Provinciepagina's: alleen provincies die ooit een verkoop van deze soort hadden.
  const provPaginas = [];
  const vandaag = dagNL();
  for (const t of types) {
    const slugs = new Set(listings.filter(l => t.categories.includes(l.category) && PROVINCIES[l.provincie]).map(l => l.provincie));
    const metKomend = new Set(provincieTelling(t, listings, vandaag).map(([slug]) => slug));
    for (const slug of slugs) {
      schrijfPagina(`${t.path}/provincie/${slug}`, renderProvincieHtml(landingTemplate, t, slug, listings, landingGroups));
      provPaginas.push({ t, slug, indexeren: metKomend.has(slug) });
    }
  }
  console.log(`  rendered ${provPaginas.length} provinciepagina's`);

  // Kringloop per plaats.
  const winkels = await fetchWinkels();
  let kringloop = null;
  if (winkels) {
    kringloop = buildKringloopGroepen(winkels);
    for (const [, g] of kringloop) schrijfPagina(`kringloop/${g.slug}`, renderKringloopHtml(landingTemplate, g, kringloop, listings));
    schrijfPagina('kringloop', renderKringloopIndexHtml(landingTemplate, kringloop, winkels.length));
    console.log(`  rendered ${kringloop.size} kringlooppagina's (${winkels.length} winkels)`);
  }

  const sm = buildSitemaps(listings, landingGroups, types, provPaginas, kringloop);
  writeFileSync(resolve(PROJECT_ROOT, 'sitemap.xml'), sm.nl);
  writeFileSync(resolve(PROJECT_ROOT, 'sitemap-be.xml'), sm.be);
  writeFileSync(resolve(PROJECT_ROOT, 'robots.txt'), buildRobotsTxt());
  console.log(`  wrote sitemap.xml (${sm.aantallen.nl}) + sitemap-be.xml (${sm.aantallen.be}) + robots.txt`);

  console.log('✓ Prerender complete');
}

main().catch(e => { console.error('Prerender failed:', e); process.exit(1); });
