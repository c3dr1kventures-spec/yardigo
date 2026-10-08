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

// ── Config ─────────────────────────────────────────────────────────
async function cfg(sb: any, key: string): Promise<string | null> {
  const { data } = await sb.from('app_config').select('value').eq('key', key).maybeSingle();
  return data?.value ?? null;
}
async function setCfg(sb: any, key: string, value: string) {
  await sb.from('app_config').upsert({ key, value }, { onConflict: 'key' });
}

// ── Kaartje ────────────────────────────────────────────────────────
const PENDING_COLS = 'id,title,description,event_subtype,date_start,date_end,time_start,time_end,city,address,latitude,longitude,organizer_name,organizer_url,contact_email,contact_phone,is_private_seller,status,auto_check,lead_source_url,source_url,approved_listing_id';

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
  if (p.status === 'tip') {
    return { inline_keyboard: [
      [{ text: '💬 Toestemming vragen', callback_data: `dm:${p.id}` }],
      [{ text: '✅ Publiceren (contact achter login)', callback_data: `ok:${p.id}` }],
      [{ text: '❌ Overslaan', callback_data: `no:${p.id}` }],
    ] };
  }
  return { inline_keyboard: [[
    { text: '✅ Publiceren', callback_data: `ok:${p.id}` },
    { text: '❌ Afwijzen', callback_data: `no:${p.id}` },
  ]] };
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
  return { data: btoa(bin), media_type: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg' };
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

function contactUitTekst(t: string) {
  const urls = [...t.matchAll(/https?:\/\/[^\s<>"]+/gi)].map(m => m[0].replace(/[).,]+$/, ''));
  const mail = t.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ?? null;
  const tel = t.match(/(?:\+31|0031|\+32|0)\s?6[\s-]?(?:\d[\s-]?){8}|(?:\+31|\+32|0)\d{1,3}[\s-]?\d{6,7}/)?.[0]?.replace(/[^\d+]/g, '') ?? null;
  return { url: urls[0] ?? null, mail, tel };
}

async function nieuwItem(sb: any, chat: string, tekst: string, fotoId: string | null) {
  await tg('sendChatAction', { chat_id: chat, action: 'typing' });
  const image = fotoId ? await fotoAlsBase64(fotoId) : null;
  const parseRes = await fetch(Deno.env.get('SUPABASE_URL') + '/functions/v1/parse-event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (Deno.env.get('SUPABASE_ANON_KEY') ?? ''),
      'x-cron-secret': (await cfg(sb, 'cron_secret')) ?? '',
    },
    body: JSON.stringify({ mode: 'admin', text: tekst || undefined, image: image || undefined }),
  });
  const pj = await parseRes.json().catch(() => ({}));
  if (pj?.ok === false) return send(chat, '🤷 Geen evenement gevonden in dit bericht.');
  const e = pj?.data;
  if (!e?.titel || !e?.datum) return send(chat, '⚠️ Kon dit niet lezen' + (pj?.error ? ': ' + esc(String(pj.error).slice(0, 200)) : ' (titel of datum ontbreekt).'));

  const ct = contactUitTekst(tekst);
  const orgUrl = ct.url || e.bron_url || null;
  const geo = await geocode(e.adres, e.plaats);
  const h = await sb.rpc('discovery_content_hash', { p_title: e.titel, p_date: e.datum, p_city: e.plaats });
  if (geo && h.data) {
    const dup = await sb.rpc('discovery_find_similar', { p_hash: h.data, p_lat: geo.lat, p_lng: geo.lng, p_date: e.datum, p_radius_m: 500 });
    if (dup.data) return send(chat, `♻️ Staat er al (${esc(String(dup.data))}): <b>${esc(e.titel)}</b>`);
  }
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
    raw_ai_response: { parse_event: e },
  };
  row.auto_check = autoCheck({ id: 0, ...row }, true);
  const ins = await sb.from('pending_events').insert(row).select(PENDING_COLS).single();
  if (ins.error) return send(chat, '⚠️ Opslaan mislukt: ' + esc(ins.error.message));
  await stuurKaart(sb, chat, ins.data);
}

// ── Knoppen ────────────────────────────────────────────────────────
function fbReactie(listingId: string): string {
  return `Staat ook op de YardiGo-kaart 📍 ${SITE}/v/${listingId}`;
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

  if (actie === 'ok') {
    const ontbreekt: string[] = [];
    if (!heeftContact(p)) ontbreekt.push('contactweg (antwoord met link/06/e-mail)');
    if (p.latitude == null || p.longitude == null) ontbreekt.push('coördinaten (antwoord met adres + plaats)');
    if (!p.date_start || p.date_start < new Date().toISOString().slice(0, 10)) ontbreekt.push('datum in de toekomst');
    if (ontbreekt.length) {
      await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Ontbreekt: ' + ontbreekt.join(', '), show_alert: true });
      return;
    }
    try {
      const reviewer = await curatorId(sb);
      const listingId = await publishPending(sb, p, reviewer, null);
      await tg('editMessageText', { chat_id: chat, message_id: msg.message_id, parse_mode: 'HTML', disable_web_page_preview: true,
        text: `✅ <b>${esc(p.title)}</b> staat live\n${SITE}/v/${listingId}\n\nReactie voor Facebook:\n<code>${esc(fbReactie(listingId))}</code>` });
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

// ── Main ───────────────────────────────────────────────────────────
serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!TOKEN) return json({ error: 'TELEGRAM_BOT_TOKEN ontbreekt' }, 500);
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const action = new URL(req.url).searchParams.get('action');

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
    const chat = String(m.chat.id);
    const tekst: string = m.text || m.caption || '';

    // Koppelen
    if (/^\/start\b/.test(tekst)) {
      const code = await cfg(sb, 'telegram_pair_code');
      const gegeven = tekst.split(/\s+/)[1] || '';
      if (code && gegeven && gegeven === code && m.chat.type === 'private') {
        await setCfg(sb, 'telegram_admin_chat', chat);
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
