// YardiGo – post-guestbook-message Edge Function
// Verwerkt een nieuw bericht voor het (ouderwetse) gastenboek op de homepage.
// Draait bewust als enige schrijfpad naar guestbook_messages — de tabel heeft
// geen publieke INSERT-policy — zodat rate-limiting, link-filtering en de
// honeypot-check niet te omzeilen zijn via een directe API-call met de anon key.
//
// Deploy: supabase functions deploy post-guestbook-message
//
// Required env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   GUESTBOOK_IP_SALT   (willekeurige secret, alleen voor het hashen van IP's — nooit het ruwe IP opslaan)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const MAX_NAME_LEN = 40
const MAX_MESSAGE_LEN = 300
const MAX_PER_DAY = 3
const RATE_WINDOW_HOURS = 24
const LINK_PATTERN = /https?:\/\/|www\./i

async function hashIp(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(ip + salt)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  try {
    const body = await req.json()
    const name = String(body?.name ?? '').trim()
    const message = String(body?.message ?? '').trim()
    const honeypot = String(body?.website ?? '').trim() // verborgen veld, mensen laten dit leeg

    // Bot ingevuld het honeypot-veld: doe alsof het gelukt is, sla niets op.
    if (honeypot) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      })
    }

    if (!name || name.length > MAX_NAME_LEN) {
      return new Response(JSON.stringify({ error: `Naam is verplicht (max ${MAX_NAME_LEN} tekens).` }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      })
    }
    if (!message || message.length > MAX_MESSAGE_LEN) {
      return new Response(JSON.stringify({ error: `Bericht is verplicht (max ${MAX_MESSAGE_LEN} tekens).` }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      })
    }
    if (LINK_PATTERN.test(name) || LINK_PATTERN.test(message)) {
      return new Response(JSON.stringify({ error: 'Links zijn niet toegestaan in het gastenboek.' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      })
    }

    const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'
    const salt = Deno.env.get('GUESTBOOK_IP_SALT') ?? ''
    const ipHash = await hashIp(ip, salt)

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const since = new Date(Date.now() - RATE_WINDOW_HOURS * 3600000).toISOString()
    const { count } = await supabaseAdmin
      .from('guestbook_messages')
      .select('id', { count: 'exact', head: true })
      .eq('ip_hash', ipHash)
      .gte('created_at', since)

    if ((count ?? 0) >= MAX_PER_DAY) {
      return new Response(
        JSON.stringify({ error: `Je hebt het maximum van ${MAX_PER_DAY} berichten per dag bereikt. Probeer het morgen weer.` }),
        { status: 429, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }

    const { error: insertError } = await supabaseAdmin
      .from('guestbook_messages')
      .insert({ name: name.slice(0, MAX_NAME_LEN), message: message.slice(0, MAX_MESSAGE_LEN), ip_hash: ipHash })

    if (insertError) {
      console.error('post-guestbook-message insert error:', insertError)
      return new Response(JSON.stringify({ error: 'Opslaan mislukt, probeer het later opnieuw.' }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      })
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
