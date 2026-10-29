-- ═══════════════════════════════════════════════════════════════════════
-- Advies per wachtrij-item (29 okt 2026).
--
-- De telegram-bot en de mini-app (tg.html) zetten bij elk kaartje een advies:
-- plaatsen, aanvullen, toestemming vragen, controleren of afwijzen. Daarvoor
-- twee dingen uit de database, in één aanroep:
--   - kandidaten: live advertenties op dezelfde dag in dezelfde plaats (of
--     binnen 1,5 km). De Edge Function vergelijkt de titels en beslist of het
--     een dubbele is.
--   - bronnen: hoe vaak je items uit dezelfde bron eerder goedkeurde of
--     afwees. Bron = discovered_via_query als die een vaste bron is
--     ('meukisleuk:rommelmarkt', 'verzamelsite:marktenmeer', 'bron:…',
--     'telegram', 'website-tip'); vrije zoekopdrachten tellen samen als
--     'zoekopdracht'.
-- Alleen voor de service role (Edge Function).
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.pending_bron_sleutel(q text)
returns text
language sql immutable set search_path = public
as $$
  select case when q is null then 'onbekend'
              when position(':' in q) > 0 or q in ('telegram', 'website-tip') then q
              else 'zoekopdracht' end;
$$;

create or replace function public.pending_advies_context(p_ids bigint[])
returns jsonb
language sql stable security definer set search_path = public, extensions
as $$
  select jsonb_build_object(
    'kandidaten', coalesce((
      select jsonb_agg(jsonb_build_object('pending_id', q.id, 'listing_id', l.id, 'title', l.title, 'city', l.city,
               'm', case when q.latitude is not null and l.latitude is not null
                         then round(st_distance(st_setsrid(st_makepoint(q.longitude, q.latitude), 4326)::geography,
                                                st_setsrid(st_makepoint(l.longitude, l.latitude), 4326)::geography))::int end))
      from pending_events q
      join listings l on l.status = 'active' and l.date_start = q.date_start
       and (lower(btrim(l.city)) = lower(btrim(q.city))
            or (q.latitude is not null and l.latitude is not null
                and st_dwithin(st_setsrid(st_makepoint(q.longitude, q.latitude), 4326)::geography,
                               st_setsrid(st_makepoint(l.longitude, l.latitude), 4326)::geography, 1500)))
      where q.id = any(p_ids)
    ), '[]'::jsonb),
    'bronnen', coalesce((
      select jsonb_object_agg(bron, jsonb_build_object('ok', ok, 'weg', weg))
      from (
        select pending_bron_sleutel(discovered_via_query) as bron,
               count(*) filter (where status = 'goedgekeurd') as ok,
               count(*) filter (where status = 'afgewezen') as weg
        from pending_events where status in ('goedgekeurd', 'afgewezen')
        group by 1
      ) s
    ), '{}'::jsonb)
  );
$$;

revoke all on function public.pending_advies_context(bigint[]) from public, anon, authenticated;
revoke all on function public.pending_bron_sleutel(text) from public, anon, authenticated;
grant execute on function public.pending_advies_context(bigint[]) to service_role;
grant execute on function public.pending_bron_sleutel(text) to service_role;
