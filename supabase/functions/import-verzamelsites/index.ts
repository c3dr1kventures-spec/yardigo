// YardiGo – import-verzamelsites Edge Function
//
// Leest agenda's van concurrerende verzamelsites als LEAD-bron, net als
// import-meukisleuk. De verzamelsite komt nooit in beeld: de listing krijgt
// de website van de organisator als bron (als die bekend is); anders zoekt
// resolve-source de originele organisator (source_status 'onopgelost').
//
// Per run één site (roterend via app_config 'verzamelsites_cursor'):
//   marktenmeer.nl   sitemaps → detailpagina's met JSON-LD Event, inclusief
//                    organisator (naam + website).
//   rommelroutes.nl  sitemap → detailpagina's met JSON-LD Event en geo; de
//                    organisator staat er niet bij (resolve-source).
//   rondsnuffelen.nl themapagina's met kaartjes (titel, datum, plaats, tekst);
//                    geen adres en zelden een organisator.
// Alle drie staan crawlen toe in robots.txt. Hun afbeeldingen niet
// (rommelroutes /api, platform.standhub.nl): affiches komen alleen van de
// website van de organisator zelf (_shared/affiche.ts).
//
// Alleen feiten (titel, datum, tijd, plaats, type). Beschrijving schrijft de
// AI zelf, nooit letterlijk overgenomen.
//
// Aanroep (POST, JSON):
//   {}                          normale run (volgende site)
//   { "site": "marktenmeer" }   deze site
//   { "dryRun": true }          niets wegschrijven, wel samenvatting
//   { "max_items": 15 }         max nieuwe items (standaard 15)
//   { "publish": false }        wel importeren, niet automatisch publiceren
//
// Auth: header x-cron-secret = app_config.cron_secret, of admin-JWT.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { autoCheck, publishPending } from '../_shared/publish.ts';
import { bepaalSubtype, SUBTYPES } from '../_shared/subtypes.ts';
import { borgPlek, veiligeGeocode } from '../_shared/locatie.ts';
import { zoekAffiche } from '../_shared/affiche.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SITES = ['marktenmeer', 'rommelroutes', 'rondsnuffelen'] as const;
type Site = typeof SITES[number];
const DOMEIN: Record<Site, string> = { marktenmeer: 'marktenmeer.nl', rommelroutes: 'rommelroutes.nl', rondsnuffelen: 'rondsnuffelen.nl' };

const ANTHROPIC_MODELS  = ['claude-haiku-5-5', 'claude-haiku-4-5'];
const USER_AGENT        = 'Mozilla/5.0 (compatible; YardiGoDiscover/1.0; +https://www.yardigo.nl)';
const FETCH_INTERVAL_MS = 1200;
const PAGE_TIMEOUT_MS   = 12000;
const AI_TIMEOUT_MS     = 40000;
const DEFAULT_MAX_ITEMS = 15;
const MAX_AFFICHES      = 5;          // affiche-zoektochten per run (elk een AI-call)
const LIST_PHASE_MS     = 30000;
const DETAIL_PHASE_MS   = 50000;

// Tweedehands-markten herkennen aan titel/slug, vóór er een AI-call aan te pas komt.
const MARKT_WOORDEN = /rommel|vlooien|snuffel|brocante|kofferbak|garage|tweedehands|kleding|boekenmarkt|kinder|curiosa|antiek|vintage|ruilbeurs|speelgoed|zolder|kringloop|second.?hand|troc|vide.?grenier/i;
const MAANDEN: Record<string, number> = { januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12 };

// ── Helpers ────────────────────────────────────────────────────────
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xml' }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.text();
}

function decodeEntities(s: string): string {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&hellip;/g, '…').replace(/&euml;/g, 'ë').replace(/&eacute;/g, 'é')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
const tekst = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

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

function jsonLdEvent(html: string): any {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1]);
      const items = Array.isArray(j) ? j : (j['@graph'] || [j]);
      const ev = items.find((x: any) => x && x['@type'] === 'Event');
      if (ev) return ev;
    } catch { /* volgende */ }
  }
  return null;
}

// "2026-11-29T09:00:00+01:00" → tijd zoals op de site bedoeld (lokale tijd).
const tijd = (iso: string | null | undefined) => {
  const m = String(iso || '').match(/T(\d{2}):(\d{2})/);
  return m && !(m[1] === '00' && m[2] === '00') ? `${m[1]}:${m[2]}` : null;
};

