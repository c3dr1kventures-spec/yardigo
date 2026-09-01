// YardiGo – resolve-source Edge Function
//
// Zoekt bij een event dat via een verzamelsite binnenkwam de ORIGINELE bron
// (organisator, vereniging, gemeente, dorpssite) en vervangt de bron-
// vermelding daarmee. De verzamelsite blijft alleen intern bewaard als
// "lead" en komt nooit in beeld bij bezoekers.
//
// Waarom apart van discover-events: die functie zit met RUN_BUDGET_MS al
// tegen het plafond van de edge runtime. Deze draait op een eigen cron en
// werkt een wachtrij af.
//
// Werkwijze per event:
//   1. Zoekopdracht opbouwen uit de FEITEN (titel, plaats, maand, jaar).
//      Feiten zijn vrij; we nemen niets van de verzamelsite over.
//   2. Brave Search, met -site: uitsluiting voor de lead en voor alles
//      wat in discovery_blocklist staat.
//   3. Kandidaatpagina's ophalen (1 per seconde, zelfde tempo als
//      discover-events).
//   4. Haiku beoordeelt per pagina: is dit hetzelfde event, en is dit de
//      organisator zelf?
//   5. De harde controle (datum + plaats) doen we in code, niet op het
//      oordeel van het model. Datum moet exact matchen, plaats moet
//      matchen, pagina zonder datum wordt afgewezen. Dat vangt de twee
//      valkuilen: een ander evenement in hetzelfde dorp, en de editie van
//      vorig jaar bij een terugkerend evenement.
//
// Aanroep (POST, JSON):
//   { "target": "pending" }                     — wachtrij pending_events
//   { "target": "listings" }                    — backfill gepubliceerde listings
//   { "max_items": 10 }                         — standaard 10
//   { "dryRun": true }                          — niets wegschrijven
//   { "domains": ["meukisleuk.nl"] }            — beperk backfill tot deze bronnen
//
// Auth:
//   - Cron:  header x-cron-secret = app_config.cron_secret
//   - Admin: header Authorization: Bearer <JWT>, profiel.is_admin = true
//
// Required secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (auto-injected)
//   ANTHROPIC_API_KEY, BRAVE_API_KEY           (handmatig zetten)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ANTHROPIC_MODEL    = 'claude-haiku-4-5';
const BRAVE_ENDPOINT     = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_MAX_ITEMS  = 10;
const MAX_KANDIDATEN     = 3;     // pagina's die we per event openen
const BRAVE_RESULTS      = 10;
const MAX_TEXT           = 8000;
const FETCH_INTERVAL_MS  = 1000;  // 1 fetch per sec, zelfde als discover-events
const PAGE_FETCH_TIMEOUT = 12000;
const ANTHROPIC_TIMEOUT  = 30000;
const MIN_ZEKERHEID      = 80;    // onder deze drempel schrijven we niets weg
const RUN_BUDGET_MS      = 110000;
const MAX_QUERY_LEN      = 380;   // Brave kapt lange queries af

// Alleen een SELECTIE-filter voor de backfill: welke bestaande listings
// bekijken we als "kwam via een verzamelsite binnen". Dit is NADRUKKELIJK
// geen blocklist en heeft geen invloed op discover-events. Overrulebaar
// per aanroep met { "domains": [...] }.
const BACKFILL_DOMAIN_HINTS = [
  'meukisleuk.nl',
  'brocantes.be',
  'brocanterie.be',
  'out.be',
  'quefaire.be',
  'facebook.com',
];

// ── Interfaces ─────────────────────────────────────────────────────
interface BraveResult { title: string; url: string; description?: string; }

interface TeResolven {
  soort: 'pending' | 'listing';
  id: string;                 // uuid (listing) of bigint-as-string (pending)
  title: string;
  city: string | null;
  date_start: string;         // YYYY-MM-DD
  land: string;
  source_url: string | null;
  source_label: string | null;
}

