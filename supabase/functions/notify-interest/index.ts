// YardiGo – notify-interest Edge Function
// Mailt de organisator van een verkoop wanneer iemand op "Ik ga erheen!" klikt,
// mits de organisator dit aan heeft staan (profiles.notify_interest_email).
// Deze functie werd al aangeroepen vanuit index.html (notifyOrganizerInterest)
// maar bestond niet — resultaat: interesse-meldingen gingen altijd verloren.
//
// Deploy: supabase functions deploy notify-interest
//
// Required env:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//   BREVO_API_KEY, REMINDER_FROM_EMAIL, REMINDER_FROM_NAME, REMINDER_BASE_URL
//   (hergebruikt dezelfde Brevo-secrets als send-reminder-emails)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Geen geldig autorisatie-token' }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }

    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )
    const { data: { user: interestedUser }, error: userError } = await supabaseUser.auth.getUser()
    if (userError || !interestedUser) {
      return new Response(
        JSON.stringify({ error: 'Gebruiker niet gevonden of sessie verlopen' }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }

    const body = await req.json()
    const listingId = body?.listing_id as string
    if (!listingId) {
      return new Response(
        JSON.stringify({ error: 'listing_id is verplicht' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const { data: listing, error: listingError } = await supabaseAdmin
      .from('listings')
      .select('id, title, user_id')
      .eq('id', listingId)
      .maybeSingle()

    if (listingError || !listing) {
      return new Response(
        JSON.stringify({ error: 'Verkoop niet gevonden' }),
        { status: 404, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }

    // Je eigen interesse in je eigen verkoop levert geen mail op
    if (listing.user_id === interestedUser.id) {
      return new Response(JSON.stringify({ ok: true, skipped: 'self' }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      })
    }

    const { data: organiserProfile } = await supabaseAdmin
      .from('profiles')
      .select('notify_interest_email, display_name')
      .eq('id', listing.user_id)
      .maybeSingle()

    // Standaard aan (matcht de default in de settings-UI) tenzij expliciet uitgezet
    if (organiserProfile?.notify_interest_email === false) {
      return new Response(JSON.stringify({ ok: true, skipped: 'opted_out' }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      })
    }

    // Anti-spam: één specifieke persoon kan maar 1x per listing ooit een mail
    // veroorzaken, ongeacht hoe vaak diegene "Ik ga erheen" aan/uit toggelt
    // (elke toggle is een delete+insert in listing_interests, en zonder deze
    // check triggerde elke insert opnieuw een e-mail).
    const { error: dedupError } = await supabaseAdmin
      .from('interest_email_log')
      .insert({ listing_id: listing.id, interested_user_id: interestedUser.id })
    if (dedupError) {
      if (dedupError.code === '23505') {
        return new Response(JSON.stringify({ ok: true, skipped: 'already_notified' }), {
          status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        })
      }
      console.error('notify-interest dedup insert error:', dedupError)
      // Onverwachte DB-fout: mail alsnog versturen (fail-open), dedup is een
      // extra beschermlaag, geen kernvereiste voor de feature zelf.
    }

    const { data: organiserUser } = await supabaseAdmin.auth.admin.getUserById(listing.user_id)
    const organiserEmail = organiserUser?.user?.email
    if (!organiserEmail) {
      return new Response(JSON.stringify({ ok: true, skipped: 'no_email' }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      })
    }

    const brevoApiKey = Deno.env.get('BREVO_API_KEY') ?? ''
    const fromEmail = Deno.env.get('REMINDER_FROM_EMAIL') ?? 'noreply@yardigo.nl'
    const fromName = Deno.env.get('REMINDER_FROM_NAME') ?? 'YardiGo'
    const baseUrl = (Deno.env.get('REMINDER_BASE_URL') ?? 'https://www.yardigo.nl').replace(/\/$/, '')

    const title = escapeHtml(listing.title ?? 'jouw verkoop')
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2>🎉 Iemand heeft interesse!</h2>
        <p>Iemand heeft aangegeven dat ze naar <strong>${title}</strong> toe gaan.</p>
        <p><a href="${baseUrl}/v/${listing.id}" style="display:inline-block;background:#3F6B4A;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none">Bekijk je verkoop</a></p>
        <p style="color:#888;font-size:12px">Je kunt deze meldingen uitzetten in je YardiGo-instellingen onder Meldingen.</p>
      </div>`
    const text = `Iemand heeft interesse in ${title}. Bekijk: ${baseUrl}/v/${listing.id}`

    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': brevoApiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: fromName, email: fromEmail },
        to: [{ email: organiserEmail }],
        subject: `Iemand gaat naar "${listing.title}"!`,
        htmlContent: html,
        textContent: text,
        tags: ['notify-interest'],
      }),
    })

    if (!res.ok) {
      const errBody = await res.text()
      console.error('notify-interest Brevo error:', res.status, errBody)
      return new Response(
        JSON.stringify({ error: 'E-mail versturen mislukt' }),
        { status: 502, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    })
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    )
  }
})
