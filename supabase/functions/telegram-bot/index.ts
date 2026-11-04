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
import { toetsPlek, veiligeGeocode, zoekPlek } from '../_shared/locatie.ts';
import { bepaalSubtype } from '../_shared/subtypes.ts';
import { advies, adviesContext, adviesIcoon, type Advies, type AdviesContext } from '../_shared/advies.ts';

const SITE = 'https://www.yardigo.nl';
const MINIAPP = SITE + '/tg';
const DIGEST_BATCH = 8;

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
const PENDING_COLS = 'id,discovered_via_query,title,description,event_subtype,date_start,date_end,time_start,time_end,city,address,latitude,longitude,organizer_name,organizer_url,contact_email,contact_phone,is_private_seller,status,auto_check,lead_source_url,source_url,approved_listing_id,poster_url,plek_geschat,taal:raw_ai_response->parse_event->>taal,land:raw_ai_response->parse_event->>land,postcode:raw_ai_response->parse_event->>postcode';

function datumNl(d: string | null): string {
  if (!d) return '?';
  const dt = new Date(d + 'T12:00:00Z');
  return dt.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Amsterdam' });
}

function heeftContact(p: any): boolean {
  return !!(p.organizer_url || p.contact_phone || p.contact_email);
}

function kaartTekst(p: any, a?: Advies): string {
  const tijd = p.time_start ? ` ${String(p.time_start).slice(0, 5)}${p.time_end ? '–' + String(p.time_end).slice(0, 5) : ''}` : '';
  const regels = [
    ...(p.discovered_via_query === TIP_VIA ? ['📮 <b>Tip via de website, zonder account</b>'] : []),
    `${p.is_private_seller ? '🏠' : '🎪'} <b>${esc(p.title)}</b>`,
    ...(a ? [`${adviesIcoon(a.k)} <b>Advies: ${esc(a.kop)}</b>`, ...a.waarom.slice(0, 3).map(w => `   · ${esc(w)}`), ''] : []),
    `📅 ${datumNl(p.date_start)}${p.date_end ? ' t/m ' + datumNl(p.date_end) : ''}${tijd}`,
    `📍 ${esc(p.city || '?')}${p.address ? ' — ' + esc(p.address) : ''}${p.latitude == null ? ' ⚠️ geen coördinaten' : p.plek_geschat ? '\n⚠️ <b>plek geschat</b>: meer plaatsen heten zo. Klopt de pin niet? Antwoord met het adres of de postcode.' : ''}`,
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

function kaartKnoppen(p: any, a?: Advies) {
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
  const ok = { text: '✅ Publiceren', callback_data: `ok:${p.id}` }, no = { text: '❌ Afwijzen', callback_data: `no:${p.id}` };
  return { inline_keyboard: [
    a?.k === 'afwijzen' ? [no, ok] : [ok, no],
    ...zonder,
    [bewerk],
  ] };
}

async function stuurKaart(sb: any, chat: string, p: any, ctx?: AdviesContext) {
  const a = advies(p, watOntbreekt(p), ctx ?? await adviesContext(sb, [p.id]));
  await send(chat, kaartTekst(p, a), { reply_markup: kaartKnoppen(p, a) });
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
  const ctx = await adviesContext(sb, (data || []).map((p: any) => p.id));
  for (const p of data || []) await stuurKaart(sb, chat, p, ctx);
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

// ── Sponsorvakken (homepage) ───────────────────────────────────────
// Per domein zes plekken: 1-3 links, 4-6 rechts. nl = yardigo.nl,
// be = yardigo.be, de = yardigo.de. De site toont alleen lopende sponsors van
// zijn eigen land (RLS op public.sponsors); weergaven en kliks staan per dag
// in sponsor_stats.
const SPONSOR_KLEUREN = ['#3A6B4A', '#E07B39', '#B7791F', '#55625A', '#3A6B4A', '#E07B39'];
const SPONSOR_LANDEN: Record<string, string> = { nl: '🇳🇱 yardigo.nl', be: '🇧🇪 yardigo.be', de: '🇩🇪 yardigo.de' };

async function sponsorOverzicht(sb: any, chat: string, alleen: string | null) {
  const vandaag = new Date().toISOString().slice(0, 10);
  const week = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
  const { data: lijst } = await sb.from('sponsors').select('id,land,plek,naam,eindigt').eq('actief', true).order('plek');
  const ids = (lijst || []).map((s: any) => s.id);
  const { data: stats } = ids.length
    ? await sb.from('sponsor_stats').select('sponsor_id,dag,weergaven,kliks').in('sponsor_id', ids)
    : { data: [] };
  const som = (a: any[], k: string) => a.reduce((n, x) => n + (x[k] || 0), 0);
  const regels = ['<b>Sponsorvakken</b> (per domein: 1-3 links, 4-6 rechts)'];
  for (const land of alleen ? [alleen] : Object.keys(SPONSOR_LANDEN)) {
    const vanLand = (lijst || []).filter((x: any) => x.land === land);
    regels.push('', `<b>${SPONSOR_LANDEN[land]}</b>${vanLand.length ? '' : ': alle 6 plekken vrij'}`);
    if (!vanLand.length) continue;
    for (let p = 1; p <= 6; p++) {
      const s = vanLand.find((x: any) => x.plek === p);
      if (!s) { regels.push(`${p}. <i>vrij</i>`); continue; }
      const st = (stats || []).filter((x: any) => x.sponsor_id === s.id);
      const w = st.filter((x: any) => x.dag >= week);
      regels.push(`${p}. <b>${esc(s.naam)}</b> t/m ${datumNl(s.eindigt)}${s.eindigt < vandaag ? ' (verlopen, niet meer zichtbaar)' : ''}\n` +
        `     7 dagen: ${som(w, 'weergaven')}× gezien, ${som(w, 'kliks')} kliks. Totaal: ${som(st, 'weergaven')}× gezien, ${som(st, 'kliks')} kliks`);
    }
  }
  regels.push('',
    'Plaatsen: <code>/sponsor be 2 Naam | korte zin | https://site.be | 4</code>',
    'Land: nl, be of de (zonder land: nl). Het laatste getal is het aantal weken (standaard 4). Stuur het als bijschrift bij een foto, dan wordt die foto het logo.',
    'Weghalen: <code>/sponsorweg be 2</code>');
  await send(chat, regels.join('\n'));
}

async function sponsorZet(sb: any, chat: string, tekst: string, fileIds: string[]) {
  const m = tekst.match(/^\/sponsor\s+(?:(nl|be|de)\s+)?([1-6])\s+([\s\S]+)$/i);
  if (!m) return send(chat, 'Gebruik: <code>/sponsor be 2 Naam | korte zin | https://site.be | 4</code> (land nl, be of de). Typ /sponsor voor het overzicht.');
  const land = (m[1] || 'nl').toLowerCase();
  const plek = Number(m[2]);
  const [naam = '', zin = '', link = '', weken = ''] = m[3].split('|').map(x => x.trim());
  let url = link;
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  url = url.replace(/^http:\/\//i, 'https://');
  const fout: string[] = [];
  if (!naam || naam.length > 40) fout.push('naam (1 tot 40 tekens)');
  if (zin.length > 90) fout.push(`korte zin (max 90 tekens, nu ${zin.length})`);
  try { if (!url || !new URL(url).hostname.includes('.')) throw 0; } catch { fout.push('website'); }
  if (fout.length) return send(chat, '⚠️ Klopt niet: ' + fout.join(', ') + '.\nVoorbeeld: <code>/sponsor nl 2 Kringloop De Zwaluw | Elke zaterdag nieuwe spullen | https://dezwaluw.nl | 4</code>');

  let logo: string | null = null;
  if (fileIds.length) {
    const img = await fotoAlsBase64(fileIds);
    if (!img) return send(chat, '⚠️ Ik kon het logo niet ophalen. Probeer het nog eens, of stuur de opdracht zonder foto.');
    try {
      const bin = Uint8Array.from(atob(img.data), c => c.charCodeAt(0));
      const pad = `sponsors/${randomHex(8)}.${img.media_type.split('/')[1].replace('jpeg', 'jpg')}`;
      const up = await sb.storage.from('listings').upload(pad, bin, { contentType: img.media_type, upsert: false });
      if (up.error) throw new Error(up.error.message);
      logo = sb.storage.from('listings').getPublicUrl(pad).data.publicUrl;
    } catch (e) { return send(chat, '⚠️ Logo opslaan mislukt: ' + esc((e as Error).message)); }
  }

  const n = Math.min(Math.max(parseInt(weken, 10) || 4, 1), 52);
  const begint = new Date().toISOString().slice(0, 10);
  const eindigt = new Date(Date.now() + (n * 7 - 1) * 864e5).toISOString().slice(0, 10);
  const { data: oud } = await sb.from('sponsors').update({ actief: false }).eq('land', land).eq('plek', plek).eq('actief', true).select('naam');
  const { error } = await sb.from('sponsors').insert({
    land, plek, naam, tekst: zin || null, url, logo_url: logo, kleur: SPONSOR_KLEUREN[plek - 1], begint, eindigt,
  });
  if (error) return send(chat, '⚠️ Opslaan mislukt: ' + esc(error.message));
  await send(chat, `✅ ${SPONSOR_LANDEN[land]}, plek ${plek} (${plek <= 3 ? 'links' : 'rechts'}): <b>${esc(naam)}</b> staat live t/m ${datumNl(eindigt)}.` +
    (oud?.length ? `\nVervangt ${esc(oud[0].naam)}.` : '') +
    `\nZichtbaar op brede schermen (vanaf 1600 px). /sponsor voor het overzicht.`);
}

async function sponsorWeg(sb: any, chat: string, tekst: string) {
  const m = tekst.match(/^\/sponsorweg\s+(?:(nl|be|de)\s+)?([1-6])\b/i);
  if (!m) return send(chat, 'Gebruik: <code>/sponsorweg be 2</code> (land nl, be of de; plek 1 tot 6).');
  const land = (m[1] || 'nl').toLowerCase(), plek = Number(m[2]);
  const { data } = await sb.from('sponsors').update({ actief: false }).eq('land', land).eq('plek', plek).eq('actief', true).select('naam');
  await send(chat, data?.length ? `🗑 ${esc(data[0].naam)} is weg van ${SPONSOR_LANDEN[land]}, plek ${plek}.` : `${SPONSOR_LANDEN[land]}, plek ${plek} was al vrij.`);
}

// ── Nieuw item uit foto/tekst ──────────────────────────────────────
// Telegram's getFile hangt soms een minuut. Kort wachten, en daarna de
// kleinere versie van de foto proberen (ander bestand, vaak wel meteen
// beschikbaar; 800 px is voor de AI nog goed leesbaar).
async function telegramBestand(fileIds: string[]): Promise<Response | null> {
  for (let poging = 0; poging < 3; poging++) {
    const fileId = fileIds[Math.min(poging, fileIds.length - 1)];
    try {
      const f = await fetch(`https://api.telegram.org/bot${TOKEN}/getFile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: fileId }),
        signal: AbortSignal.timeout(7000) }).then(r => r.json());
      const path = f?.result?.file_path;
      if (path) {
        const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${path}`, { signal: AbortSignal.timeout(12000) });
        if (r.ok) return r;
      } else console.warn('getFile', poging, f?.description);
    } catch (e) { console.warn('getFile', poging, (e as Error).message); }
    await new Promise(z => setTimeout(z, 1000));
  }
  return null;
}

async function fotoAlsBase64(fileIds: string[]): Promise<{ data: string; media_type: string } | null> {
  const r = await telegramBestand(fileIds);
  if (!r) return null;
  const path = new URL(r.url).pathname;
  const buf = new Uint8Array(await r.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const ext = path.split('.').pop()?.toLowerCase();
  const mt = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : null;
  if (!mt) return null;
  return { data: btoa(bin), media_type: mt };
}

// Grootste foto eerst, daarna de op één na grootste als reserve.
function fotoIds(m: any): string[] {
  if (m?.photo?.length) return m.photo.slice(-2).reverse().map((x: any) => x.file_id);
  return m?.document?.file_id ? [m.document.file_id] : [];
}

// Land voor de plekzoeker: wat de AI las, anders een Duitse affiche = Duitsland.
function landVan(e: { land?: string | null; taal?: string | null } | null | undefined): string | null {
  return e?.land || (e?.taal === 'de' ? 'DE' : null);
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
  // NL, BE en DE, mobiel en vast, ook met +31/0032/(0). Geen datums ("08-11-2026") of IBAN's.
  const tel = t.replace(/\(0\)/g, '').match(/(?<![\w+])(?:\+|00)(?:31|32|49)(?:[\s\-./]{0,3}\d){8,11}(?!\d)|(?<![\w+])(?!0\d{0,1}[-./]\d{1,2}[-./]\d{2,4})0(?:[\s\-./]{0,3}\d){8,11}(?!\d)/)?.[0]
    ?.replace(/[^\d+]/g, '').replace(/^00/, '+') ?? null;
  return { url: urls[0] ?? null, mail, tel };
}

// dup: het item dat er al is. kind 'live' = staat op de kaart, 'open' = in
// de lijst (nieuw/tip), 'afgewezen' = eerder afgewezen.
interface Dup { kind: 'live' | 'open' | 'afgewezen'; title: string; pending_id?: number; listing_id?: string; url?: string; fb?: string; affiche?: 'toegevoegd' | 'heeft_al' }
// extra: de items voor de overige data op dezelfde affiche.
type Maak = ({ ok: true; row: any } | { ok: false; msg: string; dup?: Dup }) & { extra?: Maak[] };

// Affiche met meerdere data: elke datum een eigen item, ook bij za + zo.
// Data in het verleden vallen af, tenzij er niets anders is.
function reeksen(e: any): Array<{ van: string; tot: string | null; start: string | null; eind: string | null }> {
  const vandaag = new Date().toISOString().slice(0, 10);
  const per = new Map<string, any>();
  for (const d of [{ datum: e.datum, starttijd: e.starttijd, eindtijd: e.eindtijd }, ...(e.datums || [])]) {
    if (d?.datum && !per.has(d.datum)) per.set(d.datum, d);
  }
  const alle = [...per.values()].sort((a, b) => a.datum.localeCompare(b.datum));
  const toekomst = alle.filter(d => d.datum >= vandaag);
  return (toekomst.length ? toekomst : [per.get(e.datum) ?? alle[0]]).slice(0, 12)
    .map(d => ({ van: d.datum, tot: null, start: d.starttijd ?? e.starttijd ?? null, eind: d.eindtijd ?? e.eindtijd ?? null }));
}

// Instelling 'direct plaatsen': zelf aangeleverde items gaan meteen live als
// alles compleet is en de AI niet twijfelt.
async function directPlaatsen(sb: any, row: any): Promise<{ id: string; url: string; fb: string } | null> {
  if (row.plek_geschat || (await cfg(sb, 'telegram_autopublish')) !== 'true') return null;
  const g = metGroep(row);
  if (g.ontbreekt.length || g.groep === 'controleren' || g.groep === 'afwijzen') return null;
  try {
    const listingId = await publishPending(sb, row, await curatorId(sb), null);
    return { id: listingId, ...await deel(sb, listingId, row.taal) };
  } catch (e) { console.warn('direct plaatsen', (e as Error).message); return null; }
}

// Soort achteraf rechtzetten: de AI leest "garagesale" op de affiche, maar
// met meerdere huizen is het een rommelroute (en andersom).
const SOORTEN: Record<string, { naam: string; subtype: string }> = {
  o: { naam: '🏠 Garagesale (1 huis)', subtype: 'opritverkoop' },
  r: { naam: '🏘 Rommelroute', subtype: 'rommelroute' },
  m: { naam: '🎪 Markt', subtype: 'rommelmarkt' },
};
function soortNaam(subtype: string | null): string {
  if (subtype === 'opritverkoop') return SOORTEN.o.naam;
  if (subtype === 'rommelroute' || subtype === 'buurtverkoop') return SOORTEN.r.naam;
  return '🎪 Markt' + (subtype && subtype !== 'rommelmarkt' ? ` (${subtype})` : '');
}
function soortKnoppen(listingId: string, subtype: string | null) {
  const nu = subtype === 'opritverkoop' ? 'o' : subtype === 'rommelroute' || subtype === 'buurtverkoop' ? 'r' : 'm';
  return { inline_keyboard: [Object.entries(SOORTEN).filter(([k]) => k !== nu)
    .map(([k, v]) => ({ text: 'Wordt ' + v.naam, callback_data: `sv:${listingId}:${k}` }))] };
}
async function liveBericht(sb: any, chat: string, titel: string, live: { id: string; url: string }) {
  const { data } = await sb.from('listings').select('event_subtype').eq('id', live.id).maybeSingle();
  const st = data?.event_subtype ?? null;
  return send(chat, `✅ <b>${esc(titel)}</b> staat op de kaart\n🏷 Soort: ${soortNaam(st)}\n${live.url}`, { reply_markup: soortKnoppen(live.id, st) });
}
async function soortKnop(sb: any, chat: string, cq: any, listingId: string, k: string) {
  const s = SOORTEN[k];
  const { data: l } = await sb.from('listings').select('id,title,category').eq('id', listingId).maybeSingle();
  if (!s || !l) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Advertentie niet gevonden' });
  // Garagesale: adres pas 24 uur vooraf (category garagesale). Markt: openbaar.
  // Route: privacy blijft zoals hij was.
  const category = k === 'o' ? 'garagesale' : k === 'm' ? 'rommelmarkt' : l.category;
  const u = await sb.from('listings').update({ event_subtype: s.subtype, category }).eq('id', l.id);
  if (u.error) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Opslaan mislukt', show_alert: true });
  const tekst = String(cq.message?.text || '').replace(/🏷 Soort: .*/, '🏷 Soort: ' + s.naam);
  await tg('editMessageText', { chat_id: chat, message_id: cq.message.message_id, disable_web_page_preview: true,
    text: tekst, reply_markup: soortKnoppen(l.id, s.subtype) });
  return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Soort is nu ' + s.naam });
}

// Meteen laten zien dat de affiche binnen is; het lezen duurt even.
// Lukt de foto niet (Telegram hapert), dan zelf nog één keer proberen.
async function nieuwItem(sb: any, chat: string, tekst: string, ids: string[], msgId?: number, herkansing = false) {
  const bezig = (await send(chat, herkansing ? '🔁 Nieuwe poging om de affiche op te halen…' : ids.length ? '⏳ Affiche ontvangen, ik lees hem…' : '⏳ Even lezen…',
    { reply_to_message_id: msgId }))?.result?.message_id;
  await tg('sendChatAction', { chat_id: chat, action: 'typing' });
  try {
    const image = ids.length ? await fotoAlsBase64(ids) : null;
    if (ids.length && !image) {
      if (herkansing) return send(chat, '⚠️ Telegram geeft de afbeelding nog steeds niet vrij (storing bij Telegram). Stuur hem later nog een keer.', { reply_to_message_id: msgId });
      await send(chat, '🐢 Telegram geeft de afbeelding traag vrij. Ik probeer het over een halve minuut zelf opnieuw, je hoeft niets te doen.', { reply_to_message_id: msgId });
      return opAchtergrond(chat, (async () => {
        await new Promise(z => setTimeout(z, 25000));
        await nieuwItem(sb, chat, tekst, ids, msgId, true);
      })());
    }
    const r = await maakItem(sb, tekst, image);
    if (r.extra?.length) await send(chat, `📅 Deze affiche heeft ${r.extra.length + 1} data, je krijgt per datum een kaartje.`);
    for (const x of [r, ...(r.extra || [])]) await toonItem(sb, chat, x, msgId);
  } finally {
    if (bezig) await tg('deleteMessage', { chat_id: chat, message_id: bezig });
  }
}

// Werk na het antwoord aan Telegram afmaken (Supabase EdgeRuntime.waitUntil).
function opAchtergrond(chat: string, werk: Promise<unknown>) {
  const klaar = werk.catch(async e => {
    console.error('achtergrond', e);
    await send(chat, '⚠️ Fout: ' + esc((e as Error).message.slice(0, 200)));
  });
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(klaar); else return klaar;
}

async function toonItem(sb: any, chat: string, r: Maak, msgId?: number) {
  if (r.ok) {
    const live = await directPlaatsen(sb, r.row);
    if (live) { await liveBericht(sb, chat, r.row.title, live); return fbBericht(chat, live.fb); }
    return stuurKaart(sb, chat, r.row);
  }
  const d = r.dup;
  if (d?.kind === 'open' && d.pending_id) {
    const { data: p } = await sb.from('pending_events').select(PENDING_COLS).eq('id', d.pending_id).maybeSingle();
    await send(chat, '📋 Deze stond al in je lijst' + (d.affiche === 'toegevoegd' ? ', je affiche is erbij gezet' : '') + ' — hier is hij:');
    if (p) return stuurKaart(sb, chat, p);
  }
  if (d?.kind === 'live') {
    if (d.affiche === 'heeft_al' && d.listing_id) {
      await send(chat, `🗺 <b>${esc(d.title)}</b> staat al live op de kaart en heeft al een afbeelding.\n${d.url}`, {
        reply_to_message_id: msgId,
        reply_markup: { inline_keyboard: [[{ text: '🖼 Deze affiche als hoofdfoto', callback_data: `pv:${d.listing_id}` }]] } });
    } else {
      const extra = d.affiche === 'toegevoegd' ? '\n🖼 Je affiche staat er nu bij als foto.' : '';
      await send(chat, `🗺 <b>${esc(d.title)}</b> staat al live op de kaart.${extra}\n${d.url}`);
    }
    return fbBericht(chat, d.fb);
  }
  if (d?.kind === 'afgewezen') {
    return send(chat, `🚫 <b>${esc(d.title)}</b> had je eerder afgewezen.`, {
      reply_markup: { inline_keyboard: [[{ text: '↩️ Toch opnieuw bekijken', callback_data: `re:${d.pending_id}` }]] } });
  }
  return send(chat, r.msg);
}

// Bestaand item gevonden: contact aanvullen waar het ontbreekt, en zeggen wát het is.
// Met affiche erbij: zet hem bij het bestaande item als dat nog geen afbeelding
// heeft. Alleen bij onze eigen (niet-geclaimde) advertenties, nooit bij die van
// een gebruiker.
async function bestaandItem(sb: any, ref: any, contact: { url: string | null; tel: string | null; mail: string | null },
  image: { data: string; media_type: string } | null = null, taal: string | null = null): Promise<Dup> {
  const listingId: string | null = ref.listing_id ?? null;
  if (listingId) {
    if (contact.url || contact.tel || contact.mail) {
      await sb.from('listing_contacts').upsert(
        { listing_id: listingId, website_url: contact.url, phone: contact.tel, email: contact.mail },
        { onConflict: 'listing_id', ignoreDuplicates: true });
    }
    let affiche: Dup['affiche'];
    if (image) {
      const { data: l } = await sb.from('listings').select('images,placed_by,claimed_by_user_id').eq('id', listingId).maybeSingle();
      if (l && l.placed_by === 'yardigo' && !l.claimed_by_user_id) {
        if ((l.images || []).length) affiche = 'heeft_al';
        else {
          const url = await bewaarPoster(sb, image);
          if (url) {
            const up = await sb.from('listings').update({ images: [url] }).eq('id', listingId);
            if (!up.error) affiche = 'toegevoegd';
          }
        }
      }
    }
    return { kind: 'live', title: ref.title, listing_id: listingId, affiche, ...(await deel(sb, listingId, taal)) };
  }
  const id = ref.pending_id as number;
  if (ref.status === 'afgewezen') return { kind: 'afgewezen', title: ref.title, pending_id: id };
  const { data: p } = await sb.from('pending_events').select('organizer_url,contact_phone,contact_email,poster_url').eq('id', id).maybeSingle();
  const patch: any = {};
  let affiche: Dup['affiche'];
  if (image && p && !p.poster_url) {
    const url = await bewaarPoster(sb, image);
    if (url) { patch.poster_url = url; affiche = 'toegevoegd'; }
  }
  if (contact.url && !p?.organizer_url) patch.organizer_url = contact.url;
  if (contact.tel && !p?.contact_phone) patch.contact_phone = contact.tel;
  if (contact.mail && !p?.contact_email) patch.contact_email = contact.mail;
  if (Object.keys(patch).length) await sb.from('pending_events').update(patch).eq('id', id);
  return { kind: 'open', title: ref.title, pending_id: id, affiche };
}

// Affiche/tekst → parse-event → geocode → dedupe → pending_events.
async function maakItem(sb: any, tekst: string, image: { data: string; media_type: string } | null, via = 'telegram'): Promise<Maak> {
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

  // Contact uit het bericht zelf, anders wat de AI op de affiche las.
  const ct = contactUitTekst(tekst);
  const ctAffiche = contactUitTekst([e.telefoon, e.email].filter(Boolean).join(' '));
  ct.tel ??= ctAffiche.tel;
  ct.mail ??= ctAffiche.mail;
  const orgUrl = ct.url || e.bron_url || null;
  // Plek moet in de plaats liggen; anders liever geen pin (dan kijkt er een mens naar).
  const geo = await zoekPlek(sb, e.adres, e.plaats, landVan(e), e.postcode);
  let poster: Promise<string | null> | undefined;   // één keer uploaden, gedeeld door alle data
  const items: Maak[] = [];
  for (const r of reeksen(e)) {
    items.push(await itemVoorDatum(sb, e, r, { geo, orgUrl, ct, image, via, poster: () => poster ??= image ? bewaarPoster(sb, image) : Promise.resolve(null) }));
  }
  return { ...items[0], extra: items.slice(1) };
}

async function itemVoorDatum(sb: any, e: any, r: { van: string; tot: string | null; start: string | null; eind: string | null },
  o: { geo: any; orgUrl: string | null; ct: any; image: any; via: string; poster: () => Promise<string | null> }): Promise<Maak> {
  const { geo, orgUrl, ct, image, via } = o;
  const h = await sb.rpc('discovery_content_hash', { p_title: e.titel, p_date: r.van, p_city: e.plaats });
  if (h.data) {
    const ref = await sb.rpc('discovery_find_similar_ref', { p_hash: h.data, p_lat: geo?.lat ?? null, p_lng: geo?.lng ?? null, p_date: r.van, p_radius_m: 500 });
    if (ref.data) {
      const dup = await bestaandItem(sb, ref.data, { url: orgUrl, tel: ct.tel, mail: ct.mail }, image, e.taal);
      return { ok: false, msg: 'Staat er al: ' + dup.title, dup };
    }
  }
  const posterUrl = await o.poster();
  let subtype = bepaalSubtype(e.event_type, e.subcategorie, e.titel);
  if (subtype === 'overig' && e.event_type !== 'overig') subtype = 'rommelmarkt';
  const isPart = subtype === 'opritverkoop';
  const row: any = {
    title: e.titel, description: e.beschrijving, event_subtype: subtype,
    date_start: r.van, date_end: r.tot, time_start: r.start, time_end: r.eind,
    city: e.plaats, address: e.adres,
    latitude: geo?.lat ?? null, longitude: geo?.lng ?? null, plek_geschat: !!geo?.geschat,
    source_url: orgUrl || via, source_domain: orgUrl ? domainOf(orgUrl) : via,
    source_label: e.bron_naam, source_status: orgUrl ? 'origineel' : 'onbekend',
    discovered_via_query: via, content_hash: h.data || randomHex(16),
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
// Domein per land van de verkoop (listing_land, listing-land.sql). De site
// kiest zelf de taal van de bezoeker, dus een Franse affiche in België
// wordt yardigo.be en opent in het Frans bij een Franstalige browser.
// yardigo.de is er nog niet: Duitsland tot dan op yardigo.app (neutraler dan
// een Nederlands domein). Frankrijk staat niet in de plaatsenlijst: Franse
// affiches naar yardigo.be.
const DOMEIN: Record<string, string> = { nl: 'yardigo.nl', be: 'yardigo.be', lu: 'yardigo.be', de: 'yardigo.app' };
async function domeinVan(sb: any, listingId: string, taal?: string | null): Promise<string> {
  const { data: land } = await sb.rpc('listing_land', { p_id: listingId });
  return DOMEIN[land as string] || (taal === 'fr' ? 'yardigo.be' : taal === 'de' ? 'yardigo.app' : 'yardigo.nl');
}
// Korte deellink (yardigo.be/s/<code>); valt terug op /v/<id>.
async function korteLink(sb: any, listingId: string, taal?: string | null): Promise<string> {
  const { data } = await sb.from('listings').select('short_code').eq('id', listingId).maybeSingle();
  const domein = await domeinVan(sb, listingId, taal);
  // Franse of Duitse affiche: pagina opent in die taal.
  const lang = taal === 'fr' || taal === 'de' ? `?lang=${taal}` : '';
  return (data?.short_code ? `${domein}/s/${data.short_code}` : `https://www.${domein}/v/${listingId}`) + lang;
}
// Reactie onder de Facebook-post, in de taal van de affiche (parse-event 'taal').
const FB_ZIN: Record<string, string> = {
  nl: 'Staat nu ook op YardiGo', fr: 'Maintenant aussi sur YardiGo', de: 'Jetzt auch auf YardiGo', en: 'Now also on YardiGo',
};
function fbTekst(link: string, taal?: string | null): string {
  return `${FB_ZIN[taal || ''] || FB_ZIN.nl} 📍 ${link}`;
}
async function deel(sb: any, listingId: string, taal?: string | null): Promise<{ url: string; fb: string }> {
  const kort = await korteLink(sb, listingId, taal);
  return { url: kort.startsWith('http') ? kort : 'https://' + kort, fb: fbTekst(kort, taal) };
}

function dmTekst(p: any): string {
  return [
    `Hoi! Ik zag je ${p.event_subtype === 'opritverkoop' ? 'opritverkoop' : 'verkoop'} in ${p.city || 'je buurt'} op ${datumNl(p.date_start)}.`,
    'Ik ben van YardiGo, een gratis kaart met rommelmarkten, garage sales en opritverkopen in Nederland en België.',
    'Vind je het goed als ik je verkoop daar ook op zet? Dan vinden meer mensen uit de buurt je. Je kunt hem daarna zelf beheren, en ik plaats geen huisnummer zonder jouw ok. 🙂',
  ].join(' ');
}

// ── Kwaliteit: meldingen van bezoekers, steekproef, importbewaker ──
async function listingKort(sb: any, id: string) {
  const { data } = await sb.from('listings').select('id,title,city,date_start,time_start,status,short_code,placed_by').eq('id', id).maybeSingle();
  return data;
}
function listingRegel(l: any): string {
  const link = l.short_code ? `https://yardigo.nl/s/${l.short_code}` : `${SITE}/v/${l.id}`;
  return `<b>${esc(l.title)}</b>\n📅 ${datumNl(l.date_start)}${l.time_start ? ' ' + String(l.time_start).slice(0, 5) : ''} · 📍 ${esc(l.city || '')}\n${link}`;
}

async function stuurMelding(sb: any, chat: string, reportId: number) {
  const { data: r } = await sb.from('listing_reports').select('id,listing_id,reason,note,created_at').eq('id', reportId).maybeSingle();
  if (!r) return false;
  const l = await listingKort(sb, r.listing_id);
  if (!l) return false;
  const { count } = await sb.from('listing_reports').select('id', { count: 'exact', head: true }).eq('listing_id', l.id).eq('status', 'open');
  await send(chat, `🚩 <b>Melding:</b> ${esc(r.reason)}${r.note ? `\n💬 “${esc(r.note)}”` : ''}${(count ?? 0) > 1 ? `\n(${count} open meldingen voor deze advertentie)` : ''}\n\n${listingRegel(l)}`, {
    reply_markup: { inline_keyboard: [[
      { text: '🚫 Offline halen', callback_data: `lo:${l.id}` },
      { text: '👍 Klopt wel', callback_data: `lk:${l.id}` },
    ]] } });
  return true;
}

async function steekproef(sb: any, chat: string, aantal = 5): Promise<number> {
  const vandaag = new Date().toISOString().slice(0, 10);
  const week = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data: gehad } = await sb.from('quality_checks').select('listing_id');
  const skip = new Set((gehad || []).map((g: any) => g.listing_id));
  const { data } = await sb.from('listings').select('id,title,city,date_start,time_start,status,short_code')
    .eq('placed_by', 'yardigo').eq('status', 'active').gte('date_start', vandaag).gte('created_at', week).limit(200);
  const pool = (data || []).filter((l: any) => !skip.has(l.id));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const kies = pool.slice(0, aantal);
  if (!kies.length) return 0;
  await send(chat, `🔎 <b>Steekproef</b> — ${kies.length} automatisch geplaatste advertenties van deze week. Klopt alles (datum, tijd, plek, soort)?`);
  for (const l of kies) {
    await sb.from('quality_checks').upsert({ listing_id: l.id }, { onConflict: 'listing_id', ignoreDuplicates: true });
    await send(chat, listingRegel(l), { reply_markup: { inline_keyboard: [[
      { text: '✅ Klopt', callback_data: `qok:${l.id}` },
      { text: '❌ Klopt niet', callback_data: `qno:${l.id}` },
    ]] } });
  }
  return kies.length;
}

async function bewaker(sb: any, chat: string): Promise<{ ok: boolean; nieuw24: number; live48: number }> {
  const d24 = new Date(Date.now() - 86400000).toISOString();
  const d48 = new Date(Date.now() - 2 * 86400000).toISOString();
  const nieuw24 = (await sb.from('pending_events').select('id', { count: 'exact', head: true })
    .like('external_ref', 'meukisleuk:%').gte('created_at', d24)).count ?? 0;
  const live48 = (await sb.from('listings').select('id', { count: 'exact', head: true })
    .eq('placed_by', 'yardigo').gte('created_at', d48)).count ?? 0;
  const ok = nieuw24 > 0 || live48 > 0;
  if (!ok) {
    await send(chat, `⚠️ <b>Import-bewaker</b>\nDe afgelopen 24 uur is er niets nieuws binnengekomen en in 48 uur niets automatisch geplaatst. Mogelijk is de bron veranderd of geblokkeerd — even laten nakijken.`);
  }
  return { ok, nieuw24, live48 };
}

// ── Locatiecontrole (elk uur): ligt elke pin in de opgegeven plaats? ──
// YardiGo-pins die niet kloppen worden zo mogelijk automatisch op het juiste
// adres gezet; lukt dat niet (of is het een advertentie van een gebruiker),
// dan komt hij hier ter beoordeling langs.
function kaartLink(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=13/${lat}/${lng}`;
}

async function locatieControle(sb: any, chat: string, droog = false) {
  const eind = Date.now() + 45000;
  const vandaag = new Date().toISOString().slice(0, 10);
  const { data } = await sb.from('listings')
    .select('id,title,city,address,latitude,longitude,date_start,time_start,status,short_code,placed_by,claimed_by_user_id')
    .eq('status', 'active').or(`date_start.gte.${vandaag},date_end.gte.${vandaag}`)
    .is('locatie_check_at', null).not('latitude', 'is', null).order('date_start').limit(1000);
  const st = { gecontroleerd: 0, ok: 0, hersteld: 0, afwijkend: 0, onbekend: 0, storing: 0, over: 0 };
  const hersteld: string[] = [];
  const proef: any[] = [];
  let meldingen = 0;
  for (const l of data || []) {
    if (Date.now() > eind) { st.over++; continue; }
    st.gecontroleerd++;
    const nu = new Date().toISOString();
    const t = await toetsPlek(sb, { lat: l.latitude, lng: l.longitude }, l.city);
    if (t.status === 'storing') {
      // Opzoekdienst onbereikbaar: niets vastleggen, volgend uur opnieuw.
      if (++st.storing >= 3) break;
      continue;
    }
    if (droog) {   // proefrun: alleen rapporteren
      st[t.status === 'ok' ? 'ok' : t.status === 'afwijkend' ? 'afwijkend' : 'onbekend']++;
      if (t.status !== 'ok') proef.push({ status: t.status, km: t.km, titel: l.title, plaats: l.city });
      continue;
    }
    if (t.status === 'ok') {
      st.ok++;
      await sb.from('listings').update({ locatie_status: 'ok', locatie_afwijking_km: t.km, locatie_check_at: nu }).eq('id', l.id);
      continue;
    }
    const vanYardigo = l.placed_by === 'yardigo' && !l.claimed_by_user_id;
    if (t.status === 'afwijkend' && vanYardigo) {
      const v = await veiligeGeocode(sb, l.address, l.city);
      if (v && !v.bij_benadering) {
        st.hersteld++;
        await sb.from('listings').update({ latitude: v.lat, longitude: v.lng, locatie_status: 'hersteld', locatie_afwijking_km: t.km, locatie_check_at: nu }).eq('id', l.id);
        hersteld.push(`• ${esc(l.title)} (${esc(l.city || '')}): lag ${t.km} km verkeerd`);
        continue;
      }
    }
    if (t.status === 'afwijkend') st.afwijkend++; else st.onbekend++;
    await sb.from('listings').update({ locatie_status: t.status, locatie_afwijking_km: t.km, locatie_check_at: nu }).eq('id', l.id);
    if (meldingen >= 10) continue;   // rest blijft gemarkeerd; niet de chat volspammen
    meldingen++;
    const kop = t.status === 'afwijkend'
      ? `📍 <b>Pin klopt niet:</b> ligt ${t.km} km van ${esc(l.city || '?')}`
      : `❓ <b>Plaats niet te controleren:</b> “${esc(l.city || '(leeg)')}” is geen bekende plaatsnaam`;
    const knoppen: any[] = [];
    if (t.eenduidig) {
      knoppen.push({ text: `📍 Naar ${String(l.city).slice(0, 18)}`, callback_data: `lpc:${l.id}` });
    }
    knoppen.push({ text: '👍 Plek klopt', callback_data: `lpo:${l.id}` });
    knoppen.push({ text: '🚫 Offline', callback_data: `lo:${l.id}` });
    await send(chat, `${kop}${vanYardigo ? '' : '\n<i>Geplaatst door een gebruiker.</i>'}\n\n${listingRegel(l)}\nHuidige pin: ${kaartLink(l.latitude, l.longitude)}`,
      { reply_markup: { inline_keyboard: [knoppen] } });
  }
  if (droog) return { ...st, proef };
  if (hersteld.length) {
    await send(chat, `🛠 <b>Pins automatisch rechtgezet</b> (${hersteld.length})\n${hersteld.slice(0, 15).join('\n')}`);
  }
  return st;
}

// Door discover-events gevonden doorlopende agenda's (gemeente, VVV,
// vereniging) aan de admin voorleggen. Aangezet = elke nacht uitgelezen.
async function bronVoorstellen(sb: any, chat: string): Promise<number> {
  const r = await sb.from('scrape_sources').select('id,domain,base_url,country,voorstel_reden')
    .eq('voorgesteld', true).eq('actief', false).is('telegram_sent_at', null).order('created_at').limit(5);
  for (const b of r.data || []) {
    await send(chat, `🔎 <b>Nieuwe bron gevonden</b> (${esc(b.country || '?')})
${esc(b.base_url || b.domain)}
<i>${esc((b.voorstel_reden || '').slice(0, 300))}</i>

Aanzetten = elke nacht uitlezen; markten van de organisator zelf gaan dan automatisch live.`, {
      reply_markup: { inline_keyboard: [[{ text: '✅ Bron aanzetten', callback_data: 'sa:' + b.id }, { text: '🚫 Niet gebruiken', callback_data: 'sx:' + b.id }]] } });
    await sb.from('scrape_sources').update({ telegram_sent_at: new Date().toISOString() }).eq('id', b.id);
  }
  return (r.data || []).length;
}

async function bronKnop(sb: any, chat: string, cq: any, actie: string, id: number) {
  const r = await sb.from('scrape_sources').update(actie === 'sa' ? { actief: true, voorgesteld: false } : { voorgesteld: false })
    .eq('id', id).select('domain').maybeSingle();
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: actie === 'sa' ? 'Bron staat aan' : 'Genegeerd' });
  return tg('editMessageText', { chat_id: chat, message_id: cq.message.message_id, parse_mode: 'HTML',
    text: (actie === 'sa' ? '✅ Bron aangezet: ' : '🚫 Bron genegeerd: ') + esc(r.data?.domain || String(id)) });
}

async function kwaliteitKnop(sb: any, chat: string, cq: any, actie: string, listingId: string) {
  const msg = cq.message;
  const l = await listingKort(sb, listingId);
  if (!l) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Advertentie niet gevonden' });
  const nu = new Date().toISOString();
  const bewerk = (tekst: string, knoppen: any[] = []) => tg('editMessageText', {
    chat_id: chat, message_id: msg.message_id, parse_mode: 'HTML', disable_web_page_preview: true,
    text: tekst, reply_markup: { inline_keyboard: knoppen } });

  if (actie === 'lo') {
    await sb.from('listings').update({ status: 'cancelled' }).eq('id', l.id);
    await sb.from('listing_reports').update({ status: 'opgelost' }).eq('listing_id', l.id).eq('status', 'open');
    await sb.from('quality_checks').update({ verdict: 'fout', decided_at: nu }).eq('listing_id', l.id);
    await bewerk(`🚫 Offline gehaald\n\n${listingRegel(l)}`, [[{ text: '↩️ Toch terugzetten', callback_data: `lb:${l.id}` }]]);
    return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Offline gehaald' });
  }
  if (actie === 'lb') {
    await sb.from('listings').update({ status: 'active' }).eq('id', l.id);
    await bewerk(`↩️ Weer live\n\n${listingRegel(l)}`);
    return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Weer live' });
  }
  if (actie === 'lk') {
    await sb.from('listing_reports').update({ status: 'genegeerd' }).eq('listing_id', l.id).eq('status', 'open');
    await bewerk(`👍 Melding genegeerd — advertentie blijft staan\n\n${listingRegel(l)}`);
    return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Genegeerd' });
  }
  if (actie === 'lpo') {
    await sb.from('listings').update({ locatie_status: 'handmatig_ok', locatie_check_at: nu }).eq('id', l.id);
    await bewerk(`👍 Plek goedgekeurd\n\n${listingRegel(l)}`);
    return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Genoteerd' });
  }
  if (actie === 'lpc') {
    const { data: x } = await sb.from('listings').select('city').eq('id', l.id).maybeSingle();
    const v = await veiligeGeocode(sb, null, x?.city ?? null);
    if (!v) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Kon de plaats niet eenduidig vinden', show_alert: true });
    await sb.from('listings').update({ latitude: v.lat, longitude: v.lng, locatie_status: 'hersteld', locatie_check_at: nu }).eq('id', l.id);
    await bewerk(`📍 Pin naar het centrum van ${esc(x?.city || '')} gezet\n\n${listingRegel(l)}\nNieuwe pin: ${kaartLink(v.lat, v.lng)}`);
    return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Pin verplaatst' });
  }
  if (actie === 'qok') {
    await sb.from('quality_checks').update({ verdict: 'ok', decided_at: nu }).eq('listing_id', l.id);
    await bewerk(`✅ Klopt\n\n${listingRegel(l)}`);
    return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Genoteerd' });
  }
  if (actie === 'qno') {
    await sb.from('quality_checks').update({ verdict: 'fout', decided_at: nu }).eq('listing_id', l.id);
    await bewerk(`❌ Klopt niet — wat wil je doen?\n\n${listingRegel(l)}\n\nAanpassen kan in de admin (Curated-tab).`,
      [[{ text: '🚫 Offline halen', callback_data: `lo:${l.id}` }]]);
    return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Genoteerd' });
  }
  return tg('answerCallbackQuery', { callback_query_id: cq.id });
}

// "Deze affiche als hoofdfoto": de foto zit in het bericht waar de knop op antwoordt.
async function afficheKnop(sb: any, chat: string, cq: any, listingId: string) {
  const bron = cq.message?.reply_to_message;
  const ids = fotoIds(bron);
  const image = ids.length ? await fotoAlsBase64(ids) : null;
  const { data: l } = await sb.from('listings').select('images,placed_by,claimed_by_user_id').eq('id', listingId).maybeSingle();
  if (!image || !l || l.placed_by !== 'yardigo' || l.claimed_by_user_id) {
    return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Kan de affiche hier niet bij zetten', show_alert: true });
  }
  const url = await bewaarPoster(sb, image);
  if (!url) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Uploaden mislukt', show_alert: true });
  await sb.from('listings').update({ images: [url, ...(l.images || [])].slice(0, 6) }).eq('id', listingId);
  await tg('editMessageReplyMarkup', { chat_id: chat, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
  return tg('answerCallbackQuery', { callback_query_id: cq.id, text: '🖼 Affiche is nu de hoofdfoto' });
}

async function knop(sb: any, chat: string, cq: any) {
  const [actie, idStr, extra] = String(cq.data || '').split(':');
  if (actie === 'sv') return soortKnop(sb, chat, cq, idStr, extra);
  if (['lo', 'lb', 'lk', 'qok', 'qno', 'lpc', 'lpo'].includes(actie)) return kwaliteitKnop(sb, chat, cq, actie, idStr);
  if (actie === 'sa' || actie === 'sx') return bronKnop(sb, chat, cq, actie, parseInt(idStr, 10));
  if (actie === 'pv') return afficheKnop(sb, chat, cq, idStr);
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
      const d = await deel(sb, listingId, p.taal);
      const st = (await sb.from('listings').select('event_subtype').eq('id', listingId).maybeSingle()).data?.event_subtype ?? null;
      await tg('editMessageText', { chat_id: chat, message_id: msg.message_id, parse_mode: 'HTML', disable_web_page_preview: true,
        text: `✅ <b>${esc(p.title)}</b> staat live\n🏷 Soort: ${soortNaam(st)}\n${d.url}`, reply_markup: soortKnoppen(listingId, st) });
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
    const { data: p0 } = await sb.from('pending_events').select('city,land:raw_ai_response->parse_event->>land,taal:raw_ai_response->parse_event->>taal').eq('id', id).maybeSingle();
    const geo = await zoekPlek(sb, tekst.trim(), tekst.includes(',') ? null : p0?.city, landVan(p0));
    if (!geo) { await send(chat, '⚠️ Geen link, 06, e-mail of vindbaar adres herkend.'); return true; }
    patch.address = tekst.trim(); patch.latitude = geo.lat; patch.longitude = geo.lng; patch.plek_geschat = geo.geschat;
  }
  const up = await sb.from('pending_events').update(patch).eq('id', id).select(PENDING_COLS).single();
  if (up.error) { await send(chat, '⚠️ ' + esc(up.error.message)); return true; }
  const a = advies(up.data, watOntbreekt(up.data), await adviesContext(sb, [id]));
  await tg('editMessageText', { chat_id: chat, message_id: kaart.message_id, parse_mode: 'HTML', disable_web_page_preview: true,
    text: kaartTekst(up.data, a), reply_markup: kaartKnoppen(up.data, a) });
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

// Indeling voor de mini-app: de groep is het advies (_shared/advies.ts).
function metGroep(p: any, ctx?: AdviesContext) {
  const ontbreekt = watOntbreekt(p);
  const a = advies(p, ontbreekt, ctx);
  return { ...p, ontbreekt, advies: a, groep: a.k };
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
      return apiJson({ item: metGroep(r.data, await adviesContext(sb, [r.data.id])) });
    }

    case 'save': {
      const patch: Record<string, unknown> = {};
      for (const k of BEWERKBAAR) if (k in (b.patch || {})) {
        const v = b.patch[k];
        patch[k] = typeof v === 'string' ? (v.trim() || null) : v;
      }
      if ('poster_url' in (b.patch || {}) && !b.patch.poster_url) patch.poster_url = null;
      if (typeof patch.is_private_seller === 'boolean') patch.status = patch.is_private_seller ? 'tip' : 'nieuw';
      // Pin zelf verzet in de mini-app: dan is hij niet meer geschat.
      if (patch.latitude !== undefined) patch.plek_geschat = false;
      if (b.geocode && (patch.address !== undefined || patch.city !== undefined)) {
        const cur = (await sb.from('pending_events').select('address,city,postcode:raw_ai_response->parse_event->>postcode,land:raw_ai_response->parse_event->>land,taal:raw_ai_response->parse_event->>taal').eq('id', b.id).maybeSingle()).data || {};
        const ga = (patch.address ?? cur.address) as string | null, gc = (patch.city ?? cur.city) as string | null;
        const g = await zoekPlek(sb, ga, gc, landVan(cur), cur.postcode);
        if (g) { patch.latitude = g.lat; patch.longitude = g.lng; patch.plek_geschat = g.geschat; }
      }
      const r = await sb.from('pending_events').update(patch).eq('id', b.id).in('status', ['tip', 'nieuw']).select(cols).single();
      if (r.error) return apiJson({ error: r.error.message }, 400);
      // Redenen opnieuw bepalen; het oordeel 'past niet bij YardiGo' blijft staan.
      const past = !(r.data.auto_check?.redenen || []).includes('past niet bij YardiGo');
      const check = autoCheck(r.data, past);
      await sb.from('pending_events').update({ auto_check: check }).eq('id', b.id);
      return apiJson({ item: metGroep({ ...r.data, auto_check: check }, await adviesContext(sb, [r.data.id])) });
    }

    case 'geocode': {
      const cur = b.id ? (await sb.from('pending_events').select('postcode:raw_ai_response->parse_event->>postcode,land:raw_ai_response->parse_event->>land,taal:raw_ai_response->parse_event->>taal').eq('id', b.id).maybeSingle()).data : null;
      return apiJson({ geo: await zoekPlek(sb, b.address || null, b.city || null, landVan(cur), cur?.postcode) });
    }

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
        return apiJson({ listing_id: listingId, ...(await deel(sb, listingId, p.taal)) });
      } catch (e) { return apiJson({ error: (e as Error).message }, 500); }
    }

    // Meerdere tegelijk afwijzen (groep 'afwijzen' in de mini-app). Terugzetten kan per item via 'reopen'.
    case 'reject_many': {
      const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isFinite).slice(0, 200);
      if (!ids.length) return apiJson({ error: 'Geen items' }, 400);
      const r = await sb.from('pending_events').update({ status: 'afgewezen', reviewed_at: new Date().toISOString(), review_notes: 'via mini-app (advies)' })
        .in('id', ids).in('status', ['tip', 'nieuw']).select('id');
      if (r.error) return apiJson({ error: r.error.message }, 400);
      return apiJson({ ok: true, aantal: (r.data || []).length });
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
      // Overige data van dezelfde affiche, elk als eigen item.
      const extra = [];
      for (const x of r.extra || []) {
        if (x.ok) extra.push({ item: metGroep(x.row), published: await directPlaatsen(sb, x.row) });
        else if (x.dup) extra.push({ dup: x.dup });
      }
      if (!r.ok && r.dup) return apiJson({ dup: r.dup, extra });
      if (!r.ok) return apiJson({ error: r.msg.replace(/<[^>]+>/g, '') }, 400);
      return apiJson({ item: metGroep(r.row), published: await directPlaatsen(sb, r.row), extra });
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
      const ctx = await adviesContext(sb, (r.data || []).map((p: any) => p.id));
      return apiJson({ items: (r.data || []).map((p: any) => metGroep(p, ctx)) });
    }

    case 'recent': {
      const r = await sb.from('listings').select('id,title,city,date_start,event_subtype,created_at,short_code')
        .eq('placed_by', 'yardigo').order('created_at', { ascending: false }).limit(30);
      const ids = (r.data || []).map((l: any) => l.id);
      const talen = ids.length ? (await sb.from('pending_events').select('approved_listing_id,taal:raw_ai_response->parse_event->>taal').in('approved_listing_id', ids)).data || [] : [];
      const taalVan = new Map(talen.map((t: any) => [t.approved_listing_id, t.taal]));
      return apiJson({ items: await Promise.all((r.data || []).map(async (l: any) => {
        const taal = taalVan.get(l.id) as string | undefined;
        const domein = await domeinVan(sb, l.id, taal);
        const kort = (l.short_code ? `${domein}/s/${l.short_code}` : `https://www.${domein}/v/${l.id}`) + (taal === 'fr' || taal === 'de' ? `?lang=${taal}` : '');
        return { ...l, url: kort.startsWith('http') ? kort : 'https://' + kort, fb: fbTekst(kort, taal) };
      })) });
    }
  }
  return apiJson({ error: 'onbekende op' }, 400);
}

