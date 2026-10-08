// YardiGo – import-meukisleuk Edge Function
//
// Leest de agenda van meukisleuk.nl als LEAD-bron. Meukisleuk zelf komt nooit
// in beeld: de listing krijgt de website van de organisator als bron (als die
// er is) en de contactgegevens gaan naar listing_contacts (alleen zichtbaar
// voor ingelogde gebruikers).
//
// Werkwijze per run:
//   A. Lijstpagina's doorlopen vanaf een cursor (app_config
//      'meukisleuk_cursor'), detail-URL's verzamelen die nog niet in
//      pending_events.external_ref staan.
//   B. Detailpagina's ophalen (1 per seconde). De feiten komen uit de
//      schema.org-JSON-LD op de pagina (naam, datum, locatie, geo,
//      organisator, telefoon); de website van de organisator uit de HTML.
//   C. Eén Claude-call voor de hele batch: eigen korte beschrijving (geen
//      letterlijke overname), type, particulier ja/nee, past bij YardiGo.
//   D. Dedupe → pending_events → auto-check (zie _shared/publish.ts).
//      Slaagt de check: direct live. Particulier: status 'tip' (Telegram).
//      Anders: blijft 'nieuw' met de redenen in auto_check.
//
// Aanroep (POST, JSON):
//   {}                          — normale run
//   { "dryRun": true }          — niets wegschrijven, wel samenvatting
//   { "max_items": 20 }         — max nieuwe detailpagina's (standaard 20)
//   { "publish": false }        — wel importeren, niet automatisch publiceren
//
// Auth: header x-cron-secret = app_config.cron_secret, of admin-JWT.
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { autoCheck, publishPending } from '../_shared/publish.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const BASE              = 'https://www.meukisleuk.nl';
const LEAD_DOMAIN       = 'meukisleuk.nl';
const ANTHROPIC_MODELS  = ['claude-haiku-5-5', 'claude-haiku-4-5'];
const USER_AGENT        = 'Mozilla/5.0 (compatible; YardiGoDiscover/1.0; +https://www.yardigo.nl)';
const FETCH_INTERVAL_MS = 1000;
const PAGE_TIMEOUT_MS   = 10000;
const AI_TIMEOUT_MS     = 40000;
const DEFAULT_MAX_ITEMS = 20;
const MAX_LIST_PAGES    = 10;
// Edge functions worden na 150 s hard afgekapt. Elke fase checkt of er nog
// genoeg tijd over is voor de volgende stap, zodat de run altijd netjes eindigt.
const LIST_PHASE_MS     = 25000;
const DETAIL_PHASE_MS   = 60000;

// Categorieën die bij YardiGo passen, met het subtype dat we eraan geven.
// Volgorde = volgorde van de cursor.
const CATEGORIEEN: { slug: string; subtype: string }[] = [
  { slug: 'garage-sale',                subtype: 'opritverkoop' },
  { slug: 'rommelmarkt',                subtype: 'rommelmarkt'  },
  { slug: 'kofferbakverkoop',           subtype: 'kofferbak'    },
  { slug: 'antiek-+en+curiosamarkt',    subtype: 'antiekmarkt'  },
  { slug: 'boekenmarkt',                subtype: 'boekenmarkt'  },
  { slug: 'tweedehandskledingbeurs',    subtype: 'overig'       },
  { slug: 'tweedehandsspeelgoedbeurs',  subtype: 'overig'       },
  { slug: 'evenement',                  subtype: 'overig'       },
];
const SUBTYPES = new Set(['rommelmarkt','vlooienmarkt','opritverkoop','rommelroute','buurtverkoop','kofferbak','antiekmarkt','boekenmarkt','braderie','kerstmarkt','overig']);

