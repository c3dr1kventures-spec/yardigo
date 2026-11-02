// YardiGo – send-reminders: de weekendmail (en maandmail) voor wie zich
// in /app heeft aangemeld (profiles.promo_email_opt_in).
//
// Per ontvanger de dichtstbijzijnde verkopen in de komende periode:
//   weekly  (vrijdag 08:00): vandaag t/m 9 dagen vooruit (dit weekend + volgende week)
//   monthly (de 1e, 08:00):  vandaag t/m 31 dagen vooruit
// Plek: thuislocatie (home_lat/lng), anders het centrum van de woonplaats
// (_shared/locatie.ts), anders de eerstvolgende verkopen in het hele land.
// Alleen titel, soort, datum en plaats; nooit een adres.
//
// Aanroep (pg_cron, header x-cron-secret):
//   POST /functions/v1/send-reminders  body {"frequency":"weekly"}
//   ...?dry=1   niets versturen: geeft per ontvanger wat hij zou krijgen,
//               plus de HTML van de eerste mail.
// Echt versturen alleen als app_config 'weekendmail_aan' = 'true'.
// Secrets: BREVO_API_KEY, REMINDER_FROM_EMAIL, REMINDER_FROM_NAME.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { isCronCall } from '../_shared/cron-auth.ts';
import { toetsPlek } from '../_shared/locatie.ts';

