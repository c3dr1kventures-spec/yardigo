// YardiGo – process-notifications Edge Function
// Verstuurt daadwerkelijk de 4 notificatietypen uit de "Meldingen"-instellingen
// (index.html), die daarvoor alleen decoratieve UI waren zonder enige
// backend-verwerking. Wordt per job aangeroepen via pg_cron (zie onderaan).
//
// Aanroep: POST /functions/v1/process-notifications?job=nearby
//          POST /functions/v1/process-notifications?job=category_direct
//          POST /functions/v1/process-notifications?job=favorites
//          POST /functions/v1/process-notifications?job=morning_route
//          POST /functions/v1/process-notifications?job=digest_daily
//          POST /functions/v1/process-notifications?job=digest_weekly
//
// Required env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT   (web push)
//   ONESIGNAL_APP_ID, ONESIGNAL_REST_API_KEY             (native push, optioneel totdat aangesloten)
//   NOTIF_CRON_SECRET                                    (shared secret, zelfde patroon als send-reminder-emails)
//   NOTIF_BASE_URL                                        (bv. https://www.yardigo.nl)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { sendWebPush, sendOneSignal, distanceKm, isWithinQuietHours } from '../_shared/push.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
}

// UI-categorieën ↔ DB-category kolomwaarden (zelfde mapping als index.html:4133-4135)
const TYPE_TO_CATEGORIES: Record<string, string[]> = {
  particulier: ['garagesale', 'garageverkoop', 'overig'],
  buurt: ['buurtverkoop'],
  evenement: ['rommelmarkt', 'vlooienmarkt', 'kofferbakverkoop'],
}
function categoriesForTypes(types: string[]): string[] {
  const out = new Set<string>()
  for (const t of types) for (const c of TYPE_TO_CATEGORIES[t] ?? []) out.add(c)
  return [...out]
}

function nowInAmsterdam(): Date {
  // Server draait in UTC; reken om naar Europe/Amsterdam voor dag/tijd-checks.
  const s = new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' })
  return new Date(s)
}
function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes()
}
const DAY_CODES = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za']

interface Listing {
  id: string
  title: string
  category: string
  latitude: number | null
  longitude: number | null
  tags: string[] | null
  date_start: string
  time_start: string | null
  user_id: string
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

  const expectedSecret = Deno.env.get('NOTIF_CRON_SECRET') ?? ''
  const providedSecret = req.headers.get('x-cron-secret') ?? ''
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    })
  }

  const url = new URL(req.url)
  const job = url.searchParams.get('job') ?? ''
  const baseUrl = (Deno.env.get('NOTIF_BASE_URL') ?? 'https://www.yardigo.nl').replace(/\/$/, '')

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  try {
    let result: Record<string, unknown>
    switch (job) {
      case 'nearby': result = await runNearby(supabase, baseUrl, 'direct'); break
      case 'category_direct': result = await runCategoryAlerts(supabase, baseUrl, 'direct'); break
      case 'favorites': result = await runFavorites(supabase, baseUrl); break
      case 'morning_route': result = await runMorningRoute(supabase, baseUrl); break
      case 'digest_daily':
        result = {
          nearby: await runNearby(supabase, baseUrl, 'dagelijks'),
          category: await runCategoryAlerts(supabase, baseUrl, 'dagelijks'),
        }
        break
      case 'digest_weekly':
        result = { category: await runCategoryAlerts(supabase, baseUrl, 'wekelijks') }
        break
      default:
        return new Response(JSON.stringify({ error: 'Onbekende of ontbrekende job-parameter' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        })
    }
    return new Response(JSON.stringify({ job, ...result }), {
      status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    })
  } catch (err) {
    console.error(`process-notifications job=${job} failed:`, err)
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    })
  }
})

