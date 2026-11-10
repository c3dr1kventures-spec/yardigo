// YardiGo: gedeelde route lezen voor de deelvoorvertoning (api/route-deel.js
// en api/route-og.js). Vercel maakt van bestanden met een _ geen eigen endpoint.
//
// Twee soorten deellinks (site/route.js, deelLink en deel):
//   /route/<code>     route uit een account, via get_gedeelde_route (nooit start/eind)
//   /route?stops=…    base64url van JSON: oud een rij stops, nieuw { n, d, t, v, s }
// Per stop: [id, titel, soort, lat, lng, plaats, sub, benadering, van, tot, begin, eind, tijden].
// Een echt adres van een garagesale zit er nooit in (afgerond op ~1 km).

export const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://fwehqudhwzcnkcuypuqw.supabase.co';
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3ZWhxdWRod3pjbmtjdXlwdXF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzOTQwNzgsImV4cCI6MjA4OTk3MDA3OH0.A5mPApoGySr97niz6QLZGFSDhsfCqOwi-k8v58mHjMI';

const SOORTEN = ['oprit', 'route', 'markt', 'winkel'];
const tekst = (x, n) => (typeof x === 'string' ? x.slice(0, n || 120) : '');
const dag = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(x || '') ? x : null);

function goedeStop(s) {
  return s && SOORTEN.includes(s.soort) && Number.isFinite(+s.lat) && Number.isFinite(+s.lng) && Math.abs(+s.lat) <= 90 && Math.abs(+s.lng) <= 180;
}

function uitLink(ruw) {
  try {
    const b = ruw.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
    const pak = JSON.parse(new TextDecoder().decode(bytes));
    const rij = Array.isArray(pak) ? pak : pak && Array.isArray(pak.s) ? pak.s : null;
    if (!rij) return null;
    const stops = rij.slice(0, 25).filter(Array.isArray).map((x) => ({
      titel: tekst(x[1]), soort: x[2], lat: +x[3], lng: +x[4], plaats: tekst(x[5]), van: dag(x[8]),
    })).filter(goedeStop);
    if (!stops.length) return null;
    return { naam: Array.isArray(pak) ? '' : tekst(pak.n, 80), datum: Array.isArray(pak) ? null : dag(pak.d), vervoer: Array.isArray(pak) ? 'auto' : pak.v || 'auto', stops };
  } catch (_) {
    return null;
  }
}

async function uitAccount(code) {
  if (!/^[A-Za-z0-9]{8,16}$/.test(code || '')) return null;
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/get_gedeelde_route', {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_code: code }),
    });
    if (!r.ok) return null;
    const x = (await r.json())[0];
    if (!x || !Array.isArray(x.stops)) return null;
    const stops = x.stops.filter(goedeStop).slice(0, 50).map((s) => ({
      titel: tekst(s.titel), soort: s.soort, lat: +s.lat, lng: +s.lng, plaats: tekst(s.plaats), van: dag(s.van),
    }));
    if (!stops.length) return null;
    return { naam: tekst(x.naam, 80), datum: dag(x.datum), vervoer: x.vervoer || 'auto', stops };
  } catch (_) {
    return null;
  }
}

// { code } of { stops } (de ruwe waarde van ?stops=) → route of null.
export async function leesRoute({ code, stops }) {
  if (code) return uitAccount(code);
  if (stops) return uitLink(stops);
  return null;
}

// De dag van de route: de gekozen datum, anders de eerste dag van een verkoop.
export function routeDag(r) {
  if (r.datum) return r.datum;
  const d = r.stops.map((s) => s.van).filter(Boolean).sort()[0];
  return d || null;
}

export function datumKort(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00Z');
  if (isNaN(d.getTime())) return '';
  const dagen = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
  const maanden = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  return `${dagen[d.getUTCDay()]} ${d.getUTCDate()} ${maanden[d.getUTCMonth()]}`;
}

// Plaatsen in volgorde, zonder dubbele na elkaar: "Assen → Norg → Roden".
export function plaatsen(r, max) {
  const uit = [];
  r.stops.forEach((s) => { const p = s.plaats || s.titel; if (p && uit[uit.length - 1] !== p) uit.push(p); });
  const n = max || 4;
  return uit.length > n ? uit.slice(0, n).join(' → ') + ' …' : uit.join(' → ');
}

export function routeTitel(r) {
  return r.naam || `Route met ${r.stops.length} ${r.stops.length === 1 ? 'stop' : 'stops'}`;
}

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const CRAWLER_RE = /(facebookexternalhit|facebookcatalog|WhatsApp|Twitterbot|LinkedInBot|TelegramBot|Slackbot|Slack-ImgProxy|Discordbot|Googlebot|bingbot|Pinterest|Applebot|redditbot|SkypeUriPreview|Iframely|vkShare|Embedly|Signal)/i;