interface Verificatie {
  is_zelfde_event: boolean;
  is_originele_bron: boolean;
  datum_op_pagina: string | null;   // YYYY-MM-DD
  plaats_op_pagina: string | null;
  organisator: string | null;
  zekerheid: number;                // 0-100
  toelichting: string;
}

// ── Helpers ────────────────────────────────────────────────────────
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function parseBadges(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') { try { const a = JSON.parse(raw); if (Array.isArray(a)) return a.map(String); } catch {} return []; }
  return [];
}

function extractDomain(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch { return ''; }
}

function stripHtml(html: string, maxLen: number): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function safeParseJson(raw: string): Record<string, unknown> | null {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{'), last = s.lastIndexOf('}');
  if (first !== -1 && last > first) s = s.slice(first, last + 1);
  try {
    const obj = JSON.parse(s);
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : null;
  } catch { return null; }
}

function extractPathValue<T>(obj: any, path: string, fallback: T): T {
  try { const parts = path.split('.'); let cur = obj; for (const p of parts) cur = cur?.[p]; return (cur ?? fallback) as T; }
  catch { return fallback; }
}

async function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithTimeout(url: string, opts: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// Normaliseert een plaatsnaam voor vergelijking: accenten eraf, kleine
// letters, alleen letters over. "Morialmé" en "morialme" matchen dan, en
// "Sint Joost" en "sint-joost" ook.
function normPlaats(s: string | null): string {
  return (s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

// Plaatsvergelijking is bewust soepel in één richting: de pagina mag een
// preciezere plaats noemen dan wij hebben ("Berg aan de Maas" vs "Urmond"
// matcht niet, maar "Meers, Elsloo" vs "Elsloo" wel).
function plaatsMatcht(onze: string | null, hunne: string | null): boolean {
  const a = normPlaats(onze), b = normPlaats(hunne);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

const NL_MAANDEN = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
const FR_MOIS    = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
const DE_MONATE  = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];

function maandNaam(datum: string, land: string): string {
  const idx = Math.max(0, Math.min(11, parseInt(datum.slice(5, 7), 10) - 1));
  if (land === 'FR') return FR_MOIS[idx];
  if (land === 'DE') return DE_MONATE[idx];
  return NL_MAANDEN[idx];
}

// Zoekopdracht uit de feiten. De titel tussen aanhalingstekens zodat we
// niet op losse woorden matchen, plus plaats en maand+jaar als context.
function bouwZoekQuery(item: TeResolven, uitsluiten: string[]): string {
  const jaar  = item.date_start.slice(0, 4);
  const maand = maandNaam(item.date_start, item.land);
  const delen = ['"' + item.title.replace(/"/g, '').trim() + '"'];
  if (item.city) delen.push(item.city.trim());
  delen.push(maand, jaar);

  let q = delen.join(' ');
  for (const d of uitsluiten) {
    const toevoeging = ' -site:' + d;
    if (q.length + toevoeging.length > MAX_QUERY_LEN) break;
    q += toevoeging;
  }
  return q;
}

// Noch pending_events noch listings heeft een landkolom. De TLD van de
// bron is de enige aanwijzing die we altijd hebben; NL is de rest.
function landUitDomein(domein: string): string {
  const d = (domein || '').toLowerCase();
  if (d.endsWith('.be')) return 'BE';
  if (d.endsWith('.fr')) return 'FR';
  if (d.endsWith('.de')) return 'DE';
  return 'NL';
}

function braveLandParam(land: string): string {
  switch ((land || '').toUpperCase()) {
    case 'BE': return '&country=BE';
    case 'FR': return '&country=FR';
    case 'DE': return '&country=DE';
    default:   return '&country=NL';
  }
}

async function fetchPageText(url: string): Promise<string> {
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'YardiGo/1.0 (+https://www.yardigo.nl; yardigo.app@gmail.com)' },
  }, PAGE_FETCH_TIMEOUT);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return stripHtml(await res.text(), MAX_TEXT);
}

// ── Anthropic verificatie ─────────────────────────────────────────
function buildSystemPrompt(item: TeResolven, vandaag: string): string {
  return [
    'Je controleert of een webpagina de ORIGINELE bron is van een specifiek evenement.',
    `Vandaag is ${vandaag}.`,
    '',
    'Het evenement dat we zoeken:',
    `  titel:  ${item.title}`,
    `  plaats: ${item.city || 'onbekend'}`,
    `  datum:  ${item.date_start}`,
    '',
    'Antwoord UITSLUITEND met één JSON-object, geen uitleg buiten JSON, geen markdown-fences.',
    '',
    'Schema:',
    '{',
    '  "is_zelfde_event": bool,        // beschrijft deze pagina exact dit evenement?',
    '  "is_originele_bron": bool,      // organisator/vereniging/gemeente/dorpssite = true; verzamelsite/agenda-site/marktplaats = false',
    '  "datum_op_pagina": "YYYY-MM-DD" | null,  // de datum die de PAGINA noemt, niet de datum hierboven overnemen',
    '  "plaats_op_pagina": string | null,',
    '  "organisator": string | null,   // naam van vereniging/organisator/gemeente, voor de bronvermelding',
    '  "zekerheid": 0-100,',
    '  "toelichting": string           // < 200 tekens',
    '}',
    '',
    'Regels:',
    '- Noemt de pagina geen datum, zet datum_op_pagina op null. Verzin niets.',
    '- Gaat het om een terugkerend evenement waarvan de pagina een ANDERE editie beschrijft, dan is_zelfde_event=false.',
    '- Een pagina die alleen een lijst met evenementen toont zonder eigen informatie is geen originele bron.',
    '- Bij twijfel: lagere zekerheid, niet gokken.',
  ].join('\n');
}

async function verifieerPagina(
  anthropicKey: string, item: TeResolven, url: string, tekst: string, vandaag: string,
): Promise<Verificatie | null> {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 600,
      system: buildSystemPrompt(item, vandaag),
      messages: [{ role: 'user', content: 'URL: ' + url + '\n\nPagina-tekst:\n' + tekst }],
    }),
  }, ANTHROPIC_TIMEOUT);
  if (!res.ok) return null;
  const j = await res.json();
  const parts = (j?.content || []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n').trim();
  const parsed = safeParseJson(parts);
  if (!parsed) return null;

  const zekerheid = Number(parsed.zekerheid);
  return {
    is_zelfde_event:   parsed.is_zelfde_event === true,
    is_originele_bron: parsed.is_originele_bron === true,
    datum_op_pagina:   typeof parsed.datum_op_pagina === 'string' ? parsed.datum_op_pagina.slice(0, 10) : null,
    plaats_op_pagina:  typeof parsed.plaats_op_pagina === 'string' ? parsed.plaats_op_pagina : null,
    organisator:       typeof parsed.organisator === 'string' ? parsed.organisator.trim().slice(0, 120) : null,
    zekerheid:         Number.isFinite(zekerheid) ? Math.max(0, Math.min(100, zekerheid)) : 0,
    toelichting:       typeof parsed.toelichting === 'string' ? parsed.toelichting.slice(0, 200) : '',
  };
}