// Organisatorlink: Facebook-pagina's volledig, anders de homepage. Verzamelsites
// verwijzen vaak naar een oude eventpagina van de organisator.
function organisatorUrl(url: string | null | undefined, leadDomein: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(String(url));
    const d = u.hostname.replace(/^www\./, '').toLowerCase();
    if (!d || d.endsWith(leadDomein)) return null;
    if (/(^|\.)facebook\.com$/.test(d)) return u.toString();
    return u.origin + '/';
  } catch { return null; }
}

// ── Gemeenschappelijk itemformaat ──────────────────────────────────
interface Item {
  ref: string; site: Site; leadUrl: string;
  title: string; dateStart: string; dateEnd: string | null;
  timeStart: string | null; timeEnd: string | null;
  venue: string | null; street: string | null; postcode: string | null; city: string | null; country: string | null;
  lat: number | null; lng: number | null;
  organizerName: string | null; organizerUrl: string | null;
  rawDescription: string;
}

function vanJsonLd(ev: any, site: Site, ref: string, leadUrl: string): Item | null {
  if (!ev?.name || !ev?.startDate) return null;
  const loc = ev.location || {}, addr = loc.address || {}, geo = loc.geo || {}, org = ev.organizer || {};
  const start = String(ev.startDate), end = ev.endDate ? String(ev.endDate) : null;
  const orgUrl = organisatorUrl(org.url, DOMEIN[site]);
  return {
    ref, site, leadUrl,
    // "Vlooienmarkt De Schilp in Rijswijk – 29 november 2026": datum eraf.
    title: decodeEntities(String(ev.name)).replace(/\s*[–-]\s*\d{1,2}\s+\w+\s+20\d\d\s*$/, '').trim().slice(0, 140),
    dateStart: start.slice(0, 10),
    dateEnd: end && end.slice(0, 10) !== start.slice(0, 10) ? end.slice(0, 10) : null,
    timeStart: tijd(start), timeEnd: tijd(end),
    venue: loc.name && loc.name !== addr.streetAddress ? decodeEntities(String(loc.name)).trim() : null,
    street: String(addr.streetAddress || '').trim() || null,
    postcode: String(addr.postalCode || '').trim() || null,
    city: String(addr.addressLocality || '').trim() || null,
    country: addr.addressCountry ? String(addr.addressCountry).toUpperCase().slice(0, 2) : null,
    lat: geo.latitude ? parseFloat(geo.latitude) : null,
    lng: geo.longitude ? parseFloat(geo.longitude) : null,
    // Een verzamelsite die zichzelf als organisator noemt telt niet.
    organizerName: orgUrl && org.name ? decodeEntities(String(org.name)).trim().slice(0, 120) : null,
    organizerUrl: orgUrl,
    rawDescription: decodeEntities(String(ev.description || '')).slice(0, 900),
  };
}

// ── Adapters: lijst → kandidaten ───────────────────────────────────
interface Kandidaat { ref: string; url: string; item?: Item }

async function sitemapUrls(index: string, patroon: RegExp, diag: string[]): Promise<string[]> {
  const xml = await fetchText(index);
  const subs = [...xml.matchAll(/<loc>([^<]+\.xml)<\/loc>/g)].map(m => m[1]).filter(u => patroon.test(u));
  const lijsten = subs.length ? subs : [index];
  const out: string[] = [];
  for (const u of lijsten) {
    try {
      const x = u === index ? xml : (await sleep(FETCH_INTERVAL_MS), await fetchText(u));
      out.push(...[...x.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]));
    } catch (e) { diag.push('sitemap ' + u + ': ' + (e as Error).message); }
  }
  return out;
}

