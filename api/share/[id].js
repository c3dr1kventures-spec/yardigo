// YardiGo — /api/share/[id]  (Vercel Edge runtime)
//
// Dynamische router voor /v/:id shares:
//   - Crawler (Facebook/WhatsApp/Twitter/…): return kleine HTML met
//     per-event OG-tags + JSON-LD. og:image wijst naar /api/og/[id].
//   - Gewone bezoeker: fetch de SPA index.html van dezelfde deployment
//     en stuur die door. Daarmee blijft de URL /v/:id staan en pakt de
//     bestaande handleSaleDeepLink() in index.html het id op uit
//     location.pathname (zoals we in commit a60fea0 hebben gebouwd).
//
// Waarom fetch-approach voor bezoekers (i.p.v. redirect of nog een
// rewrite): een Vercel-rewrite kan niet éérst een filesystem-match
// forceren zodra dit endpoint hit is, dus we hebben zelf een HTML nodig.
// Redirecten naar /?v=<id> zou de URL veranderen (slechte UX +
// share-links komen daarmee terug op de root). Fetch behoudt /v/:id in
// de adresbalk en werkt betrouwbaar in Vercel Edge same-origin.
//
// Privacy: we selecteren uitsluitend publieke velden (title,
// event_subtype, category, date_start, date_end, time_start, time_end,
// city, status, confirmation_status). GEEN address / latitude /
// longitude — die worden nergens in de OG-response opgenomen.

export const config = { runtime: 'edge' };

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://fwehqudhwzcnkcuypuqw.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3ZWhxdWRod3pjbmtjdXlwdXF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzOTQwNzgsImV4cCI6MjA4OTk3MDA3OH0.A5mPApoGySr97niz6QLZGFSDhsfCqOwi-k8v58mHjMI';

const BASE_URL = 'https://www.yardigo.nl';

// Crawler-detectie: lijst gebaseerd op de social/search-scanners die
// standaard OG-previews genereren. Case-insensitive match.
const CRAWLER_RE = /(facebookexternalhit|WhatsApp|Twitterbot|LinkedInBot|TelegramBot|Slackbot|Slack-ImgProxy|Discordbot|Googlebot|bingbot|Pinterest|Applebot|YandexBot|DuckDuckBot|Baiduspider)/i;

const EVENT_SUBTYPE_LABEL = {
  rommelmarkt:   'Rommelmarkt',
  vlooienmarkt:  'Vlooienmarkt',
  braderie:      'Braderie',
  kerstmarkt:    'Kerstmarkt',
  antiekmarkt:   'Antiekmarkt',
  boekenmarkt:   'Boekenmarkt',
  kofferbak:     'Kofferbakverkoop',
  rommelroute:   'Rommelroute',
  opritverkoop:  'Opritverkoop',
  buurtverkoop:  'Rommelroute',
};

const CATEGORY_LABEL = {
  garagesale:       'Opritverkoop',
  garageverkoop:    'Opritverkoop',
  rommelmarkt:      'Rommelmarkt',
  vlooienmarkt:     'Vlooienmarkt',
  kofferbakverkoop: 'Kofferbakverkoop',
  buurtverkoop:     'Rommelroute',
  overig:           'Verkoop',
};

function typeLabel(ev) {
  return (ev && (EVENT_SUBTYPE_LABEL[ev.event_subtype] || CATEGORY_LABEL[ev.category])) || 'Verkoop';
}

