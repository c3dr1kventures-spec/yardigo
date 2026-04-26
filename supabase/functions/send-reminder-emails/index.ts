// YardiGo – send-reminder-emails Edge Function
// Stuurt automatische herinneringsmails naar organisatoren van een
// buurtverkoop wanneer hun buren na 3 of 7 dagen de confirmation
// link nog niet hebben aangeklikt.
//
// Trigger: dagelijks via pg_cron (zie README onderaan dit bestand).
// Aanroep: POST /functions/v1/send-reminder-emails?type=3d
//          POST /functions/v1/send-reminder-emails?type=7d
//
// Required env:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   BREVO_API_KEY                   (Brevo transactional key)
//   REMINDER_FROM_EMAIL             (bv. noreply@yardigo.nl)
//   REMINDER_FROM_NAME              (bv. YardiGo)
//   REMINDER_BASE_URL               (bv. https://www.yardigo.nl)
//   REMINDER_CRON_SECRET            (shared secret om misbruik te voorkomen)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
}

interface PendingListing {
  listing_id: string
  address_label: string | null
  address: string | null
  token: string
}

interface ReminderRow {
  organiser_id: string
  organiser_email: string
  neighborhood_group_id: string
  buurtverkoop_title: string
  buurtverkoop_date: string
  pending_listings: PendingListing[]
  listing_ids: string[]
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  try {
    // ── Shared secret om ongeauthenticeerde calls te blokkeren ──
    const expectedSecret = Deno.env.get('REMINDER_CRON_SECRET') ?? ''
    const providedSecret = req.headers.get('x-cron-secret') ?? ''
    if (!expectedSecret || providedSecret !== expectedSecret) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }

    // ── Reminder-type bepalen ──
    const url = new URL(req.url)
    const type = (url.searchParams.get('type') ?? '3d').toLowerCase()
    if (type !== '3d' && type !== '7d') {
      return new Response(
        JSON.stringify({ error: 'type must be 3d or 7d' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }

    // ── Supabase admin client ──
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // ── Haal pending reminders op ──
    const { data, error } = await supabase.rpc('get_pending_reminders', { reminder_type: type })
    if (error) throw error
    const rows = (data ?? []) as ReminderRow[]

    const brevoApiKey = Deno.env.get('BREVO_API_KEY') ?? ''
    const fromEmail = Deno.env.get('REMINDER_FROM_EMAIL') ?? 'noreply@yardigo.nl'
    const fromName = Deno.env.get('REMINDER_FROM_NAME') ?? 'YardiGo'
    const baseUrl = (Deno.env.get('REMINDER_BASE_URL') ?? 'https://www.yardigo.nl').replace(/\/$/, '')

    let sent = 0
    let failed = 0
    const errors: string[] = []

    for (const row of rows) {
      if (!row.organiser_email) {
        failed++
        errors.push(`No email for organiser ${row.organiser_id}`)
        continue
      }

      const subject = type === '3d'
        ? `Herinnering: ${row.pending_listings.length} buren hebben nog niet bevestigd`
        : `Laatste kans: onbevestigde adressen vervallen vandaag`

      const html = buildEmailHtml(row, type, baseUrl)
      const text = buildEmailText(row, type, baseUrl)

      try {
        const res = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'api-key': brevoApiKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            sender: { name: fromName, email: fromEmail },
            to: [{ email: row.organiser_email }],
            subject,
            htmlContent: html,
            textContent: text,
            tags: ['reminder', `reminder_${type}`],
          }),
        })

        if (!res.ok) {
          const body = await res.text()
          failed++
          errors.push(`Brevo ${res.status} for ${row.organiser_email}: ${body.substring(0, 200)}`)
          continue
        }

        // Markeer als verstuurd zodat we niet dubbel mailen
        await supabase.rpc('mark_reminders_sent', {
          p_listing_ids: row.listing_ids,
          reminder_type: type,
        })

        sent++
      } catch (e) {
        failed++
        errors.push(`Exception for ${row.organiser_email}: ${(e as Error).message}`)
      }
    }

    return new Response(
      JSON.stringify({
        type,
        organisers_found: rows.length,
        sent,
        failed,
        errors: errors.slice(0, 10),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    )
  }
})

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildEmailHtml(row: ReminderRow, type: '3d' | '7d', baseUrl: string): string {
  const intro = type === '3d'
    ? `Drie dagen geleden heb je een buurtverkoop aangemaakt via YardiGo. Een aantal buren heeft hun confirmation-link nog niet aangeklikt.`
    : `Vandaag vervallen de onbevestigde adressen in je buurtverkoop. Dit is je laatste kans om hen te herinneren.`

  const items = row.pending_listings.map(p => {
    const link = `${baseUrl}/bevestig?token=${encodeURIComponent(p.token)}`
    const label = p.address_label ? escapeHtml(p.address_label) : 'Buur'
    const addr = escapeHtml(p.address ?? '(adres nog in te vullen)')
    return `<li style="margin-bottom:14px"><strong>${label}</strong> &middot; ${addr}<br><a href="${escapeHtml(link)}" style="color:#E07B39;word-break:break-all">${escapeHtml(link)}</a></li>`
  }).join('')

  const title = escapeHtml(row.buurtverkoop_title ?? 'Je buurtverkoop')

  return `<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F9F5EF;margin:0;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:white;border-radius:14px;padding:28px 26px;box-shadow:0 4px 20px rgba(0,0,0,.06)">
    <div style="font-size:11px;font-weight:700;color:#E07B39;letter-spacing:.6px;text-transform:uppercase;margin-bottom:6px">🏘️ Buurtverkoop reminder</div>
    <h1 style="font-size:22px;margin:0 0 14px;color:#2C2416">${title}</h1>
    <p style="color:#3A2E1E;line-height:1.55;margin:0 0 18px">${escapeHtml(intro)}</p>
    <p style="color:#3A2E1E;line-height:1.55;margin:0 0 10px"><strong>${row.pending_listings.length} buren</strong> wachten nog op bevestiging:</p>
    <ul style="padding:0 0 0 18px;margin:0 0 20px;color:#2C2416;line-height:1.5">${items}</ul>
    <div style="background:#FDF0E7;border-left:3px solid #E07B39;border-radius:8px;padding:12px 14px;font-size:13px;color:#7A4A2A;margin-bottom:16px">
      ${type === '3d'
        ? '💡 Stuur deze links (nogmaals) via WhatsApp of e-mail. Niet bevestigde adressen vervallen automatisch na 7 dagen.'
        : '⏰ Deze adressen worden vandaag nog automatisch gewist als er geen bevestiging binnenkomt.'}
    </div>
    <p style="color:#7A6E62;font-size:12px;line-height:1.5;margin:0">Je kunt de links ook terugvinden in YardiGo onder <strong>Mijn verkopen</strong> → klik op je buurtverkoop.</p>
  </div>
  <div style="max-width:560px;margin:12px auto 0;text-align:center;color:#7A6E62;font-size:11px">
    Deze mail is automatisch verstuurd door YardiGo omdat je zelf een buurtverkoop hebt aangemaakt.
  </div>
</body>
</html>`
}