// De harde controle staat bewust hier en niet in de prompt: het model mag
// adviseren, maar datum en plaats vergelijken we zelf.
function isGeldigeMatch(item: TeResolven, v: Verificatie): { ok: boolean; reden: string } {
  if (!v.is_zelfde_event)                  return { ok: false, reden: 'model: ander evenement' };
  if (!v.is_originele_bron)                return { ok: false, reden: 'model: geen originele bron' };
  if (v.zekerheid < MIN_ZEKERHEID)         return { ok: false, reden: 'zekerheid ' + v.zekerheid + ' < ' + MIN_ZEKERHEID };
  if (!v.datum_op_pagina)                  return { ok: false, reden: 'pagina noemt geen datum' };
  if (v.datum_op_pagina !== item.date_start) {
    return { ok: false, reden: 'datum wijkt af (' + v.datum_op_pagina + ' vs ' + item.date_start + ')' };
  }
  if (item.city && !plaatsMatcht(item.city, v.plaats_op_pagina)) {
    return { ok: false, reden: 'plaats wijkt af (' + (v.plaats_op_pagina || 'geen') + ' vs ' + item.city + ')' };
  }
  return { ok: true, reden: 'ok' };
}

// ── Auth ───────────────────────────────────────────────────────────
async function isAuthorized(req: Request, adminClient: any): Promise<{ ok: true; via: 'cron' | 'admin' } | { ok: false; status: number; error: string }> {
  const cronHdr = req.headers.get('x-cron-secret') ?? '';
  if (cronHdr) {
    const { data } = await adminClient.from('app_config').select('value').eq('key', 'cron_secret').maybeSingle();
    if (data?.value && cronHdr === data.value) return { ok: true, via: 'cron' };
  }
  const authHdr = req.headers.get('Authorization') ?? '';
  const m = authHdr.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401, error: 'Missing auth' };
  const userRes = await adminClient.auth.getUser(m[1]);
  if (userRes.error || !userRes.data?.user) return { ok: false, status: 401, error: 'Invalid token' };
  const prof = await adminClient.from('profiles').select('is_admin, admin_badges').eq('id', userRes.data.user.id).maybeSingle();
  if (prof.error) return { ok: false, status: 500, error: prof.error.message };
  const badges = parseBadges(prof.data?.admin_badges);
  if (prof.data?.is_admin !== true && !badges.includes('admin')) return { ok: false, status: 403, error: 'Admin required' };
  return { ok: true, via: 'admin' };
}

