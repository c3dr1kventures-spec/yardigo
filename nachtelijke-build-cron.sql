-- Nachtelijke herbouw van de site (19 okt 2026).
-- Vercel bouwt alleen bij een push; de prerender (sitemap, stads-, provincie-
-- en dit-weekend-pagina's) moet ook de imports van die nacht meenemen.
-- Deploy Hook "nachtelijk" (branch main) staat in Vercel > Settings > Git.
-- De hook-URL is geheim en staat in app_config (alleen service_role):
--   insert into app_config(key, value) values ('vercel_deploy_hook', '<url>')
--   on conflict (key) do update set value = excluded.value;
-- 05:45 UTC: na discover-events (04:30), resolve-source (05:00) en de eerste
-- meukisleuk-import (05:15). Mislukt de build, dan blijft de vorige live.
select cron.schedule('yardigo-nachtelijke-build', '45 5 * * *', $$
  select net.http_post(
    url := (select value from public.app_config where key = 'vercel_deploy_hook'),
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 30000);
$$);