function buildEmailText(row: ReminderRow, type: '3d' | '7d', baseUrl: string): string {
  const title = row.buurtverkoop_title ?? 'Je buurtverkoop'
  const intro = type === '3d'
    ? 'Drie dagen geleden heb je een buurtverkoop aangemaakt via YardiGo. Een aantal buren heeft de confirmation-link nog niet aangeklikt.'
    : 'Vandaag vervallen de onbevestigde adressen in je buurtverkoop. Dit is je laatste kans om hen te herinneren.'
  const items = row.pending_listings.map(p => {
    const link = `${baseUrl}/bevestig?token=${encodeURIComponent(p.token)}`
    const label = p.address_label ?? 'Buur'
    const addr = p.address ?? '(adres nog in te vullen)'
    return `- ${label} (${addr})\n  ${link}`
  }).join('\n\n')
  const footer = type === '3d'
    ? 'Niet bevestigde adressen vervallen automatisch na 7 dagen.'
    : 'Deze adressen worden vandaag automatisch gewist als er geen bevestiging binnenkomt.'
  return `${title}\n\n${intro}\n\n${row.pending_listings.length} buren wachten nog op bevestiging:\n\n${items}\n\n${footer}\n\n-- YardiGo`
}

/*
════════════════════════════════════════════════════════════════
Deploy & scheduling
════════════════════════════════════════════════════════════════

1. Deploy:
     supabase functions deploy send-reminder-emails

2. Zet de secrets in het Supabase dashboard (Edge Functions → secrets):
     BREVO_API_KEY
     REMINDER_FROM_EMAIL
     REMINDER_FROM_NAME
     REMINDER_BASE_URL
     REMINDER_CRON_SECRET

3. SQL migratie draaien:
     reminder-emails-setup.sql

4. pg_cron schedule (in Supabase SQL editor):

     -- pg_cron en pg_net extensies moeten aanstaan
     create extension if not exists pg_cron;
     create extension if not exists pg_net;

     -- Dagelijks om 10:00 UTC de 3-dagen reminder draaien
     select cron.schedule(
       'reminder-3d-daily',
       '0 10 * * *',
       $$
       select net.http_post(
         url := 'https://<PROJECT>.functions.supabase.co/send-reminder-emails?type=3d',
         headers := jsonb_build_object(
           'Content-Type', 'application/json',
           'x-cron-secret', '<REMINDER_CRON_SECRET>'
         )
       );
       $$
     );

     -- Dagelijks om 10:05 UTC de 7-dagen reminder draaien
     select cron.schedule(
       'reminder-7d-daily',
       '5 10 * * *',
       $$
       select net.http_post(
         url := 'https://<PROJECT>.functions.supabase.co/send-reminder-emails?type=7d',
         headers := jsonb_build_object(
           'Content-Type', 'application/json',
           'x-cron-secret', '<REMINDER_CRON_SECRET>'
         )
       );
       $$
     );

5. Testen (lokaal):
     curl -X POST \
       -H "x-cron-secret: $REMINDER_CRON_SECRET" \
       'https://<PROJECT>.functions.supabase.co/send-reminder-emails?type=3d'

════════════════════════════════════════════════════════════════
*/
