// YardiGo – telegram-bot Edge Function
//
// Eigen YardiGo-bot voor de admin. Twee ingangen:
//
//   1. Telegram-webhook (POST zonder ?action): berichten en knop-kliks.
//      Telegram stuurt header X-Telegram-Bot-Api-Secret-Token mee; die moet
//      gelijk zijn aan app_config 'telegram_webhook_secret'. Alleen de
//      gekoppelde admin-chat (app_config 'telegram_admin_chat') wordt bediend.
//
//   2. Beheer/cron (POST ?action=..., header x-cron-secret):
//      - setup:  webhook registreren + koppelcode aanmaken
//      - digest: nog niet verstuurde tips + wachtrij-items als kaartjes sturen
//
// Wat de admin in Telegram kan:
//   - /start <code>   chat koppelen (eenmalig)
//   - /stats          tellers
//   - /meer           volgende kaartjes uit de wachtrij
//   - affiche (foto) of tekst/link sturen → parse-event → kaartje met knoppen
//   - antwoorden op een kaartje met een link, 06 of e-mail → contact aanvullen
//   - knoppen: publiceren, afwijzen, en bij particulieren "toestemming vragen"
//     (kant-en-klare DM-tekst) of "publiceren, contact achter login".
//
// Required secrets: TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY (via parse-event),
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY (auto).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { autoCheck, curatorId, publishPending } from '../_shared/publish.ts';

