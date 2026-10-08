// YardiGo – gedeelde publiceer-logica voor curated events
//
// Eén plek die bepaalt of een pending_event zonder menselijke blik live mag,
// en die het daadwerkelijk publiceert. Gebruikt door import-meukisleuk en
// telegram-bot (en later eventueel discover-events).
//
// Harde regels voor automatisch publiceren — álle moeten kloppen:
//   1. datum vandaag of later
//   2. coördinaten aanwezig
//   3. AI zegt: past bij YardiGo (tweedehands-markt, geen winkel/beurs voor nieuw)
//   4. geen particuliere verkoop (die gaan als 'tip' naar Telegram)
//   5. er is een contactweg: website/FB-pagina van de organisator of telefoon
//   6. titel aanwezig
// Dubbele events zijn vóór het aanmaken van de pending-rij al uitgefilterd.
//
// Bronvermelding: de verzamelsite (lead) komt NOOIT in de listing. Alleen de
// website van de organisator, of niets.

export interface PendingLike {
  id: number;
  title: string | null;
  description: string | null;
  event_subtype: string | null;
  date_start: string | null;
  date_end: string | null;
  time_start: string | null;
  time_end: string | null;
  city: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  organizer_name: string | null;
  organizer_url: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  is_private_seller: boolean | null;
  raw_ai_response?: any;
}

export interface AutoCheck {
  ok: boolean;
  redenen: string[];
  checked_at: string;
}

export function autoCheck(p: PendingLike, pastBijYardigo: boolean): AutoCheck {
  const redenen: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  if (!p.title || !p.title.trim())                      redenen.push('geen titel');
  if (!p.date_start || p.date_start < today)            redenen.push('datum ontbreekt of voorbij');
  if (p.latitude == null || p.longitude == null)        redenen.push('geen coördinaten');
  if (!pastBijYardigo)                                  redenen.push('past niet bij YardiGo');
  if (p.is_private_seller === true)                     redenen.push('particuliere verkoop');
  if (p.is_private_seller == null)                      redenen.push('onbekend of particulier');
  if (!p.organizer_url && !p.contact_phone && !p.contact_email) redenen.push('geen contactweg');
  return { ok: redenen.length === 0, redenen, checked_at: new Date().toISOString() };
}

// Eerste admin-profiel als eigenaar/curator van automatisch geplaatste
// listings. De listing-triggers laten admins onbeperkt plaatsen.
let curatorCache: string | null = null;
export async function curatorId(sb: any): Promise<string | null> {
  if (curatorCache) return curatorCache;
  const r = await sb.from('profiles').select('id').eq('is_admin', true).limit(1).maybeSingle();
  curatorCache = r.data?.id ?? null;
  return curatorCache;
}

// Zet een pending_event om in een actieve listing + contactrij.
// Geeft het listing-id terug, of gooit een Error.
export async function publishPending(sb: any, p: PendingLike, reviewer: string | null, autoInfo: AutoCheck | null): Promise<string> {
  const curator = await curatorId(sb);
  if (!curator) throw new Error('geen admin-profiel gevonden als curator');

  const payload = {
    placed_by:           'yardigo',
    status:              'active',
    confirmation_status: 'confirmed',
    category:            'rommelmarkt',
    event_subtype:       p.event_subtype || 'rommelmarkt',
    title:               p.title,
    description:         p.description,
    city:                p.city,
    address:             p.address || p.city || '—',
    date_start:          p.date_start,
    date_end:            p.date_end,
    time_start:          p.time_start,
    time_end:            p.time_end,
    latitude:            p.latitude,
    longitude:           p.longitude,
    source_url:          p.organizer_url || null,
    source_label:        p.organizer_name || null,
    address_reveal_mode: 'instant',
    images:              [],
    user_id:             curator,
    curator_user_id:     reviewer || curator,
  };
  const ins = await sb.from('listings').insert(payload).select('id').single();
  if (ins.error) throw new Error('listing insert: ' + ins.error.message);
  const listingId = ins.data.id as string;

  if (p.organizer_url || p.contact_phone || p.contact_email || p.organizer_name) {
    const c = await sb.from('listing_contacts').upsert({
      listing_id:     listingId,
      organizer_name: p.organizer_name,
      website_url:    p.organizer_url,
      email:          p.contact_email,
      phone:          p.contact_phone,
    }, { onConflict: 'listing_id' });
    if (c.error) throw new Error('contact insert: ' + c.error.message);
  }

  const up = await sb.from('pending_events').update({
    status:              'goedgekeurd',
    reviewer_user_id:    reviewer,
    reviewed_at:         new Date().toISOString(),
    approved_listing_id: listingId,
    review_notes:        reviewer ? null : 'automatisch gepubliceerd',
    ...(autoInfo ? { auto_check: autoInfo } : {}),
  }).eq('id', p.id);
  if (up.error) throw new Error('pending update: ' + up.error.message);

  return listingId;
}