// ── Helpers ────────────────────────────────────────────────────────
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchText(url: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

function decodeEntities(s: string): string {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&euml;/g, 'ë').replace(/&eacute;/g, 'é')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function htmlToText(html: string): string {
  return decodeEntities(html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n'))
    .split('\n').map(l => l.trim()).filter(Boolean).join('\n');
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

function safeParseJson(raw: string): any {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch { return null; }
}

function normPhone(p: string | null | undefined): string | null {
  if (!p) return null;
  const d = p.replace(/[^\d+]/g, '');
  return d.length >= 9 ? d : null;
}

// ── Detailpagina parsen ────────────────────────────────────────────
interface Detail {
  ref: string;            // 'meukisleuk:<id>'
  leadUrl: string;
  categorie: string | null;
  subtypeHint: string;
  title: string;
  dateStart: string;      // YYYY-MM-DD
  dateEnd: string | null;
  timeStart: string | null;
  timeEnd: string | null;
  venue: string | null;
  street: string | null;
  postcode: string | null;
  city: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
  organizerName: string | null;
  organizerUrl: string | null;
  phone: string | null;
  email: string | null;
  rawDescription: string;
}

function parseDetail(html: string, leadUrl: string, id: string, subtypeHint: string): Detail | null {
  // JSON-LD Event
  let ev: any = null;
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1]);
      const arr = Array.isArray(j) ? j : [j];
      ev = arr.find((x: any) => x && x['@type'] === 'Event') || ev;
    } catch { /* volgende */ }
  }
  if (!ev || !ev.name || !ev.startDate) return null;

  const text = htmlToText(html);
  const start = String(ev.startDate);
  const end   = ev.endDate ? String(ev.endDate) : null;
  const loc   = ev.location || {};
  const addr  = loc.address || {};
  const geo   = loc.geo || {};
  const org   = ev.organizer || {};

  // Tijden: "van 9:30 tot 16:00" in de paginatekst; JSON-LD heeft vaak alleen de start.
  const tm = text.replace(/\n/g, ' ').match(/van\s*(\d{1,2}[:.]\d{2})\s*tot\s*(\d{1,2}[:.]\d{2})/i);
  const pad = (t: string | undefined | null) => {
    if (!t) return null; const m = t.replace('.', ':').match(/^(\d{1,2}):(\d{2})$/);
    return m ? m[1].padStart(2, '0') + ':' + m[2] : null;
  };
  const timeStart = pad(tm?.[1]) || pad(start.slice(11, 16));
  const timeEnd   = pad(tm?.[2]) || (end ? pad(end.slice(11, 16)) : null);

  // Categorie-regel ("Categorie\nRommelmarkt")
  const cat = text.match(/\nCategorie\n([^\n]+)/);

  // Organisator-blok: van "Georganiseerd door" tot "Bekijk alle"
  let organizerUrl: string | null = null;
  const blokStart = html.indexOf('Georganiseerd door');
  if (blokStart !== -1) {
    const blokEind = html.indexOf('Bekijk alle', blokStart);
    const blok = html.slice(blokStart, blokEind > blokStart ? blokEind : blokStart + 4000);
    for (const m of blok.matchAll(/href="(https?:\/\/[^"]+)"/gi)) {
      const d = domainOf(m[1]);
      if (d && !d.endsWith(LEAD_DOMAIN)) { organizerUrl = m[1]; break; }
    }
  }
  // Organisatoren vullen soms hun e-mail in als website ("https://info@x.nl").
  let urlEmail: string | null = null;
  if (organizerUrl) {
    const em = organizerUrl.replace(/^https?:\/\//i, '').match(/^([^/@\s]+@[^/\s]+\.[a-z]{2,})\/?$/i);
    if (em) { urlEmail = em[1]; organizerUrl = null; }
  }
  const telTekst = text.match(/Tel\.?\s*nr\.?\s*([+\d][\d\s\-]{7,})/i);

  return {
    ref: 'meukisleuk:' + id,
    leadUrl,
    categorie: cat ? cat[1].trim() : null,
    subtypeHint,
    title: decodeEntities(String(ev.name)).trim().slice(0, 140),
    dateStart: start.slice(0, 10),
    dateEnd: end && end.slice(0, 10) !== start.slice(0, 10) ? end.slice(0, 10) : null,
    timeStart, timeEnd,
    venue:    loc.name ? decodeEntities(String(loc.name)).trim() : null,
    street:   String(addr.streetAddress || '').trim() || null,
    postcode: String(addr.postalCode || '').trim() || null,
    city:     String(addr.addressLocality || '').trim() || null,
    country:  addr.addressCountry ? String(addr.addressCountry).toUpperCase() : null,
    lat: geo.latitude  ? parseFloat(geo.latitude)  : null,
    lng: geo.longitude ? parseFloat(geo.longitude) : null,
    organizerName: org.name ? decodeEntities(String(org.name)).trim().slice(0, 120) : null,
    organizerUrl: organizerUrl || (org.url && !domainOf(org.url).endsWith(LEAD_DOMAIN) ? org.url : null),
    phone: normPhone(org.telephone) || normPhone(telTekst?.[1]),
    email: org.email ? String(org.email).trim() : urlEmail,
    rawDescription: decodeEntities(String(ev.description || '')).slice(0, 900),
  };
}

