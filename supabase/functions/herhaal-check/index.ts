// YardiGo – herhaal-check Edge Function
//
// Elke nacht: markten van vorig jaar waarvan de nieuwe editie over 6 tot 8
// weken verwacht wordt en die er nog niet op staan (herhaal_kandidaten(), zie
// herhaal-detectie.sql).
//   - Organisator met account (zelf geplaatst of geclaimd, niet geblokkeerd):
//     mail met link naar /herhaal?t=<token>: één klik en de markt staat er
//     met de nieuwe datum weer op.
//   - Anders (geïmporteerd, geen account): kaartje in Telegram, zodat
//     Christian de nieuwe editie kan opzoeken. Geen ongevraagde mail naar
//     contactgegevens uit openbare bronnen (AVG).
// Elke markt krijgt dit één keer per editie (unique vorig_listing_id).
//
// Aanroep (POST, JSON):
//   {}                   normale run
//   { "dryRun": true }   niets versturen of opslaan, wel tonen wat er zou gebeuren
//   { "max": 30 }        max aantal per run (standaard 30)
// Auth: header x-cron-secret = app_config.cron_secret.
// Secrets: BREVO_API_KEY, REMINDER_FROM_EMAIL, REMINDER_FROM_NAME, TELEGRAM_BOT_TOKEN.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { isCronCall } from '../_shared/cron-auth.ts';

const SITE = 'https://www.yardigo.nl';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type Taal = 'nl' | 'en' | 'fr' | 'de';
function taalVan(country: string | null): Taal {
  const c = (country || '').toUpperCase();
  return c === 'DE' || c === 'AT' ? 'de' : c === 'FR' || c === 'LU' ? 'fr' : 'nl';
}
const LOCALE: Record<Taal, string> = { nl: 'nl-NL', en: 'en-GB', fr: 'fr-BE', de: 'de-DE' };
const datum = (iso: string, t: Taal) =>
  new Date(iso + 'T12:00:00Z').toLocaleDateString(LOCALE[t], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

const MAIL: Record<Taal, { onderwerp: string; hoi: string; tekst: string; knop: string; nee: string; voet: string }> = {
  nl: { onderwerp: 'Staat {titel} er dit jaar weer?', hoi: 'Hoi {naam},',
    tekst: 'Vorig jaar stond <b>{titel}</b> in {plaats} op YardiGo, op {vorig}. Komt hij dit jaar terug? Waarschijnlijk rond {verwacht}. Met één klik zet je hem er weer op, met dezelfde gegevens en de nieuwe datum.',
    knop: 'Ja, zet hem erop', nee: 'Dit jaar niet? Klik ook op de knop en kies "Dit jaar niet", dan vragen we het niet nog eens.',
    voet: 'Je krijgt deze mail omdat je deze markt vorig jaar op YardiGo zette.' },
  en: { onderwerp: 'Is {titel} on again this year?', hoi: 'Hi {naam},',
    tekst: 'Last year <b>{titel}</b> in {plaats} was on YardiGo, on {vorig}. Is it coming back this year? Probably around {verwacht}. With one click you put it back on, with the same details and the new date.',
    knop: 'Yes, put it on', nee: 'Not this year? Click the button too and choose "Not this year", and we will not ask again.',
    voet: 'You are receiving this because you listed this market on YardiGo last year.' },
  fr: { onderwerp: '{titel} revient-il cette année ?', hoi: 'Bonjour {naam},',
    tekst: "L'an dernier, <b>{titel}</b> à {plaats} était sur YardiGo, le {vorig}. Revient-il cette année ? Probablement vers le {verwacht}. En un clic, vous le remettez en ligne avec les mêmes informations et la nouvelle date.",
    knop: 'Oui, remettez-le en ligne', nee: 'Pas cette année ? Cliquez aussi sur le bouton et choisissez « Pas cette année », nous ne vous le demanderons plus.',
    voet: "Vous recevez ce message car vous avez publié ce marché sur YardiGo l'an dernier." },
  de: { onderwerp: 'Findet {titel} dieses Jahr wieder statt?', hoi: 'Hallo {naam},',
    tekst: 'Letztes Jahr war <b>{titel}</b> in {plaats} auf YardiGo, am {vorig}. Kommt er dieses Jahr wieder? Wahrscheinlich um den {verwacht}. Mit einem Klick stellst du ihn wieder ein, mit denselben Angaben und dem neuen Datum.',
    knop: 'Ja, wieder einstellen', nee: 'Dieses Jahr nicht? Klick trotzdem auf den Button und wähle „Dieses Jahr nicht“, dann fragen wir nicht noch einmal.',
    voet: 'Du erhältst diese E-Mail, weil du diesen Markt letztes Jahr auf YardiGo eingestellt hast.' },
};

function vul(s: string, v: Record<string, string>): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');
}