const SITE = 'https://www.yardigo.nl';
const STRAAL_KM = 25;
const AANTAL = 8;

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = (x: number) => (x * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SOORT: Record<string, string> = {
  opritverkoop: 'Opritverkoop', rommelroute: 'Rommelroute', buurtverkoop: 'Buurtverkoop',
  rommelmarkt: 'Rommelmarkt', vlooienmarkt: 'Vlooienmarkt', snuffelmarkt: 'Snuffelmarkt', jaarmarkt: 'Jaarmarkt',
  kofferbak: 'Kofferbakverkoop', boekenmarkt: 'Boekenmarkt', antiekmarkt: 'Antiekmarkt', kerstmarkt: 'Kerstmarkt',
  braderie: 'Braderie', kinderbeurs: 'Kinderbeurs', kledingmarkt: 'Kledingmarkt',
};
// Zelfde kleuren als de kaart: oprit amber, route oranje, markten groen.
function kleur(sub: string | null, cat: string | null): string {
  if (sub === 'opritverkoop' || cat === 'garagesale') return '#F2A830';
  if (sub === 'rommelroute' || sub === 'buurtverkoop' || cat === 'buurtverkoop') return '#E07B39';
  return '#3A6B4A';
}

function datumTekst(start: string, eind: string | null, tijd: string | null): string {
  const f = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Amsterdam' });
  const t = tijd ? `, ${String(tijd).slice(0, 5)}` : '';
  return eind && eind !== start ? `${f(start)} t/m ${f(eind)}${t}` : `${f(start)}${t}`;
}

interface Verkoop {
  id: string; title: string | null; city: string | null; category: string | null; event_subtype: string | null;
  date_start: string; date_end: string | null; time_start: string | null;
  latitude: number | null; longitude: number | null; short_code: string | null;
}
type Gekozen = Verkoop & { km: number | null };

function kies(verkopen: Verkoop[], plek: { lat: number; lng: number } | null): Gekozen[] {
  if (!plek) return verkopen.slice(0, AANTAL).map(v => ({ ...v, km: null }));
  return verkopen
    .filter(v => v.latitude != null && v.longitude != null)
    .map(v => ({ ...v, km: distanceKm(plek.lat, plek.lng, v.latitude!, v.longitude!) }))
    .filter(v => v.km <= STRAAL_KM)
    .sort((a, b) => a.date_start.localeCompare(b.date_start) || a.km - b.km)
    .slice(0, AANTAL);
}

function link(v: Verkoop): string {
  return v.short_code ? `${SITE}/s/${v.short_code}` : `${SITE}/v/${v.id}`;
}

function mail(naam: string, rijen: Gekozen[], waar: string | null, maand: boolean, uitschrijf: string, totaal: number) {
  const periode = maand ? 'de komende maand' : 'dit weekend en volgende week';
  const intro = waar
    ? `Dit staat er ${periode} binnen ${STRAAL_KM} km van ${esc(waar)}:`
    : `Dit zijn de eerstvolgende verkopen ${periode}. Stel in de app je woonplaats in, dan krijg je alleen verkopen bij jou in de buurt.`;
  const kaartjes = rijen.map(v => `
    <a href="${link(v)}" style="display:block;text-decoration:none;border:1px solid #E6E1D6;border-left:4px solid ${kleur(v.event_subtype, v.category)};border-radius:10px;padding:10px 12px;margin-bottom:8px;background:#FFFFFF">
      <div style="font-size:14px;font-weight:700;color:#1E2922">${esc(v.title || 'Verkoop')}</div>
      <div style="font-size:12px;color:#5C6660;margin-top:3px">${esc(SOORT[v.event_subtype || ''] || 'Verkoop')} · ${esc(datumTekst(v.date_start, v.date_end, v.time_start))} · ${esc(v.city || '')}${v.km != null ? ` · ${v.km < 1 ? '< 1' : Math.round(v.km)} km` : ''}</div>
    </a>`).join('');
  const meer = totaal > rijen.length ? `<p style="margin:12px 0 0;color:#5C6660;font-size:13px">En nog ${totaal - rijen.length} meer op de kaart.</p>` : '';
  const html = `<!DOCTYPE html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#F4F2EC;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:20px 16px">
  <div style="background:#3A6B4A;border-radius:14px 14px 0 0;padding:18px 24px">
    <div style="font-size:22px;font-weight:800;color:#FFFFFF">YardiGo</div>
    <div style="font-size:12px;color:rgba(255,255,255,.85);margin-top:2px">Rommelmarkten en garage sales bij jou in de buurt</div>
  </div>
  <div style="background:#FAF9F5;border-radius:0 0 14px 14px;padding:22px 20px;border:1px solid #E6E1D6;border-top:none">
    <p style="margin:0 0 10px;color:#1E2922;font-size:16px;font-weight:700">Hoi ${esc(naam)}</p>
    <p style="margin:0 0 16px;color:#3B453F;font-size:14px;line-height:1.55">${intro}</p>
    ${kaartjes}${meer}
    <div style="text-align:center;margin:20px 0 4px">
      <a href="${SITE}/" style="display:inline-block;background:#E07B39;color:#FFFFFF;border-radius:10px;padding:12px 26px;font-weight:700;font-size:14px;text-decoration:none">Bekijk de kaart</a>
    </div>
  </div>
  <p style="text-align:center;margin:14px 0 0;color:#8A918C;font-size:11px;line-height:1.6">
    Je krijgt deze mail omdat je je in YardiGo hebt aangemeld voor tips.<br>
    <a href="${uitschrijf}" style="color:#8A918C">Afmelden voor deze mail</a>
  </p>
</div></body></html>`;
  const tekst = [`Hoi ${naam}`, '', intro.replace(/<[^>]+>/g, ''), '',
    ...rijen.map(v => `${v.title || 'Verkoop'} (${SOORT[v.event_subtype || ''] || 'Verkoop'}), ${datumTekst(v.date_start, v.date_end, v.time_start)}, ${v.city || ''}\n${link(v)}`),
    '', `Bekijk de kaart: ${SITE}/`, '', `Afmelden: ${uitschrijf}`].join('\n');
  const onderwerp = waar
    ? `${totaal} ${totaal === 1 ? 'verkoop' : 'verkopen'} bij ${waar} ${maand ? 'deze maand' : 'dit weekend en volgende week'}`
    : `De eerstvolgende rommelmarkten en garage sales`;
  return { html, tekst, onderwerp };
}

async function stuurMail(to: string, onderwerp: string, html: string, tekst: string): Promise<boolean> {
  const key = Deno.env.get('BREVO_API_KEY') ?? '';
  if (!key) { console.error('BREVO_API_KEY ontbreekt'); return false; }
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { accept: 'application/json', 'api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: { name: Deno.env.get('REMINDER_FROM_NAME') ?? 'YardiGo', email: Deno.env.get('REMINDER_FROM_EMAIL') ?? 'noreply@yardigo.nl' },
      to: [{ email: to }], subject: onderwerp, htmlContent: html, textContent: tekst, tags: ['weekendmail'],
    }),
  });
  if (!r.ok) console.error('brevo', r.status, (await r.text()).slice(0, 300));
  return r.ok;
}

serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!(await isCronCall(req))) return json({ error: 'Unauthorized' }, 401);
  const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } });

  const url = new URL(req.url);
  const aan = (await sb.from('app_config').select('value').eq('key', 'weekendmail_aan').maybeSingle()).data?.value === 'true';
  const droog = url.searchParams.has('dry') || !aan;
  const body = await req.json().catch(() => ({}));
  const freq = body.frequency === 'monthly' || url.searchParams.get('frequency') === 'monthly' ? 'monthly' : 'weekly';
  const maand = freq === 'monthly';

  const vandaag = new Date().toISOString().slice(0, 10);
  const tot = new Date(Date.now() + (maand ? 31 : 9) * 86400000).toISOString().slice(0, 10);
  const { data: verkopen, error: vErr } = await sb.from('listings')
    .select('id,title,city,category,event_subtype,date_start,date_end,time_start,latitude,longitude,short_code')
    .eq('status', 'active').lte('date_start', tot).or(`date_start.gte.${vandaag},date_end.gte.${vandaag}`)
    .order('date_start').limit(3000);
  if (vErr) return json({ error: vErr.message }, 500);

  // Niet twee keer in dezelfde periode, ook niet als de cron opnieuw draait.
  const grens = new Date(Date.now() - (maand ? 27 : 6) * 86400000).toISOString();
  const { data: ontvangers, error: oErr } = await sb.from('profiles')
    .select('id,display_name,city,home_lat,home_lng,unsubscribe_token')
    .eq('promo_email_opt_in', true).eq('email_frequency', freq).not('is_blocked', 'is', true)
    .or(`last_reminder_sent_at.is.null,last_reminder_sent_at.lt.${grens}`);
  if (oErr) return json({ error: oErr.message }, 500);

  const st = { ontvangers: ontvangers?.length ?? 0, verstuurd: 0, leeg: 0, geen_mail: 0, fout: 0 };
  const proef: unknown[] = [];
  let voorbeeld: string | null = null;

  for (const p of ontvangers || []) {
    const { data: u } = await sb.auth.admin.getUserById(p.id);
    const email = u?.user?.email;
    if (!email) { st.geen_mail++; continue; }

    let plek = p.home_lat != null && p.home_lng != null ? { lat: p.home_lat, lng: p.home_lng } : null;
    let waar: string | null = plek ? (p.city?.split(',')[0].trim() || 'je huis') : null;
    if (!plek && p.city) {
      const t = await toetsPlek(sb, null, p.city);
      if (t.centrum) { plek = t.centrum; waar = p.city.split(',')[0].trim(); }
    }
    const binnen = plek ? kies(verkopen as Verkoop[], plek) : [];
    // Niets in de buurt: liever geen mail dan een lege.
    if (plek && !binnen.length) { st.leeg++; proef.push({ id: p.id, waar, aantal: 0 }); continue; }
    const rijen = plek ? binnen : kies(verkopen as Verkoop[], null);
    const totaal = plek ? (verkopen as Verkoop[]).filter(v => v.latitude != null && v.longitude != null
      && distanceKm(plek!.lat, plek!.lng, v.latitude!, v.longitude!) <= STRAAL_KM).length : (verkopen?.length ?? 0);

    const naam = p.display_name || email.split('@')[0];
    const uitschrijf = `${SITE}/?uitschrijven-promo=1&token=${p.unsubscribe_token}`;
    const m = mail(naam, rijen, waar, maand, uitschrijf, totaal);
    if (droog) {
      proef.push({ id: p.id, waar, aantal: rijen.length, totaal, onderwerp: m.onderwerp });
      voorbeeld ??= m.html;
      continue;
    }
    if (await stuurMail(email, m.onderwerp, m.html, m.tekst)) {
      st.verstuurd++;
      await sb.from('profiles').update({ last_reminder_sent_at: new Date().toISOString() }).eq('id', p.id);
    } else st.fout++;
  }

  return json({ ok: true, freq, droog, verkopen: verkopen?.length ?? 0, ...st, ...(droog ? { proef, voorbeeld } : {}) });
});