// Particulier: alleen de straatnaam tonen, nooit het huisnummer.
function straatZonderNummer(street: string | null): string | null {
  if (!street) return null;
  const s = street.replace(/\s+\d+\s*[a-zA-Z]?(\s*-\s*\d+)?$/, '').trim();
  return /[a-zA-Z]{3,}/.test(s) ? s : null;
}

// ── Geocode-terugval (alleen als JSON-LD geen geo heeft) ──────────
async function pdok(q: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const r = await fetch('https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?rows=1&fl=centroide_ll&q=' + encodeURIComponent(q));
    if (!r.ok) return null;
    const c = (await r.json())?.response?.docs?.[0]?.centroide_ll;
    const m = typeof c === 'string' ? c.match(/POINT\(([-\d.]+)\s+([-\d.]+)\)/) : null;
    return m ? { lng: parseFloat(m[1]), lat: parseFloat(m[2]) } : null;
  } catch { return null; }
}

// ── Claude: herschrijven + classificeren (één call per batch) ─────
interface AiItem { ref: string; titel?: string; beschrijving?: string; event_subtype?: string; is_particulier?: boolean; past_bij_yardigo?: boolean; }

// In batches van AI_BATCH parallel: één grote batch liep tegen max_tokens aan.
const AI_BATCH = 8;
async function classify(key: string, items: Detail[], diag: string[]): Promise<Map<string, AiItem>> {
  const out = new Map<string, AiItem>();
  const batches: Detail[][] = [];
  for (let i = 0; i < items.length; i += AI_BATCH) batches.push(items.slice(i, i + AI_BATCH));
  const res = await Promise.allSettled(batches.map(b => classifyBatch(key, b, diag)));
  for (const r of res) {
    if (r.status === 'fulfilled') r.value.forEach((v, k) => out.set(k, v));
    else diag.push('ai: ' + (r.reason as Error)?.message);
  }
  return out;
}

async function classifyBatch(key: string, items: Detail[], diag: string[]): Promise<Map<string, AiItem>> {
  const out = new Map<string, AiItem>();
  if (!items.length) return out;
  const system = [
    'Je verwerkt aankondigingen van tweedehands-verkopen voor YardiGo, een kaart met rommelmarkten, vlooienmarkten, opritverkopen en kofferbakverkopen in Nederland en België.',
    'Antwoord UITSLUITEND met één JSON-object: {"items":[...]}, geen tekst erbuiten.',
    'Per item: {"ref": string, "titel": string, "beschrijving": string, "event_subtype": string, "is_particulier": bool, "past_bij_yardigo": bool}',
    '- titel: korte, nette titel (max 70 tekens), zonder datum en zonder hoofdletters-geschreeuw.',
    '- beschrijving: EIGEN formulering in het Nederlands, 1-2 zinnen, max 220 tekens. Nooit zinnen letterlijk overnemen. Geen telefoonnummers, e-mail of URLs, en geen datum of tijden (die staan al apart).',
    '- event_subtype: één van rommelmarkt, vlooienmarkt, opritverkoop, rommelroute, buurtverkoop, kofferbak, antiekmarkt, boekenmarkt, braderie, kerstmarkt, overig.',
    '- is_particulier: true als het een verkoop door een privépersoon bij huis is (garage sale, opruiming, verhuisverkoop, tuinverkoop). false bij een vereniging, kerk, school, bedrijf, gemeente of beroepsorganisator — ook als er een persoonsnaam als contact staat. Ook false bij een buurt-, wijk- of dorpsbrede garage sale of rommelroute met meerdere deelnemende adressen (dat is een publiek evenement, ook als een bewoner het organiseert).',
    '- past_bij_yardigo: true bij verkoop van tweedehands spullen door particulieren of op een markt (rommelmarkt, vlooienmarkt, brocante, kofferbak, kleding-/speelgoedbeurs, boekenmarkt, garage sale). false bij winkels, webshops, verzamel-/platenbeurzen voor handelaren, kunstmarkten met nieuw werk, braderieën zonder tweedehands, veilingen.',
  ].join('\n');
  const user = JSON.stringify(items.map(d => ({
    ref: d.ref, titel: d.title, categorie: d.categorie, organisator: d.organizerName,
    heeft_website: !!d.organizerUrl, plaats: d.city, tekst: d.rawDescription,
  })));

  for (const model of ANTHROPIC_MODELS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 6000, system, messages: [{ role: 'user', content: user }] }),
      });
      if (r.status === 404 || r.status === 400) {           // model niet beschikbaar → volgende
        diag.push('ai ' + model + ' ' + r.status + ': ' + (await r.text()).slice(0, 200));
        continue;
      }
      if (!r.ok) throw new Error('anthropic ' + r.status + ': ' + (await r.text()).slice(0, 200));
      const j = await r.json();
      const txt = (j?.content || []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n');
      const parsed = safeParseJson(txt);
      if (!parsed?.items) diag.push('ai ' + model + ' onleesbaar (' + j?.stop_reason + '): ' + txt.slice(0, 200));
      for (const it of (parsed?.items || [])) if (it?.ref) out.set(String(it.ref), it);
      return out;
    } finally { clearTimeout(t); }
  }
  return out;
}