// Stuurt een push (web + native) naar één gebruiker en logt het resultaat.
// listingId mag null zijn voor niet-listing-gebonden meldingen (ochtendroute) —
// dedupe daarvoor gebeurt op datum door de aanroeper, niet via deze functie.
async function pushToUser(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  title: string,
  body: string,
  url: string
): Promise<boolean> {
  let sentAny = false

  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', userId)
  for (const sub of subs ?? []) {
    const res = await sendWebPush({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, { title, body, url })
    if (res.ok) sentAny = true
    if (res.expired) await supabase.from('push_subscriptions').delete().eq('id', sub.id)
  }

  const { data: tokens } = await supabase
    .from('device_tokens')
    .select('onesignal_player_id')
    .eq('user_id', userId)
  const playerIds = (tokens ?? []).map((t) => t.onesignal_player_id)
  if (playerIds.length) {
    const ok = await sendOneSignal(playerIds, title, body, url)
    if (ok) sentAny = true
  }

  return sentAny
}

async function runNearby(supabase: ReturnType<typeof createClient>, baseUrl: string, timing: 'direct' | 'dagelijks') {
  const sinceMinutes = timing === 'direct' ? 20 : 60 * 26 // dagelijkse job draait 1x/24u, marge van 2u
  const since = new Date(Date.now() - sinceMinutes * 60000).toISOString()

  const { data: listings } = await supabase
    .from('listings')
    .select('id, title, category, latitude, longitude, tags, date_start, time_start, user_id')
    .eq('status', 'active')
    .gte('created_at', since)
    .limit(200)
  if (!listings?.length) return { new_listings: 0, notified: 0 }

  const { data: prefs } = await supabase
    .from('notification_preferences')
    .select('user_id, nearby_radius_km, nearby_types, quiet_hours_start_min')
    .eq('master_enabled', true)
    .eq('nearby_enabled', true)
    .eq('nearby_timing', timing)
  if (!prefs?.length) return { new_listings: listings.length, notified: 0 }

  const userIds = prefs.map((p) => p.user_id)
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, home_lat, home_lng')
    .in('id', userIds)
    .not('home_lat', 'is', null)
  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]))

  const now = nowInAmsterdam()
  const nowMin = minutesOfDay(now)
  let notified = 0

  for (const listing of (listings as Listing[])) {
    if (listing.latitude === null || listing.longitude === null) continue
    for (const pref of prefs) {
      const profile = profileById.get(pref.user_id)
      if (!profile) continue
      if (!categoriesForTypes(pref.nearby_types ?? []).includes(listing.category)) continue
      if (isWithinQuietHours(pref.quiet_hours_start_min, nowMin)) continue
      const dist = distanceKm(profile.home_lat, profile.home_lng, listing.latitude, listing.longitude)
      if (dist > pref.nearby_radius_km) continue

      const { data: already } = await supabase
        .from('notification_log')
        .select('id')
        .eq('user_id', pref.user_id)
        .eq('notif_type', 'nearby')
        .eq('listing_id', listing.id)
        .maybeSingle()
      if (already) continue

      const sent = await pushToUser(
        supabase, pref.user_id,
        'Nieuwe verkoop bij jou in de buurt! 🏠',
        `${listing.title} · ${Math.round(dist * 10) / 10} km van jou`,
        `${baseUrl}/v/${listing.id}`
      )
      if (sent) {
        notified++
        await supabase.from('notification_log').insert({ user_id: pref.user_id, notif_type: 'nearby', listing_id: listing.id })
      }
    }
  }
  return { new_listings: listings.length, notified }
}