async function lijstMarktenmeer(vandaag: string, diag: string[]): Promise<Kandidaat[]> {
  const urls = await sitemapUrls('https://marktenmeer.nl/sitemap_index.xml', /mm_markt-sitemap/, diag);
  const out: Kandidaat[] = [];
  for (const u of urls) {
    const slug = u.replace(/\/$/, '').split('/').pop() || '';
    if (!u.includes('/markt/') || !MARKT_WOORDEN.test(slug)) continue;
    const m = slug.match(new RegExp('(\\d{1,2})-(' + Object.keys(MAANDEN).join('|') + ')-(20\\d\\d)'));
    if (!m) continue;                                     // zonder datum in de slug: meestal doorlopend/vaag
    const d = `${m[3]}-${String(MAANDEN[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (d < vandaag) continue;
    out.push({ ref: 'marktenmeer:' + slug, url: u });
  }
  return out;
}

async function lijstRommelroutes(diag: string[]): Promise<Kandidaat[]> {
  const urls = await sitemapUrls('https://www.rommelroutes.nl/sitemap.xml', /^$/, diag);
  return urls.filter(u => /\/evenementen\/[^/]+$/.test(u))
    .map(u => ({ ref: 'rommelroutes:' + u.split('/').pop(), url: u }));
}

// "woensdag 14 t/m dinsdag 20 oktober", "zaterdag 24 en zondag 25 oktober",
// "zaterdag 31 oktober t/m zondag 1 november". Geen jaar: eerstvolgende.
function rsDatums(s: string, vandaag: string): { start: string; end: string | null } | null {
  const delen = [...s.toLowerCase().matchAll(new RegExp('(\\d{1,2})(?:\\s+(' + Object.keys(MAANDEN).join('|') + '))?', 'g'))];
  if (!delen.length) return null;
  const dagen: { d: number; m: number | null }[] = delen.map(x => ({ d: +x[1], m: x[2] ? MAANDEN[x[2]] : null }));
  for (let i = dagen.length - 2; i >= 0; i--) if (dagen[i].m == null) dagen[i].m = dagen[i + 1].m;
  if (dagen.some(x => x.m == null)) return null;
  const jaar0 = +vandaag.slice(0, 4), maand0 = +vandaag.slice(5, 7);
  const iso = (x: { d: number; m: number | null }) => {
    const j = x.m! < maand0 - 1 ? jaar0 + 1 : jaar0;       // januari gezien in oktober = volgend jaar
    return `${j}-${String(x.m).padStart(2, '0')}-${String(x.d).padStart(2, '0')}`;
  };
  const start = iso(dagen[0]), end = iso(dagen[dagen.length - 1]);
  return { start, end: end !== start ? end : null };
}

async function lijstRondsnuffelen(vandaag: string, diag: string[]): Promise<Kandidaat[]> {
  const out = new Map<string, Kandidaat>();
  for (const thema of ['rommelmarkt', 'vlooienmarkt', 'brocante', 'kofferbakverkoop']) {
    const url = `https://rondsnuffelen.nl/thema/${thema}/`;
    let html = '';
    try { await sleep(FETCH_INTERVAL_MS); html = await fetchText(url); }
    catch (e) { diag.push('lijst ' + url + ': ' + (e as Error).message); continue; }
    for (const c of html.split('<div class="evenement-card">').slice(1)) {
      const titel = tekst(c.match(/<h3>([\s\S]*?)<\/h3>/)?.[1] || '');
      const datumTxt = tekst(c.match(/class="info datum">[\s\S]*?<span>([\s\S]*?)<\/span>/)?.[1] || '');
      const plaatsTxt = tekst(c.match(/class="info locatie">[\s\S]*?<span>([\s\S]*?)<\/span>/)?.[1] || '');
      const toel = tekst(c.match(/class="info locatie-toelichting">[\s\S]*?<span>([\s\S]*?)<\/span>/)?.[1] || '');
      const beschr = tekst(c.match(/class="beschrijving">([\s\S]*?)<\/div>/)?.[1] || '');
      const link = c.match(/href="(https?:\/\/[^"]+)"[^>]*>\s*Meer informatie/i)?.[1] || null;
      if (!titel || !MARKT_WOORDEN.test(titel + ' ' + beschr.slice(0, 200))) continue;
      const dt = rsDatums(datumTxt, vandaag);
      if (!dt || (dt.end || dt.start) < vandaag) continue;
      const pm = plaatsTxt.match(/^(.*?)\s*\((NL|BE|DE)\)\s*$/i);
      const city = (pm ? pm[1] : plaatsTxt).trim() || null;
      const sleutel = (titel + '-' + dt.start).toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').slice(0, 90);
      const ref = 'rondsnuffelen:' + sleutel;
      if (out.has(ref)) continue;
      const orgUrl = organisatorUrl(link, 'rondsnuffelen.nl');
      out.set(ref, { ref, url, item: {
        ref, site: 'rondsnuffelen', leadUrl: url, title: titel.slice(0, 140),
        dateStart: dt.start, dateEnd: dt.end, timeStart: null, timeEnd: null,
        venue: toel && toel.length <= 80 ? toel : null, street: null, postcode: null, city,
        country: pm ? pm[2].toUpperCase() : 'NL', lat: null, lng: null,
        organizerName: null, organizerUrl: orgUrl,
        rawDescription: (beschr + (toel ? ' Locatie: ' + toel : '')).slice(0, 900),
      } });
    }
  }
  return [...out.values()];
}

