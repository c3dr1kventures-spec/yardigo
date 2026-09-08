// YardiGo – gedeelde push-verzendhelpers (Web Push + OneSignal)
// Gebruikt door de process-*-notifications cron-functies.

import webpush from 'npm:web-push@3.6.7'

let _configured = false
function ensureConfigured() {
  if (_configured) return
  webpush.setVapidDetails(
    Deno.env.get('VAPID_SUBJECT') ?? 'mailto:support@yardigo.nl',
    Deno.env.get('VAPID_PUBLIC_KEY') ?? '',
    Deno.env.get('VAPID_PRIVATE_KEY') ?? ''
  )
  _configured = true
}

export interface WebPushSubscription {
  endpoint: string
  p256dh: string
  auth: string
}

export interface WebPushResult {
  ok: boolean
  expired: boolean
}

// Stuurt één web push. expired=true betekent: subscription is niet meer
// geldig (410/404) en mag uit push_subscriptions verwijderd worden.
export async function sendWebPush(sub: WebPushSubscription, payload: Record<string, unknown>): Promise<WebPushResult> {
  ensureConfigured()
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    )
    return { ok: true, expired: false }
  } catch (e) {
    const statusCode = (e as { statusCode?: number })?.statusCode
    console.error('sendWebPush failed:', statusCode, (e as Error).message)
    return { ok: false, expired: statusCode === 404 || statusCode === 410 }
  }
}

// Stuurt native push via OneSignal aan een set player ids. Geeft stil `false`
// terug (geen throw) zolang ONESIGNAL_APP_ID nog niet is ingesteld, zodat de
// cron-functies werken vóórdat OneSignal is aangesloten.
export async function sendOneSignal(playerIds: string[], title: string, body: string, url: string): Promise<boolean> {
  const appId = Deno.env.get('ONESIGNAL_APP_ID') ?? ''
  const apiKey = Deno.env.get('ONESIGNAL_REST_API_KEY') ?? ''
  if (!appId || !apiKey || playerIds.length === 0) return false
  try {
    const res = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${apiKey}`,
      },
      body: JSON.stringify({
        app_id: appId,
        include_player_ids: playerIds,
        headings: { en: title, nl: title },
        contents: { en: body, nl: body },
        url,
      }),
    })
    if (!res.ok) console.error('sendOneSignal failed:', res.status, await res.text())
    return res.ok
  } catch (e) {
    console.error('sendOneSignal exception:', (e as Error).message)
    return false
  }
}

// Haversine-afstand in km tussen twee lat/lng-punten.
export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// True als "nu" (in de tijdzone van de server, UTC) binnen het stille-uren-
// venster van de gebruiker valt. Venster loopt van quiet_hours_start_min tot
// 07:00 de volgende dag (vaste eindtijd — de UI heeft vooralsnog geen aparte
// eindtijd-instelling).
export function isWithinQuietHours(quietStartMin: number | null, nowMinutesOfDay: number): boolean {
  if (quietStartMin === null || quietStartMin === undefined) return false
  const quietEndMin = 420 // 07:00
  if (quietStartMin <= quietEndMin) {
    return nowMinutesOfDay >= quietStartMin && nowMinutesOfDay < quietEndMin
  }
  // Venster loopt over middernacht heen (bv. 22:00 → 07:00)
  return nowMinutesOfDay >= quietStartMin || nowMinutesOfDay < quietEndMin
}
