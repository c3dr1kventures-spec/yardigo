// YardiGo – winkels-melding (zie winkels-sync.sql)
//
// Zondagochtend via pg_cron: stuurt de nog niet gemelde wijzigingen in de
// kringloopwinkels (nieuw / gewijzigd / weg / terug) als één overzicht naar
// de Telegram-adminchat en zet ze daarna op gemeld. Niets veranderd: geen
// bericht.
// Auth: x-cron-secret (zelfde als de andere cron-functies).
// Secrets: TELEGRAM_BOT_TOKEN (+ standaard SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { isCronCall } from '../_shared/cron-auth.ts';

const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const PER_SOORT = 12;   // zoveel namen per kopje, de rest als telling

type Rij = { id: number; winkel_id: number; land: string; wat: string; oud: Record<string, string> | null; nieuw: Record<string, string> | null };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const vlag = (land: string) => (land === 'be' ? '🇧🇪' : land === 'nl' ? '🇳🇱' : land.toUpperCase());

const VELD: Record<string, string> = {
  naam: 'naam', straat: 'adres', huisnummer: 'adres', postcode: 'adres', plaats: 'plaats',
  openingstijden: 'openingstijden', website: 'website', telefoon: 'telefoon',
};
function watVeranderd(r: Rij): string {
  const o = r.oud ?? {}, n = r.nieuw ?? {};
  const velden = new Set<string>();
  for (const k of Object.keys(VELD)) if ((o[k] ?? '') !== (n[k] ?? '')) velden.add(VELD[k]);
  return [...velden].join(', ');
}

function regel(r: Rij): string {
  const w = r.nieuw ?? r.oud ?? {};
  const plek = w.plaats ? `, ${esc(w.plaats)}` : '';
  const basis = `${vlag(r.land)} ${esc(w.naam)}${plek}`;
  if (r.wat === 'gewijzigd') {
    const v = watVeranderd(r);
    let extra = v ? ` <i>(${esc(v)})</i>` : '';
    if (v === 'openingstijden' && r.nieuw?.openingstijden) extra += `\n      ${esc(r.oud?.openingstijden ?? '?')} → ${esc(r.nieuw.openingstijden)}`;
    return '• ' + basis + extra;
  }
  return '• ' + basis;
}

serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'alleen POST' }, 405);
  if (!(await isCronCall(req))) return json({ error: 'unauthorized' }, 401);
  if (!TOKEN) return json({ error: 'TELEGRAM_BOT_TOKEN ontbreekt' }, 500);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: cfg } = await sb.from('app_config').select('value').eq('key', 'telegram_admin_chat').maybeSingle();
  const chat = cfg?.value;
  if (!chat) return json({ ok: false, error: 'geen gekoppelde chat' });

  const { data, error } = await sb.from('winkels_wijzigingen')
    .select('id, winkel_id, land, wat, oud, nieuw').eq('gemeld', false).order('id').limit(2000);
  if (error) return json({ ok: false, error: error.message }, 500);
  const rijen = (data ?? []) as Rij[];
  if (!rijen.length) return json({ ok: true, verstuurd: 0 });

  // Per winkel alleen de laatste wijziging tonen.
  const laatste = new Map<number, Rij>();
  for (const r of rijen) laatste.set(r.winkel_id, r);
  const per: Record<string, Rij[]> = { nieuw: [], terug: [], gewijzigd: [], weg: [] };
  for (const r of laatste.values()) per[r.wat]?.push(r);

  const kop: Record<string, string> = {
    nieuw: '🆕 Nieuw op de kaart', terug: '↩️ Weer terug', gewijzigd: '✏️ Gewijzigd', weg: '🚫 Niet meer in OpenStreetMap (van de kaart gehaald)',
  };
  const delen = [`🛍 <b>Kringloopwinkels: wekelijkse controle</b>\n${per.nieuw.length} nieuw · ${per.gewijzigd.length} gewijzigd · ${per.weg.length} weg · ${per.terug.length} terug`];
  for (const wat of ['nieuw', 'terug', 'gewijzigd', 'weg']) {
    const lijst = per[wat];
    if (!lijst.length) continue;
    const toon = lijst.slice(0, PER_SOORT).map(regel);
    if (lijst.length > PER_SOORT) toon.push(`<i>en nog ${lijst.length - PER_SOORT}</i>`);
    delen.push(`<b>${kop[wat]}</b>\n${toon.join('\n')}`);
  }
  delen.push('<i>Bron: OpenStreetMap. Klopt iets niet, pas het daar aan; de kaart volgt binnen een week.</i>');

  let tekst = delen.join('\n\n');
  if (tekst.length > 4000) tekst = tekst.slice(0, 3990) + '…';
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: tekst, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j?.ok) return json({ ok: false, error: j?.description ?? r.status }, 502);

  await sb.from('winkels_wijzigingen').update({ gemeld: true }).in('id', rijen.map((x) => x.id));
  return json({ ok: true, verstuurd: rijen.length });
});