// ── Claude: herschrijven + classificeren ───────────────────────────
interface AiItem { ref: string; titel?: string; beschrijving?: string; event_subtype?: string; is_particulier?: boolean; past_bij_yardigo?: boolean; }
const AI_BATCH = 8;

async function classify(key: string, items: Item[], diag: string[]): Promise<Map<string, AiItem>> {
  const out = new Map<string, AiItem>();
  const batches: Item[][] = [];
  for (let i = 0; i < items.length; i += AI_BATCH) batches.push(items.slice(i, i + AI_BATCH));
  const res = await Promise.allSettled(batches.map(b => classifyBatch(key, b, diag)));
  for (const r of res) {
    if (r.status === 'fulfilled') r.value.forEach((v, k) => out.set(k, v));
    else diag.push('ai: ' + (r.reason as Error)?.message);
  }
  return out;
}

async function classifyBatch(key: string, items: Item[], diag: string[]): Promise<Map<string, AiItem>> {
  const out = new Map<string, AiItem>();
  if (!items.length) return out;
  const system = [
    'Je verwerkt aankondigingen van tweedehands-verkopen voor YardiGo, een kaart met rommelmarkten, vlooienmarkten, opritverkopen en kofferbakverkopen in Nederland en België.',
    'Antwoord UITSLUITEND met één JSON-object: {"items":[...]}, geen tekst erbuiten.',
    'Per item: {"ref": string, "titel": string, "beschrijving": string, "event_subtype": string, "is_particulier": bool, "past_bij_yardigo": bool}',
    '- titel: korte, nette titel (max 70 tekens), zonder datum en zonder hoofdletters-geschreeuw.',
    '- beschrijving: EIGEN formulering in het Nederlands, 1-2 zinnen, max 220 tekens. Nooit zinnen letterlijk overnemen. Geen telefoonnummers, e-mail of URLs, en geen datum of tijden (die staan al apart).',
    '- event_subtype: één van ' + [...SUBTYPES].join(', ') + '. opritverkoop = één huis; rommelroute/buurtverkoop = meerdere adressen in een buurt of dorp; anders de soort markt (snuffelmarkt/vlooienmarkt/jaarmarkt alleen als de bron dat woord gebruikt; kinderbeurs = kinderkleding-/speelgoedbeurs; kledingmarkt = kledingbeurs). Gemengde markt = de eerstgenoemde soort.',
    '- is_particulier: true als het een verkoop door een privépersoon bij huis is (garage sale, opruiming, verhuisverkoop, tuinverkoop). false bij een vereniging, kerk, school, bedrijf, gemeente of beroepsorganisator. Ook false bij een buurt-, wijk- of dorpsbrede garage sale of rommelroute met meerdere adressen.',
    '- past_bij_yardigo: true bij verkoop van tweedehands spullen door particulieren of op een markt (rommelmarkt, vlooienmarkt, brocante, kofferbak, kleding-/speelgoedbeurs, boekenmarkt, garage sale). false bij winkels, webshops, kringloopwinkels met gewone openingsdagen, verzamel-/platenbeurzen voor handelaren, kunstmarkten met nieuw werk, kermissen, braderieën zonder tweedehands, veilingen.',
  ].join('\n');
  const user = JSON.stringify(items.map(d => ({
    ref: d.ref, titel: d.title, organisator: d.organizerName, plaats: d.city, locatie: d.venue, tekst: d.rawDescription,
  })));
  for (const model of ANTHROPIC_MODELS) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 6000, system, messages: [{ role: 'user', content: user }] }),
    });
    if (r.status === 404 || r.status === 400) { diag.push('ai ' + model + ' ' + r.status); continue; }
    if (!r.ok) throw new Error('anthropic ' + r.status + ': ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    const txt = (j?.content || []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n');
    const parsed = safeParseJson(txt);
    if (!parsed?.items) diag.push('ai ' + model + ' onleesbaar (' + j?.stop_reason + ')');
    for (const it of (parsed?.items || [])) if (it?.ref) out.set(String(it.ref), it);
    return out;
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
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
  const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } });
  if (!anthropicKey) return json({ error: 'env missing' }, 500);

  const auth = await isAuthorized(req, sb);
  if (!auth.ok) return json({ error: auth.error }, auth.status ?? 401);

  let body: { site?: string; dryRun?: boolean; max_items?: number; publish?: boolean } = {};
  try { body = await req.json(); } catch (_) {}
  const dryRun   = body.dryRun === true;
  const publish  = body.publish !== false;
  const maxItems = Math.max(1, Math.min(30, body.max_items ?? DEFAULT_MAX_ITEMS));

  // Welke site: expliciet, anders roterend.
  const cur = await sb.from('app_config').select('value').eq('key', 'verzamelsites_cursor').maybeSingle();
  const volgende = (SITES.indexOf((cur.data?.value || '') as Site) + 1) % SITES.length;
  const site: Site = SITES.includes(body.site as Site) ? body.site as Site : SITES[volgende];
  if (!dryRun && !body.site) await sb.from('app_config').upsert({ key: 'verzamelsites_cursor', value: site }, { onConflict: 'key' });
  const lead = DOMEIN[site];

  const s: any = {
    via: auth.via, site, dryRun, kandidaten: 0, nieuw: 0, detail_ok: 0, detail_fout: 0, voorbij: 0,
    geen_markt: 0, dubbel: 0, ingevoegd: 0, gepubliceerd: 0, tips: 0, wachtrij: 0, affiches: 0,
    redenen: {} as Record<string, number>, errors: [] as string[],
  };
  const vandaag = new Date().toISOString().slice(0, 10);

  // A. Kandidaten van deze site, min wat we al kennen.
  let kand: Kandidaat[] = [];
  try {
    kand = site === 'marktenmeer' ? await lijstMarktenmeer(vandaag, s.errors)
      : site === 'rommelroutes' ? await lijstRommelroutes(s.errors)
      : await lijstRondsnuffelen(vandaag, s.errors);
  } catch (e) { s.errors.push('lijst: ' + (e as Error).message); }
  s.kandidaten = kand.length;

  // Al verwerkt: in pending_events, of eerder overgeslagen (voorbij/geen markt).
  const overKey = 'verzamelsites_overgeslagen_' + site;
  const over = await sb.from('app_config').select('value').eq('key', overKey).maybeSingle();
  let overgeslagen: string[] = [];
  try { overgeslagen = JSON.parse(over.data?.value || '[]'); } catch (_) {}
  const bekend = new Set<string>(overgeslagen);
  for (let i = 0; i < kand.length; i += 200) {
    const r = await sb.from('pending_events').select('external_ref').in('external_ref', kand.slice(i, i + 200).map(k => k.ref));
    for (const x of r.data || []) bekend.add(x.external_ref);
  }
  kand = kand.filter(k => !bekend.has(k.ref));
  // Willekeurige volgorde: onze plaatsingen lopen dan niet gelijk met hun lijst.
  for (let i = kand.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [kand[i], kand[j]] = [kand[j], kand[i]]; }
  kand = kand.slice(0, maxItems);
  s.nieuw = kand.length;

  // B. Details (rondsnuffelen heeft alles al op de lijstpagina).
  const items: Item[] = [];
  const nieuwOvergeslagen: string[] = [];
  for (const k of kand) {
    if (elapsed() > LIST_PHASE_MS + DETAIL_PHASE_MS) break;
    let it = k.item ?? null;
    if (!it) {
      try { await sleep(FETCH_INTERVAL_MS); it = vanJsonLd(jsonLdEvent(await fetchText(k.url)), site, k.ref, k.url); }
      catch (e) { s.detail_fout++; s.errors.push('detail ' + k.url + ': ' + (e as Error).message); continue; }
      if (!it) { s.detail_fout++; nieuwOvergeslagen.push(k.ref); continue; }
      s.detail_ok++;
    }
    if ((it.dateEnd || it.dateStart) < vandaag) { s.voorbij++; nieuwOvergeslagen.push(k.ref); continue; }
    items.push(it);
  }

  // C. AI: eigen titel/beschrijving, type, past het.
  let ai = new Map<string, AiItem>();
  try { ai = await classify(anthropicKey, items, s.errors); } catch (e) { s.errors.push('ai: ' + (e as Error).message); }

  // D. Plek, dubbelcheck, wachtrij, eventueel live.
  let affichesGezocht = 0;
  for (const d of items) {
    const a = ai.get(d.ref);
    if (!a) { s.errors.push('ai mist ' + d.ref); continue; }
    if (a.past_bij_yardigo === false) { s.geen_markt++; nieuwOvergeslagen.push(d.ref); continue; }
    const titel = (a.titel || d.title).trim();
    const subtype = bepaalSubtype(SUBTYPES.has(a.event_subtype || '') ? a.event_subtype : null, null, titel);
    const adres = [d.venue, d.street].filter(Boolean).join(', ') || null;

    // Locatie: geo van de bron toetsen, anders exact adres; plaatscentrum alleen als noodgreep.
    let lat = d.lat, lng = d.lng, bijBenadering = false;
    if (lat != null && lng != null) {
      const g = await borgPlek(sb, { lat, lng }, d.street, d.city);
      lat = g?.lat ?? null; lng = g?.lng ?? null;
    }
    if (lat == null || lng == null) {
      const g = await veiligeGeocode(sb, d.street ? [d.street, d.postcode].filter(Boolean).join(' ') : null, d.city);
      if (g) { lat = g.lat; lng = g.lng; bijBenadering = g.bij_benadering; }
    }

    const h = await sb.rpc('discovery_content_hash', { p_title: titel, p_date: d.dateStart, p_city: d.city });
    if (h.error) { s.errors.push('hash: ' + h.error.message); continue; }
    const dup = await sb.rpc('discovery_find_similar', { p_hash: h.data, p_lat: lat, p_lng: lng, p_date: d.dateStart, p_radius_m: 1000 });
    if (dup.data) {
      s.dubbel++; nieuwOvergeslagen.push(d.ref);
      if (!dryRun && String(dup.data).startsWith('pending') && d.organizerUrl) {
        await sb.from('pending_events').update({ organizer_name: d.organizerName, organizer_url: d.organizerUrl })
          .eq('content_hash', h.data).is('organizer_url', null);
      }
      continue;
    }

    const isPart = a.is_particulier === true;
    const row: any = {
      title: titel,
      description: (a.beschrijving || '').slice(0, 240) || null,
      event_subtype: subtype,
      date_start: d.dateStart, date_end: d.dateEnd, time_start: d.timeStart, time_end: d.timeEnd,
      city: d.city, address: isPart ? null : adres,
      latitude: lat, longitude: lng,
      source_url: d.organizerUrl || d.leadUrl,
      source_domain: d.organizerUrl ? domainOf(d.organizerUrl) : lead,
      source_label: d.organizerName,
      lead_source_url: d.leadUrl, lead_source_domain: lead,
      source_status: d.organizerUrl ? 'origineel' : 'onopgelost',
      discovered_via_query: 'verzamelsite:' + site,
      content_hash: h.data,
      organizer_name: d.organizerName, organizer_url: d.organizerUrl,
      is_private_seller: typeof a.is_particulier === 'boolean' ? a.is_particulier : null,
      external_ref: d.ref,
      raw_ai_response: { ai: a, venue: d.venue, postcode: d.postcode, country: d.country, street_full: d.street, locatie_bij_benadering: bijBenadering },
      status: isPart ? 'tip' : 'nieuw',
    };

    // Affiche van de organisator zelf (alleen met een echte organisatorsite).
    if (!dryRun && d.organizerUrl && affichesGezocht < MAX_AFFICHES && elapsed() < 120000) {
      affichesGezocht++;
      const poster = await zoekAffiche(sb, anthropicKey, d.organizerUrl, { titel, datum: d.dateStart, plaats: d.city }, 'import/' + site);
      if (poster) { row.poster_url = poster; s.affiches++; }
    }

    const check = autoCheck({ id: 0, ...row }, a.past_bij_yardigo === true);
    if (bijBenadering) { check.redenen.push('locatie bij benadering'); check.ok = false; }
    row.auto_check = check;
    if (dryRun) {
      s.ingevoegd++; check.ok ? s.gepubliceerd++ : (isPart ? s.tips++ : s.wachtrij++);
      (s.preview ||= []).push({ ref: d.ref, titel, desc: row.description, subtype, datum: d.dateStart, tijd: [d.timeStart, d.timeEnd],
        plaats: d.city, adres: row.address, ll: [lat, lng], benadering: bijBenadering, org: d.organizerName, web: d.organizerUrl,
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
    else { s.wachtrij++; for (const r of check.redenen) s.redenen[r] = (s.redenen[r] || 0) + 1; }
  }

  if (!dryRun && nieuwOvergeslagen.length) {
    const lijst = [...new Set([...overgeslagen, ...nieuwOvergeslagen])].slice(-3000);
    await sb.from('app_config').upsert({ key: overKey, value: JSON.stringify(lijst) }, { onConflict: 'key' });
  }

  s.duur_ms = elapsed();
  return json({ ok: true, summary: s }, 200);
});
