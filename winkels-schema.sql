-- Winkels (20 okt 2026): vaste adressen naast de verkopen.
--
-- Kringloop, tweedehands, antiek, brocante, vintage en winkels van goede
-- doelen, met openingstijden, zodat bezoekers ze op de kaart zien en
-- meenemen in hun rondje. Eerste bron is OpenStreetMap (shop=second_hand,
-- shop=charity, shop=antiques); later kunnen winkels zich zelf aanmelden
-- en overnemen (claimed_by_user_id), net als markten.
--   - osm_type + osm_id is uniek, zodat een nieuwe import bijwerkt in plaats
--     van dubbelt. Rijen die niet meer in OSM staan zet de import op
--     actief = false, nooit weggooien (een geclaimde winkel blijft).
--   - openingstijden is de ruwe OSM-notatie (bv. "Tu-Sa 10:00-17:00");
--     de app rekent daarmee "nu open" uit.
--   - Bronvermelding verplicht (ODbL): "© OpenStreetMap-bijdragers".
-- Zelfde aanpak als listings: RLS aan, geen policies, lezen alleen via de
-- RPC hieronder (straal en limiet, tegen leegtrekken).

create table if not exists public.winkels (
  id                 bigint generated always as identity primary key,
  osm_type           text check (osm_type in ('node', 'way', 'relation')),
  osm_id             bigint,
  naam               text not null,
  soort              text not null check (soort in ('kringloop', 'tweedehands', 'antiek', 'goede_doel')),
  osm_shop           text,
  straat             text,
  huisnummer         text,
  postcode           text,
  plaats             text,
  land               text check (land in ('nl', 'be', 'de', 'fr', 'lu')),
  latitude           double precision not null,
  longitude          double precision not null,
  location           geography(Point, 4326) generated always as
                       (st_setsrid(st_makepoint(longitude, latitude), 4326)::geography) stored,
  openingstijden     text,
  website            text,
  telefoon           text,
  rolstoel           text,
  bron               text not null default 'osm',
  actief             boolean not null default true,
  claimed_by_user_id uuid references auth.users(id) on delete set null,
  laatst_gesynct     timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  unique (osm_type, osm_id)
);
create index if not exists idx_winkels_location on public.winkels using gist (location);
create index if not exists idx_winkels_plaats on public.winkels (land, plaats);
-- RLS aan, bewust geen policies: alleen via de RPC hieronder.
alter table public.winkels enable row level security;

create or replace function public.winkels_in_de_buurt(
  p_lat double precision,
  p_lng double precision,
  p_km double precision default 20,
  p_limiet integer default 200
)
returns table (
  id bigint, naam text, soort text, straat text, huisnummer text, postcode text,
  plaats text, latitude double precision, longitude double precision,
  openingstijden text, website text, rolstoel text, afstand_km double precision
)
language sql stable security definer set search_path = public
as $$
  select w.id, w.naam, w.soort, w.straat, w.huisnummer, w.postcode, w.plaats,
         w.latitude, w.longitude, w.openingstijden, w.website, w.rolstoel,
         round((st_distance(w.location, st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography) / 1000)::numeric, 1)::double precision
  from winkels w
  where w.actief
    and st_dwithin(w.location, st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography, least(greatest(p_km, 1), 50) * 1000)
  order by w.location <-> st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography
  limit least(greatest(p_limiet, 1), 300);
$$;
revoke all on function public.winkels_in_de_buurt(double precision, double precision, double precision, integer) from public;
grant execute on function public.winkels_in_de_buurt(double precision, double precision, double precision, integer) to anon, authenticated;