// ── Eén event oplossen ─────────────────────────────────────────────
interface Uitkomst {
  gevonden: boolean;
  url?: string;
  domein?: string;
  label?: string;
  zekerheid?: number;
  notitie: string;
  bekeken: number;
}

async function resolveEen(
  item: TeResolven, braveKey: string, anthropicKey: string,
  blockDomeinen: string[], vandaag: string, deadline: number,
): Promise<Uitkomst> {
  const leadDomein = extractDomain(item.source_url || '');
  const uitsluiten = [...new Set([leadDomein, ...blockDomeinen, 'yardigo.nl', 'yardigo.be', 'yardigo.app'].filter(Boolean))];
  const query = bouwZoekQuery(item, uitsluiten);

  let braveJson: any = null;
  try {
    const res = await fetchWithTimeout(
      BRAVE_ENDPOINT + '?q=' + encodeURIComponent(query) + '&count=' + BRAVE_RESULTS + braveLandParam(item.land),
      { headers: { Accept: 'application/json', 'X-Subscription-Token': braveKey } }, 10000);
    if (!res.ok) throw new Error('Brave ' + res.status);
    braveJson = await res.json();
  } catch (e) {
    return { gevonden: false, notitie: 'zoekfout: ' + (e as Error).message, bekeken: 0 };
  }

  const resultaten = extractPathValue<BraveResult[]>(braveJson, 'web.results', []);
  const gezien = new Set<string>();
  const kandidaten: string[] = [];
  for (const r of resultaten) {
    const url = (r.url || '').trim();
    if (!url) continue;
    const d = extractDomain(url);
    if (!d || gezien.has(d)) continue;
    if (uitsluiten.some(b => d === b || d.endsWith('.' + b))) continue;
    gezien.add(d);
    kandidaten.push(url);
    if (kandidaten.length >= MAX_KANDIDATEN) break;
  }

  if (!kandidaten.length) return { gevonden: false, notitie: 'geen bruikbare zoekresultaten', bekeken: 0 };

  let beste: { url: string; v: Verificatie } | null = null;
  const redenen: string[] = [];
  let bekeken = 0;

  for (const url of kandidaten) {
    if (Date.now() > deadline) { redenen.push('tijd op'); break; }
    await sleep(FETCH_INTERVAL_MS);
    bekeken++;
    let tekst = '';
    try { tekst = await fetchPageText(url); }
    catch (e) { redenen.push(extractDomain(url) + ': ' + (e as Error).message); continue; }
    if (tekst.length < 120) { redenen.push(extractDomain(url) + ': te weinig tekst'); continue; }

    const v = await verifieerPagina(anthropicKey, item, url, tekst, vandaag);
    if (!v) { redenen.push(extractDomain(url) + ': geen bruikbaar AI-antwoord'); continue; }

    const check = isGeldigeMatch(item, v);
    if (!check.ok) { redenen.push(extractDomain(url) + ': ' + check.reden); continue; }
    if (!beste || v.zekerheid > beste.v.zekerheid) beste = { url, v };
  }

  if (!beste) {
    return { gevonden: false, notitie: redenen.join(' | ').slice(0, 500) || 'geen match', bekeken };
  }
  const domein = extractDomain(beste.url);
  return {
    gevonden: true,
    url: beste.url,
    domein,
    label: beste.v.organisator || domein,
    zekerheid: beste.v.zekerheid,
    notitie: beste.v.toelichting,
    bekeken,
  };
}

