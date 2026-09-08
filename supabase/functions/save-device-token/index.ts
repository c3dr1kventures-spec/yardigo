// YardiGo – save-device-token Edge Function
// Slaat een OneSignal player id op voor native iOS/Android push.
// Aangeroepen vanuit de Capacitor-app na OneSignal-init.
//
// Deploy: supabase functions deploy save-device-token

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface DeviceTokenPayload {
  onesignal_player_id: string
  platform: 'ios' | 'android'
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
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser()
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: 'Gebruiker niet gevonden of sessie verlopen' }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }

    const body = (await req.json()) as DeviceTokenPayload
    if (!body?.onesignal_player_id || !['ios', 'android'].includes(body?.platform)) {
      return new Response(
        JSON.stringify({ error: 'onesignal_player_id en platform (ios|android) zijn verplicht' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const { error: upsertError } = await supabaseAdmin
      .from('device_tokens')
      .upsert(
        {
          user_id: user.id,
          onesignal_player_id: body.onesignal_player_id,
          platform: body.platform,
          last_used_at: new Date().toISOString(),
        },
        { onConflict: 'onesignal_player_id' }
      )

    if (upsertError) {
      console.error('save-device-token upsert error:', upsertError)
      return new Response(
        JSON.stringify({ error: upsertError.message }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      )
    }

    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    )
  }
})
