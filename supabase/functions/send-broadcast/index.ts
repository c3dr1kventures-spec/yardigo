// YardiGo – send-broadcast Edge Function v4
// Stuurt een e-mail naar alle gebruikers met de bijbehorende opt-in,
// optioneel gefilterd op country.
//
// type 'service' (default) → marketing_email_opt_in = TRUE
//   unsubscribe: /?uitschrijven=1&token=<uuid>
//
// type 'promo' → promo_email_opt_in = TRUE
//   unsubscribe: /?uitschrijven-promo=1&token=<uuid>
//
// Aanroep (POST, JSON):
//   {
//     "subject": "Onderwerp",
//     "body":    "Berichttekst (plain, \\n wordt <p>)",
//     "country": "NL" | "BE" | "all",
//     "type":    "service" | "promo"   (default: "service")
//     "dry_run": false                 (optioneel — telt alleen ontvangers)
//   }
//
// Auth: Bearer JWT van een ingelogde admin (profiles.is_admin = true).
// verify_jwt staat op false zodat we zelf duidelijke 401/403 messages geven.
//
// Required env:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY
//   BROADCAST_FROM_EMAIL   (default: 'YardiGo <info@mail.yardigo.nl>')
//   BROADCAST_BASE_URL     (default: 'https://www.yardigo.nl')

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface BroadcastRequest {
  subject?: string
  body?: string
  country?: string
  type?: string
  dry_run?: boolean
}

interface Recipient {
  id: string
  email: string
  display_name: string | null
  unsubscribe_token: string
  country: string | null
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    if (!supabaseUrl || !serviceKey) {
      return json({ error: 'Server misconfigured: SUPABASE env missing' }, 500)
    }

    // ── Auth: bearer JWT van een admin ──
    const authHeader = req.headers.get('Authorization') ?? ''
    const match = authHeader.match(/^Bearer\s+(.+)$/i)
    if (!match) {
      return json({ error: 'Missing Authorization Bearer token' }, 401)
    }
    const jwt = match[1]

    const adminClient = createClient(supabaseUrl, serviceKey)

    const userRes = await adminClient.auth.getUser(jwt)
    if (userRes.error || !userRes.data?.user) {
      return json({ error: 'Invalid token' }, 401)
    }
    const callerId = userRes.data.user.id

    const profRes = await adminClient
      .from('profiles')
      .select('is_admin, admin_badges')
      .eq('id', callerId)
      .maybeSingle()
    if (profRes.error) {
      return json({ error: 'Cannot verify admin: ' + profRes.error.message }, 500)
    }
    const isAdmin = profRes.data?.is_admin === true
    const badges = parseBadges(profRes.data?.admin_badges)
    if (!isAdmin && !badges.includes('admin')) {
      return json({ error: 'Forbidden: admin role required' }, 403)
    }

    // ── Body parsen ──
    let payload: BroadcastRequest
    try {
      payload = await req.json()
    } catch {
      return json({ error: 'Invalid JSON body' }, 400)
    }
    const subject = (payload.subject ?? '').trim()
    const body = (payload.body ?? '').trim()
    const country = (payload.country ?? 'all').toUpperCase()
    const broadcastType = (payload.type ?? 'service').toLowerCase()
    const dryRun = payload.dry_run === true

    if (!subject) return json({ error: 'subject is required' }, 400)
    if (!body) return json({ error: 'body is required' }, 400)
    if (!['ALL', 'NL', 'BE'].includes(country)) {
      return json({ error: 'country must be all, NL or BE' }, 400)
    }
    if (!['service', 'promo'].includes(broadcastType)) {
      return json({ error: 'type must be service or promo' }, 400)
    }

    // ── Opt-in kolom bepalen obv type ──
    const optInColumn = broadcastType === 'promo' ? 'promo_email_opt_in' : 'marketing_email_opt_in'
    const unsubParam  = broadcastType === 'promo' ? 'uitschrijven-promo' : 'uitschrijven'

    // ── Ontvangers ophalen ──
    let q = adminClient
      .from('profiles')
      .select('id, display_name, unsubscribe_token, country')
      .eq(optInColumn, true)
    if (country !== 'ALL') q = q.eq('country', country)

    const profsRes = await q
    if (profsRes.error) {
      return json({ error: 'Cannot list profiles: ' + profsRes.error.message }, 500)
    }

    const profiles = profsRes.data ?? []
    if (profiles.length === 0) {
      return json({ recipients: 0, sent: 0, failed: 0, dry_run: dryRun, country, type: broadcastType, errors: [] }, 200)
    }

    // E-mails resolven via auth admin
    const recipients: Recipient[] = []
    for (const p of profiles) {
      const u = await adminClient.auth.admin.getUserById(p.id)
      if (u.error || !u.data?.user?.email) continue
      recipients.push({
        id: p.id,
        email: u.data.user.email,
        display_name: p.display_name,
        unsubscribe_token: p.unsubscribe_token,
        country: p.country,
      })
    }

    if (dryRun) {
      return json({
        recipients: recipients.length,
        sent: 0,
        failed: 0,
        dry_run: true,
        country,
        type: broadcastType,
        errors: [],
      }, 200)
    }

