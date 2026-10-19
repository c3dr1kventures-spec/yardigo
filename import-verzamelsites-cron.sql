-- Fase 2 (19 okt 2026): import-verzamelsites (marktenmeer.nl, rommelroutes.nl,
-- rondsnuffelen.nl) als lead-bron. Elke run pakt de volgende site, dus elke
-- site komt elke 6 uur langs. Tussen de meukisleuk-runs in (die draaien op :15).
-- Secret staat in app_config, niet in de job.

select cron.schedule(
  'yardigo-import-verzamelsites',
  '45 5-19/2 * * *',
  $$
  select net.http_post(
    url     := 'https://fwehqudhwzcnkcuypuqw.supabase.co/functions/v1/import-verzamelsites',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (select value from public.app_config where key = 'cron_secret')
    ),
    body                 := '{"max_items": 15}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);

-- marktenmeer.nl stond ook als scrape_source (AI leest één pagina); dat doet
-- nu deze importer. De twee voorstellen (rommelroutes, rondsnuffelen) ook uit.
update public.scrape_sources set actief = false, voorgesteld = false
where domain in ('marktenmeer.nl', 'rommelroutes.nl', 'rondsnuffelen.nl');
