// YardiGo – discover-events Edge Function
//
// Speurt online naar rommelroutes/garageverkopen/rommelmarkten/
// buurtverkopen via Brave Search, laat Anthropic (Claude Haiku 4.5)
// beoordelen of de bron origineel + relevant is, en importeert events
// dedupe-safe naar `pending_events`. Structurele agenda-domeinen
// worden als 'voorgesteld' in `scrape_sources` gezet.
//
// Aanroep (POST, JSON):
//   {}                          — normale run
//   { "dryRun": true }          — geen writes, alleen samenvatting
//   { "max_urls": 25 }          — override standaard-limiet
//
// Auth:
//   - Cron: header x-cron-secret = app_config.cron_secret
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

const ANTHROPIC_MODEL      = 'claude-haiku-4-5';
const BRAVE_ENDPOINT       = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_MAX_URLS     = 25;
const DEFAULT_MAX_TEXT     = 8000;
const FETCH_INTERVAL_MS    = 1000;   // 1 fetch per sec
const BRAVE_RESULTS        = 10;
const PAGE_FETCH_TIMEOUT   = 12000;  // 12s per pagina
const ANTHROPIC_TIMEOUT    = 30000;
const DUPE_RADIUS_M        = 500;

// ── Interfaces ─────────────────────────────────────────────────────
interface DiscoveryQuery { id: number; query_tekst: string; land: string; laatste_run: string | null; }
interface BraveResult    { title: string; url: string; description?: string; }
interface EventParsed {
  titel: string | null;
  event_type: string | null;
  datum: string | null;
  starttijd: string | null;
  eindtijd: string | null;
  plaats: string | null;
  adres: string | null;
  beschrijving: string | null;
  bron_naam: string | null;
  bron_url: string | null;
}
interface Beoordeling {
  is_originele_bron: boolean;
  heeft_toekomstige_events: boolean;
  is_structurele_agenda: boolean;
  events: EventParsed[];
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

const NL_MAANDEN = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
const FR_MOIS    = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
const DE_MONATE  = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];

function expandQuery(tpl: string, land: string, monthOffset: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + monthOffset);
  const y = d.getFullYear();
  const mIdx = d.getMonth();
  const maand = NL_MAANDEN[mIdx];
  const mois  = FR_MOIS[mIdx];
  const monat = DE_MONATE[mIdx];
  return tpl
    .replace(/\{maand\}/gi,  maand)
    .replace(/\{jaar\}/gi,   String(y))
    .replace(/\{mois\}/gi,   mois)
    .replace(/\{annee\}/gi,  String(y))
    .replace(/\{Monat\}/g,   monat)
    .replace(/\{Jahr\}/gi,   String(y));
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

// ── Geocoding: PDOK (NL) → BAN (FR) → Nominatim (BE/DE/fallback) ─
async function geocode(address: string | null, city: string | null, country: string): Promise<{ lat: number; lng: number } | null> {
  const query = [address, city].filter(Boolean).join(', ').trim();
  if (!query) return null;
  try {
    if (country === 'NL') {
      const r = await fetchWithTimeout('https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?q=' + encodeURIComponent(query) + '&rows=1&fq=type:(adres+woonplaats)&fl=weergavenaam,centroide_ll', { headers: { Accept: 'application/json' } }, 8000);
      if (r.ok) {
        const j = await r.json();
        const doc = j?.response?.docs?.[0];
        const cll = doc?.centroide_ll; // "POINT(lng lat)"
        if (typeof cll === 'string') {
          const m = cll.match(/POINT\(([-\d.]+)\s+([-\d.]+)\)/);
          if (m) return { lng: parseFloat(m[1]), lat: parseFloat(m[2]) };
        }
      }
    }
    if (country === 'FR') {
      const r = await fetchWithTimeout('https://api-adresse.data.gouv.fr/search/?limit=1&q=' + encodeURIComponent(query), { headers: { Accept: 'application/json' } }, 8000);
      if (r.ok) {
        const j = await r.json();
        const c = j?.features?.[0]?.geometry?.coordinates;
        if (Array.isArray(c) && c.length >= 2) return { lng: c[0], lat: c[1] };
      }
    }
    // Fallback: Nominatim (BE/DE/rest)
    const cc = country === 'BE' ? 'be' : country === 'DE' ? 'de' : country === 'NL' ? 'nl' : country === 'FR' ? 'fr' : '';
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1' + (cc ? '&countrycodes=' + cc : '') + '&q=' + encodeURIComponent(query);
    const r = await fetchWithTimeout(url, { headers: { Accept: 'application/json', 'User-Agent': 'YardiGo-discover-events' } }, 8000);
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j) && j[0]?.lat && j[0]?.lon) return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon) };
    }
  } catch (_) { /* geocode is best-effort */ }
  return null;
}