// ── Main ───────────────────────────────────────────────────────────
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  const supabaseUrl  = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
  const braveKey     = Deno.env.get('BRAVE_API_KEY') ?? '';
  if (!supabaseUrl || !serviceKey) return json({ error: 'SUPABASE env missing' }, 500);
  if (!anthropicKey)               return json({ error: 'ANTHROPIC_API_KEY missing' }, 500);
  if (!braveKey)                   return json({ error: 'BRAVE_API_KEY missing' }, 500);

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const auth = await isAuthorized(req, sb);
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  let body: { target?: string; max_items?: number; dryRun?: boolean; domains?: string[] } = {};
  try { body = await req.json(); } catch (_) {}
  const target   = body.target === 'listings' ? 'listings' : 'pending';
  const maxItems = Math.max(1, Math.min(50, body.max_items ?? DEFAULT_MAX_ITEMS));
  const dryRun   = body.dryRun === true;
  const deadline = Date.now() + RUN_BUDGET_MS;
  const vandaag  = new Date().toISOString().slice(0, 10);

  // Blocklist alleen LEZEN, om te voorkomen dat we weer bij dezelfde
  // verzamelsite uitkomen. Deze functie wijzigt de blocklist nooit.
  const blRes = await sb.from('discovery_blocklist').select('domein');
  const blockDomeinen: string[] = (blRes.data || []).map((r: any) => (r.domein || '').toLowerCase()).filter(Boolean);

  const samenvatting: any = {
    target, dryRun, bekeken: 0, opgelost: 0, onopgelost: 0,
    paginas_geopend: 0, budget_op: false, items: [] as any[], errors: [] as string[],
  };

  // ── Werklijst ophalen ────────────────────────────────────────────
  const werk: TeResolven[] = [];

  if (target === 'pending') {
    const res = await sb.from('pending_events')
      .select('id,title,city,date_start,source_url,source_label')
      .eq('source_status', 'aggregator')
      .eq('status', 'nieuw')
      .order('created_at', { ascending: true })
      .limit(maxItems);
    if (res.error) return json({ error: 'pending_events: ' + res.error.message }, 500);
    for (const r of res.data || []) {
      werk.push({
        soort: 'pending', id: String(r.id), title: r.title, city: r.city,
        date_start: String(r.date_start).slice(0, 10),
        land: landUitDomein(extractDomain(r.source_url || '')),
        source_url: r.source_url, source_label: r.source_label,
      });
    }
  } else {
    const hints = (Array.isArray(body.domains) && body.domains.length)
      ? body.domains.map(d => String(d).toLowerCase())
      : BACKFILL_DOMAIN_HINTS;

    // Alles met een bron ophalen en in code filteren op domein: source_url
    // is een vrije tekstkolom, dus een ILIKE per domein is onnauwkeurig.
    const res = await sb.from('listings')
      .select('id,title,city,date_start,source_url,source_label')
      .not('source_url', 'is', null)
      .order('created_at', { ascending: false })
      .limit(500);
    if (res.error) return json({ error: 'listings: ' + res.error.message }, 500);

    const alGedaan = await sb.from('listing_source_leads').select('listing_id,status');
    const gedaanMap = new Map<string, string>((alGedaan.data || []).map((r: any) => [r.listing_id, r.status]));

    for (const r of res.data || []) {
      if (werk.length >= maxItems) break;
      const d = extractDomain(r.source_url || '');
      if (!d || !hints.some(h => d === h || d.endsWith('.' + h))) continue;
      if (gedaanMap.get(r.id) === 'origineel') continue;   // al opgelost
      werk.push({
        soort: 'listing', id: r.id, title: r.title, city: r.city,
        date_start: String(r.date_start).slice(0, 10),
        land: landUitDomein(d),
        source_url: r.source_url, source_label: r.source_label,
      });
    }
  }

  // ── Afwerken ─────────────────────────────────────────────────────
  for (const item of werk) {
    if (Date.now() > deadline) { samenvatting.budget_op = true; break; }
    samenvatting.bekeken++;

    let uit: Uitkomst;
    try {
      uit = await resolveEen(item, braveKey, anthropicKey, blockDomeinen, vandaag, deadline);
    } catch (e) {
      samenvatting.errors.push(item.title + ': ' + (e as Error).message);
      continue;
    }
    samenvatting.paginas_geopend += uit.bekeken;

    samenvatting.items.push({
      id: item.id, titel: item.title, plaats: item.city, datum: item.date_start,
      oude_bron: item.source_label || extractDomain(item.source_url || ''),
      nieuwe_bron: uit.gevonden ? uit.label : null,
      nieuwe_url: uit.gevonden ? uit.url : null,
      zekerheid: uit.zekerheid ?? null,
      notitie: uit.notitie,
    });

    if (uit.gevonden) samenvatting.opgelost++; else samenvatting.onopgelost++;
    if (dryRun) continue;

    const leadUrl    = item.source_url || '';
    const leadDomein = extractDomain(leadUrl);

    if (item.soort === 'pending') {
      const patch: Record<string, unknown> = {
        source_resolved_at: new Date().toISOString(),
        source_notes: uit.notitie,
      };
      if (uit.gevonden) {
        // Lead pas vastleggen als we hem daadwerkelijk vervangen.
        patch.lead_source_url    = leadUrl || null;
        patch.lead_source_domain = leadDomein || null;
        patch.source_url         = uit.url;
        patch.source_domain      = uit.domein;
        patch.source_label       = uit.label;
        patch.source_status      = 'origineel';
        patch.source_confidence  = uit.zekerheid ?? null;
      } else {
        patch.source_status = 'onopgelost';
      }
      const up = await sb.from('pending_events').update(patch).eq('id', item.id);
      if (up.error) samenvatting.errors.push('update pending ' + item.id + ': ' + up.error.message);
    } else {
      // Gepubliceerde listing: bron vervangen, lead in de admin-only tabel.
      const lead = {
        listing_id: item.id,
        lead_url: leadUrl,
        lead_domain: leadDomein,
        resolved_url: uit.gevonden ? uit.url : null,
        resolved_domain: uit.gevonden ? uit.domein : null,
        resolved_label: uit.gevonden ? uit.label : null,
        status: uit.gevonden ? 'origineel' : 'onopgelost',
        confidence: uit.zekerheid ?? null,
        notes: uit.notitie,
        resolved_at: new Date().toISOString(),
      };
      const ins = await sb.from('listing_source_leads').upsert(lead, { onConflict: 'listing_id' });
      if (ins.error) samenvatting.errors.push('lead ' + item.id + ': ' + ins.error.message);

      if (uit.gevonden) {
        const up = await sb.from('listings')
          .update({ source_url: uit.url, source_label: uit.label })
          .eq('id', item.id);
        if (up.error) samenvatting.errors.push('update listing ' + item.id + ': ' + up.error.message);
      }
    }
  }

  return json(samenvatting, 200);
});