// ── Tip via de website (zonder account) ────────────────────────────
// Openbaar: iedereen kan een affiche/flyer insturen. Gaat altijd naar de
// wachtrij (nooit direct live) en het kaartje in Telegram zegt erbij dat het
// van een anonieme bezoeker komt. Rem op de kosten (elke tip is een AI-call):
// per IP 5/uur en 10/dag, en alle tips samen 100/dag. Het IP wordt niet
// bewaard: alleen een gezouten hash, als uuid in ai_parse_usage (prefix
// a0000000 zodat tips te onderscheiden zijn van ingelogde gebruikers).
const TIP_VIA = 'website-tip';
const TIP_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const TIP_MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
function tipJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...TIP_CORS } });
}

async function tipLimiet(sb: any, req: Request): Promise<string | null> {
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'onbekend';
  const zout = (await cfg(sb, 'cron_secret')) ?? '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(zout + '|tip|' + ip));
  const h = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const id = `a0000000-${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}-${h.slice(12, 24)}`;
  const uur = new Date(Date.now() - 3600e3).toISOString();
  const dag = new Date(Date.now() - 86400e3).toISOString();
  const tel = async (q: any) => (await q).count ?? 0;
  const basis = () => sb.from('ai_parse_usage').select('id', { count: 'exact', head: true });
  if (await tel(basis().gte('user_id', 'a0000000-0000-0000-0000-000000000000')
    .lte('user_id', 'a0000000-ffff-ffff-ffff-ffffffffffff').gte('created_at', dag)) >= 100) return 'vol';
  if (await tel(basis().eq('user_id', id).gte('created_at', dag)) >= 10) return 'limiet';
  if (await tel(basis().eq('user_id', id).gte('created_at', uur)) >= 5) return 'limiet';
  await sb.from('ai_parse_usage').insert({ user_id: id });
  return null;
}

