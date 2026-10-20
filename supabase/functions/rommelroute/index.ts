// YardiGo – rommelroute Edge Function (Fase 3)
//
// Alle service-mail rond rommelroutes (zie rommelroute-organisator.sql):
//
// Cron (elk uur, header x-cron-secret):
//   1. Organisator: "er zijn nieuwe aanmeldingen" (één mail per route, gebundeld).
//   2. Buur: "je bent goedgekeurd, je staat op de kaart" + link om je af te melden.
//   3. Buur: uitnodiging voor een nieuwe editie (alleen als die buur bij de vorige
//      editie "mail me bij een volgende editie" aanvinkte).
//   4. Organisator: rapport na afloop (weergaven, ik ga, favorieten, adressen).
//   5. Opruimen (route_opruimen): dataminimalisatie.
//   6. Buur, ochtend van de route (vanaf 7:00): link om de live-status te zetten
//      (Fase 4). Verlopen live-statussen worden ook hier opgeruimd.
//
// Bericht van de organisator aan alle deelnemers (POST, ingelogd):
//   { "actie": "bericht", "groep_id": "bv-...", "tekst": "..." }
//   Authorization: Bearer <access token van de organisator>
//   Alleen naar buren die zich aanmeldden mét e-mail en goedgekeurd zijn. Max 3
//   per route per 24 uur. Het e-mailadres van de buur ziet de organisator nooit.
//
// Cron-aanroep (POST, JSON): {} of { "dryRun": true }
// Secrets: BREVO_API_KEY, REMINDER_FROM_EMAIL, REMINDER_FROM_NAME.

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { isCronCall } from '../_shared/cron-auth.ts';

const SITE = 'https://www.yardigo.nl';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type Taal = 'nl' | 'en' | 'fr' | 'de';
const isTaal = (t: unknown): t is Taal => t === 'nl' || t === 'en' || t === 'fr' || t === 'de';
function taalVanLand(country: string | null): Taal {
  const c = (country || '').toUpperCase();
  return c === 'DE' || c === 'AT' ? 'de' : c === 'FR' || c === 'LU' ? 'fr' : 'nl';
}
const LOCALE: Record<Taal, string> = { nl: 'nl-NL', en: 'en-GB', fr: 'fr-BE', de: 'de-DE' };
const datum = (iso: string, t: Taal) =>
  new Date(iso + 'T12:00:00Z').toLocaleDateString(LOCALE[t], { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

function vul(s: string, v: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));
}

// ── Teksten ────────────────────────────────────────────────

