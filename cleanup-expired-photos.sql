-- YardiGo — Dagelijkse opschoning van foto's van verstreken listings
--
-- Wat het doet:
-- - Roept dagelijks (03:00 UTC) edge function `cleanup-expired-photos` aan
-- - Die functie verwijdert files uit storage-bucket `listings` die
--   (a) bij listings horen waarvan COALESCE(date_end, date_start) < today, of
--   (b) helemaal geen referentie meer hebben in listings.images (weeskinderen)
-- - Vervolgens wordt op de verstreken listings `images = NULL` gezet
-- - Listings-rows zelf blijven bewaard (voor analytics/historie)
--
-- Auth: edge function checkt header `x-cron-secret` tegen app_config.cron_secret
-- (zelfde patroon als send-reminders).
--
-- Eerste deploy:  29 jun 2026

SELECT cron.schedule(
  'yardigo-cleanup-expired-photos',
  '0 3 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://fwehqudhwzcnkcuypuqw.supabase.co/functions/v1/cleanup-expired-photos',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (SELECT value FROM public.app_config WHERE key = 'cron_secret')
    ),
    body                 := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- Handmatige run (bv. backfill / na schema-wijziging):
--
--   SELECT net.http_post(
--     url     := 'https://fwehqudhwzcnkcuypuqw.supabase.co/functions/v1/cleanup-expired-photos',
--     headers := jsonb_build_object(
--       'Content-Type',  'application/json',
--       'x-cron-secret', (SELECT value FROM public.app_config WHERE key = 'cron_secret')
--     ),
--     body                 := '{}'::jsonb,
--     timeout_milliseconds := 120000
--   );
--
-- Dry-run (laat zien wat er verwijderd zou worden, zonder iets aan te raken):
-- body := '{"dryRun": true}'::jsonb