async function tip(sb: any, req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: TIP_CORS });
  const body = await req.json().catch(() => null);
  if (!body) return tipJson({ ok: false, reason: 'ongeldig' }, 400);
  if (body.website) return tipJson({ ok: true, status: 'ontvangen' });   // honeypot: bots vullen alles in
  const tekst = String(body.text || '').slice(0, 2000).trim();
  const img = body.image;
  const image = img && typeof img.data === 'string' && TIP_MEDIA.has(img.media_type) && img.data.length < 7_000_000
    ? { data: img.data, media_type: img.media_type } : null;
  if (!image && tekst.length < 20) return tipJson({ ok: false, reason: 'leeg' }, 400);
  const limiet = await tipLimiet(sb, req);
  if (limiet) return tipJson({ ok: false, reason: limiet }, 429);

  const r = await maakItem(sb, tekst, image, TIP_VIA);
  const nieuw = [r, ...(r.extra || [])].filter(x => x.ok) as Array<{ ok: true; row: any }>;
  if (nieuw.length) {
    const chat = await cfg(sb, 'telegram_admin_chat');
    if (chat) for (const x of nieuw) await stuurKaart(sb, chat, x.row);
    return tipJson({ ok: true, status: 'ontvangen' });
  }
  if (r.dup && r.dup.kind !== 'afgewezen') return tipJson({ ok: true, status: 'bestaat_al', title: r.dup.title, url: r.dup.kind === 'live' ? r.dup.url : null });
  if (r.dup) return tipJson({ ok: true, status: 'ontvangen' });
  return tipJson({ ok: false, reason: 'niet_gelezen' });
}