function mailHtml(t: Taal, v: Record<string, string>, link: string): string {
  const m = MAIL[t];
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#F9F5EF;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:20px 16px">
  <div style="background:#3A6B4A;border-radius:14px 14px 0 0;padding:18px 24px;text-align:center;font-size:22px;font-weight:800;color:white">YardiGo</div>
  <div style="background:white;border-radius:0 0 14px 14px;padding:24px;border:1.5px solid #E8E0D4;border-top:none">
    <p style="margin:0 0 12px;color:#2C2416;font-size:15px;font-weight:700">${vul(m.hoi, v)}</p>
    <p style="margin:0 0 18px;color:#4A3E32;font-size:14px;line-height:1.6">${vul(m.tekst, v)}</p>
    <div style="text-align:center;margin:0 0 18px">
      <a href="${link}" style="display:inline-block;background:#3A6B4A;color:white;border-radius:10px;padding:12px 28px;font-weight:700;font-size:14px;text-decoration:none">${m.knop}</a>
    </div>
    <p style="margin:0;color:#7A6E62;font-size:12px;line-height:1.6">${m.nee}</p>
  </div>
  <p style="text-align:center;margin-top:14px;color:#9E9587;font-size:11px">${m.voet}</p>
</div></body></html>`;
}

async function stuurMail(to: string, onderwerp: string, html: string, tekst: string): Promise<boolean> {
  const key = Deno.env.get('BREVO_API_KEY') ?? '';
  if (!key) return false;
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { accept: 'application/json', 'api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: { name: Deno.env.get('REMINDER_FROM_NAME') ?? 'YardiGo', email: Deno.env.get('REMINDER_FROM_EMAIL') ?? 'noreply@yardigo.nl' },
      to: [{ email: to }], subject: onderwerp, htmlContent: html, textContent: tekst, tags: ['herhaal-check'],
    }),
  });
  if (!r.ok) console.error('brevo', r.status, (await r.text()).slice(0, 300));
  return r.ok;
}

async function stuurTelegram(chat: string, tekst: string): Promise<boolean> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
  if (!token || !chat) return false;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: tekst, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  return r.ok;
}

serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!(await isCronCall(req))) return json({ error: 'Unauthorized' }, 401);
  const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } });

  let body: { dryRun?: boolean; max?: number } = {};
  try { body = await req.json(); } catch (_) {}
  const dryRun = body.dryRun === true;
  const max = Math.max(1, Math.min(100, body.max ?? 30));

  const k = await sb.rpc('herhaal_kandidaten');
  if (k.error) return json({ error: k.error.message }, 500);
  const kandidaten = (k.data || []).slice(0, max);
  const chat = (await sb.from('app_config').select('value').eq('key', 'telegram_admin_chat').maybeSingle()).data?.value ?? '';

  const s = { kandidaten: (k.data || []).length, mail: 0, telegram: 0, fout: 0, dryRun, preview: [] as any[] };
  for (const c of kandidaten) {
    // Wie is de organisator, en mogen we die mailen?
    let email: string | null = null, naam = '', country: string | null = null;
    if (c.eigenaar_id) {
      const p = await sb.from('profiles').select('display_name, country, is_blocked').eq('id', c.eigenaar_id).maybeSingle();
      if (p.data && !p.data.is_blocked) {
        const u = await sb.auth.admin.getUserById(c.eigenaar_id);
        email = u.data?.user?.email ?? null;
        naam = p.data.display_name || (email ? email.split('@')[0] : '');
        country = p.data.country;
      }
    }
    const kanaal = email ? 'mail' : 'telegram';
    if (dryRun) { s.preview.push({ titel: c.title, plaats: c.city, vorig: c.date_start, verwacht: c.verwachte_datum, kanaal }); continue; }

    const ins = await sb.from('herhaal_verzoeken').insert({
      vorig_listing_id: c.listing_id, eigenaar_id: email ? c.eigenaar_id : null, kanaal, verwachte_datum: c.verwachte_datum,
    }).select('token').single();
    if (ins.error) { s.fout++; console.error('insert', ins.error.message); continue; }

    if (email) {
      const t = taalVan(country);
      const v = { naam: esc(naam), titel: esc(c.title), plaats: esc(c.city || ''), vorig: datum(c.date_start, t), verwacht: datum(c.verwachte_datum, t) };
      const link = `${SITE}/herhaal?t=${ins.data.token}&lang=${t}`;
      const tekst = vul(MAIL[t].tekst, v).replace(/<[^>]+>/g, '') + '\n\n' + link;
      if (await stuurMail(email, vul(MAIL[t].onderwerp, { titel: c.title }), mailHtml(t, v, link), tekst)) s.mail++;
      else { s.fout++; await sb.from('herhaal_verzoeken').delete().eq('vorig_listing_id', c.listing_id); }   // volgende nacht opnieuw
    } else {
      const zoek = 'https://www.google.com/search?q=' + encodeURIComponent(`${c.title} ${c.city || ''} ${c.verwachte_datum.slice(0, 4)}`);
      const ok = await stuurTelegram(chat, [
        '🔁 <b>Komt deze markt terug?</b>',
        `Vorig jaar: <b>${esc(c.title)}</b> in ${esc(c.city || '?')} op ${datum(c.date_start, 'nl')}.`,
        `Verwacht rond ${datum(c.verwachte_datum, 'nl')}, nog niet op YardiGo.`,
        `🔎 <a href="${zoek}">Zoek de nieuwe datum</a>. Gevonden? Stuur de affiche of link naar mij.`,
      ].join('\n'));
      ok ? s.telegram++ : s.fout++;
    }
  }
  return json({ ok: true, ...s });
});