const SITE = 'https://www.yardigo.nl';
const MINIAPP = SITE + '/tg';
const DIGEST_BATCH = 8;
const SUBTYPES = new Set(['rommelmarkt','vlooienmarkt','opritverkoop','rommelroute','buurtverkoop','kofferbak','antiekmarkt','boekenmarkt','braderie','kerstmarkt','overig']);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function domainOf(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

function randomHex(n: number): string {
  const b = new Uint8Array(n); crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// ── Telegram API ───────────────────────────────────────────────────
const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';

async function tg(method: string, body: Record<string, unknown>): Promise<any> {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j?.ok) console.warn('telegram', method, r.status, j?.description);
  return j;
}

function send(chat: number | string, html: string, extra: Record<string, unknown> = {}) {
  return tg('sendMessage', { chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
}

// Losse FB-reactie als eigen bericht: lang indrukken → Kopiëren pakt dan precies deze tekst.
function fbBericht(chat: number | string, fb: string) {
  return tg('sendMessage', { chat_id: chat, text: fb, disable_web_page_preview: true });
}

function menuKnop(chat: string) {
  return tg('setChatMenuButton', { chat_id: chat, menu_button: { type: 'web_app', text: 'YardiGo', web_app: { url: MINIAPP } } });
}

// ── Config ─────────────────────────────────────────────────────────
async function cfg(sb: any, key: string): Promise<string | null> {
  const { data } = await sb.from('app_config').select('value').eq('key', key).maybeSingle();
  return data?.value ?? null;
}
async function setCfg(sb: any, key: string, value: string) {
  await sb.from('app_config').upsert({ key, value }, { onConflict: 'key' });
}

// ── Kaartje ────────────────────────────────────────────────────────
const PENDING_COLS = 'id,title,description,event_subtype,date_start,date_end,time_start,time_end,city,address,latitude,longitude,organizer_name,organizer_url,contact_email,contact_phone,is_private_seller,status,auto_check,lead_source_url,source_url,approved_listing_id,poster_url';

function datumNl(d: string | null): string {
  if (!d) return '?';
  const dt = new Date(d + 'T12:00:00Z');
  return dt.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Amsterdam' });
}

function heeftContact(p: any): boolean {
  return !!(p.organizer_url || p.contact_phone || p.contact_email);
}

function kaartTekst(p: any): string {
  const tijd = p.time_start ? ` ${String(p.time_start).slice(0, 5)}${p.time_end ? '–' + String(p.time_end).slice(0, 5) : ''}` : '';
  const regels = [
    `${p.is_private_seller ? '🏠' : '🎪'} <b>${esc(p.title)}</b>`,
    `📅 ${datumNl(p.date_start)}${p.date_end ? ' t/m ' + datumNl(p.date_end) : ''}${tijd}`,
    `📍 ${esc(p.city || '?')}${p.address ? ' — ' + esc(p.address) : ''}${p.latitude == null ? ' ⚠️ geen coördinaten' : ''}`,
    `🏷 ${esc(p.event_subtype || '?')} · ${p.is_private_seller === true ? 'particulier' : p.is_private_seller === false ? 'organisator' : 'onbekend'}`,
  ];
  if (p.description) regels.push(`<i>${esc(p.description)}</i>`);
  if (p.poster_url) regels.push(`🖼 <a href="${esc(p.poster_url)}">affiche</a> wordt de foto`);
  const contact: string[] = [];
  if (p.organizer_name) contact.push('👤 ' + esc(p.organizer_name));
  if (p.organizer_url) contact.push(`🌐 <a href="${esc(p.organizer_url)}">${esc(domainOf(p.organizer_url) || 'website')}</a>`);
  if (p.contact_phone) contact.push('☎️ ' + esc(p.contact_phone));
  if (p.contact_email) contact.push('✉️ ' + esc(p.contact_email));
  regels.push(contact.length ? contact.join(' · ') : '⚠️ <b>geen contactweg</b> — antwoord op dit bericht met een link, 06 of e-mail');
  const redenen = (p.auto_check?.redenen || []).filter((r: string) => r !== 'geen contactweg' || !heeftContact(p));
  if (redenen.length) regels.push('🔎 ' + esc(redenen.join(', ')));
  if (p.lead_source_url) regels.push(`🔗 <a href="${esc(p.lead_source_url)}">gevonden via ${esc(domainOf(p.lead_source_url))}</a>`);
  regels.push(`#p${p.id}`);
  return regels.join('\n');
}

function kaartKnoppen(p: any) {
  const bewerk = { text: '✏️ Bewerken', web_app: { url: `${MINIAPP}?id=${p.id}` } };
  const zonder = heeftContact(p) ? [] : [[{ text: '📍 Toch plaatsen zonder contact', callback_data: `nc:${p.id}` }]];
  if (p.status === 'tip') {
    return { inline_keyboard: [
      [{ text: '💬 Toestemming vragen', callback_data: `dm:${p.id}` }],
      [{ text: '✅ Publiceren (contact achter login)', callback_data: `ok:${p.id}` }],
      ...zonder,
      [bewerk, { text: '❌ Overslaan', callback_data: `no:${p.id}` }],
    ] };
  }
  return { inline_keyboard: [
    [{ text: '✅ Publiceren', callback_data: `ok:${p.id}` }, { text: '❌ Afwijzen', callback_data: `no:${p.id}` }],
    ...zonder,
    [bewerk],
  ] };
}

async function stuurKaart(sb: any, chat: string, p: any) {
  await send(chat, kaartTekst(p), { reply_markup: kaartKnoppen(p) });
  await sb.from('pending_events').update({ telegram_sent_at: new Date().toISOString() }).eq('id', p.id);
}

// ── Digest ─────────────────────────────────────────────────────────
async function digest(sb: any, chat: string, alleenNieuw: boolean): Promise<number> {
  const vandaag = new Date().toISOString().slice(0, 10);
  let q = sb.from('pending_events').select(PENDING_COLS)
    .in('status', ['tip', 'nieuw']).gte('date_start', vandaag)
    .order('status', { ascending: false })          // 'tip' vóór 'nieuw'
    .order('date_start', { ascending: true })
    .limit(DIGEST_BATCH);
  if (alleenNieuw) q = q.is('telegram_sent_at', null);
  const { data } = await q;
  for (const p of data || []) await stuurKaart(sb, chat, p);
  return (data || []).length;
}

async function tellers(sb: any) {
  const vandaag = new Date().toISOString().slice(0, 10);
  const c = async (f: (q: any) => any) => (await f(sb.from('pending_events').select('id', { count: 'exact', head: true }))).count ?? 0;
  const live = (await sb.from('listings').select('id', { count: 'exact', head: true })
    .eq('status', 'active').gte('date_start', vandaag)).count ?? 0;
  return {
    live,
    tips: await c(q => q.eq('status', 'tip').gte('date_start', vandaag)),
    wachtrij: await c(q => q.eq('status', 'nieuw').gte('date_start', vandaag)),
    onverstuurd: await c(q => q.in('status', ['tip', 'nieuw']).gte('date_start', vandaag).is('telegram_sent_at', null)),
  };
}

// ── Nieuw item uit foto/tekst ──────────────────────────────────────
async function fotoAlsBase64(fileId: string): Promise<{ data: string; media_type: string } | null> {
  const f = await tg('getFile', { file_id: fileId });
  const path = f?.result?.file_path;
  if (!path) return null;
  const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${path}`);
  if (!r.ok) return null;
  const buf = new Uint8Array(await r.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const ext = path.split('.').pop()?.toLowerCase();
  const mt = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : null;
  if (!mt) return null;
  return { data: btoa(bin), media_type: mt };
}

async function geocode(adres: string | null, plaats: string | null): Promise<{ lat: number; lng: number } | null> {
  const q = [adres, plaats].filter(Boolean).join(', ');
  if (!q) return null;
  try {
    const r = await fetch('https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?rows=1&fl=centroide_ll&fq=type:(adres+woonplaats+weg)&q=' + encodeURIComponent(q));
    const c = (await r.json())?.response?.docs?.[0]?.centroide_ll;
    const m = typeof c === 'string' ? c.match(/POINT\(([-\d.]+)\s+([-\d.]+)\)/) : null;
    if (m) return { lng: parseFloat(m[1]), lat: parseFloat(m[2]) };
  } catch (_) { /* volgende */ }
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=nl,be&q=' + encodeURIComponent(q),
      { headers: { 'User-Agent': 'YardiGo/1.0 (https://www.yardigo.nl; yardigo.app@gmail.com)' } });
    const j = await r.json();
    if (j?.[0]?.lat) return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon) };
  } catch (_) { /* geen */ }
  return null;
}

// Facebook-link → openbare preview (zoals Telegram/WhatsApp die ook tonen).
// Werkt voor openbare posts en pagina's; besloten groepen geven niets terug.
function decodeHtml(s: string): string {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function metaTag(html: string, prop: string): string | null {
  const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i'));
  const b = a || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'));
  return b ? decodeHtml(b[1]).trim() : null;
}
function isFacebook(u: string): boolean {
  return /(^|\.)(facebook\.com|fb\.com|fb\.me|fb\.watch|m\.facebook\.com)$/i.test(domainOf(u));
}
async function fbPreview(url: string): Promise<{ tekst: string; image: string | null } | null> {
  try {
    const r = await fetch(url, { redirect: 'follow', headers: {
      'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.5',
    } });
    const html = (await r.text()).slice(0, 600_000);
    const titel = metaTag(html, 'og:title');
    const besch = metaTag(html, 'og:description') || metaTag(html, 'description');
    const image = metaTag(html, 'og:image');
    console.log('fbPreview', r.status, domainOf(r.url), { titel: titel?.length ?? 0, besch: besch?.length ?? 0, image: !!image });
    const tekst = [titel, besch].filter(Boolean).join('\n');
    if (tekst.length < 15 && !image) return null;
    return { tekst, image };
  } catch (e) { console.warn('fbPreview', (e as Error).message); return null; }
}

async function urlAlsBase64(url: string): Promise<{ data: string; media_type: string } | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const mt = (r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(mt)) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > 4_800_000) return null;
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { data: btoa(bin), media_type: mt };
  } catch { return null; }
}

// Affiche bewaren in de publieke bucket; wordt bij publiceren de listing-foto.
async function bewaarPoster(sb: any, image: { data: string; media_type: string }): Promise<string | null> {
  try {
    const bin = Uint8Array.from(atob(image.data), c => c.charCodeAt(0));
    const ext = image.media_type.split('/')[1].replace('jpeg', 'jpg');
    const path = `telegram/${new Date().toISOString().slice(0, 10)}/${randomHex(8)}.${ext}`;
    const up = await sb.storage.from('listings').upload(path, bin, { contentType: image.media_type, upsert: false });
    if (up.error) { console.warn('poster upload', up.error.message); return null; }
    return sb.storage.from('listings').getPublicUrl(path).data.publicUrl;
  } catch (e) { console.warn('poster', (e as Error).message); return null; }
}

function contactUitTekst(t: string) {
  const urls = [...t.matchAll(/https?:\/\/[^\s<>"]+/gi)].map(m => m[0].replace(/[).,]+$/, ''));
  const mail = t.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ?? null;
  const tel = t.match(/(?:\+31|0031|\+32|0)\s?6[\s-]?(?:\d[\s-]?){8}|(?:\+31|\+32|0)\d{1,3}[\s-]?\d{6,7}/)?.[0]?.replace(/[^\d+]/g, '') ?? null;
  return { url: urls[0] ?? null, mail, tel };
}

// dup: het item dat er al is. kind 'live' = staat op de kaart, 'open' = in
// de lijst (nieuw/tip), 'afgewezen' = eerder afgewezen.
interface Dup { kind: 'live' | 'open' | 'afgewezen'; title: string; pending_id?: number; listing_id?: string; url?: string; fb?: string }
type Maak = { ok: true; row: any } | { ok: false; msg: string; dup?: Dup };

// Instelling 'direct plaatsen': zelf aangeleverde items gaan meteen live als
// alles compleet is en de AI niet twijfelt.
async function directPlaatsen(sb: any, row: any): Promise<{ url: string; fb: string } | null> {
  if ((await cfg(sb, 'telegram_autopublish')) !== 'true') return null;
  const g = metGroep(row);
  if (g.ontbreekt.length || g.groep === 'twijfel') return null;
  try {
    const listingId = await publishPending(sb, row, await curatorId(sb), null);
    return await deel(sb, listingId);
  } catch (e) { console.warn('direct plaatsen', (e as Error).message); return null; }
}

async function nieuwItem(sb: any, chat: string, tekst: string, fotoId: string | null) {
  await tg('sendChatAction', { chat_id: chat, action: 'typing' });
  const image = fotoId ? await fotoAlsBase64(fotoId) : null;
  if (fotoId && !image) return send(chat, '⚠️ Kon de afbeelding niet ophalen. Stuur hem als <b>foto</b> (niet als bestand).');
  const r = await maakItem(sb, tekst, image);
  if (r.ok) {
    const live = await directPlaatsen(sb, r.row);
    if (live) { await send(chat, `✅ <b>${esc(r.row.title)}</b> staat op de kaart\n${live.url}`); return fbBericht(chat, live.fb); }
    return stuurKaart(sb, chat, r.row);
  }
  const d = r.dup;
  if (d?.kind === 'open' && d.pending_id) {
    const { data: p } = await sb.from('pending_events').select(PENDING_COLS).eq('id', d.pending_id).maybeSingle();
    await send(chat, '📋 Deze stond al in je lijst — hier is hij:');
    if (p) return stuurKaart(sb, chat, p);
  }
  if (d?.kind === 'live') {
    await send(chat, `🗺 <b>${esc(d.title)}</b> staat al live op de kaart.\n${d.url}`);
    return fbBericht(chat, d.fb);
  }
  if (d?.kind === 'afgewezen') {
    return send(chat, `🚫 <b>${esc(d.title)}</b> had je eerder afgewezen.`, {
      reply_markup: { inline_keyboard: [[{ text: '↩️ Toch opnieuw bekijken', callback_data: `re:${d.pending_id}` }]] } });
  }
  return send(chat, r.msg);
}

// Bestaand item gevonden: contact aanvullen waar het ontbreekt, en zeggen wát het is.
async function bestaandItem(sb: any, ref: any, contact: { url: string | null; tel: string | null; mail: string | null }): Promise<Dup> {
  const listingId: string | null = ref.listing_id ?? null;
  if (listingId) {
    if (contact.url || contact.tel || contact.mail) {
      await sb.from('listing_contacts').upsert(
        { listing_id: listingId, website_url: contact.url, phone: contact.tel, email: contact.mail },
        { onConflict: 'listing_id', ignoreDuplicates: true });
    }
    return { kind: 'live', title: ref.title, listing_id: listingId, ...(await deel(sb, listingId)) };
  }
  const id = ref.pending_id as number;
  if (ref.status === 'afgewezen') return { kind: 'afgewezen', title: ref.title, pending_id: id };
  const { data: p } = await sb.from('pending_events').select('organizer_url,contact_phone,contact_email').eq('id', id).maybeSingle();
  const patch: any = {};
  if (contact.url && !p?.organizer_url) patch.organizer_url = contact.url;
  if (contact.tel && !p?.contact_phone) patch.contact_phone = contact.tel;
  if (contact.mail && !p?.contact_email) patch.contact_email = contact.mail;
  if (Object.keys(patch).length) await sb.from('pending_events').update(patch).eq('id', id);
  return { kind: 'open', title: ref.title, pending_id: id };
}

// Affiche/tekst → parse-event → geocode → dedupe → pending_events.
async function maakItem(sb: any, tekst: string, image: { data: string; media_type: string } | null): Promise<Maak> {
  // Alleen een (Facebook-)link gedeeld? Haal de openbare preview op: tekst + afbeelding.
  const link = contactUitTekst(tekst).url;
  let parseTekst = tekst;
  if (!image && link && isFacebook(link)) {
    const pv = await fbPreview(link);
    if (!pv) return { ok: false, msg: '🔒 Ik kan deze Facebook-post niet openen (vaak een besloten groep). Maak een screenshot van de post en stuur die, met de link erbij.' };
    parseTekst = pv.tekst + '\n\n' + tekst;
    if (pv.image) image = await urlAlsBase64(pv.image);
  }
  const parseRes = await fetch(Deno.env.get('SUPABASE_URL') + '/functions/v1/parse-event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (Deno.env.get('SUPABASE_ANON_KEY') ?? ''),
      'x-cron-secret': (await cfg(sb, 'cron_secret')) ?? '',
    },
    body: JSON.stringify({ mode: 'admin', keep_address: true, text: parseTekst || undefined, image: image || undefined }),
  });
  const pj = await parseRes.json().catch(() => ({}));
  console.log('parse-event', parseRes.status, JSON.stringify(pj).slice(0, 300));
  if (pj?.ok === false) return { ok: false, msg: '🤷 Ik zie hierin geen rommelmarkt, garage sale of andere verkoop. Is de tekst op de afbeelding goed leesbaar?' };
  const e = pj?.data;
  if (!e?.titel || !e?.datum) return { ok: false, msg: '⚠️ Kon dit niet lezen' + (pj?.error ? ': ' + esc(String(pj.error).slice(0, 200)) : ' (titel of datum ontbreekt).') };

  const ct = contactUitTekst(tekst);
  const orgUrl = ct.url || e.bron_url || null;
  const geo = await geocode(e.adres, e.plaats);
  const h = await sb.rpc('discovery_content_hash', { p_title: e.titel, p_date: e.datum, p_city: e.plaats });
  if (h.data) {
    const ref = await sb.rpc('discovery_find_similar_ref', { p_hash: h.data, p_lat: geo?.lat ?? null, p_lng: geo?.lng ?? null, p_date: e.datum, p_radius_m: 500 });
    if (ref.data) {
      const dup = await bestaandItem(sb, ref.data, { url: orgUrl, tel: ct.tel, mail: ct.mail });
      return { ok: false, msg: 'Staat er al: ' + dup.title, dup };
    }
  }
  const posterUrl = image ? await bewaarPoster(sb, image) : null;
  const subtype = SUBTYPES.has(e.event_type || '') ? e.event_type : 'rommelmarkt';
  const isPart = subtype === 'opritverkoop';
  const row: any = {
    title: e.titel, description: e.beschrijving, event_subtype: subtype,
    date_start: e.datum, time_start: e.starttijd, time_end: e.eindtijd,
    city: e.plaats, address: e.adres,
    latitude: geo?.lat ?? null, longitude: geo?.lng ?? null,
    source_url: orgUrl || 'telegram', source_domain: orgUrl ? domainOf(orgUrl) : 'telegram',
    source_label: e.bron_naam, source_status: orgUrl ? 'origineel' : 'onbekend',
    discovered_via_query: 'telegram', content_hash: h.data || randomHex(16),
    organizer_name: e.bron_naam, organizer_url: orgUrl,
    contact_phone: ct.tel, contact_email: ct.mail,
    is_private_seller: isPart, status: isPart ? 'tip' : 'nieuw',
    poster_url: posterUrl,
    raw_ai_response: { parse_event: e },
  };
  row.auto_check = autoCheck({ id: 0, ...row }, true);
  const ins = await sb.from('pending_events').insert(row).select(PENDING_COLS).single();
  if (ins.error) return { ok: false, msg: '⚠️ Opslaan mislukt: ' + esc(ins.error.message) };
  return { ok: true, row: ins.data };
}

function watOntbreekt(p: any, zonderContact = false): string[] {
  const o: string[] = [];
  if (!p.title || !String(p.title).trim()) o.push('titel');
  if (!zonderContact && !heeftContact(p)) o.push('contactweg (link, 06 of e-mail)');
  if (p.latitude == null || p.longitude == null) o.push('locatie op de kaart');
  if (!p.date_start || p.date_start < new Date().toISOString().slice(0, 10)) o.push('datum in de toekomst');
  return o;
}

// ── Knoppen ────────────────────────────────────────────────────────
// Korte deellink (yardigo.nl/s/<code>); valt terug op /v/<id>.
async function korteLink(sb: any, listingId: string): Promise<string> {
  const { data } = await sb.from('listings').select('short_code').eq('id', listingId).maybeSingle();
  return data?.short_code ? `yardigo.nl/s/${data.short_code}` : `${SITE}/v/${listingId}`;
}
function fbTekst(link: string): string {
  return `Staat nu ook op YardiGo 📍 ${link}`;
}
async function deel(sb: any, listingId: string): Promise<{ url: string; fb: string }> {
  const kort = await korteLink(sb, listingId);
  return { url: kort.startsWith('http') ? kort : 'https://' + kort, fb: fbTekst(kort) };
}

function dmTekst(p: any): string {
  return [
    `Hoi! Ik zag je ${p.event_subtype === 'opritverkoop' ? 'opritverkoop' : 'verkoop'} in ${p.city || 'je buurt'} op ${datumNl(p.date_start)}.`,
    'Ik ben van YardiGo, een gratis kaart met rommelmarkten, garage sales en opritverkopen in Nederland en België.',
    'Vind je het goed als ik je verkoop daar ook op zet? Dan vinden meer mensen uit de buurt je. Je kunt hem daarna zelf beheren, en ik plaats geen huisnummer zonder jouw ok. 🙂',
  ].join(' ');
}

async function knop(sb: any, chat: string, cq: any) {
  const [actie, idStr] = String(cq.data || '').split(':');
  const id = parseInt(idStr, 10);
  const msg = cq.message;
  const { data: p } = await sb.from('pending_events').select(PENDING_COLS).eq('id', id).maybeSingle();
  if (!p) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Niet gevonden' });
  if (actie === 're' && p.status === 'afgewezen') {
    const { data: p2 } = await sb.from('pending_events').update({ status: p.is_private_seller ? 'tip' : 'nieuw', review_notes: null })
      .eq('id', id).select(PENDING_COLS).single();
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Terug in je lijst' });
    return stuurKaart(sb, chat, p2);
  }
  if (p.status === 'goedgekeurd' || p.status === 'afgewezen') {
    return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Al ' + p.status });
  }

  if (actie === 'no') {
    await sb.from('pending_events').update({ status: 'afgewezen', reviewed_at: new Date().toISOString(), review_notes: 'via Telegram' }).eq('id', id);
    await tg('editMessageText', { chat_id: chat, message_id: msg.message_id, parse_mode: 'HTML', disable_web_page_preview: true,
      text: '❌ <s>' + esc(p.title) + '</s> — afgewezen' });
    return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Afgewezen' });
  }

  if (actie === 'dm') {
    await tg('answerCallbackQuery', { callback_query_id: cq.id });
    const waar = p.lead_source_url ? `\n\nStuur via: <a href="${esc(p.lead_source_url)}">${esc(domainOf(p.lead_source_url))}</a>` : (p.organizer_url ? `\n\nStuur via: ${esc(p.organizer_url)}` : '');
    return send(chat, `💬 Kopieer en stuur:\n\n<code>${esc(dmTekst(p))}</code>${waar}\n\nKrijg je een ja? Druk dan op ✅ bij #p${p.id}.`, { reply_to_message_id: msg.message_id });
  }

  if (actie === 'ok' || actie === 'nc') {
    const ontbreekt = watOntbreekt(p, actie === 'nc');
    if (ontbreekt.length) {
      await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Ontbreekt: ' + ontbreekt.join(', '), show_alert: true });
      return;
    }
    try {
      const reviewer = await curatorId(sb);
      const listingId = await publishPending(sb, p, reviewer, null);
      const d = await deel(sb, listingId);
      await tg('editMessageText', { chat_id: chat, message_id: msg.message_id, parse_mode: 'HTML', disable_web_page_preview: true,
        text: `✅ <b>${esc(p.title)}</b> staat live\n${d.url}` });
      await fbBericht(chat, d.fb);
      return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Gepubliceerd' });
    } catch (e) {
      return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Mislukt: ' + (e as Error).message.slice(0, 150), show_alert: true });
    }
  }
  return tg('answerCallbackQuery', { callback_query_id: cq.id });
}

// Antwoord op een kaartje: contact of adres aanvullen.
async function aanvulling(sb: any, chat: string, tekst: string, kaart: any) {
  const m = String(kaart.text || '').match(/#p(\d+)/);
  if (!m) return false;
  const id = parseInt(m[1], 10);
  const ct = contactUitTekst(tekst);
  const patch: any = {};
  if (ct.url) patch.organizer_url = ct.url;
  if (ct.tel) patch.contact_phone = ct.tel;
  if (ct.mail) patch.contact_email = ct.mail;
  if (!ct.url && !ct.tel && !ct.mail && tekst.trim().length > 3) {
    const { data: p0 } = await sb.from('pending_events').select('city').eq('id', id).maybeSingle();
    const geo = await geocode(tekst.trim(), tekst.includes(',') ? null : p0?.city);
    if (!geo) { await send(chat, '⚠️ Geen link, 06, e-mail of vindbaar adres herkend.'); return true; }
    patch.address = tekst.trim(); patch.latitude = geo.lat; patch.longitude = geo.lng;
  }
  const up = await sb.from('pending_events').update(patch).eq('id', id).select(PENDING_COLS).single();
  if (up.error) { await send(chat, '⚠️ ' + esc(up.error.message)); return true; }
  await tg('editMessageText', { chat_id: chat, message_id: kaart.message_id, parse_mode: 'HTML', disable_web_page_preview: true,
    text: kaartTekst(up.data), reply_markup: kaartKnoppen(up.data) });
  await send(chat, '👍 Bijgewerkt', { reply_to_message_id: kaart.message_id });
  return true;
}

// ── Mini-app API ───────────────────────────────────────────────────
// Auth: Telegram initData (HMAC met de bot-token), user.id = gekoppelde admin.
const CORS = {
  'Access-Control-Allow-Origin': SITE,
  'Access-Control-Allow-Headers': 'content-type, x-tg-init-data',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function apiJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data)));
}

