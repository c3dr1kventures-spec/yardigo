// YardiGo – import-oliebollen Edge Function
//
// Vult public.oliebollen_kramen uit het Gemeenteblad. Gemeenten moeten
// standplaatsvergunningen (aanvraag, besluit, intrekking) publiceren op
// officielebekendmakingen.nl; de open SRU-zoekdienst van KOOP
// (repository.overheid.nl/sru) geeft die terug als we zoeken op "oliebollen".
// Openbare overheidsinformatie, geen scraping van andere kaarten.
//
// Per publicatie:
//   1. tekst ophalen (alleen het "Lichaam", lange stukken als APV's slaan we over)
//   2. AI (Haiku) leest: gaat het om een vaste verkoopplek voor oliebollen?
//      Zo ja: plaats, locatie, adres, periode, dagen, tijden, vergunning.
//      Nee bij huis-aan-huis venten, geluidswagens, evenementen, regels.
//   3. plek zoeken (PDOK/Photon, getoetst aan de plaatsnaam)
//   4. samenvoegen met een bestaande kraam op dezelfde plek (aanvraag en
//      besluit zijn twee publicaties), of nieuw aanmaken
//   5. intrekking/weigering zet de kraam op 'ingetrokken'
// Elke publicatie komt in oliebollen_bronnen, zodat een run alleen nieuwe leest.
//
// Aanroep (POST, JSON):
//   {}                     normale run (max 40 nieuwe publicaties)
//   { "max": 80 }          meer per run (backfill)
//   { "dryRun": true }     niets wegschrijven, wel resultaat per publicatie
//   { "action": "goedkeuren", "id": 12 }   (admin) kraam live zetten: plek zoeken
//                          als die ontbreekt; een aanvulling ("aanvulling op #8")
//                          wordt in kraam 8 samengevoegd en daarna verwijderd
//   { "action": "verbergen", "id": 12 }    (admin) van de kaart halen
// Na elke run: nieuwe aanmeldingen van kraamhouders als Telegram-bericht.
//
// Auth: header x-cron-secret = app_config.cron_secret, of admin-JWT.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { zoekPlek } from '../_shared/locatie.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const ANTHROPIC_MODELS = ['claude-haiku-5-5', 'claude-haiku-4-5'];
const SRU = 'https://repository.overheid.nl/sru';
const USER_AGENT = 'Mozilla/5.0 (compatible; YardiGo/1.0; +https://www.yardigo.nl)';
const MAX_TEKST = 5000;          // langer = beleidsregels/APV, geen vergunning
const AI_BATCH = 8;
const TIJD_BUDGET_MS = 120000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
}
function safeParseJson(raw: string): any {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch { return null; }
}
function decode(s: string): string {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
const tag = (xml: string, t: string) => decode((xml.match(new RegExp('<' + t + '[^>]*>([^<]*)<')) || [])[1] || '').trim();

// Seizoen: vanaf 1 augustus (aanvragen beginnen in de zomer) t/m eind januari.
function seizoenStart(nu = new Date()): string {
  const j = nu.getUTCMonth() >= 6 ? nu.getUTCFullYear() : nu.getUTCFullYear() - 1;
  return `${j}-08-01`;
}

function seizoenEinde(nu = new Date()): string {
  return `${Number(seizoenStart(nu).slice(0, 4)) + 1}-01-31`;
}

interface Pub { id: string; titel: string; gemeente: string; provincie: string; datum: string; html: string; url: string }

async function zoekPublicaties(vanaf: string, fouten: string[]): Promise<Pub[]> {
  const uit: Pub[] = [];
  const q = `c.product-area==officielepublicaties AND cql.textAndIndexes="oliebollen" AND dt.date>=${vanaf}`;
  for (let start = 1; start <= 2000; start += 100) {
    const u = `${SRU}?query=${encodeURIComponent(q)}&maximumRecords=100&startRecord=${start}`;
    let xml = '';
    try {
      const r = await fetch(u, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) { fouten.push('sru ' + r.status); break; }
      xml = await r.text();
    } catch (e) { fouten.push('sru ' + (e as Error).message); break; }
    const recs = xml.split('<sru:record>').slice(1);
    for (const r of recs) {
      if (tag(r, 'overheidwetgeving:publicatienaam') !== 'Gemeenteblad') continue;
      uit.push({
        id: tag(r, 'dcterms:identifier'), titel: tag(r, 'dcterms:title'),
        gemeente: tag(r, 'overheidwetgeving:gemeentenaam') || tag(r, 'dcterms:creator'),
        provincie: tag(r, 'overheidwetgeving:ligtInProvincie'), datum: tag(r, 'dcterms:date').slice(0, 10),
        html: (r.match(/manifestation="html">([^<]*)</) || [])[1] || '',
        url: (r.match(/<gzd:preferredUrl>([^<]*)</) || [])[1] || '',
      });
    }
    if (recs.length < 100) break;
  }
  return uit.filter(p => p.id && p.html);
}

async function lichaam(url: string): Promise<string> {
  const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  let h = await r.text();
  const a = h.search(/<div[^>]*id="broodtekst"|<main/i);
  if (a > 0) h = h.slice(a);
  h = h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ');
  let t = decode(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  // Alles na de bezwaarclausule en de paginavoet is ruis.
  t = t.replace(/(Inhoudsopgave|Toon volledige inhoudsopgave)\s*Lichaam/i, '').split(/Inhoudsopgave Lichaam Acties|Authentieke versie downloaden/)[0];
  return t.replace(/^.*?Gepubliceerd op \d{4}-\d{2}-\d{2}/, '').trim();
}

async function leesMetAi(key: string, items: { ref: string; gemeente: string; titel: string; tekst: string }[], fouten: string[]) {
  const system = [
    'Je leest Nederlandse gemeentelijke bekendmakingen over de verkoop van oliebollen. Antwoord ALLEEN met JSON: {"items":[...]} met per bekendmaking één object met "ref".',
    'Velden:',
    '- relevant: true als het gaat om een VASTE verkoopplek (kraam, wagen, standplaats, drive-in, verkoop bij een pand/winkel/supermarkt/tuincentrum, verkoopactie van een vereniging op één plek). false bij huis-aan-huis venten of rondrijden, geluidswagens, evenementen/hardloopwedstrijden, kermissen, algemene regels/beleid/APV, marktverordeningen, of als oliebollen er alleen terloops in staan.',
    '- reden: korte reden (max 60 tekens) als relevant=false.',
    '- vergunning: "aanvraag" (ontvangen aanvraag), "verleend" (besluit/toestemming/vergunning verleend), "melding" (geaccepteerde melding), "geweigerd" of "ingetrokken".',
    '- soort: "actie" bij een vereniging, scouting, school, kerk of goed doel (meestal 1-2 dagen), anders "kraam".',
    '- naam: naam van de kraam of het bedrijf als die er letterlijk staat (bv. "Rauwerda\'s oliebollen"), anders null. Nooit een privépersoon.',
    '- plaats: de woonplaats/kern waar de kraam staat (niet per se de gemeentenaam; bv. "Heilig Landstichting" in gemeente Berg en Dal).',
    '- locatie: korte omschrijving voor bezoekers, bv. "bij winkelcentrum Noordhove" of "parkeerterrein Intratuin". Max 80 tekens. Geen zaaknummers.',
    '- adres: straat + huisnummer, of plein/straat zonder nummer, voor de geocoder. null als onbekend.',
    '- postcode: als die er staat, anders null.',
    '- datum_van, datum_tot: YYYY-MM-DD. Eén dag: beide gelijk. Onbekend: null.',
    '- dagen: alleen als het niet elke dag is, bv. "alleen zaterdagen", "30 en 31 december". Anders null.',
    '- tijden: openingstijden als ze er staan, bv. "7:00-18:00". Anders null.',
  ].join('\n');
  const user = JSON.stringify(items);
  for (const model of ANTHROPIC_MODELS) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(45000),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 4000, system, messages: [{ role: 'user', content: user }] }),
    });
    if (r.status === 404 || r.status === 400) { fouten.push('ai ' + model + ' ' + r.status); continue; }
    if (!r.ok) throw new Error('anthropic ' + r.status + ': ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    const txt = (j?.content || []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n');
    const p = safeParseJson(txt);
    const m = new Map<string, any>();
    for (const it of (p?.items || [])) if (it?.ref) m.set(String(it.ref), it);
    if (!p?.items) fouten.push('ai onleesbaar');
    return m;
  }
  return new Map<string, any>();
}

