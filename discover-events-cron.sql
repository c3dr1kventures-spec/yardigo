-- YardiGo — pg_cron schedule voor discover-events
--
-- Wanneer: elke maandag 04:30 UTC (= 06:30 Europe/Amsterdam in CEST /
--          zomer; 05:30 NL in wintertijd — pg_cron accepteert geen
--          named-timezone in de schedule-string).
--
-- Ná de dagelijkse scrape-job (die op 06:00-08:00 UTC draait bij andere
-- YardiGo-cron) zodat gevonden events niet botsen met net-gepubliceerde
-- reguliere listings.
--
-- Auth via x-cron-secret (dezelfde als reminder-emails/send-reminders).

SELECT cron.schedule(
  'yardigo-discover-events-weekly',
  '30 4 * * 1',
  $$
  SELECT net.http_post(
    url     := 'https://fwehqudhwzcnkcuypuqw.supabase.co/functions/v1/discover-events',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (SELECT value FROM public.app_config WHERE key = 'cron_secret')
    ),
    body                 := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

-- Handmatig runnen (vanuit SQL editor):
--
-- SELECT net.http_post(
--   url     := 'https://fwehqudhwzcnkcuypuqw.supabase.co/functions/v1/discover-events',
--   headers := jsonb_build_object(
--     'Content-Type',  'application/json',
--     'x-cron-secret', (SELECT value FROM public.app_config WHERE key = 'cron_secret')
--   ),
--   body                 := '{"dryRun":true}'::jsonb,  -- of {} voor echt
--   timeout_milliseconds := 300000
-- );