// ── Anthropic beoordeling ─────────────────────────────────────────
function buildSystemPrompt(today: string, country: string): string {
  return [
    'Je beoordeelt een webpagina als potentiële bron voor lokale-verkoop-evenementen (rommelmarkten, rommelroutes, opritverkoop, buurtverkopen, brocantes, Flohmärkte, vide-greniers).',
    `Vandaag is ${today}. Context land: ${country}.`,
    '',
    'Antwoord UITSLUITEND met één JSON-object, geen uitleg buiten JSON, geen markdown-fences.',
    '',
    'Schema:',
    '{',
    '  "is_originele_bron": bool,           // organisator/gemeente/vereniging/dorpssite = true; verzamelsite/aggregator/marktplaats = false',
    '  "heeft_toekomstige_events": bool,',
    '  "is_structurele_agenda": bool,       // publiceert dit domein doorlopend events (agenda-site) of eenmalige pagina?',
    '  "events": [ ... ],                   // alleen TOEKOMSTIGE events; leeg indien geen',
    '  "toelichting": string                // < 240 tekens waarom origineel-of-niet en wat voor site',
    '}',
    '',
    'Elk event in "events" volgt DIT schema (kopie parse-event):',
    '{',
    '  "titel": string | null,',
    '  "event_type": "opritverkoop"|"rommelroute"|"rommelmarkt"|"buurtverkoop"|"overig" | null,',
    '  "datum": "YYYY-MM-DD" | null,',
    '  "starttijd": "HH:MM" | null,',
    '  "eindtijd": "HH:MM" | null,',
    '  "plaats": string | null,',
    '  "adres": string | null,',
    '  "beschrijving": string | null,       // EIGEN korte formulering, max 240 tekens, geen letterlijke overname',
    '  "bron_naam": string | null,',
    '  "bron_url": string | null',
    '}',
    '',
    'Regels:',
    '- adres = alleen bij duidelijk publieke locatie (sporthal, plein, kerk, markthal, schoolplein, gemeentekantoor). Bij privéadres van particulier: adres=null.',
    '- Neem GEEN events over waarvan de datum al voorbij is (< vandaag).',
    '- Bij aggregators (rommelmarkten.nl, meukisleuk.nl, marktplaats.nl, Facebook, 2dehands, leboncoin) is is_originele_bron=false, events=[] en toelichting benoemt dat het een aggregator is.',
    '- Verzin niets. Onduidelijk = null.',
  ].join('\n');
}

async function beoordeelPagina(anthropicKey: string, url: string, tekst: string, country: string): Promise<Beoordeling | null> {
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2000,
      system: buildSystemPrompt(today, country),
      messages: [{ role: 'user', content: 'URL: ' + url + '\n\nPagina-tekst:\n' + tekst }],
    }),
  }, ANTHROPIC_TIMEOUT);
  if (!res.ok) return null;
  const j = await res.json();
  const parts = (j?.content || []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n').trim();
  const parsed = safeParseJson(parts);
  if (!parsed) return null;
  return {
    is_originele_bron:        parsed.is_originele_bron === true,
    heeft_toekomstige_events: parsed.heeft_toekomstige_events === true,
    is_structurele_agenda:    parsed.is_structurele_agenda === true,
    events: Array.isArray(parsed.events) ? parsed.events as EventParsed[] : [],
    toelichting: typeof parsed.toelichting === 'string' ? parsed.toelichting : '',
  };
}