async function initDataUser(initData: string): Promise<number | null> {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = await hmac(new TextEncoder().encode('WebAppData'), TOKEN);
  const sig = [...await hmac(secret, dcs)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (sig !== hash) return null;
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
  try { return JSON.parse(params.get('user') || '{}').id ?? null; } catch { return null; }
}

// Eén eenvoudige indeling voor de mini-app.
const TWIJFEL = ['past niet bij YardiGo', 'type onduidelijk', 'onbekend of particulier'];
function metGroep(p: any) {
  const ontbreekt = watOntbreekt(p);
  const redenen: string[] = p.auto_check?.redenen || [];
  const groep = p.status === 'tip' || p.is_private_seller === true ? 'particulier'
    : redenen.some(r => TWIJFEL.includes(r)) ? 'twijfel'
    : ontbreekt.length ? 'mist' : 'klaar';
  return { ...p, ontbreekt, groep };
}

const BEWERKBAAR = ['title','description','event_subtype','date_start','date_end','time_start','time_end','city','address',
  'latitude','longitude','organizer_name','organizer_url','contact_phone','contact_email','is_private_seller'];

async function api(sb: any, req: Request): Promise<Response> {
  const admin = await cfg(sb, 'telegram_admin_chat');
  const uid = await initDataUser(req.headers.get('x-tg-init-data') || '');
  if (!admin || !uid || String(uid) !== admin) return apiJson({ error: 'Geen toegang' }, 403);

  const b = await req.json().catch(() => ({}));
  const vandaag = new Date().toISOString().slice(0, 10);
  const cols = PENDING_COLS + ',created_at,discovered_via_query';

  switch (b.op) {
    case 'stats':
      return apiJson(await tellers(sb));

    case 'list': {
      const status = b.status === 'tip' ? ['tip'] : b.status === 'nieuw' ? ['nieuw'] : ['tip', 'nieuw'];
      let q = sb.from('pending_events').select(cols, { count: 'exact' })
        .in('status', status).gte('date_start', vandaag)
        .order('date_start', { ascending: true }).order('id', { ascending: true })
        .range(b.offset || 0, (b.offset || 0) + 49);
      if (b.reason) q = q.contains('auto_check', { redenen: [b.reason] });
      if (b.q) q = q.or(`title.ilike.%${String(b.q).replace(/[%,()]/g, '')}%,city.ilike.%${String(b.q).replace(/[%,()]/g, '')}%`);
      const r = await q;
      if (r.error) return apiJson({ error: r.error.message }, 500);
      return apiJson({ items: (r.data || []).map((p: any) => ({ ...p, ontbreekt: watOntbreekt(p) })), total: r.count ?? 0 });
    }

    case 'get': {
      const r = await sb.from('pending_events').select(cols).eq('id', b.id).maybeSingle();
      if (!r.data) return apiJson({ error: 'Niet gevonden' }, 404);
      return apiJson({ item: metGroep(r.data) });
    }

    case 'save': {
      const patch: Record<string, unknown> = {};
      for (const k of BEWERKBAAR) if (k in (b.patch || {})) {
        const v = b.patch[k];
        patch[k] = typeof v === 'string' ? (v.trim() || null) : v;
      }
      if ('poster_url' in (b.patch || {}) && !b.patch.poster_url) patch.poster_url = null;
      if (typeof patch.is_private_seller === 'boolean') patch.status = patch.is_private_seller ? 'tip' : 'nieuw';
      if (b.geocode && (patch.address !== undefined || patch.city !== undefined)) {
        const cur = (await sb.from('pending_events').select('address,city').eq('id', b.id).maybeSingle()).data || {};
        const g = await geocode((patch.address ?? cur.address) as string | null, (patch.city ?? cur.city) as string | null);
        if (g) { patch.latitude = g.lat; patch.longitude = g.lng; }
      }
      const r = await sb.from('pending_events').update(patch).eq('id', b.id).in('status', ['tip', 'nieuw']).select(cols).single();
      if (r.error) return apiJson({ error: r.error.message }, 400);
      // Redenen opnieuw bepalen; het oordeel 'past niet bij YardiGo' blijft staan.
      const past = !(r.data.auto_check?.redenen || []).includes('past niet bij YardiGo');
      const check = autoCheck(r.data, past);
      await sb.from('pending_events').update({ auto_check: check }).eq('id', b.id);
      return apiJson({ item: metGroep({ ...r.data, auto_check: check }) });
    }

    case 'geocode':
      return apiJson({ geo: await geocode(b.address || null, b.city || null) });

    case 'publish': {
      const r = await sb.from('pending_events').select(PENDING_COLS).eq('id', b.id).maybeSingle();
      const p = r.data;
      if (!p) return apiJson({ error: 'Niet gevonden' }, 404);
      if (p.status === 'goedgekeurd' || p.status === 'afgewezen') return apiJson({ error: 'Al ' + p.status }, 409);
      // zonder_contact: admin kiest bewust om zonder contactweg te plaatsen.
      const o = watOntbreekt(p, b.zonder_contact === true);
      if (o.length) return apiJson({ error: 'Ontbreekt: ' + o.join(', ') }, 400);
      try {
        const listingId = await publishPending(sb, p, await curatorId(sb), null);
        if (b.zonder_contact === true && !heeftContact(p)) {
          await sb.from('pending_events').update({ review_notes: 'geplaatst zonder contact (admin)' }).eq('id', p.id);
        }
        return apiJson({ listing_id: listingId, ...(await deel(sb, listingId)) });
      } catch (e) { return apiJson({ error: (e as Error).message }, 500); }
    }

    case 'reject': {
      const r = await sb.from('pending_events').update({ status: 'afgewezen', reviewed_at: new Date().toISOString(), review_notes: 'via mini-app' })
        .eq('id', b.id).in('status', ['tip', 'nieuw']);
      if (r.error) return apiJson({ error: r.error.message }, 400);
      return apiJson({ ok: true });
    }

    case 'dm': {
      const r = await sb.from('pending_events').select(PENDING_COLS).eq('id', b.id).maybeSingle();
      if (!r.data) return apiJson({ error: 'Niet gevonden' }, 404);
      return apiJson({ text: dmTekst(r.data), via: r.data.lead_source_url || r.data.organizer_url || null });
    }

    case 'create': {
      const image = b.image?.data ? { data: String(b.image.data), media_type: String(b.image.media_type || 'image/jpeg') } : null;
      const r = await maakItem(sb, String(b.text || ''), image);
      if (!r.ok && r.dup) return apiJson({ dup: r.dup });
      if (!r.ok) return apiJson({ error: r.msg.replace(/<[^>]+>/g, '') }, 400);
      const live = await directPlaatsen(sb, r.row);
      return apiJson({ item: metGroep(r.row), published: live });
    }

    case 'settings':
      if (typeof b.autopublish === 'boolean') await setCfg(sb, 'telegram_autopublish', String(b.autopublish));
      return apiJson({ autopublish: (await cfg(sb, 'telegram_autopublish')) === 'true' });

    case 'reopen': {
      const r = await sb.from('pending_events').select('is_private_seller,status').eq('id', b.id).maybeSingle();
      if (r.data?.status !== 'afgewezen') return apiJson({ error: 'Niet afgewezen' }, 400);
      await sb.from('pending_events').update({ status: r.data.is_private_seller ? 'tip' : 'nieuw', review_notes: null }).eq('id', b.id);
      return apiJson({ ok: true });
    }

    case 'todo': {
      const r = await sb.from('pending_events').select(cols)
        .in('status', ['tip', 'nieuw']).gte('date_start', vandaag)
        .order('date_start', { ascending: true }).order('id', { ascending: true }).limit(400);
      if (r.error) return apiJson({ error: r.error.message }, 500);
      return apiJson({ items: (r.data || []).map(metGroep) });
    }

    case 'recent': {
      const r = await sb.from('listings').select('id,title,city,date_start,event_subtype,created_at,short_code')
        .eq('placed_by', 'yardigo').order('created_at', { ascending: false }).limit(30);
      return apiJson({ items: (r.data || []).map((l: any) => {
        const kort = l.short_code ? `yardigo.nl/s/${l.short_code}` : `${SITE}/v/${l.id}`;
        return { ...l, url: kort.startsWith('http') ? kort : 'https://' + kort, fb: fbTekst(kort) };
      }) });
    }
  }
  return apiJson({ error: 'onbekende op' }, 400);
}

// ── Main ───────────────────────────────────────────────────────────
serve(async (req: Request) => {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!TOKEN) return json({ error: 'TELEGRAM_BOT_TOKEN ontbreekt' }, 500);
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  if (url.searchParams.has('api')) return api(sb, req);
  const action = url.searchParams.get('action');

  // ── Beheer / cron ──
  if (action) {
    const secret = await cfg(sb, 'cron_secret');
    if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ error: 'unauthorized' }, 401);

    if (action === 'setup') {
      const hook = randomHex(24);
      const code = randomHex(4);
      await setCfg(sb, 'telegram_webhook_secret', hook);
      await setCfg(sb, 'telegram_pair_code', code);
      const url = Deno.env.get('SUPABASE_URL') + '/functions/v1/telegram-bot';
      const r = await tg('setWebhook', { url, secret_token: hook, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
      await tg('setMyCommands', { commands: [
        { command: 'stats', description: 'Tellers: live, tips, wachtrij' },
        { command: 'meer', description: 'Volgende kaartjes uit de wachtrij' },
        { command: 'help', description: 'Wat kan deze bot' },
      ] });
      const admin = await cfg(sb, 'telegram_admin_chat');
      if (admin) await menuKnop(admin);
      const me = await tg('getMe', {});
      return json({ ok: !!r?.ok, bot: me?.result?.username, pair_code: code, webhook: r?.description });
    }

    if (action === 'digest') {
      const chat = await cfg(sb, 'telegram_admin_chat');
      if (!chat) return json({ ok: false, error: 'geen gekoppelde chat' });
      const t = await tellers(sb);
      if (t.onverstuurd === 0) return json({ ok: true, verstuurd: 0 });
      await send(chat, `☀️ <b>YardiGo-update</b>\n🗺 ${t.live} live · 🏠 ${t.tips} tips · 📥 ${t.wachtrij} in wachtrij\n${t.onverstuurd} nieuw sinds de vorige keer — hier komen ze:`);
      const n = await digest(sb, chat, true);
      if (t.onverstuurd > n) await send(chat, `Nog ${t.onverstuurd - n} — stuur /meer voor de volgende.`);
      return json({ ok: true, verstuurd: n });
    }
    return json({ error: 'onbekende action' }, 400);
  }

  // ── Telegram-webhook ──
  const hook = await cfg(sb, 'telegram_webhook_secret');
  if (!hook || req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== hook) return json({ error: 'unauthorized' }, 401);

  const upd = await req.json().catch(() => null);
  if (!upd) return json({ ok: true });
  const admin = await cfg(sb, 'telegram_admin_chat');

  try {
    if (upd.callback_query) {
      const chat = String(upd.callback_query.message?.chat?.id ?? '');
      if (!admin || chat !== admin) return json({ ok: true });
      await knop(sb, chat, upd.callback_query);
      return json({ ok: true });
    }

    const m = upd.message;
    if (!m) return json({ ok: true });
    console.log('update', JSON.stringify({ text: !!m.text, caption: !!m.caption, photo: m.photo?.length ?? 0,
      doc: m.document ? { mime: m.document.mime_type, size: m.document.file_size } : null, group: m.media_group_id ?? null }));
    const chat = String(m.chat.id);
    const tekst: string = m.text || m.caption || '';

    // Koppelen
    if (/^\/start\b/.test(tekst)) {
      const code = await cfg(sb, 'telegram_pair_code');
      const gegeven = tekst.split(/\s+/)[1] || '';
      if (code && gegeven && gegeven === code && m.chat.type === 'private') {
        await setCfg(sb, 'telegram_admin_chat', chat);
        await menuKnop(chat);
        await setCfg(sb, 'telegram_pair_code', randomHex(8));   // code eenmalig
        await send(chat, '✅ Gekoppeld! Je krijgt hier dagelijks nieuwe tips en wachtrij-items.\n\nStuur me een affiche, screenshot of link van een rommelmarkt/garage sale en ik maak er een kaartje van. Typ /help voor meer.');
      } else if (chat !== admin) {
        await send(chat, 'Dit is een privé-bot van YardiGo. Kijk op ' + SITE + ' 🗺');
      }
      return json({ ok: true });
    }
    if (!admin || chat !== admin) {
      await send(chat, 'Dit is een privé-bot van YardiGo. Kijk op ' + SITE + ' 🗺');
      return json({ ok: true });
    }

    if (/^\/stats\b/.test(tekst)) {
      const t = await tellers(sb);
      await send(chat, `🗺 ${t.live} live (toekomst)\n🏠 ${t.tips} tips\n📥 ${t.wachtrij} in wachtrij\n✉️ ${t.onverstuurd} nog niet getoond`);
    } else if (/^\/meer\b/.test(tekst)) {
      const n = await digest(sb, chat, true);
      if (!n) await send(chat, '🎉 Niets meer — alles is getoond.');
    } else if (/^\/help\b/.test(tekst)) {
      await send(chat, [
        '<b>YardiGo-bot</b>',
        '📸 Stuur een affiche of screenshot (met eventueel de link van de post als bijschrift) → kaartje',
        '🔗 Stuur tekst of een link → kaartje',
        '↩️ Antwoord op een kaartje met een link, 06 of e-mail → contact aangevuld; met een adres → locatie',
        '✅/❌ op een kaartje → publiceren of afwijzen. Na publiceren krijg je een kant-en-klare Facebook-reactie.',
        '/stats · /meer',
      ].join('\n'));
    } else if (m.reply_to_message?.from?.is_bot && await aanvulling(sb, chat, tekst, m.reply_to_message)) {
      // afgehandeld
    } else if (m.document && /heic|heif/i.test((m.document.mime_type || '') + (m.document.file_name || ''))) {
      await send(chat, '📷 Dit is een iPhone-bestand (HEIC) dat ik niet kan lezen. Stuur hem als <b>foto</b> in plaats van als bestand, of maak er een screenshot van.');
    } else if (m.document && /^image\//.test(m.document.mime_type || '') && (m.document.file_size || 0) > 4_500_000) {
      await send(chat, '📷 Dit bestand is te groot. Stuur hem als <b>foto</b> (dan verkleint Telegram hem) of als screenshot.');
    } else if (m.photo?.length || (m.document && /^image\//.test(m.document.mime_type || ''))) {
      const fileId = m.photo?.length ? m.photo[m.photo.length - 1].file_id : m.document.file_id;
      await nieuwItem(sb, chat, tekst, fileId);
    } else if (tekst.trim().length >= 10) {
      await nieuwItem(sb, chat, tekst, null);
    } else {
      await send(chat, 'Stuur een affiche, screenshot of tekst/link van een verkoop. /help voor meer.');
    }
  } catch (e) {
    console.error('telegram-bot', e);
    const c = String(upd.message?.chat?.id ?? upd.callback_query?.message?.chat?.id ?? '');
    if (admin && c === admin) await send(c, '⚠️ Fout: ' + esc((e as Error).message.slice(0, 200)));
  }
  return json({ ok: true });
});
