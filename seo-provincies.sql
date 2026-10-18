-- SEO Fase 1B (19 okt 2026): provincie per plaats, voor provinciepagina's.
-- NL = GeoNames admin1, BE = admin2 (admin1 is daar het gewest).
-- Slugs: limburg (NL) / belgisch-limburg, belgisch-luxemburg, brussel, ...
-- Data: supabase/data/plaatsen-provincie.psv (bouw_provincies.py), gekoppeld
-- op lat/lng/cc (zelfde afronding als plaatsen.psv).

alter table public.plaatsen add column if not exists provincie text;
alter function public.plaats_norm(text) set search_path = '';   -- advisor: vaste search_path

drop function if exists public.get_listings_seo();

create function public.get_listings_seo()
returns table(
  id uuid, title text, category text, event_subtype text,
  date_start date, date_end date, time_start time, time_end time,
  address text, city text, latitude double precision, longitude double precision,
  address_reveal_mode text, description text, images text[],
  confirmation_status text, user_id uuid, status text,
  updated_at timestamptz, land text, plaats_ok boolean,
  organizer_name text, organizer_url text, provincie text
)
language sql stable security definer set search_path to 'public'
as $function$
  select l.id, l.title, l.category, l.event_subtype,
    l.date_start, l.date_end, l.time_start, l.time_end,
    case when listing_is_private(l.category, l.event_subtype) or l.address_reveal_mode <> 'instant'
         then null else l.address end,
    l.city,
    case when listing_is_private(l.category, l.event_subtype) then (listing_fuzz(l.id, l.latitude, l.longitude)).lat else l.latitude end,
    case when listing_is_private(l.category, l.event_subtype) then (listing_fuzz(l.id, l.latitude, l.longitude)).lng else l.longitude end,
    case when listing_is_private(l.category, l.event_subtype) then 'day_before' else l.address_reveal_mode end,
    l.description, l.images, l.confirmation_status, l.user_id, l.status,
    l.updated_at,
    coalesce(m.cc, d.cc),
    m.cc is not null,
    case when listing_is_private(l.category, l.event_subtype) then null else l.source_label end,
    case when listing_is_private(l.category, l.event_subtype) then null else l.source_url end,
    -- Provincie van de plaatsnaam, anders van de dichtstbijzijnde plaats in hetzelfde land.
    coalesce(m.provincie, case when m.cc is null or d.cc = m.cc then d.provincie end)
  from listings l
  -- Plaatsnaam die binnen 25 km van de pin echt bestaat.
  left join lateral (
    select p.cc, p.provincie from plaatsen p
    where p.naam_norm = plaats_norm(l.city)
      and l.latitude is not null
      and abs(p.lat - l.latitude) < 0.23 and abs(p.lng - l.longitude) < 0.37
    order by (p.lat - l.latitude)^2 + (p.lng - l.longitude)^2
    limit 1
  ) m on true
  -- Anders: land van de dichtstbijzijnde plaats.
  left join lateral (
    select p.cc, p.provincie from plaatsen p
    where (m.cc is null or m.provincie is null) and l.latitude is not null
      and abs(p.lat - l.latitude) < 0.2 and abs(p.lng - l.longitude) < 0.3
    order by (p.lat - l.latitude)^2 + (p.lng - l.longitude)^2
    limit 1
  ) d on true
  where l.status = 'active' and coalesce(l.confirmation_status, 'confirmed') = 'confirmed'
  order by l.date_start desc
  limit 2000
$function$;

grant execute on function public.get_listings_seo() to anon, authenticated, service_role;

-- Inladen (na push naar main), via de http-extensie:
-- with f as (
--   select content from http_get('https://raw.githubusercontent.com/c3dr1kventures-spec/yardigo/main/supabase/data/plaatsen-provincie.psv')
-- ), r as (
--   select split_part(x, '|', 1)::float8 lat, split_part(x, '|', 2)::float8 lng,
--          split_part(x, '|', 3) cc, split_part(x, '|', 4) prov
--   from f, regexp_split_to_table(f.content, E'\n') x where x <> ''
-- )
-- update plaatsen p set provincie = r.prov from r
-- where p.cc = r.cc and p.lat = r.lat and p.lng = r.lng;