    // ── Resend ──
    const resendKey = Deno.env.get('RESEND_API_KEY') ?? ''
    if (!resendKey) {
      return json({ error: 'Server misconfigured: RESEND_API_KEY missing' }, 500)
    }
    const fromAddr = Deno.env.get('BROADCAST_FROM_EMAIL') ?? 'YardiGo <info@mail.yardigo.nl>'
    const baseUrl = (Deno.env.get('BROADCAST_BASE_URL') ?? 'https://www.yardigo.nl').replace(/\/$/, '')

    let sent = 0
    let failed = 0
    const errors: string[] = []

    for (const r of recipients) {
      const unsubUrl = `${baseUrl}/?${unsubParam}=1&token=${encodeURIComponent(r.unsubscribe_token)}`
      const html = buildHtml({
        subject,
        body,
        displayName: r.display_name,
        unsubUrl,
        broadcastType,
      })
      const text = buildText({ subject, body, unsubUrl, broadcastType })

      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: fromAddr,
            to: [r.email],
            subject,
            html,
            text,
            headers: {
              'List-Unsubscribe': `<${unsubUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
          }),
        })
        if (!res.ok) {
          const txt = await res.text()
          failed++
          errors.push(`Resend ${res.status} for ${r.email}: ${txt.substring(0, 180)}`)
          continue
        }
        sent++
      } catch (e) {
        failed++
        errors.push(`Exception for ${r.email}: ${(e as Error).message}`)
      }
    }

    return json({
      recipients: recipients.length,
      sent,
      failed,
      dry_run: false,
      country,
      type: broadcastType,
      errors: errors.slice(0, 10),
    }, 200)
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

function parseBadges(raw: unknown): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw === 'string') {
    try {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return arr.map(String)
    } catch {}
    return []
  }
  return []
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function bodyToHtml(body: string): string {
  return body
    .split(/\n\s*\n/)
    .map(p => `<p style="margin:0 0 14px;color:#2C2416;line-height:1.6;font-size:15px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

function buildHtml(opts: {
  subject: string
  body: string
  displayName: string | null
  unsubUrl: string
  broadcastType: string
}): string {
  const name = opts.displayName ? escapeHtml(opts.displayName.split(' ')[0]) : 'daar'
  const isPromo = opts.broadcastType === 'promo'
  const headerLabel = isPromo ? 'YardiGo tips' : 'YardiGo update'
  const footerLine1 = isPromo
    ? 'Je ontvangt deze e-mail omdat je hebt aangegeven tips over verkopen bij jou in de buurt te willen ontvangen.'
    : 'Je ontvangt deze e-mail omdat je in je YardiGo-instellingen hebt aangegeven service-updates per e-mail te willen ontvangen.'
  const footerLine2 = isPromo
    ? 'Je kunt dit op elk moment uitzetten via <em>Mijn → Instellingen → E-mail voorkeuren</em> of via de link hieronder.'
    : 'Je kunt dit op elk moment uitzetten via <em>Mijn → Instellingen → Meldingen</em> of via de link hieronder.'
  const unsubLabel = isPromo ? 'Uitschrijven voor YardiGo herinneringen' : 'Uitschrijven voor YardiGo updates'

  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#F9F5EF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:24px 12px">
    <div style="background:#E07B39;border-radius:14px 14px 0 0;padding:22px 26px;text-align:left">
      <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,.85);letter-spacing:.6px;text-transform:uppercase;margin-bottom:4px">${escapeHtml(headerLabel)}</div>
      <div style="font-size:22px;font-weight:800;color:white;letter-spacing:-.3px">YardiGo</div>
      <div style="font-size:12px;color:rgba(255,255,255,.85);margin-top:2px">Garagesales bij jou in de buurt</div>
    </div>
    <div style="background:white;border-radius:0 0 14px 14px;padding:28px 26px;box-shadow:0 4px 20px rgba(0,0,0,.06)">
      <h1 style="font-size:20px;margin:0 0 16px;color:#2C2416;line-height:1.3">${escapeHtml(opts.subject)}</h1>
      <p style="margin:0 0 14px;color:#2C2416;line-height:1.6;font-size:15px">Hoi ${name},</p>
      ${bodyToHtml(opts.body)}
      <p style="margin:24px 0 0;color:#7A6E62;font-size:13px;line-height:1.5">Veel zoek- en verkoopplezier,<br><strong>Het YardiGo-team</strong></p>
    </div>
    <div style="text-align:center;color:#7A6E62;font-size:11px;line-height:1.6;margin-top:18px;padding:0 14px">
      ${footerLine1}<br>
      ${footerLine2}<br>
      <a href="${escapeHtml(opts.unsubUrl)}" style="color:#7A6E62;text-decoration:underline">${unsubLabel}</a>
    </div>
  </div>
</body>
</html>`
}

function buildText(opts: {
  subject: string
  body: string
  unsubUrl: string
  broadcastType: string
}): string {
  const isPromo = opts.broadcastType === 'promo'
  const footerNote = isPromo
    ? 'Je ontvangt deze e-mail omdat je hebt aangegeven tips over verkopen bij jou in de buurt te willen ontvangen. Uitschrijven:'
    : 'Je ontvangt deze e-mail omdat je in je YardiGo-instellingen service-updates per e-mail hebt aangezet. Uitschrijven:'
  return `${opts.subject}\n\n${opts.body}\n\n— Het YardiGo-team\n\n${footerNote} ${opts.unsubUrl}`
}