// ── Auth ───────────────────────────────────────────────────────────
async function isAuthorized(req: Request, sb: any): Promise<{ ok: boolean; via?: string; status?: number; error?: string }> {
  const cron = req.headers.get('x-cron-secret') ?? '';
  if (cron) {
    const { data } = await sb.from('app_config').select('value').eq('key', 'cron_secret').maybeSingle();
    if (data?.value && cron === data.value) return { ok: true, via: 'cron' };
  }
  const m = (req.headers.get('Authorization') ?? '').match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401, error: 'Missing auth' };
  const u = await sb.auth.getUser(m[1]);
  if (u.error || !u.data?.user) return { ok: false, status: 401, error: 'Invalid token' };
  const p = await sb.from('profiles').select('is_admin').eq('id', u.data.user.id).maybeSingle();
  if (p.data?.is_admin !== true) return { ok: false, status: 403, error: 'Admin required' };
  return { ok: true, via: 'admin' };
}

// ── Main ───────────────────────────────────────────────────────────
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;
  const supabaseUrl  = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
  if (!supabaseUrl || !serviceKey || !anthropicKey) return json({ error: 'env missing' }, 500);
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const auth = await isAuthorized(req, sb);
  if (!auth.ok) return json({ error: auth.error }, auth.status ?? 401);

  let body: { dryRun?: boolean; max_items?: number; publish?: boolean } = {};
  try { body = await req.json(); } catch (_) {}
  const dryRun   = body.dryRun === true;
  const publish  = body.publish !== false;
  const maxItems = Math.max(1, Math.min(40, body.max_items ?? DEFAULT_MAX_ITEMS));

  const s: any = {
    via: auth.via, dryRun, lijstpaginas: 0, gezien: 0, nieuw: 0, detail_ok: 0, detail_fout: 0,
    voorbij: 0, dubbel: 0, ingevoegd: 0, gepubliceerd: 0, tips: 0, wachtrij: 0,
    redenen: {} as Record<string, number>, errors: [] as string[], cursor_van: null, cursor_naar: null,
  };

  // A. Lijstpagina's vanaf de cursor
  const curRow = await sb.from('app_config').select('value').eq('key', 'meukisleuk_cursor').maybeSingle();
  let cursor = { cat: 0, page: 1 };
  try { if (curRow.data?.value) cursor = { ...cursor, ...JSON.parse(curRow.data.value) }; } catch (_) {}
  if (cursor.cat >= CATEGORIEEN.length) cursor = { cat: 0, page: 1 };
  s.cursor_van = { ...cursor };

  const kandidaten: { id: string; url: string; subtype: string }[] = [];
  const gezienIds = new Set<string>();
  // Pagina 1 van garage-sale altijd meenemen: daar komen de verse opritverkopen binnen.
  const bezoek: { cat: number; page: number; vast?: boolean }[] = [{ cat: 0, page: 1, vast: true }];

  for (let i = 0; i < MAX_LIST_PAGES && elapsed() < LIST_PHASE_MS && kandidaten.length < maxItems; i++) {
    const stap = bezoek.length ? bezoek.shift()! : { ...cursor };
    const cat = CATEGORIEEN[stap.cat];
    const url = BASE + '/agenda/' + cat.slug + (stap.page > 1 ? '?page=' + stap.page : '');
    let html = '';
    try { await sleep(FETCH_INTERVAL_MS); html = await fetchText(url); s.lijstpaginas++; }
    catch (e) { s.errors.push('lijst ' + url + ': ' + (e as Error).message); }

    const ids = [...new Set([...html.matchAll(/https:\/\/www\.meukisleuk\.nl\/(\d{5,})\/[^"'\s]+\.html/g)].map(m => m[1] + '|' + m[0]))];
    const nieuwOpPagina = ids.filter(x => !gezienIds.has(x.split('|')[0]));
    nieuwOpPagina.forEach(x => gezienIds.add(x.split('|')[0]));
    s.gezien += nieuwOpPagina.length;

    if (nieuwOpPagina.length) {
      const refs = nieuwOpPagina.map(x => 'meukisleuk:' + x.split('|')[0]);
      const bekend = await sb.from('pending_events').select('external_ref').in('external_ref', refs);
      const bekendSet = new Set((bekend.data || []).map((r: any) => r.external_ref));
      for (const x of nieuwOpPagina) {
        const [id, u] = x.split('|');
        if (!bekendSet.has('meukisleuk:' + id) && kandidaten.length < maxItems) kandidaten.push({ id, url: u, subtype: cat.subtype });
      }
    }

    if (!stap.vast) {
      // Cursor door: lege pagina = categorie klaar.
      if (!ids.length || stap.page >= 60) cursor = { cat: (stap.cat + 1) % CATEGORIEEN.length, page: 1 };
      else cursor = { cat: stap.cat, page: stap.page + 1 };
    }
  }
  s.nieuw = kandidaten.length;
  s.cursor_naar = { ...cursor };
  if (!dryRun) await sb.from('app_config').upsert({ key: 'meukisleuk_cursor', value: JSON.stringify(cursor) }, { onConflict: 'key' });

  // B. Detailpagina's
  const today = new Date().toISOString().slice(0, 10);
  const details: Detail[] = [];
  for (const k of kandidaten) {
    if (elapsed() > LIST_PHASE_MS + DETAIL_PHASE_MS) break;
    try {
      await sleep(FETCH_INTERVAL_MS);
      const d = parseDetail(await fetchText(k.url), k.url, k.id, k.subtype);
      if (!d) { s.detail_fout++; continue; }
      s.detail_ok++;
      if ((d.dateEnd || d.dateStart) < today) { s.voorbij++; continue; }
      if ((d.lat == null || d.lng == null) && (d.street || d.city) && (d.country || 'NL') === 'NL') {
        const g = await pdok([d.street, d.postcode, d.city].filter(Boolean).join(' '));
        if (g) { d.lat = g.lat; d.lng = g.lng; }
      }
      details.push(d);
    } catch (e) { s.detail_fout++; s.errors.push('detail ' + k.url + ': ' + (e as Error).message); }
  }

  // C. Claude in één batch
  let ai = new Map<string, AiItem>();
  try { ai = await classify(anthropicKey, details, s.errors); }
  catch (e) { s.errors.push('ai: ' + (e as Error).message); }

  // D. Dedupe → pending → auto-check → publiceren
  for (const d of details) {
    const a = ai.get(d.ref);
    if (!a) { s.errors.push('ai mist ' + d.ref); continue; }
    const titel = (a.titel || d.title).trim();
    const subtype = SUBTYPES.has(a.event_subtype || '') ? a.event_subtype! : d.subtypeHint;
    const adres = [d.venue, d.street].filter(Boolean).join(', ') || null;

    const h = await sb.rpc('discovery_content_hash', { p_title: titel, p_date: d.dateStart, p_city: d.city });
    if (h.error) { s.errors.push('hash: ' + h.error.message); continue; }
    const dup = await sb.rpc('discovery_find_similar', { p_hash: h.data, p_lat: d.lat, p_lng: d.lng, p_date: d.dateStart, p_radius_m: 500 });
    if (dup.data) {
      s.dubbel++;
      // Bestaande wachtrij-rij zonder contact? Verrijk die met organisator/contact.
      if (!dryRun && String(dup.data).startsWith('pending')) {
        await sb.from('pending_events').update({
          organizer_name: d.organizerName, organizer_url: d.organizerUrl, contact_phone: d.phone, contact_email: d.email,
        }).eq('content_hash', h.data).is('organizer_name', null);
      }
      continue;
    }

    const isPart = a.is_particulier === true;
    const row: any = {
      title: titel,
      description: (a.beschrijving || '').slice(0, 240) || null,
      event_subtype: subtype,
      date_start: d.dateStart, date_end: d.dateEnd,
      time_start: d.timeStart, time_end: d.timeEnd,
      city: d.city,
      // Particulier: geen huisadres opslaan als publiek adres; alleen straat zonder nummer.
      address: isPart ? straatZonderNummer(d.street) : adres,
      latitude: d.lat, longitude: d.lng,
      source_url: d.organizerUrl || d.leadUrl,
      source_domain: d.organizerUrl ? domainOf(d.organizerUrl) : LEAD_DOMAIN,
      source_label: d.organizerName,
      lead_source_url: d.leadUrl, lead_source_domain: LEAD_DOMAIN,
      source_status: d.organizerUrl ? 'origineel' : 'onopgelost',
      discovered_via_query: 'meukisleuk:' + d.subtypeHint,
      content_hash: h.data,
      organizer_name: d.organizerName, organizer_url: d.organizerUrl,
      contact_phone: d.phone, contact_email: d.email,
      is_private_seller: typeof a.is_particulier === 'boolean' ? a.is_particulier : null,
      external_ref: d.ref,
      raw_ai_response: { ai: a, categorie: d.categorie, venue: d.venue, postcode: d.postcode, country: d.country, street_full: d.street },
      status: isPart ? 'tip' : 'nieuw',
    };
    const check = autoCheck({ id: 0, ...row }, a.past_bij_yardigo === true);
    row.auto_check = check;
    if (dryRun) {
      s.ingevoegd++; check.ok ? s.gepubliceerd++ : (isPart ? s.tips++ : s.wachtrij++);
      (s.preview ||= []).push({ ref: d.ref, titel, desc: row.description, subtype, datum: d.dateStart, tijd: [d.timeStart, d.timeEnd],
        plaats: d.city, adres: row.address, org: d.organizerName, web: d.organizerUrl, tel: !!d.phone, part: a.is_particulier,
        past: a.past_bij_yardigo, uitkomst: check.ok ? 'live' : isPart ? 'tip' : 'wachtrij', redenen: check.redenen });
      continue;
    }

    const ins = await sb.from('pending_events').insert(row).select('*').single();
    if (ins.error) { s.errors.push('insert ' + d.ref + ': ' + ins.error.message); continue; }
    s.ingevoegd++;

    if (check.ok && publish) {
      try { await publishPending(sb, ins.data, null, check); s.gepubliceerd++; }
      catch (e) { s.errors.push('publish ' + d.ref + ': ' + (e as Error).message); s.wachtrij++; }
    } else if (isPart) s.tips++;
    else {
      s.wachtrij++;
      for (const r of check.redenen) s.redenen[r] = (s.redenen[r] || 0) + 1;
    }
  }

  // E. Herkansing: goedgekeurd door de auto-check maar publiceren mislukte eerder.
  if (!dryRun && publish) {
    const retry = await sb.from('pending_events').select('*')
      .like('external_ref', 'meukisleuk:%').eq('status', 'nieuw')
      .eq('auto_check->>ok', 'true').gte('date_start', today).limit(10);
    for (const p of retry.data || []) {
      try { await publishPending(sb, p, null, null); s.gepubliceerd++; }
      catch (e) { s.errors.push('herkansing ' + p.external_ref + ': ' + (e as Error).message); }
    }
  }

  s.duur_ms = elapsed();
  return json({ ok: true, summary: s }, 200);
});