async function runCategoryAlerts(supabase: ReturnType<typeof createClient>, baseUrl: string, freq: 'direct' | 'dagelijks' | 'wekelijks') {
  const sinceMinutes = freq === 'direct' ? 20 : freq === 'dagelijks' ? 60 * 26 : 60 * 24 * 8
  const since = new Date(Date.now() - sinceMinutes * 60000).toISOString()

  const { data: listings } = await supabase
    .from('listings')
    .select('id, title, category, latitude, longitude, tags, date_start, time_start, user_id')
    .eq('status', 'active')
    .gte('created_at', since)
    .limit(300)
  if (!listings?.length) return { new_listings: 0, notified: 0 }

  const { data: prefs } = await supabase
    .from('notification_preferences')
    .select('user_id, category_alerts_categories, category_alerts_radius_km, quiet_hours_start_min')
    .eq('master_enabled', true)
    .eq('category_alerts_enabled', true)
    .eq('category_alerts_freq', freq)
  if (!prefs?.length) return { new_listings: listings.length, notified: 0 }

  const userIds = prefs.map((p) => p.user_id)
  const { data: profiles } = await supabase
    .from('profiles').select('id, home_lat, home_lng').in('id', userIds).not('home_lat', 'is', null)
  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]))
  const now = nowInAmsterdam()
  const nowMin = minutesOfDay(now)
  let notified = 0

  for (const listing of (listings as Listing[])) {
    if (listing.latitude === null || listing.longitude === null) continue
    const tags = listing.tags ?? []
    for (const pref of prefs) {
      const cats = pref.category_alerts_categories ?? []
      if (!cats.some((c: string) => tags.some((t: string) => t.toLowerCase().includes(c.toLowerCase())))) continue
      const profile = profileById.get(pref.user_id)
      if (!profile) continue
      if (freq === 'direct' && isWithinQuietHours(pref.quiet_hours_start_min, nowMin)) continue
      const dist = distanceKm(profile.home_lat, profile.home_lng, listing.latitude, listing.longitude)
      if (dist > pref.category_alerts_radius_km) continue

      const { data: already } = await supabase
        .from('notification_log').select('id')
        .eq('user_id', pref.user_id).eq('notif_type', 'category_alert').eq('listing_id', listing.id).maybeSingle()
      if (already) continue

      const sent = await pushToUser(
        supabase, pref.user_id,
        'Nieuw in een categorie die je volgt 🏷️',
        `${listing.title} · ${Math.round(dist * 10) / 10} km van jou`,
        `${baseUrl}/v/${listing.id}`
      )
      if (sent) {
        notified++
        await supabase.from('notification_log').insert({ user_id: pref.user_id, notif_type: 'category_alert', listing_id: listing.id })
      }
    }
  }
  return { new_listings: listings.length, notified }
}

async function runFavorites(supabase: ReturnType<typeof createClient>, baseUrl: string) {
  const { data: prefs } = await supabase
    .from('notification_preferences')
    .select('user_id, favorites_advance_min')
    .eq('master_enabled', true)
    .eq('favorites_enabled', true)
  if (!prefs?.length) return { candidates: 0, notified: 0 }

  const userIds = prefs.map((p) => p.user_id)
  const { data: favorites } = await supabase
    .from('favorites')
    .select('user_id, listing_id, listings(id, title, date_start, time_start, latitude, longitude)')
    .in('user_id', userIds)
  if (!favorites?.length) return { candidates: 0, notified: 0 }

  const now = new Date()
  let notified = 0

  for (const fav of favorites as unknown as Array<{ user_id: string; listing_id: string; listings: Listing }>) {
    const listing = fav.listings
    if (!listing?.date_start || !listing.time_start) continue
    const start = new Date(`${listing.date_start}T${listing.time_start}`)
    const minutesUntil = (start.getTime() - now.getTime()) / 60000
    const pref = prefs.find((p) => p.user_id === fav.user_id)
    if (!pref) continue
    // Cron draait elke ~10 min: venster = [advance-10, advance] zodat elke sale precies 1x matcht
    if (minutesUntil > pref.favorites_advance_min || minutesUntil < pref.favorites_advance_min - 10) continue

    const { data: already } = await supabase
      .from('notification_log').select('id')
      .eq('user_id', fav.user_id).eq('notif_type', 'favorites').eq('listing_id', listing.id).maybeSingle()
    if (already) continue

    const sent = await pushToUser(
      supabase, fav.user_id,
      'Bijna tijd voor je favoriet! ⭐',
      `${listing.title} begint over ${Math.round(minutesUntil)} minuten`,
      `${baseUrl}/v/${listing.id}`
    )
    if (sent) {
      notified++
      await supabase.from('notification_log').insert({ user_id: fav.user_id, notif_type: 'favorites', listing_id: listing.id })
    }
  }
  return { candidates: favorites.length, notified }
}

