-- ═══════════════════════════════════════════════════════════════════════
-- Bezoekersmeting bewaken (14 nov 2026).
--
-- Van 27 okt tot 14 nov telde de nieuwe site niet mee in page_views en dat
-- viel niemand op (zie analytics-schatting.sql). analytics_gezondheid() geeft
-- een regel per probleem; leeg = alles in orde. Gebruikt door:
--   - /admin: rode balk bovenaan na inloggen
--   - telegram-bot?action=watchdog (dagelijks 18:00): bericht naar de beheerder
--
-- Controles (dagen in Europe/Amsterdam, 'gisteren' = laatste volle dag):
--   1. totaal: gisteren < 50% van het gemiddelde van de 7 dagen daarvoor
--      (alleen als dat gemiddelde >= 10, anders is het ruis)
--   2. per bron: de afgelopen 24 uur niets, terwijl de 7 dagen daarvoor
--      gemiddeld >= 3 per dag. Bronnen: website (alle sitepagina's behalve
--      /v/), verkooppagina's (/v/...), app (/app, /aanmelden, /verkoop).
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.analytics_gezondheid()
returns table (soort text, melding text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_tz constant text := 'Europe/Amsterdam';
  v_gisteren date := (now() at time zone v_tz)::date - 1;
  v_gist bigint;
  v_gem numeric;
  r record;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_yg_admin(auth.uid()) then
    raise exception 'Niet geautoriseerd';
  end if;

  select count(*) into v_gist from public.page_views
   where (created_at at time zone v_tz)::date = v_gisteren;
  select count(*) / 7.0 into v_gem from public.page_views
   where (created_at at time zone v_tz)::date between v_gisteren - 7 and v_gisteren - 1;
  if v_gem >= 10 and v_gist < v_gem * 0.5 then
    soort := 'daling';
    melding := format('Gisteren %s bezoeken, de week ervoor gemiddeld %s per dag (%s%%). Telt alles nog mee?',
                      v_gist, round(v_gem), round(100 * (v_gist - v_gem) / v_gem));
    return next;
  end if;

  for r in
    with pv as (
      select created_at,
             case when path like '/v/%' then 'verkooppagina''s'
                  when path like '/app%' or path in ('/aanmelden', '/verkoop') then 'app'
                  else 'website' end as bron
      from public.page_views
      where created_at > now() - interval '8 days'
    )
    select bron,
           count(*) filter (where created_at > now() - interval '24 hours') as laatste24,
           count(*) filter (where created_at <= now() - interval '24 hours') / 7.0 as gem,
           max(created_at) as laatst
    from pv group by bron
  loop
    if r.laatste24 = 0 and r.gem >= 3 then
      soort := 'bron_stil';
      melding := format('%s: al 24 uur geen enkel bezoek geteld (laatste: %s; normaal ~%s per dag). Mogelijk is de meting op die pagina''s weggevallen.',
                        initcap(r.bron), to_char(r.laatst at time zone v_tz, 'DD-MM HH24:MI'), round(r.gem));
      return next;
    end if;
  end loop;
end;
$function$;

revoke all on function public.analytics_gezondheid() from public, anon;
grant execute on function public.analytics_gezondheid() to authenticated, service_role;