const isDatum = (d: unknown) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

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

// ── Beheer vanuit /admin ───────────────────────────────────────────
const VELDEN = ['naam', 'locatie', 'adres', 'datum_van', 'datum_tot', 'dagen', 'tijden', 'website'];
async function beheer(sb: any, actie: string, id: number) {
  const r = await sb.from('oliebollen_kramen').select('*').eq('id', id).maybeSingle();
  const k = r.data;
  if (!k) return { ok: false, fout: 'kraam niet gevonden' };
  if (actie === 'verbergen') {
    await sb.from('oliebollen_kramen').update({ status: 'verborgen' }).eq('id', id);
    return { ok: true, status: 'verborgen' };
  }
  // Aanvulling op een bestaande kraam: velden overnemen, aanmelding opruimen.
  const doel = Number((String(k.opmerking || '').match(/aanvulling op #(\d+)/) || [])[1] || 0);
  if (doel && doel !== id) {
    const upd: any = {};
    for (const v of VELDEN) if (k[v]) upd[v] = k[v];
    if (k.contact_email) upd.contact_email = k.contact_email;
    const plekAnders = (k.adres && k.adres !== (await sb.from('oliebollen_kramen').select('adres').eq('id', doel).maybeSingle()).data?.adres);
    if (plekAnders) {
      const p = await zoekPlek(sb, k.adres, k.plaats, 'NL', null);
      if (p && !p.geschat) { upd.latitude = p.lat; upd.longitude = p.lng; upd.plek_geschat = false; }
    }
    upd.status = 'actief';
    const u = await sb.from('oliebollen_kramen').update(upd).eq('id', doel);
    if (u.error) return { ok: false, fout: u.error.message };
    await sb.from('oliebollen_kramen').delete().eq('id', id);
    return { ok: true, samengevoegd_in: doel };
  }
  const upd: any = { status: 'actief' };
  if (k.latitude == null || k.plek_geschat) {
    const p = await zoekPlek(sb, k.adres || k.locatie || null, k.plaats, k.land || 'NL', null);
    if (!p) return { ok: false, fout: 'plek niet gevonden: vul een straat of plein in' };
    upd.latitude = p.lat; upd.longitude = p.lng; upd.plek_geschat = !!p.geschat || !k.adres;
  }
  if (!k.datum_tot) upd.datum_tot = seizoenEinde();
  const u = await sb.from('oliebollen_kramen').update(upd).eq('id', id);
  return u.error ? { ok: false, fout: u.error.message } : { ok: true, status: 'actief', geschat: upd.plek_geschat ?? false };
}

// Nieuwe aanmeldingen van kraamhouders naar de beheerder (Telegram).
async function meldAanmeldingen(sb: any): Promise<number> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
  const chat = (await sb.from('app_config').select('value').eq('key', 'telegram_admin_chat').maybeSingle()).data?.value ?? '';
  if (!token || !chat) return 0;
  const r = await sb.from('oliebollen_kramen').select('id, naam, plaats, locatie, tijden, opmerking').eq('bron', 'aanmelding').is('gemeld_at', null).limit(20);
  const rij = r.data || [];
  if (!rij.length) return 0;
  const e = (x: unknown) => String(x ?? '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
  const tekst = `🍩 <b>${rij.length} nieuwe oliebollen-aanmelding${rij.length > 1 ? 'en' : ''}</b>\n` +
    rij.map((k: any) => `• ${e(k.naam || 'Kraam')} – ${e([k.locatie, k.plaats].filter(Boolean).join(', '))}${k.tijden ? ' (' + e(k.tijden) + ')' : ''}${/aanvulling op/.test(k.opmerking || '') ? ' <i>aanvulling</i>' : ''}`).join('\n') +
    '\n\nGoedkeuren: yardigo.nl/admin → 🍩 Oliebollen';
  const t = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: tekst, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (t.ok) await sb.from('oliebollen_kramen').update({ gemeld_at: new Date().toISOString() }).in('id', rij.map((k: any) => k.id));
  return t.ok ? rij.length : 0;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const t0 = Date.now();
  const key = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
  const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } });
  if (!key) return json({ error: 'env missing' }, 500);
  const auth = await isAuthorized(req, sb);
  if (!auth.ok) return json({ error: auth.error }, auth.status ?? 401);

  let body: { max?: number; dryRun?: boolean; action?: string; id?: number } = {};
  try { body = await req.json(); } catch (_) {}
  if (body.action === 'goedkeuren' || body.action === 'verbergen') return json(await beheer(sb, body.action, Number(body.id)));
  const dryRun = body.dryRun === true;
  const max = Math.max(1, Math.min(120, body.max ?? 40));
  const s: any = { via: auth.via, dryRun, gevonden: 0, nieuw_te_lezen: 0, gelezen: 0, nieuw: 0, samengevoegd: 0, ingetrokken: 0,
    niet_relevant: 0, geen_plek: 0, te_lang: 0, fout: 0, resterend: 0, errors: [] as string[], items: [] as any[] };

  // Slot: nooit twee runs tegelijk (die zouden dezelfde publicatie dubbel aanmaken).
  if (!dryRun) {
    const slot = await sb.from('app_config').select('value').eq('key', 'oliebollen_run').maybeSingle();
    if (slot.data?.value && Date.now() - Number(slot.data.value) < 170000) return json({ overgeslagen: 'vorige run loopt nog' });
    await sb.from('app_config').upsert({ key: 'oliebollen_run', value: String(Date.now()) }, { onConflict: 'key' });
  }

  // A. Publicaties van dit seizoen, min wat we al kennen.
  const pubs = await zoekPublicaties(seizoenStart(), s.errors);
  s.gevonden = pubs.length;
  const bekend = new Set<string>();
  for (let i = 0; i < pubs.length; i += 200) {
    const r = await sb.from('oliebollen_bronnen').select('gmb_id').in('gmb_id', pubs.slice(i, i + 200).map(p => p.id));
    for (const x of r.data || []) bekend.add(x.gmb_id);
  }
  // Titel met "oliebol" eerst: die zijn bijna altijd raak.
  const nieuw = pubs.filter(p => !bekend.has(p.id))
    .sort((a, b) => Number(/oliebol/i.test(b.titel)) - Number(/oliebol/i.test(a.titel)) || b.datum.localeCompare(a.datum));
  s.nieuw_te_lezen = nieuw.length;
  const deze = nieuw.slice(0, max);
  s.resterend = nieuw.length - deze.length;

  const log = async (p: Pub, uitkomst: string, reden: string | null, kraamId: number | null = null) => {
    s[uitkomst] = (s[uitkomst] || 0) + 1;
    if (dryRun) { s.items.push({ id: p.id, titel: p.titel.slice(0, 90), uitkomst, reden, kraamId }); return; }
    await sb.from('oliebollen_bronnen').upsert({ gmb_id: p.id, titel: p.titel.slice(0, 300), gemeente: p.gemeente, datum: p.datum || null,
      uitkomst, reden: reden?.slice(0, 200) ?? null, kraam_id: kraamId }, { onConflict: 'gmb_id' });
  };

  // Bestaande kramen van dit seizoen (voor samenvoegen).
  const best = await sb.from('oliebollen_kramen').select('id, gemeente, plaats, latitude, longitude, datum_van, datum_tot, vergunning, status, bron_url, opmerking')
    .gte('created_at', seizoenStart());
  const kramen: any[] = best.data || [];

  for (let i = 0; i < deze.length; i += AI_BATCH) {
    if (Date.now() - t0 > TIJD_BUDGET_MS) { s.resterend += deze.length - i; break; }
    const batch = deze.slice(i, i + AI_BATCH);
    const teksten: { p: Pub; tekst: string }[] = [];
    for (const p of batch) {
      try {
        const t = await lichaam(p.html);
        if (t.length > MAX_TEKST && !/oliebol/i.test(p.titel)) { await log(p, 'niet_relevant', 'lange tekst (regels/beleid)'); s.te_lang++; continue; }
        teksten.push({ p, tekst: t.slice(0, MAX_TEKST) });
      } catch (e) { s.errors.push(p.id + ': ' + (e as Error).message); s.fout++; }
    }
    if (!teksten.length) continue;
    let ai = new Map<string, any>();
    try { ai = await leesMetAi(key, teksten.map(x => ({ ref: x.p.id, gemeente: x.p.gemeente, titel: x.p.titel, tekst: x.tekst })), s.errors); }
    catch (e) { s.errors.push('ai: ' + (e as Error).message); continue; }

    for (const { p } of teksten) {
      s.gelezen++;
      const a = ai.get(p.id);
      if (!a) { s.errors.push(p.id + ': geen AI-antwoord'); continue; }   // volgende run opnieuw
      if (!a.relevant) { await log(p, 'niet_relevant', a.reden || null); continue; }
      const plaats = String(a.plaats || p.gemeente || '').trim();
      const gevonden = await zoekPlek(sb, a.adres || a.locatie || null, plaats, 'NL', a.postcode || null);
      // Zonder straat is het hooguit het plaatscentrum: nooit als echte pin tonen.
      const plek = gevonden && !a.adres ? { ...gevonden, geschat: true } : gevonden;
      let van = isDatum(a.datum_van), tot = isDatum(a.datum_tot) || van;
      // Seizoensvergunning zonder datum: tot eind januari.
      if (!van && !tot) tot = seizoenEinde();

      // Samenvoegen: zelfde gemeente, binnen 250 m (of zelfde plaats zonder plek), periode overlapt.
      const overlapt = (k: any) => !van || !k.datum_van || ((k.datum_van <= (tot || van)) && ((k.datum_tot || k.datum_van) >= van));
      const zelfde = kramen.find(k => k.gemeente === p.gemeente && overlapt(k) && (
        plek && k.latitude != null ? km(plek, { lat: k.latitude, lng: k.longitude }) < 0.25 : (!plek && k.latitude == null && k.plaats === plaats)));

      const intrekking = a.vergunning === 'geweigerd' || a.vergunning === 'ingetrokken';
      if (intrekking) {
        if (zelfde && !dryRun) await sb.from('oliebollen_kramen').update({ status: 'ingetrokken', opmerking: (zelfde.opmerking ? zelfde.opmerking + ' · ' : '') + a.vergunning + ' ' + p.id }).eq('id', zelfde.id);
        await log(p, 'ingetrokken', zelfde ? null : 'geen kraam om in te trekken', zelfde?.id ?? null);
        continue;
      }
      const velden: any = {
        naam: a.naam || null, locatie: a.locatie ? String(a.locatie).slice(0, 120) : null, adres: a.adres || null,
        plaats, gemeente: p.gemeente, provincie: p.provincie || null, land: 'NL',
        datum_van: van, datum_tot: tot, dagen: a.dagen || null, tijden: a.tijden || null,
        soort: a.soort === 'actie' ? 'actie' : 'kraam',
        vergunning: ['aanvraag', 'verleend', 'melding'].includes(a.vergunning) ? a.vergunning : 'onbekend',
        bron: 'gemeenteblad', bron_url: p.url || null,
      };
      if (zelfde) {
        // Besluit na aanvraag: vergunning bijwerken, lege velden aanvullen.
        const upd: any = {};
        if (velden.vergunning === 'verleend' && zelfde.vergunning !== 'verleend') { upd.vergunning = 'verleend'; upd.bron_url = velden.bron_url; }
        for (const k of ['naam', 'locatie', 'adres', 'dagen', 'tijden', 'datum_van', 'datum_tot']) if (velden[k] && !zelfde[k]) upd[k] = velden[k];
        if (Object.keys(upd).length && !dryRun) await sb.from('oliebollen_kramen').update(upd).eq('id', zelfde.id);
        await log(p, 'samengevoegd', null, zelfde.id);
        continue;
      }
      if (!plek) { velden.status = 'controleren'; velden.opmerking = 'plek niet gevonden'; }
      else if (van && van > seizoenEinde()) { velden.latitude = plek.lat; velden.longitude = plek.lng; velden.status = 'controleren'; velden.opmerking = 'datum valt in een later seizoen (typfout gemeente?)'; }
      else { velden.latitude = plek.lat; velden.longitude = plek.lng; velden.plek_geschat = !!plek.geschat; if (plek.geschat) { velden.status = 'controleren'; velden.opmerking = 'alleen plaats bekend'; } }
      if (dryRun) { s.items.push({ id: p.id, ...velden }); s.nieuw++; continue; }
      const ins = await sb.from('oliebollen_kramen').insert(velden).select('id').single();
      if (ins.error) { s.errors.push(p.id + ': ' + ins.error.message); s.fout++; continue; }
      kramen.push({ id: ins.data.id, ...velden });
      await log(p, plek && !plek.geschat ? 'nieuw' : 'geen_plek', velden.opmerking ?? null, ins.data.id);
    }
  }
  s.ms = Date.now() - t0;
  if (!dryRun) {
    await sb.from('app_config').upsert({ key: 'oliebollen_run', value: '0' }, { onConflict: 'key' });
    try { s.aanmeldingen_gemeld = await meldAanmeldingen(sb); } catch (e) { s.errors.push('telegram: ' + (e as Error).message); }
  }
  return json(s);
});