async function runMorningRoute(supabase: ReturnType<typeof createClient>, baseUrl: string) {
  const now = nowInAmsterdam()
  const today = DAY_CODES[now.getDay()]
  const nowMin = minutesOfDay(now)

  const { data: prefs } = await supabase
    .from('notification_preferences')
    .select('user_id, morning_route_time_min, morning_route_days, morning_route_send_when')
    .eq('master_enabled', true)
    .eq('morning_route_enabled', true)
  if (!prefs?.length) return { candidates: 0, notified: 0 }

  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)
  let notified = 0

  for (const pref of prefs) {
    if (!(pref.morning_route_days ?? []).includes(today)) continue
    // Cron draait elke ~15 min: venster = [tijd-15, tijd]
    if (nowMin > pref.morning_route_time_min || nowMin < pref.morning_route_time_min - 15) continue

    const { data: alreadyToday } = await supabase
      .from('notification_log').select('id')
      .eq('user_id', pref.user_id).eq('notif_type', 'morning_route')
      .gte('sent_at', todayStart.toISOString())
      .maybeSingle()
    if (alreadyToday) continue

    let favCount = 0
    if (pref.morning_route_send_when === 'favorieten') {
      const { count } = await supabase
        .from('favorites')
        .select('listing_id, listings!inner(date_start)', { count: 'exact', head: true })
        .eq('user_id', pref.user_id)
        .eq('listings.date_start', todayStart.toISOString().slice(0, 10))
      favCount = count ?? 0
      if (favCount === 0) continue
    }

    const body = pref.morning_route_send_when === 'favorieten'
      ? `Je hebt vandaag ${favCount} favoriet${favCount === 1 ? '' : 'en'} gepland`
      : 'Bekijk de route langs de verkopen van vandaag'
    const sent = await pushToUser(supabase, pref.user_id, 'Goedemorgen! Je route van vandaag 🌅', body, `${baseUrl}/`)
    if (sent) {
      notified++
      await supabase.from('notification_log').insert({ user_id: pref.user_id, notif_type: 'morning_route', listing_id: null })
    }
  }
  return { candidates: prefs.length, notified }
}

/*
pg_cron schedule (Supabase SQL editor, na deploy van deze functie):

  create extension if not exists pg_cron;
  create extension if not exists pg_net;

  -- Direct: elke 10 min, dekt nearby (timing=direct), category_alerts (freq=direct), favorites
  select cron.schedule('notif-nearby', '*/10 * * * *', $$
    select net.http_post(
      url := 'https://<PROJECT>.functions.supabase.co/process-notifications?job=nearby',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<NOTIF_CRON_SECRET>')
    );
  $$);
  select cron.schedule('notif-category-direct', '*/10 * * * *', $$
    select net.http_post(
      url := 'https://<PROJECT>.functions.supabase.co/process-notifications?job=category_direct',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<NOTIF_CRON_SECRET>')
    );
  $$);
  select cron.schedule('notif-favorites', '*/10 * * * *', $$
    select net.http_post(
      url := 'https://<PROJECT>.functions.supabase.co/process-notifications?job=favorites',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<NOTIF_CRON_SECRET>')
    );
  $$);

  -- Ochtendroute: elke 15 min (venster vangt de per-gebruiker ingestelde tijd op)
  select cron.schedule('notif-morning-route', '*/15 * * * *', $$
    select net.http_post(
      url := 'https://<PROJECT>.functions.supabase.co/process-notifications?job=morning_route',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<NOTIF_CRON_SECRET>')
    );
  $$);

  -- Dagelijkse digest: nearby (timing=dagelijks) + category_alerts (freq=dagelijks), 08:00 CEST ≈ 06:00 UTC
  select cron.schedule('notif-digest-daily', '0 6 * * *', $$
    select net.http_post(
      url := 'https://<PROJECT>.functions.supabase.co/process-notifications?job=digest_daily',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<NOTIF_CRON_SECRET>')
    );
  $$);

  -- Wekelijkse digest: category_alerts (freq=wekelijks), maandag 08:00 CEST ≈ 06:00 UTC
  select cron.schedule('notif-digest-weekly', '0 6 * * 1', $$
    select net.http_post(
      url := 'https://<PROJECT>.functions.supabase.co/process-notifications?job=digest_weekly',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<NOTIF_CRON_SECRET>')
    );
  $$);
*/