function fmtDateNl(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  const days = ['zondag','maandag','dinsdag','woensdag','donderdag','vrijdag','zaterdag'];
  const months = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractIdFromPath(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  const last = parts[parts.length - 1] || '';
  // Alleen UUID-achtige/simpele slugs door — bescherming tegen path-traversal
  return /^[A-Za-z0-9._-]{1,80}$/.test(last) ? last : '';
}

async function fetchEvent(id) {
  if (!id) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/listings`
      + `?id=eq.${encodeURIComponent(id)}`
      + `&select=id,title,event_subtype,category,date_start,date_end,time_start,time_end,city,status,confirmation_status`;
    const r = await fetch(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    if (row.status && !['active','published'].includes(row.status)) return null;
    if (row.confirmation_status && row.confirmation_status !== 'confirmed') return null;
    return row;
  } catch (_) {
    return null;
  }
}

function buildJsonLd(id, ev) {
  if (!ev || !ev.date_start) return null;
  const from = (ev.time_start || '09:00').slice(0, 5);
  const till = (ev.time_end   || '17:00').slice(0, 5);
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: ev.title || typeLabel(ev),
    startDate: `${ev.date_start}T${from}:00`,
    endDate:   `${ev.date_end || ev.date_start}T${till}:00`,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: {
      '@type': 'Place',
      name: ev.city || 'Locatie',
      address: {
        '@type': 'PostalAddress',
        addressLocality: ev.city || '',
        addressCountry: 'NL',
      },
    },
    image: [`${BASE_URL}/api/og/${encodeURIComponent(id)}`],
    organizer: { '@type': 'Organization', name: 'YardiGo', url: BASE_URL },
    url: `${BASE_URL}/v/${encodeURIComponent(id)}`,
  });
}

function buildOgHtml(id, ev) {
  const canonical  = `${BASE_URL}/v/${encodeURIComponent(id)}`;
  const ogImageUrl = `${BASE_URL}/api/og/${encodeURIComponent(id)}`;

  let title, desc;
  if (ev) {
    const label   = typeLabel(ev);
    const dateStr = fmtDateNl(ev.date_start);
    const from    = (ev.time_start || '').slice(0, 5);
    const till    = (ev.time_end   || '').slice(0, 5);
    const tijden  = from && till ? `${from}–${till}` : (from || till);
    const city    = ev.city || 'de buurt';
    const evTitle = ev.title || label;
    title = `${evTitle} · ${dateStr} in ${city} | YardiGo`;
    desc  = `${label} op ${dateStr}${tijden ? ' · ' + tijden : ''} in ${city}. Bekijk op de kaart via YardiGo.`;
  } else {
    // Event niet (meer) actief → fallback naar generieke meta i.p.v. 404
    title = 'YardiGo — Garagesales bij jou in de buurt';
    desc  = "Vind rommelmarkten en garageverkopen bij jou in de buurt. Route, foto's en het volledige overzicht op YardiGo.";
  }

  const jsonLd = ev ? buildJsonLd(id, ev) : null;

  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">

<meta property="og:type"          content="website">
<meta property="og:site_name"     content="YardiGo">
<meta property="og:locale"        content="nl_NL">
<meta property="og:url"           content="${canonical}">
<meta property="og:title"         content="${esc(title)}">
<meta property="og:description"   content="${esc(desc)}">
<meta property="og:image"         content="${ogImageUrl}">
<meta property="og:image:width"   content="1200">
<meta property="og:image:height"  content="630">
<meta property="og:image:type"    content="image/png">
<meta property="og:image:alt"     content="${esc(title)}">

<meta name="twitter:card"         content="summary_large_image">
<meta name="twitter:title"        content="${esc(title)}">
<meta name="twitter:description"  content="${esc(desc)}">
<meta name="twitter:image"        content="${ogImageUrl}">
${jsonLd ? `<script type="application/ld+json">${jsonLd}</script>` : ''}
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:32px;color:#2C2416;background:#FEF6EE">
<p style="font-size:16px;line-height:1.5;max-width:640px">
  ${esc(desc)}
  <br><br>
  <a href="${canonical}" style="color:#E07B39;font-weight:700">Open op yardigo.nl →</a>
</p>
</body>
</html>`;
}

export default async function handler(req) {
  const url = new URL(req.url);
  const id  = extractIdFromPath(url.pathname);
  const ua  = req.headers.get('user-agent') || '';
  const isCrawler = CRAWLER_RE.test(ua);

  // ── Gewone bezoeker: serveer SPA ─────────────────────────────
  if (!isCrawler) {
    try {
      const spaUrl = new URL('/index.html', url.origin);
      const spaRes = await fetch(spaUrl.toString(), { headers: { accept: 'text/html' } });
      if (spaRes.ok) {
        const html = await spaRes.text();
        return new Response(html, {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            // Kortere cache voor bezoekers zodat SPA-updates snel doorkomen
            'cache-control': 'public, s-maxage=60, stale-while-revalidate=3600',
          },
        });
      }
    } catch (_) { /* fallthrough naar redirect */ }
    // Fallback als /index.html niet bereikbaar: 302 naar root met ?v=
    // (SPA-handleSaleDeepLink pakt dat óók op).
    return new Response(null, {
      status: 302,
      headers: { location: '/?v=' + encodeURIComponent(id) },
    });
  }

  // ── Crawler: fetch event + return OG HTML ───────────────────
  const ev = await fetchEvent(id);
  const html = buildOgHtml(id, ev);
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Langere cache voor crawlers — Supabase wordt niet per share-hit geraakt
      'cache-control': 'public, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