// ── Main ───────────────────────────────────────────────────────────
serve(async (req: Request) => {
  const url = new URL(req.url);
  if (url.searchParams.has('tip')) {
    if (req.method !== 'POST' && req.method !== 'OPTIONS') return tipJson({ error: 'Method not allowed' }, 405);
    if (!TOKEN) return tipJson({ error: 'niet beschikbaar' }, 500);
    return tip(createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } }), req);
  }
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
    if (action === 'report' || action === 'watchdog' || action === 'sample' || action === 'locaties') {
      const chat = await cfg(sb, 'telegram_admin_chat');
      if (!chat) return json({ ok: false, error: 'geen gekoppelde chat' });
      if (action === 'report') {
        const body = await req.json().catch(() => ({}));
        return json({ ok: await stuurMelding(sb, chat, Number(body?.id)) });
      }
      if (action === 'watchdog') return json({ ...(await bewaker(sb, chat)), bronnen: await bronVoorstellen(sb, chat) });
      if (action === 'locaties') return json({ ok: true, ...(await locatieControle(sb, chat, url.searchParams.has('droog'))) });
      return json({ ok: true, verstuurd: await steekproef(sb, chat) });
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
    } else if (/^\/sponsorweg\b/.test(tekst)) {
      await sponsorWeg(sb, chat, tekst);
    } else if (/^\/sponsor\b/.test(tekst)) {
      const alleen = tekst.match(/^\/sponsor(?:\s+(nl|be|de))?\s*$/i);
      if (alleen) await sponsorOverzicht(sb, chat, alleen[1]?.toLowerCase() ?? null);
      else await sponsorZet(sb, chat, tekst, m.photo?.length ? fotoIds(m) : []);
    } else if (/^\/meer\b/.test(tekst)) {
      const n = await digest(sb, chat, true);
      if (!n) await send(chat, '🎉 Niets meer — alles is getoond.');
    } else if (/^\/oproep\b/.test(tekst)) {
      // Kant-en-klare posts voor Facebook-groepen; wisselende tekst zodat
      // groepen niet steeds exact hetzelfde bericht zien.
      const oprit = [
        `Ga je binnenkort spullen verkopen op je oprit, in de tuin of vanuit de garage? 🏡\nZet het gratis op de kaart van YardiGo, dan zien mensen uit de buurt het meteen. Je adres wordt pas de dag ervoor getoond.\n👉 ${SITE}/verkoop`,
        `Opruimen en verkopen vanaf je oprit? 🧺\nOp YardiGo zet je je garage sale in 2 minuten gratis op de kaart. Bezoekers zien je adres pas 24 uur van tevoren.\n👉 ${SITE}/verkoop`,
        `Tip voor iedereen die een garage sale of tuinverkoop houdt: plaats 'm gratis op YardiGo, de kaart met alle rommelmarkten en opritverkopen in de buurt 📍\n👉 ${SITE}/verkoop`,
      ];
      const org = [
        `Organiseer je een rommelmarkt, rommelroute, kofferbakverkoop of kinderbeurs? 🗺\nZet 'm gratis op YardiGo, de kaart waar mensen zoeken wat er dit weekend te doen is.\n👉 ${SITE}/aanmelden`,
        `Rommelroute of garage sale met de hele straat of wijk? 🏘\nMeld 'm gratis aan op YardiGo, dan staat hij met alle deelnemers op de kaart.\n👉 ${SITE}/aanmelden`,
      ];
      const kies = (a: string[]) => a[Math.floor(Math.random() * a.length)];
      await send(chat, '📣 Twee berichten om te kopiëren: één voor buurtgroepen (opritverkoop), één voor organisatoren. Stuur /oproep opnieuw voor een andere tekst.');
      await fbBericht(chat, kies(oprit));
      await fbBericht(chat, kies(org));
    } else if (/^\/help\b/.test(tekst)) {
      await send(chat, [
        '<b>YardiGo-bot</b>',
        '📸 Stuur een affiche of screenshot (met eventueel de link van de post als bijschrift) → kaartje',
        '🔗 Stuur tekst of een link → kaartje',
        '↩️ Antwoord op een kaartje met een link, 06 of e-mail → contact aangevuld; met een adres → locatie',
        '✅/❌ op een kaartje → publiceren of afwijzen. Na publiceren krijg je een kant-en-klare Facebook-reactie.',
        '📣 /oproep → kant-en-klare Facebook-posts met yardigo.nl/verkoop',
        '💼 /sponsor → sponsorvakken op de homepage per domein (nl, be, de): overzicht, plaatsen en weghalen',
        '/stats · /meer · /oproep · /sponsor',
      ].join('\n'));
    } else if (m.reply_to_message?.from?.is_bot && await aanvulling(sb, chat, tekst, m.reply_to_message)) {
      // afgehandeld
    } else if (m.document && /heic|heif/i.test((m.document.mime_type || '') + (m.document.file_name || ''))) {
      await send(chat, '📷 Dit is een iPhone-bestand (HEIC) dat ik niet kan lezen. Stuur hem als <b>foto</b> in plaats van als bestand, of maak er een screenshot van.');
    } else if (m.document && /^image\//.test(m.document.mime_type || '') && (m.document.file_size || 0) > 4_500_000) {
      await send(chat, '📷 Dit bestand is te groot. Stuur hem als <b>foto</b> (dan verkleint Telegram hem) of als screenshot.');
    } else if (m.photo?.length || (m.document && /^image\//.test(m.document.mime_type || ''))) {
      await nieuwItem(sb, chat, tekst, fotoIds(m), m.message_id);
    } else if (tekst.trim().length >= 10) {
      await nieuwItem(sb, chat, tekst, [], m.message_id);
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