-- ── Import uit OpenStreetMap ─────────────────────────────────
-- Haalt via de http-extensie alle shop=second_hand|charity|antiques van één
-- land op bij Overpass en werkt public.winkels bij. Duurt 1 tot 2 minuten;
-- Overpass geeft soms 502 (druk), dan gewoon later opnieuw.
-- Alleen aanroepbaar met de service-rol (SQL Editor of pg_cron):
--   select public.winkels_import_osm('nl');
create or replace function public.winkels_import_osm(p_land text)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  resp extensions.http_response;
  doc jsonb;
  n int;
  uit int;
  q text;
begin
  if p_land not in ('nl', 'be', 'de', 'fr', 'lu') then
    return jsonb_build_object('ok', false, 'reden', 'land');
  end if;
  q := format('[out:json][timeout:200];area["ISO3166-1"="%s"][admin_level=2]->.a;(nwr["shop"~"^(second_hand|charity|antiques)$"](area.a););out center tags;', upper(p_land));
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '280');
  select * into resp from extensions.http((
    'POST', 'https://overpass-api.de/api/interpreter',
    array[extensions.http_header('User-Agent', 'YardiGo-shops-import/1.0')],
    'application/x-www-form-urlencoded',
    'data=' || extensions.urlencode(q)
  )::extensions.http_request);
  if resp.status <> 200 then
    return jsonb_build_object('ok', false, 'status', resp.status, 'body', left(resp.content, 200));
  end if;
  doc := resp.content::jsonb;

  with r as (
    select x->>'type' as osm_type, (x->>'id')::bigint as osm_id,
           left(btrim(coalesce(nullif(x->'tags'->>'name', ''), x->'tags'->>'brand')), 200) as naam,
           x->'tags'->>'shop' as shop, x->'tags' as t,
           coalesce((x->>'lat')::float8, (x->'center'->>'lat')::float8) as lat,
           coalesce((x->>'lon')::float8, (x->'center'->>'lon')::float8) as lon
    from jsonb_array_elements(doc->'elements') x
  )
  insert into winkels (osm_type, osm_id, naam, soort, osm_shop, straat, huisnummer, postcode, plaats, land,
                       latitude, longitude, openingstijden, website, telefoon, rolstoel)
  select osm_type, osm_id, naam,
         case when shop = 'antiques' then 'antiek'
              when shop = 'charity' then 'goede_doel'
              when (naam || ' ' || coalesce(t->>'brand', '')) ~* 'kringloop|kringwinkel|rataplan|emmaus|wawollie|het goed|noppes|snuffel|ecokring|terre des hommes|leger des heils|dorcas|weggeef'
                   or t->>'second_hand' = 'only' then 'kringloop'
              else 'tweedehands' end,
         shop, t->>'addr:street', t->>'addr:housenumber', t->>'addr:postcode', t->>'addr:city', p_land,
         lat, lon, t->>'opening_hours', coalesce(t->>'website', t->>'contact:website'),
         coalesce(t->>'phone', t->>'contact:phone'), t->>'wheelchair'
  from r
  where coalesce(naam, '') <> '' and lat is not null
  on conflict (osm_type, osm_id) do update set
    naam = excluded.naam, soort = excluded.soort, osm_shop = excluded.osm_shop, straat = excluded.straat,
    huisnummer = excluded.huisnummer, postcode = excluded.postcode, plaats = excluded.plaats, land = excluded.land,
    latitude = excluded.latitude, longitude = excluded.longitude, openingstijden = excluded.openingstijden,
    website = excluded.website, telefoon = excluded.telefoon, rolstoel = excluded.rolstoel,
    actief = true, laatst_gesynct = now();
  get diagnostics n = row_count;

  -- Niet meer in OSM: op inactief, nooit weggooien; geclaimde winkels blijven staan.
  update winkels set actief = false
  where land = p_land and bron = 'osm' and actief and claimed_by_user_id is null and laatst_gesynct < now();
  get diagnostics uit = row_count;

  return jsonb_build_object('ok', true, 'bijgewerkt', n, 'inactief', uit);
end;
$$;
revoke all on function public.winkels_import_osm(text) from public, anon, authenticated;
