// Gedeelde check voor pg_cron-aanroepen: header x-cron-secret moet gelijk zijn
// aan app_config.cron_secret. Cron jobs lezen die waarde zelf uit app_config,
// zodat er geen secret letterlijk in cron.job staat en roteren één UPDATE is.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export async function isCronCall(req: Request): Promise<boolean> {
  const provided = req.headers.get('x-cron-secret') ?? '';
  if (!provided) return false;
  const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
  const { data } = await sb.from('app_config').select('value').eq('key', 'cron_secret').maybeSingle();
  const expected = data?.value ?? '';
  if (!expected || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