// ── Event normalisatie + insert ───────────────────────────────────
const ALLOWED_EVENT_TYPES = new Set(['opritverkoop','rommelroute','rommelmarkt','buurtverkoop','overig']);

function normalizeEvent(e: EventParsed): {
  titel: string; event_subtype: string | null;
  datum: string; starttijd: string | null; eindtijd: string | null;
  plaats: string | null; adres: string | null; beschrijving: string | null;
} | null {
  const titel = (e.titel || '').trim();
  const datum = (e.datum || '').trim();
  if (!titel || !/^\d{4}-\d{2}-\d{2}$/.test(datum)) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (datum < today) return null;
  const et = (e.event_type || '').trim();
  const pad = (t: string | null): string | null => {
    if (!t) return null; if (!/^\d{1,2}:\d{2}$/.test(t)) return null;
    const [h, m] = t.split(':'); return h.padStart(2, '0') + ':' + m;
  };
  return {
    titel,
    event_subtype: ALLOWED_EVENT_TYPES.has(et) ? et : null,
    datum,
    starttijd:    pad(e.starttijd),
    eindtijd:     pad(e.eindtijd),
    plaats:       (e.plaats || '').trim() || null,
    adres:        (e.adres  || '').trim() || null,
    beschrijving: (e.beschrijving || '').trim() || null,
  };
}

// ── Auth helper ────────────────────────────────────────────────────
async function isAuthorized(req: Request, adminClient: any): Promise<{ ok: true; via: 'cron' | 'admin' } | { ok: false; status: number; error: string }> {
  const cronHdr = req.headers.get('x-cron-secret') ?? '';
  if (cronHdr) {
    const { data } = await adminClient.from('app_config').select('value').eq('key', 'cron_secret').maybeSingle();
    if (data?.value && cronHdr === data.value) return { ok: true, via: 'cron' };
  }
  const authHdr = req.headers.get('Authorization') ?? '';
  const m = authHdr.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401, error: 'Missing auth' };
  const jwt = m[1];
  const userRes = await adminClient.auth.getUser(jwt);
  if (userRes.error || !userRes.data?.user) return { ok: false, status: 401, error: 'Invalid token' };
  const prof = await adminClient.from('profiles').select('is_admin, admin_badges').eq('id', userRes.data.user.id).maybeSingle();
  if (prof.error) return { ok: false, status: 500, error: prof.error.message };
  const badges = parseBadges(prof.data?.admin_badges);
  if (prof.data?.is_admin !== true && !badges.includes('admin')) return { ok: false, status: 403, error: 'Admin required' };
  return { ok: true, via: 'admin' };
}