const T: Record<Taal, Record<string, string>> = {
  nl: {
    hoi: 'Hoi {naam},', hoiAnoniem: 'Hoi,',
    nieuwOnderwerp: '{n} nieuwe aanmelding(en) voor {titel}',
    nieuwTekst: 'Er hebben zich {n} buren aangemeld voor <b>{titel}</b>. Bekijk ze en keur ze goed, dan staan ze direct op de kaart.',
    nieuwKnop: 'Aanmeldingen bekijken',
    nieuwVoet: 'Je krijgt deze mail omdat je deze rommelroute op YardiGo organiseert.',
    okOnderwerp: 'Je staat op de kaart: {titel}',
    okTekst: 'De organisator heeft je aanmelding goedgekeurd. Je adres staat op de kaart van <b>{titel}</b> op {datum}{tijd}. Veel verkoopplezier!',
    okKnop: 'Bekijk de route',
    okAfmelden: 'Toch niet meedoen? <a href="{link}" style="color:#7A6E62">Meld je hier af</a>, dan halen we je adres direct van de kaart.',
    voetBuur: 'Je krijgt deze mail omdat je je aanmeldde voor deze rommelroute op YardiGo.',
    uitOnderwerp: 'Doe je weer mee met {titel}?',
    uitTekst: '<b>{titel}</b> wordt opnieuw georganiseerd, op {datum}{tijd}. Vorige keer deed je mee. Doe je weer mee? Met één klik sta je weer op de kaart.',
    uitKnop: 'Ja, ik doe weer mee',
    uitNee: 'Geen zin of geen tijd? Dan hoef je niets te doen. Je adres komt niet op de kaart zonder jouw ja.',
    rapOnderwerp: 'Zo ging {titel}',
    rapTekst: 'Bedankt voor het organiseren van <b>{titel}</b>! Dit is hoe het ging op YardiGo:',
    rapWeergaven: 'keer bekeken', rapIkGa: 'mensen gingen erheen', rapFav: 'keer bewaard als favoriet', rapAdressen: 'adressen deden mee',
    rapVolgend: 'Volgend jaar weer? Open je route in Mijn verkopen en kies "Opnieuw organiseren". Je buren krijgen dan een nieuwe uitnodiging.',
    rapKnop: 'Naar Mijn verkopen',
    berOnderwerp: 'Bericht over {titel}',
    berIntro: '{org} (organisator van <b>{titel}</b> op {datum}) stuurt je dit bericht:',
    berOrg: 'De organisator',
    liveOnderwerp: 'Vandaag is het zover: {titel}',
    liveTekst: 'Vandaag is <b>{titel}</b>{tijd}. Laat bezoekers live zien hoe het bij jou gaat: open, bijna leeg of gesloten. Eén tik is genoeg, en je kunt het de hele dag aanpassen.',
    liveKnop: 'Mijn status zetten',
    liveOnder: 'Bewaar deze mail: via dezelfde knop pas je je status later weer aan.',
  },
  en: {
    hoi: 'Hi {naam},', hoiAnoniem: 'Hi,',
    nieuwOnderwerp: '{n} new sign-up(s) for {titel}',
    nieuwTekst: '{n} neighbours signed up for <b>{titel}</b>. Review and approve them, and they will be on the map right away.',
    nieuwKnop: 'View sign-ups',
    nieuwVoet: 'You are receiving this because you organise this yard sale route on YardiGo.',
    okOnderwerp: 'You are on the map: {titel}',
    okTekst: 'The organiser approved your sign-up. Your address is on the map of <b>{titel}</b> on {datum}{tijd}. Happy selling!',
    okKnop: 'View the route',
    okAfmelden: 'Changed your mind? <a href="{link}" style="color:#7A6E62">Withdraw here</a> and we will remove your address from the map right away.',
    voetBuur: 'You are receiving this because you signed up for this yard sale route on YardiGo.',
    uitOnderwerp: 'Joining {titel} again?',
    uitTekst: '<b>{titel}</b> is being organised again, on {datum}{tijd}. You took part last time. Joining again? One click and you are back on the map.',
    uitKnop: 'Yes, count me in',
    uitNee: 'Not this time? You do not need to do anything. Your address will not go on the map without your yes.',
    rapOnderwerp: 'How {titel} went',
    rapTekst: 'Thank you for organising <b>{titel}</b>! This is how it went on YardiGo:',
    rapWeergaven: 'views', rapIkGa: 'people went', rapFav: 'times saved as favourite', rapAdressen: 'addresses took part',
    rapVolgend: 'Again next year? Open your route in My sales and choose "Organise again". Your neighbours will get a new invitation.',
    rapKnop: 'Go to My sales',
    berOnderwerp: 'Message about {titel}',
    berIntro: '{org} (organiser of <b>{titel}</b> on {datum}) sends you this message:',
    berOrg: 'The organiser',
    liveOnderwerp: 'Today is the day: {titel}',
    liveTekst: 'Today is <b>{titel}</b>{tijd}. Let visitors see live how things are going at your place: open, almost sold out or closed. One tap is enough, and you can change it all day.',
    liveKnop: 'Set my status',
    liveOnder: 'Keep this email: use the same button to update your status later.',
  },
  fr: {
    hoi: 'Bonjour {naam},', hoiAnoniem: 'Bonjour,',
    nieuwOnderwerp: '{n} nouvelle(s) inscription(s) pour {titel}',
    nieuwTekst: '{n} voisins se sont inscrits pour <b>{titel}</b>. Vérifiez et approuvez-les, ils apparaîtront aussitôt sur la carte.',
    nieuwKnop: 'Voir les inscriptions',
    nieuwVoet: 'Vous recevez ce message car vous organisez ce parcours de vide-greniers sur YardiGo.',
    okOnderwerp: 'Vous êtes sur la carte : {titel}',
    okTekst: "L'organisateur a approuvé votre inscription. Votre adresse est sur la carte de <b>{titel}</b> le {datum}{tijd}. Bonne vente !",
    okKnop: 'Voir le parcours',
    okAfmelden: 'Vous ne participez plus ? <a href="{link}" style="color:#7A6E62">Désinscrivez-vous ici</a> et nous retirons aussitôt votre adresse de la carte.',
    voetBuur: 'Vous recevez ce message car vous vous êtes inscrit à ce parcours de vide-greniers sur YardiGo.',
    uitOnderwerp: 'Vous participez de nouveau à {titel} ?',
    uitTekst: '<b>{titel}</b> est de nouveau organisé, le {datum}{tijd}. Vous avez participé la dernière fois. Vous revenez ? Un clic et vous êtes de nouveau sur la carte.',
    uitKnop: 'Oui, je participe',
    uitNee: "Pas cette fois ? Vous n'avez rien à faire. Votre adresse n'apparaîtra pas sur la carte sans votre accord.",
    rapOnderwerp: 'Le bilan de {titel}',
    rapTekst: "Merci d'avoir organisé <b>{titel}</b> ! Voici le bilan sur YardiGo :",
    rapWeergaven: 'vues', rapIkGa: 'personnes y sont allées', rapFav: 'fois ajouté aux favoris', rapAdressen: 'adresses ont participé',
    rapVolgend: "L'année prochaine aussi ? Ouvrez votre parcours dans Mes ventes et choisissez « Organiser à nouveau ». Vos voisins recevront une nouvelle invitation.",
    rapKnop: 'Vers Mes ventes',
    berOnderwerp: 'Message concernant {titel}',
    berIntro: '{org} (organisateur de <b>{titel}</b> le {datum}) vous envoie ce message :',
    berOrg: "L'organisateur",
    liveOnderwerp: "C'est aujourd'hui : {titel}",
    liveTekst: "C'est aujourd'hui <b>{titel}</b>{tijd}. Montrez en direct aux visiteurs comment ça se passe chez vous : ouvert, presque vide ou fermé. Un seul clic suffit, et vous pouvez le modifier toute la journée.",
    liveKnop: 'Indiquer mon statut',
    liveOnder: 'Gardez cet e-mail : le même bouton vous permet de modifier votre statut plus tard.',
  },
  de: {
    hoi: 'Hallo {naam},', hoiAnoniem: 'Hallo,',
    nieuwOnderwerp: '{n} neue Anmeldung(en) für {titel}',
    nieuwTekst: '{n} Nachbarn haben sich für <b>{titel}</b> angemeldet. Prüfe und bestätige sie, dann stehen sie sofort auf der Karte.',
    nieuwKnop: 'Anmeldungen ansehen',
    nieuwVoet: 'Du erhältst diese E-Mail, weil du diesen Hofflohmarkt auf YardiGo organisierst.',
    okOnderwerp: 'Du bist auf der Karte: {titel}',
    okTekst: 'Die Organisation hat deine Anmeldung bestätigt. Deine Adresse steht auf der Karte von <b>{titel}</b> am {datum}{tijd}. Viel Spaß beim Verkaufen!',
    okKnop: 'Route ansehen',
    okAfmelden: 'Doch nicht dabei? <a href="{link}" style="color:#7A6E62">Hier abmelden</a>, dann nehmen wir deine Adresse sofort von der Karte.',
    voetBuur: 'Du erhältst diese E-Mail, weil du dich auf YardiGo für diesen Hofflohmarkt angemeldet hast.',
    uitOnderwerp: 'Bist du bei {titel} wieder dabei?',
    uitTekst: '<b>{titel}</b> findet wieder statt, am {datum}{tijd}. Letztes Mal warst du dabei. Machst du wieder mit? Ein Klick und du stehst wieder auf der Karte.',
    uitKnop: 'Ja, ich bin dabei',
    uitNee: 'Diesmal nicht? Dann musst du nichts tun. Ohne dein Ja kommt deine Adresse nicht auf die Karte.',
    rapOnderwerp: 'So lief {titel}',
    rapTekst: 'Danke, dass du <b>{titel}</b> organisiert hast! So lief es auf YardiGo:',
    rapWeergaven: 'Aufrufe', rapIkGa: 'Personen waren dort', rapFav: 'Mal als Favorit gespeichert', rapAdressen: 'Adressen haben mitgemacht',
    rapVolgend: 'Nächstes Jahr wieder? Öffne deine Route unter Meine Verkäufe und wähle „Erneut organisieren“. Deine Nachbarn bekommen dann eine neue Einladung.',
    rapKnop: 'Zu Meine Verkäufe',
    berOnderwerp: 'Nachricht zu {titel}',
    berIntro: '{org} (Organisation von <b>{titel}</b> am {datum}) schickt dir diese Nachricht:',
    berOrg: 'Die Organisation',
    liveOnderwerp: 'Heute ist es so weit: {titel}',
    liveTekst: 'Heute ist <b>{titel}</b>{tijd}. Zeig Besuchern live, wie es bei dir läuft: geöffnet, fast leer oder geschlossen. Ein Tippen reicht, und du kannst es den ganzen Tag ändern.',
    liveKnop: 'Meinen Status setzen',
    liveOnder: 'Bewahre diese E-Mail auf: Mit demselben Button änderst du deinen Status später wieder.',
  },
};

