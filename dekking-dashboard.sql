-- Fase 2 (19 okt 2026): dekkingsoverzicht voor admin.html (tabblad Dekking).
-- Eén aanroep, alleen voor admins (zelfde check als admin_listings).
-- Provincie/land komen uit get_listings_seo() (plaatsenlijst, zie seo-provincies.sql).
--
-- Bron-mix van komende listings:
--   organisator = zelf geplaatst (placed_by 'user') of geclaimd
--   flyer       = goedgekeurd uit pending_events met een affiche (poster_url)
--   import      = de rest van wat YardiGo verzamelde (discover-events, meukisleuk)

create or replace function public.admin_dekking()
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  za date := case when extract(isodow from current_date) = 7 then current_date - 1
                  else current_date + (6 - extract(isodow from current_date))::int end;
  zo date := za + 1;
  resultaat jsonb;
begin
  if not (coalesce(is_yg_admin(auth.uid()), false)
          or exists (select 1 from profiles where id = auth.uid() and is_admin)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  with seo as (
    select s.id, s.land, s.provincie, s.date_start, coalesce(s.date_end, s.date_start) date_end
    from get_listings_seo() s
    where coalesce(s.date_end, s.date_start) >= current_date
  ),
  komend as (
    select s.*, l.placed_by, l.claimed_by_user_id, l.latitude, l.longitude,
      case when l.placed_by = 'user' or l.claimed_by_user_id is not null then 'organisator'
           when exists (select 1 from pending_events p
                        where p.approved_listing_id = l.id and p.poster_url is not null) then 'flyer'
           else 'import' end bron
    from seo s join listings l on l.id = s.id
  ),
  -- Alle provincies, ook die zonder aanbod (juist die zijn interessant).
  per_prov as (
    select pr.cc land, pr.provincie,
      count(k.id) filter (where k.date_start <= zo and k.date_end >= za) weekend,
      count(k.id) filter (where k.date_start <= current_date + 30) dertig_dagen
    from (select distinct cc, provincie from plaatsen
          where cc in ('nl', 'be') and provincie is not null) pr
    left join komend k on k.land = pr.cc and k.provincie = pr.provincie
    group by 1, 2
  ),
  -- Grote plaatsen zonder iets binnen ~10 km in de komende 30 dagen.
  witte_vlekken as (
    select * from (
      select distinct on (p.naam, p.cc) p.naam, p.cc, p.provincie, p.inwoners
      from plaatsen p
      where p.cc in ('nl', 'be') and p.inwoners >= 20000
        and p.soort in ('PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLC', 'PPLG')
        and not exists (
          select 1 from komend k
          where k.date_start <= current_date + 30
            and k.latitude between p.lat - 0.09 and p.lat + 0.09
            and k.longitude between p.lng - 0.14 and p.lng + 0.14)
      order by p.naam, p.cc, p.inwoners desc
    ) w
    order by w.inwoners desc
    limit 40
  )
  select jsonb_build_object(
    'weekend', jsonb_build_object('van', za, 'tot', zo),
    'totaal_weekend', (select count(*) from komend where date_start <= zo and date_end >= za),
    'totaal_30', (select count(*) from komend where date_start <= current_date + 30),
    'per_provincie', coalesce((select jsonb_agg(to_jsonb(pp) order by pp.land, pp.weekend desc, pp.provincie) from per_prov pp), '[]'),
    'witte_vlekken', coalesce((select jsonb_agg(to_jsonb(w) order by w.inwoners desc) from witte_vlekken w), '[]'),
    'bron_mix', coalesce((select jsonb_object_agg(bron, n) from (select bron, count(*) n from komend group by bron) b), '{}'),
    'pending', jsonb_build_object(
      'events', (select count(*) from pending_events where status = 'nieuw' and date_start >= current_date),
      'tips', (select count(*) from pending_events where status = 'tip'),
      'listings', (select count(*) from listings where status = 'pending'))
  ) into resultaat;

  return resultaat;
end $function$;

revoke all on function public.admin_dekking() from public, anon;
grant execute on function public.admin_dekking() to authenticated;