// ── Main ───────────────────────────────────────────────────────────
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  const supabaseUrl  = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
  const braveKey     = Deno.env.get('BRAVE_API_KEY') ?? '';
  if (!supabaseUrl || !serviceKey)  return json({ error: 'SUPABASE env missing' }, 500);
  if (!anthropicKey)                 return json({ error: 'ANTHROPIC_API_KEY missing' }, 500);
  if (!braveKey)                     return json({ error: 'BRAVE_API_KEY missing' }, 500);

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const auth = await isAuthorized(req, sb);
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  // Body
  let body: { dryRun?: boolean; max_urls?: number } = {};
  try { body = await req.json(); } catch (_) {}
  const dryRun  = body.dryRun === true;
  const maxUrls = Math.max(1, Math.min(100, body.max_urls ?? DEFAULT_MAX_URLS));

  // Run start
  const runInsert = await sb.from('discovery_runs').insert({ started_at: new Date().toISOString() }).select('id').single();
  const runId = runInsert.data?.id;

  const summary: any = {
    queries_run: 0, brave_results: 0, urls_new: 0, urls_skipped_blocklist: 0,
    urls_skipped_known_source: 0, urls_skipped_seen: 0, urls_beoordeeld: 0, urls_afgewezen: 0,
    events_found: 0, events_deduped: 0, events_inserted: 0,
    sources_voorgesteld: 0, errors: [] as string[],
    dryRun, via: auth.via,
  };

  try {
    // Actieve queries + blocklist + bekende bronnen ophalen
    const [qRes, blRes, srcRes] = await Promise.all([
      sb.from('discovery_queries').select('id, query_tekst, land, laatste_run').eq('actief', true),
      sb.from('discovery_blocklist').select('domein'),
      sb.from('scrape_sources').select('domain'),
    ]);
    if (qRes.error)   throw new Error('queries: '   + qRes.error.message);
    if (blRes.error)  throw new Error('blocklist: ' + blRes.error.message);
    if (srcRes.error) throw new Error('sources: '   + srcRes.error.message);

    const blockSet = new Set<string>((blRes.data || []).map((r: any) => (r.domein || '').toLowerCase()));
    const knownSrc  = new Set<string>((srcRes.data || []).map((r: any) => (r.domain || '').toLowerCase()));

    const queries = (qRes.data || []) as DiscoveryQuery[];
    let newUrlsProcessed = 0;

    outer:
    for (const q of queries) {
      if (newUrlsProcessed >= maxUrls) break;
      summary.queries_run++;

      // 2 varianten: huidige + volgende maand
      for (const offset of [0, 1]) {
        if (newUrlsProcessed >= maxUrls) break outer;
        const expanded = expandQuery(q.query_tekst, q.land, offset);
        // Brave Search
        let braveJson: any = null;
        try {
          const braveRes = await fetchWithTimeout(BRAVE_ENDPOINT + '?q=' + encodeURIComponent(expanded)
            + '&count=' + BRAVE_RESULTS
            + (q.land === 'BE' ? '&country=BE' : q.land === 'FR' ? '&country=FR' : q.land === 'DE' ? '&country=DE' : '&country=NL'),
            { headers: { Accept: 'application/json', 'X-Subscription-Token': braveKey } }, 10000);
          if (!braveRes.ok) throw new Error('Brave ' + braveRes.status);
          braveJson = await braveRes.json();
        } catch (e) {
          summary.errors.push('brave "' + expanded + '": ' + (e as Error).message);
          continue;
        }
        const results = extractPathValue<BraveResult[]>(braveJson, 'web.results', []);
        summary.brave_results += results.length;

        for (const r of results) {
          if (newUrlsProcessed >= maxUrls) break outer;
          const url = (r.url || '').trim();
          if (!url) continue;
          const domain = extractDomain(url);
          if (!domain) continue;

          // Filter: blocklist / known source / al gezien
          if ([...blockSet].some(b => domain === b || domain.endsWith('.' + b))) {
            summary.urls_skipped_blocklist++; continue;
          }
          if (knownSrc.has(domain)) { summary.urls_skipped_known_source++; continue; }

          const seenRes = await sb.from('discovered_urls').select('id').eq('url', url).maybeSingle();
          if (seenRes.data) { summary.urls_skipped_seen++; continue; }

          summary.urls_new++;
          newUrlsProcessed++;

          // Fetch pagina (1 req/sec throttling)
          await sleep(FETCH_INTERVAL_MS);
          let pageText = '';
          try {
            const pRes = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; YardiGoDiscover/1.0)' } }, PAGE_FETCH_TIMEOUT);
            if (!pRes.ok) throw new Error('HTTP ' + pRes.status);
            const html = await pRes.text();
            pageText = stripHtml(html, DEFAULT_MAX_TEXT);
          } catch (e) {
            summary.errors.push('fetch ' + url + ': ' + (e as Error).message);
            if (!dryRun) {
              await sb.from('discovered_urls').insert({
                url, domein: domain, gevonden_via_query: expanded,
                status: 'afgewezen',
                beoordeling: { reden: 'fetch_failed', error: (e as Error).message },
              });
            }
            continue;
          }
          if (pageText.length < 200) {
            summary.errors.push('too_short: ' + url);
            if (!dryRun) {
              await sb.from('discovered_urls').insert({
                url, domein: domain, gevonden_via_query: expanded,
                status: 'afgewezen',
                beoordeling: { reden: 'te_kort', chars: pageText.length },
              });
            }
            continue;
          }

          // Anthropic beoordeling
          let beoordeling: Beoordeling | null = null;
          try { beoordeling = await beoordeelPagina(anthropicKey, url, pageText, q.land); }
          catch (e) { summary.errors.push('ai ' + url + ': ' + (e as Error).message); }
          if (!beoordeling) {
            if (!dryRun) {
              await sb.from('discovered_urls').insert({
                url, domein: domain, gevonden_via_query: expanded,
                status: 'afgewezen',
                beoordeling: { reden: 'ai_parse_failed' },
              });
            }
            summary.urls_afgewezen++;
            continue;
          }

          summary.urls_beoordeeld++;
          if (!beoordeling.is_originele_bron) summary.urls_afgewezen++;

          if (dryRun) continue;

          // Log URL-beoordeling
          await sb.from('discovered_urls').insert({
            url, domein: domain, gevonden_via_query: expanded,
            status: beoordeling.is_originele_bron ? 'beoordeeld' : 'afgewezen',
            beoordeling: beoordeling as any,
          });

          if (!beoordeling.is_originele_bron) continue;

          // Structurele agenda → voorstel voor scrape_sources
          if (beoordeling.is_structurele_agenda && !knownSrc.has(domain)) {
            const ins = await sb.from('scrape_sources').insert({
              domain, base_url: 'https://' + domain,
              country: q.land, actief: false, voorgesteld: true,
              voorstel_reden: (beoordeling.toelichting || 'AI-detectie: doorlopende agenda').slice(0, 500),
              notes: 'Gedetecteerd door discover-events op ' + new Date().toISOString().slice(0,10),
            }).select('id').maybeSingle();
            if (!ins.error) { summary.sources_voorgesteld++; knownSrc.add(domain); }
          }

          // Events verwerken
          for (const raw of beoordeling.events) {
            summary.events_found++;
            const ne = normalizeEvent(raw);
            if (!ne) continue;

            // Geocoding (best-effort)
            const geo = await geocode(ne.adres, ne.plaats, q.land);
            const lat = geo?.lat ?? null;
            const lng = geo?.lng ?? null;

            // Content hash + dedupe
            const hashRes = await sb.rpc('discovery_content_hash', {
              p_title: ne.titel, p_date: ne.datum, p_city: ne.plaats,
            });
            if (hashRes.error) { summary.errors.push('hash_rpc: ' + hashRes.error.message); continue; }
            const contentHash = hashRes.data as string;
            const sim = await sb.rpc('discovery_find_similar', {
              p_hash: contentHash, p_lat: lat, p_lng: lng,
              p_date: ne.datum, p_radius_m: DUPE_RADIUS_M,
            });
            if (sim.error) { summary.errors.push('dupe_rpc: ' + sim.error.message); continue; }
            if (sim.data) { summary.events_deduped++; continue; }

            const insEv = await sb.from('pending_events').insert({
              title:                ne.titel,
              description:          ne.beschrijving,
              event_subtype:        ne.event_subtype,
              date_start:           ne.datum,
              time_start:           ne.starttijd,
              time_end:             ne.eindtijd,
              city:                 ne.plaats,
              address:              ne.adres,
              latitude:             lat,
              longitude:            lng,
              source_url:           url,
              source_domain:        domain,
              source_label:         (raw.bron_naam || '').slice(0, 200) || null,
              discovered_via_query: expanded,
              content_hash:         contentHash,
              raw_ai_response:      raw as any,
            });
            if (insEv.error) {
              summary.errors.push('insert_pending: ' + insEv.error.message);
              continue;
            }
            summary.events_inserted++;
          }
        }

        // laatste_run bijwerken
        if (!dryRun) {
          await sb.from('discovery_queries').update({ laatste_run: new Date().toISOString() }).eq('id', q.id);
        }
      }
    }

    // Run afsluiten
    if (runId) {
      await sb.from('discovery_runs').update({
        finished_at: new Date().toISOString(),
        summary,
      }).eq('id', runId);
    }

    return json({ ok: true, run_id: runId, summary }, 200);
  } catch (err) {
    const msg = (err as Error).message;
    if (runId) {
      await sb.from('discovery_runs').update({
        finished_at: new Date().toISOString(), summary, error: msg,
      }).eq('id', runId);
    }
    return json({ error: msg, summary }, 500);
  }
});
