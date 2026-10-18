-- SEO Fase 1 (19 okt 2026): get_listings_seo levert ook updated_at, land,
-- of de plaats echt bestaat (plaats_ok) en de organisator.
--
-- land/plaats_ok komen uit de eigen plaatsenlijst (GeoNames, zie
-- supabase/data). Normalisatie is gelijk aan norm() in bouw_plaatsen.py:
-- kleine letters, accenten weg, alleen a-z.
-- organizer_* = source_label/source_url: die zijn al publiek en zijn per
-- afspraak altijd de organisator (nooit een verzamelsite).

create or replace function public.plaats_norm(p text)
returns text language sql immutable as $$
  select regexp_replace(
    translate(lower(coalesce(p, '')),
      'àáâãäåèéêëìíîïòóôõöùúûüýÿçñß',
      'aaaaaaeeeeiiiiooooouuuuyycn'),
    '[^a-z]', '', 'g')
$$;

drop function if exists public.get_listings_seo();

create function public.get_listings_seo()
returns table(
  id uuid, title text, category text, event_subtype text,
  date_start date, date_end date, time_start time, time_end time,
  address text, city text, latitude double precision, longitude double precision,
  address_reveal_mode text, description text, images text[],
  confirmation_status text, user_id uuid, status text,
  updated_at timestamptz, land text, plaats_ok boolean,
  organizer_name text, organizer_url text
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
    case when listing_is_private(l.category, l.event_subtype) then null else l.source_url end
  from listings l
  -- Plaatsnaam die binnen 25 km van de pin echt bestaat.
  left join lateral (
    select p.cc from plaatsen p
    where p.naam_norm = plaats_norm(l.city)
      and l.latitude is not null
      and abs(p.lat - l.latitude) < 0.23 and abs(p.lng - l.longitude) < 0.37
    order by (p.lat - l.latitude)^2 + (p.lng - l.longitude)^2
    limit 1
  ) m on true
  -- Anders: land van de dichtstbijzijnde plaats.
  left join lateral (
    select p.cc from plaatsen p
    where m.cc is null and l.latitude is not null
      and abs(p.lat - l.latitude) < 0.2 and abs(p.lng - l.longitude) < 0.3
    order by (p.lat - l.latitude)^2 + (p.lng - l.longitude)^2
    limit 1
  ) d on true
  where l.status = 'active' and coalesce(l.confirmation_status, 'confirmed') = 'confirmed'
  order by l.date_start desc
  limit 2000
$function$;

grant execute on function public.get_listings_seo() to anon, authenticated, service_role;

-- Snelheid: nearest-plaats lookups (12 s -> 1,2 s)
create index if not exists plaatsen_lat_lng on public.plaatsen using btree (lat, lng);
create index if not exists plaatsen_naam_lat on public.plaatsen using btree (naam_norm, lat);