function mailHtml(hoi: string, blokken: string, knop: { tekst: string; link: string } | null, onder: string, voet: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#F9F5EF;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:20px 16px">
  <div style="background:#3A6B4A;border-radius:14px 14px 0 0;padding:18px 24px;text-align:center;font-size:22px;font-weight:800;color:white">YardiGo</div>
  <div style="background:white;border-radius:0 0 14px 14px;padding:24px;border:1.5px solid #E8E0D4;border-top:none">
    <p style="margin:0 0 12px;color:#2C2416;font-size:15px;font-weight:700">${hoi}</p>
    ${blokken}
    ${knop ? `<div style="text-align:center;margin:0 0 18px"><a href="${knop.link}" style="display:inline-block;background:#3A6B4A;color:white;border-radius:10px;padding:12px 28px;font-weight:700;font-size:14px;text-decoration:none">${knop.tekst}</a></div>` : ''}
    ${onder ? `<p style="margin:0;color:#7A6E62;font-size:12px;line-height:1.6">${onder}</p>` : ''}
  </div>
  <p style="text-align:center;margin-top:14px;color:#9E9587;font-size:11px">${voet}</p>
</div></body></html>`;
}
const alinea = (s: string) => `<p style="margin:0 0 18px;color:#4A3E32;font-size:14px;line-height:1.6">${s}</p>`;
const naarTekst = (html: string) => html.replace(/<br\s*\/?>/g, '\n').replace(/<\/p>/g, '\n\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();

async function stuurMail(to: string, onderwerp: string, html: string, tag: string): Promise<boolean> {
  const key = Deno.env.get('BREVO_API_KEY') ?? '';
  if (!key) return false;
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { accept: 'application/json', 'api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: { name: Deno.env.get('REMINDER_FROM_NAME') ?? 'YardiGo', email: Deno.env.get('REMINDER_FROM_EMAIL') ?? 'noreply@yardigo.nl' },
      to: [{ email: to }], subject: onderwerp, htmlContent: html, textContent: naarTekst(html), tags: ['rommelroute', tag],
    }),
  });
  if (!r.ok) console.error('brevo', r.status, (await r.text()).slice(0, 300));
  return r.ok;
}

// ── Hulp ───────────────────────────────────────────────────

type Hoofd = { id: string; title: string; date_start: string; time_start: string | null; time_end: string | null; user_id: string };

async function hoofdVan(sb: SupabaseClient, groep: string): Promise<Hoofd | null> {
  const { data } = await sb.from('listings')
    .select('id, title, date_start, time_start, time_end, user_id, confirmation_method')
    .eq('neighborhood_group_id', groep).is('confirmation_token', null)
    .order('created_at', { ascending: true }).limit(5);
  return (data || []).find((l: any) => (l.confirmation_method ?? 'self_confirmed') === 'self_confirmed') ?? null;
}

async function organisator(sb: SupabaseClient, userId: string): Promise<{ email: string; naam: string; taal: Taal } | null> {
  const p = await sb.from('profiles').select('display_name, country, is_blocked').eq('id', userId).maybeSingle();
  if (p.data?.is_blocked) return null;
  const u = await sb.auth.admin.getUserById(userId);
  const email = u.data?.user?.email;
  if (!email) return null;
  return { email, naam: (p.data?.display_name || email.split('@')[0]).split(' ')[0], taal: taalVanLand(p.data?.country ?? null) };
}

const tijd = (h: Hoofd) => h.time_start ? ', ' + h.time_start.slice(0, 5) + (h.time_end ? '–' + h.time_end.slice(0, 5) : '') : '';

// ── Cron-taken ─────────────────────────────────────────────

async function meldNieuweAanmeldingen(sb: SupabaseClient, dryRun: boolean) {
  const { data } = await sb.from('route_aanmeldingen').select('id, groep_id')
    .eq('status', 'nieuw').is('organisator_gemeld_at', null).limit(500);
  const perGroep = new Map<string, string[]>();
  for (const a of data || []) perGroep.set(a.groep_id, [...(perGroep.get(a.groep_id) || []), a.id]);
  let n = 0;
  for (const [groep, ids] of perGroep) {
    const h = await hoofdVan(sb, groep);
    const o = h && await organisator(sb, h.user_id);
    if (h && o && !dryRun) {
      const t = T[o.taal];
      const v = { n: ids.length, titel: esc(h.title), naam: esc(o.naam) };
      const html = mailHtml(vul(t.hoi, v), alinea(vul(t.nieuwTekst, v)),
        { tekst: t.nieuwKnop, link: `${SITE}/?route=${encodeURIComponent(groep)}` }, '', t.nieuwVoet);
      if (!(await stuurMail(o.email, vul(t.nieuwOnderwerp, { n: ids.length, titel: h.title }), html, 'aanmelding'))) continue;
      n++;
    }
    // Ook zonder mailbaar adres markeren: anders proberen we het elk uur opnieuw.
    if (!dryRun) await sb.from('route_aanmeldingen').update({ organisator_gemeld_at: new Date().toISOString() }).in('id', ids);
  }
  return { routes: perGroep.size, gemaild: n };
}

async function mailBuren(sb: SupabaseClient, dryRun: boolean) {
  const { data } = await sb.from('route_aanmeldingen').select('id, groep_id, token, naam, email, taal, status')
    .in('status', ['goedgekeurd', 'uitgenodigd']).not('email', 'is', null).is('buur_gemaild_at', null).limit(200);
  let ok = 0, uit = 0;
  for (const a of data || []) {
    const h = await hoofdVan(sb, a.groep_id);
    if (!h || dryRun) continue;
    const taal: Taal = isTaal(a.taal) ? a.taal : 'nl';
    const t = T[taal];
    const v = { titel: esc(h.title), datum: datum(h.date_start, taal), tijd: tijd(h), naam: esc(a.naam || '') };
    const hoi = a.naam ? vul(t.hoi, v) : t.hoiAnoniem;
    const link = `${SITE}/doe-mee?t=${a.token}&lang=${taal}`;
    let gelukt: boolean;
    if (a.status === 'goedgekeurd') {
      const html = mailHtml(hoi, alinea(vul(t.okTekst, v)), { tekst: t.okKnop, link: `${SITE}/v/${h.id}` },
        vul(t.okAfmelden, { link }), t.voetBuur);
      gelukt = await stuurMail(a.email, vul(t.okOnderwerp, { titel: h.title }), html, 'goedgekeurd');
      if (gelukt) ok++;
    } else {
      const html = mailHtml(hoi, alinea(vul(t.uitTekst, v)), { tekst: t.uitKnop, link }, t.uitNee, t.voetBuur);
      gelukt = await stuurMail(a.email, vul(t.uitOnderwerp, { titel: h.title }), html, 'uitnodiging');
      if (gelukt) uit++;
    }
    if (gelukt) await sb.from('route_aanmeldingen').update({ buur_gemaild_at: new Date().toISOString() }).eq('id', a.id);
  }
  return { goedgekeurd: ok, uitgenodigd: uit };
}

// Ochtend van de route: buren krijgen hun persoonlijke link om live te zetten
// of ze open, bijna leeg of gesloten zijn (Fase 4, live-status.sql).
async function liveOchtend(sb: SupabaseClient, dryRun: boolean) {
  const { data, error } = await sb.rpc('route_live_kandidaten');
  if (error) return { fout: error.message };
  let n = 0;
  for (const a of data || []) {
    if (dryRun) continue;
    const taal: Taal = isTaal(a.taal) ? a.taal : 'nl';
    const t = T[taal];
    const tijdTekst = a.tijd_van ? ', ' + a.tijd_van + (a.tijd_tot ? '–' + a.tijd_tot : '') : '';
    const v = { titel: esc(a.titel), tijd: tijdTekst, naam: esc(a.naam || '') };
    const hoi = a.naam ? vul(t.hoi, v) : t.hoiAnoniem;
    const html = mailHtml(hoi, alinea(vul(t.liveTekst, v)),
      { tekst: t.liveKnop, link: `${SITE}/doe-mee?t=${a.token}&lang=${taal}` }, t.liveOnder, t.voetBuur);
    // Ook bij mislukken markeren: liever één gemiste mail dan elk uur opnieuw.
    if (await stuurMail(a.email, vul(t.liveOnderwerp, { titel: a.titel }), html, 'live')) n++;
    await sb.rpc('route_live_gemaild', { p_id: a.aanmelding_id });
  }
  return { kandidaten: (data || []).length, gemaild: n };
}

async function rapporten(sb: SupabaseClient, dryRun: boolean) {
  const { data, error } = await sb.rpc('route_rapport_kandidaten');
  if (error) { console.error('rapport', error.message); return { fout: error.message }; }
  let n = 0;
  const preview: unknown[] = [];
  for (const r of data || []) {
    const s = r.stats || {};
    // Alleen een rapport als er iets te melden valt; "0 keer bekeken" motiveert niemand.
    const waard = (s.weergaven || 0) + (s.ik_ga || 0) + (s.favorieten || 0) > 0 || (s.adressen || 0) > 1;
    if (dryRun) { preview.push({ titel: r.titel, stats: s, mail: waard }); continue; }
    if (waard) {
      const o = await organisator(sb, r.organisator_id);
      if (o) {
        const t = T[o.taal];
        const rij = (getal: number, label: string) =>
          `<tr><td style="padding:6px 12px 6px 0;font-size:22px;font-weight:800;color:#E07B39;text-align:right">${getal}</td><td style="padding:6px 0;font-size:14px;color:#4A3E32">${label}</td></tr>`;
        const tabel = `<table style="margin:0 0 18px">${rij(s.weergaven || 0, t.rapWeergaven)}${rij(s.ik_ga || 0, t.rapIkGa)}${rij(s.favorieten || 0, t.rapFav)}${rij(s.adressen || 0, t.rapAdressen)}</table>`;
        const html = mailHtml(vul(t.hoi, { naam: esc(o.naam) }), alinea(vul(t.rapTekst, { titel: esc(r.titel) })) + tabel + alinea(t.rapVolgend),
          { tekst: t.rapKnop, link: `${SITE}/?route=${encodeURIComponent(r.groep_id)}` }, '', t.nieuwVoet);
        if (await stuurMail(o.email, vul(t.rapOnderwerp, { titel: r.titel }), html, 'rapport')) n++;
      }
    }
    await sb.rpc('route_rapport_gedaan', { p_groep: r.groep_id });
  }
  return { kandidaten: (data || []).length, gemaild: n, ...(dryRun ? { preview } : {}) };
}

// ── Bericht van de organisator ─────────────────────────────

async function bericht(sb: SupabaseClient, req: Request, body: any): Promise<Response> {
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const u = jwt ? await sb.auth.getUser(jwt) : null;
  const uid = u?.data?.user?.id;
  if (!uid) return json({ ok: false, reden: 'niet_ingelogd' }, 401);

  const groep = String(body.groep_id || '');
  const tekst = String(body.tekst || '').trim();
  if (tekst.length < 5 || tekst.length > 1000) return json({ ok: false, reden: 'tekst' }, 400);

  const h = await hoofdVan(sb, groep);
  if (!h || h.user_id !== uid) return json({ ok: false, reden: 'geen_toegang' }, 403);
  const grens = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  if (h.date_start < grens) return json({ ok: false, reden: 'voorbij' }, 400);

  const sinds = new Date(Date.now() - 86400000).toISOString();
  const { count } = await sb.from('route_berichten').select('id', { count: 'exact', head: true })
    .eq('groep_id', groep).gte('created_at', sinds);
  if ((count || 0) >= 3) return json({ ok: false, reden: 'limiet' }, 429);

  const { data: ontvangers } = await sb.from('route_aanmeldingen').select('token, naam, email, taal')
    .eq('groep_id', groep).eq('status', 'goedgekeurd').not('email', 'is', null);
  if (!ontvangers?.length) return json({ ok: false, reden: 'geen_ontvangers' }, 400);

  const prof = await sb.from('profiles').select('display_name').eq('id', uid).maybeSingle();
  const orgNaam = (prof.data?.display_name || '').split(' ')[0];
  const tekstHtml = esc(tekst).replace(/\n/g, '<br>');
  let n = 0;
  for (const a of ontvangers) {
    const taal: Taal = isTaal(a.taal) ? a.taal : 'nl';
    const t = T[taal];
    const v = { titel: esc(h.title), datum: datum(h.date_start, taal), org: esc(orgNaam || t.berOrg), naam: esc(a.naam || '') };
    const citaat = `<div style="margin:0 0 18px;padding:12px 14px;background:#F9F5EF;border-left:3px solid #E07B39;border-radius:6px;color:#2C2416;font-size:14px;line-height:1.6">${tekstHtml}</div>`;
    const link = `${SITE}/doe-mee?t=${a.token}&lang=${taal}`;
    const html = mailHtml(a.naam ? vul(t.hoi, v) : t.hoiAnoniem, alinea(vul(t.berIntro, v)) + citaat,
      { tekst: t.okKnop, link: `${SITE}/v/${h.id}` }, vul(t.okAfmelden, { link }), t.voetBuur);
    if (await stuurMail(a.email, vul(t.berOnderwerp, { titel: h.title }), html, 'bericht')) n++;
  }
  await sb.from('route_berichten').insert({ groep_id: groep, tekst, ontvangers: n });
  return json({ ok: true, verstuurd: n });
}

// ── Router ─────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } });

  let body: any = {};
  try { body = await req.json(); } catch (_) {}

  if (body.actie === 'bericht') return bericht(sb, req, body);

  if (!(await isCronCall(req))) return json({ error: 'Unauthorized' }, 401);
  const dryRun = body.dryRun === true;
  const uit: Record<string, unknown> = { dryRun };
  uit.aanmeldingen = await meldNieuweAanmeldingen(sb, dryRun);
  uit.buren = await mailBuren(sb, dryRun);
  uit.live = await liveOchtend(sb, dryRun);
  uit.rapporten = await rapporten(sb, dryRun);
  if (!dryRun) {
    const o = await sb.rpc('route_opruimen');
    uit.opruimen = o.error ? o.error.message : o.data;
    const l = await sb.rpc('live_status_opruimen');
    uit.live_opgeruimd = l.error ? l.error.message : l.data;
  }
  return json({ ok: true, ...uit });
});
