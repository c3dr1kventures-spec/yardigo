-- Fase 3 (20 okt 2026): rommelroute-organisator binden.
--
-- Een rommelroute = alle listings met dezelfde neighborhood_group_id. De
-- organisator is eigenaar (user_id) van alle rijen; zijn eigen adres is de
-- "hoofdrij" (geen confirmation_token, methode self_confirmed).
--
-- Wat dit script toevoegt:
--   1. rommelroutes: per route een openbare inschrijfcode (link/QR), of de
--      inschrijving open staat, de vorige editie en of het rapport verstuurd is.
--   2. route_aanmeldingen: buren melden zich zelf aan via /doe-mee?r=<code>
--      (eigen toestemming, AVG art. 6.1.a). De organisator keurt goed; dan pas
--      komt er een listing. De buur houdt een eigen link (/doe-mee?t=<token>)
--      om zich af te melden. E-mail is optioneel en alleen voor service-mail
--      over deze route; mag_uitnodigen = apart vinkje voor een volgende editie.
--   3. route_berichten: log van berichten van de organisator aan deelnemers
--      (verstuurd door edge function rommelroute, max 3 per dag).
--   4. listing_weergaven: echte weergaven per listing. Bewust een aparte tabel:
--      listings.view_count wordt door de oude app als "gaan erheen" getoond, en
--      een update op listings zou updated_at (SEO lastmod) laten verspringen.
--   5. RPC's voor organisator, buur, statistieken, "opnieuw organiseren",
--      rapport en opruimen.
--   6. Bugfix: decline_buurt_listing en expire_old_pending_confirmations zetten
--      status 'inactive' (niet toegestaan door de check op listings.status) en
--      address = null (kolom is NOT NULL). Daardoor faalden weigeren en verlopen
--      altijd, en bleef het adres staan. Nu status 'cancelled' en address ''.

-- ── 1. Tabellen ─────────────────────────────────────────────

create table if not exists public.rommelroutes (
  groep_id             text primary key,
  organisator_id       uuid not null references auth.users(id) on delete cascade,
  inschrijf_code       text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 10),
  inschrijving_open    boolean not null default true,
  vorige_groep_id      text,
  rapport_verstuurd_at timestamptz,
  created_at           timestamptz not null default now()
);
alter table public.rommelroutes enable row level security;
create policy rommelroutes_eigen_select on public.rommelroutes
  for select to authenticated using (organisator_id = (select auth.uid()));

create table if not exists public.route_aanmeldingen (
  id                     uuid primary key default gen_random_uuid(),
  groep_id               text not null references public.rommelroutes(groep_id) on delete cascade,
  token                  uuid not null unique default gen_random_uuid(),
  adres                  text,
  postcode               text,
  plaats                 text,
  latitude               double precision,
  longitude              double precision,
  naam                   text,
  email                  text,
  wat_verkoop            text,
  taal                   text not null default 'nl' check (taal in ('nl', 'en', 'fr', 'de')),
  mag_uitnodigen         boolean not null default false,
  status                 text not null default 'nieuw'
                         check (status in ('nieuw', 'uitgenodigd', 'goedgekeurd', 'afgewezen', 'ingetrokken', 'verlopen')),
  listing_id             uuid references public.listings(id) on delete set null,
  toestemming_at         timestamptz,
  beoordeeld_at          timestamptz,
  organisator_gemeld_at  timestamptz,
  buur_gemaild_at        timestamptz,
  ip_hash                text,
  created_at             timestamptz not null default now()
);
create index if not exists idx_route_aanm_groep on public.route_aanmeldingen (groep_id, status);
create index if not exists idx_route_aanm_ip on public.route_aanmeldingen (ip_hash, created_at);
-- RLS aan, bewust geen policies: alleen via de security-definer RPC's hieronder
-- en de service role. Zo ziet de organisator nooit het e-mailadres van een buur.
alter table public.route_aanmeldingen enable row level security;

create table if not exists public.route_berichten (
  id         bigserial primary key,
  groep_id   text not null references public.rommelroutes(groep_id) on delete cascade,
  tekst      text not null,
  ontvangers integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_route_berichten_groep on public.route_berichten (groep_id, created_at);
alter table public.route_berichten enable row level security;

create table if not exists public.listing_weergaven (
  listing_id uuid primary key references public.listings(id) on delete cascade,
  aantal     integer not null default 0
);
alter table public.listing_weergaven enable row level security;

-- ── 2. Interne hulpfuncties (niet aanroepbaar via de API) ───

-- De hoofdrij: het eigen adres van de organisator.
create or replace function public.route_hoofd(p_groep text)
returns public.listings
language sql stable security definer set search_path = public
as $$
  select * from listings
  where neighborhood_group_id = p_groep and confirmation_token is null
    and coalesce(confirmation_method, 'self_confirmed') = 'self_confirmed'
  order by created_at limit 1
$$;

-- Zorgt dat er een rommelroutes-rij is (oude routes hebben er nog geen).
create or replace function public.route_meta(p_groep text)
returns public.rommelroutes
language plpgsql security definer set search_path = public
as $$
declare
  h listings;
  m rommelroutes;
begin
  select * into m from rommelroutes where groep_id = p_groep;
  if found then return m; end if;
  h := route_hoofd(p_groep);
  if h.id is null then return null; end if;
  insert into rommelroutes (groep_id, organisator_id) values (p_groep, h.user_id)
  on conflict (groep_id) do nothing;
  select * into m from rommelroutes where groep_id = p_groep;
  return m;
end $$;

create or replace function public.route_stats(p_groep text)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with l as (select id, confirmation_status, address from listings where neighborhood_group_id = p_groep)
  select jsonb_build_object(
    'weergaven',  coalesce((select sum(w.aantal) from listing_weergaven w where w.listing_id in (select id from l)), 0),
    'ik_ga',      (select count(distinct i.user_id) from listing_interests i where i.listing_id in (select id from l)),
    'favorieten', (select count(distinct f.user_id) from favorites f where f.listing_id in (select id from l)),
    'adressen',   (select count(*) from l where confirmation_status = 'confirmed' and coalesce(address, '') <> ''),
    'wachtend',   (select count(*) from l where confirmation_status = 'pending'))
$$;

create or replace function public.ip_hash_verzoek()
returns text
language sql stable security definer set search_path = public
as $$
  select encode(sha256(convert_to(
    coalesce(split_part(current_setting('request.headers', true)::json->>'x-forwarded-for', ',', 1), '?')
    || coalesce((select value from app_config where key = 'cron_secret'), ''), 'UTF8')), 'hex')
$$;

revoke all on function public.route_hoofd(text) from public, anon, authenticated;
revoke all on function public.route_meta(text) from public, anon, authenticated;
revoke all on function public.route_stats(text) from public, anon, authenticated;
revoke all on function public.ip_hash_verzoek() from public, anon, authenticated;

-- ── 3. Organisator (ingelogd) ───────────────────────────────

-- Alle routes van de ingelogde gebruiker, ook voorbije (voor "opnieuw organiseren").
create or replace function public.mijn_rommelroutes()
returns jsonb
language sql stable security definer set search_path = public
as $$
  with g as (
    select neighborhood_group_id as groep_id, min(date_start) as datum, max(coalesce(date_end, date_start)) as eind
    from listings
    where user_id = auth.uid() and neighborhood_group_id is not null and status <> 'cancelled'
    group by 1
    having max(coalesce(date_end, date_start)) >= current_date - 400
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'groep_id', g.groep_id, 'titel', h.title, 'datum', g.datum, 'voorbij', g.eind < current_date,
      'hoofd_id', h.id,
      'nieuw', (select count(*) from route_aanmeldingen a where a.groep_id = g.groep_id and a.status = 'nieuw'),
      'stats', route_stats(g.groep_id)
    ) order by g.datum desc), '[]'::jsonb)
  from g cross join lateral (select * from route_hoofd(g.groep_id)) h
  where h.id is not null
$$;

create or replace function public.route_beheer(p_groep text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  h listings;
  m rommelroutes;
begin
  h := route_hoofd(p_groep);
  if h.id is null or h.user_id is distinct from auth.uid() then
    raise exception 'geen toegang' using errcode = '42501';
  end if;
  m := route_meta(p_groep);
  return jsonb_build_object(
    'groep_id', p_groep, 'code', m.inschrijf_code, 'open', m.inschrijving_open,
    'titel', h.title, 'datum', h.date_start, 'datum_eind', h.date_end,
    'tijd_van', to_char(h.time_start, 'HH24:MI'), 'tijd_tot', to_char(h.time_end, 'HH24:MI'),
    'hoofd_id', h.id, 'voorbij', coalesce(h.date_end, h.date_start) < current_date,
    'stats', route_stats(p_groep),
    'aanmeldingen', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'adres', a.adres, 'plaats', a.plaats, 'naam', a.naam, 'wat', a.wat_verkoop,
        'status', a.status, 'heeft_email', a.email is not null, 'created_at', a.created_at
      ) order by (a.status = 'nieuw') desc, a.created_at desc)
      from route_aanmeldingen a where a.groep_id = p_groep and a.status <> 'verlopen'), '[]'::jsonb),
    -- Alle adressen van de route (eigen adres eerst), voor het overzicht en de
    -- printkaart. get_listings_map stuurt geen confirmation_token mee, dus de
    -- app kan buur-rijen daar niet betrouwbaar van het eigen adres onderscheiden.
    'adressen', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id,
        'adres', l.address, 'label', coalesce(l.participant_display_name, l.confirmation_address_label),
        'lat', l.latitude, 'lng', l.longitude, 'status', l.confirmation_status, 'hoofd', l.id = h.id,
        -- Token ook bij bevestigd: de organisator kan de buur dan de live-link
        -- (/doe-mee?t=) sturen om op de dag zelf de status te zetten (Fase 4).
        'token', case when l.confirmation_status in ('pending', 'confirmed') then l.confirmation_token end
      ) order by (l.id = h.id) desc, l.created_at)
      from listings l
      where l.neighborhood_group_id = p_groep and coalesce(l.address, '') <> ''
        and l.confirmation_status in ('confirmed', 'pending') and l.status <> 'cancelled'), '[]'::jsonb),
    'ontvangers', (select count(*) from route_aanmeldingen a
                   where a.groep_id = p_groep and a.status = 'goedgekeurd' and a.email is not null),
    'berichten_24u', (select count(*) from route_berichten b
                      where b.groep_id = p_groep and b.created_at > now() - interval '24 hours'));
end $$;

create or replace function public.route_inschrijving_zet(p_groep text, p_open boolean)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare h listings;
begin
  h := route_hoofd(p_groep);
  if h.id is null or h.user_id is distinct from auth.uid() then
    raise exception 'geen toegang' using errcode = '42501';
  end if;
  perform route_meta(p_groep);
  update rommelroutes set inschrijving_open = coalesce(p_open, true) where groep_id = p_groep;
  return jsonb_build_object('ok', true, 'open', coalesce(p_open, true));
end $$;

-- Goedkeuren maakt een listing aan op het adres van de buur (kopie van de
-- hoofdrij met datum, tijden, foto's en omschrijving). De listing krijgt de
-- token van de aanmelding als confirmation_token: zo telt hij in de app als
-- buur-rij en werkt ook /bevestig?token=... om je af te melden.
create or replace function public.route_aanmelding_beoordelen(p_id uuid, p_goedkeuren boolean)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  a route_aanmeldingen;
  h listings;
  nieuw_id uuid;
begin
  select * into a from route_aanmeldingen where id = p_id for update;
  if not found then raise exception 'onbekende aanmelding' using errcode = 'P0002'; end if;
  h := route_hoofd(a.groep_id);
  if h.id is null or h.user_id is distinct from auth.uid() then
    raise exception 'geen toegang' using errcode = '42501';
  end if;
  if a.status <> 'nieuw' then
    return jsonb_build_object('ok', true, 'status', a.status, 'al_gedaan', true);
  end if;

  if not coalesce(p_goedkeuren, false) then
    update route_aanmeldingen
      set status = 'afgewezen', beoordeeld_at = now(),
          adres = null, postcode = null, latitude = null, longitude = null, naam = null, email = null, wat_verkoop = null
      where id = a.id;
    return jsonb_build_object('ok', true, 'status', 'afgewezen');
  end if;

  if coalesce(h.date_end, h.date_start) < current_date then
    raise exception 'deze route is al voorbij' using errcode = '22023';
  end if;

  insert into listings (user_id, title, description, category, address, city, postal_code, latitude, longitude,
    date_start, date_end, time_start, time_end, images, tags, status, neighborhood_group_id, address_reveal_mode,
    confirmation_token, confirmation_status, confirmation_method, confirmation_responded_at,
    participant_display_name, confirmation_address_label, placed_by)
  values (h.user_id, h.title,
    case when a.wat_verkoop is not null then coalesce(h.description, '') || E'\n\n' || a.wat_verkoop else h.description end,
    'buurtverkoop',
    a.adres || coalesce(', ' || nullif(a.postcode, ''), '') || coalesce(' ' || nullif(a.plaats, ''), ''),
    coalesce(nullif(a.plaats, ''), h.city), a.postcode, a.latitude, a.longitude,
    h.date_start, h.date_end, h.time_start, h.time_end, h.images, h.tags, 'active', a.groep_id, h.address_reveal_mode,
    a.token, 'confirmed', 'self_confirmed', a.toestemming_at,
    a.naam, left(coalesce(nullif(a.naam, ''), 'Aanmelding'), 60), 'user')
  returning id into nieuw_id;

  update route_aanmeldingen set status = 'goedgekeurd', beoordeeld_at = now(), listing_id = nieuw_id where id = a.id;
  return jsonb_build_object('ok', true, 'status', 'goedgekeurd', 'listing_id', nieuw_id);
end $$;

-- Opnieuw organiseren: nieuwe groep met de hoofdrij op de nieuwe datum.
-- Toestemming geldt per editie (AVG), dus niemand gaat automatisch online:
--   - buren die de organisator zelf invoerde: nieuwe pending-rij met nieuwe
--     bevestigingslink; de links komen terug zodat de organisator ze deelt.
--   - buren die zich aanmeldden en "mail me bij een volgende editie" aanvinkten:
--     status 'uitgenodigd'; de edge function mailt ze de link.
--   - buren die zich aanmeldden zonder dat vinkje: niets, ze kunnen zich via de
--     nieuwe inschrijflink opnieuw aanmelden.
create or replace function public.route_opnieuw(p_groep text, p_datum date, p_tijd_van time default null, p_tijd_tot time default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  h listings;
  r record;
  nieuw_groep text := 'bv-' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  nieuw_hoofd uuid;
  nieuw_token uuid;
  span integer;
  links jsonb := '[]'::jsonb;
  n_uitgenodigd integer := 0;
begin
  h := route_hoofd(p_groep);
  if h.id is null or h.user_id is distinct from auth.uid() then
    raise exception 'geen toegang' using errcode = '42501';
  end if;
  if p_datum is null or p_datum < current_date or p_datum > current_date + 400 then
    raise exception 'datum moet tussen vandaag en volgend jaar liggen' using errcode = '22023';
  end if;
  span := coalesce(h.date_end - h.date_start, 0);

  insert into listings (user_id, title, description, category, address, city, postal_code, latitude, longitude,
    date_start, date_end, time_start, time_end, images, tags, status, neighborhood_group_id, address_reveal_mode,
    confirmation_status, confirmation_method, floorplan_url, placed_by)
  values (h.user_id, h.title, h.description, 'buurtverkoop', h.address, h.city, h.postal_code, h.latitude, h.longitude,
    p_datum, case when span > 0 then p_datum + span end,
    coalesce(p_tijd_van, h.time_start), coalesce(p_tijd_tot, h.time_end), h.images, h.tags, 'active', nieuw_groep,
    h.address_reveal_mode, 'confirmed', 'self_confirmed', h.floorplan_url, 'user')
  returning id into nieuw_hoofd;

  insert into rommelroutes (groep_id, organisator_id, vorige_groep_id) values (nieuw_groep, h.user_id, p_groep);

  for r in
    select l.*, a.id as a_id, a.mag_uitnodigen, a.email as a_email
    from listings l
    left join route_aanmeldingen a on a.listing_id = l.id
    where l.neighborhood_group_id = p_groep and l.id <> h.id
      and l.confirmation_status = 'confirmed' and coalesce(l.address, '') <> '' and l.status <> 'cancelled'
  loop
    if r.a_id is not null then
      continue when not (r.mag_uitnodigen and r.a_email is not null);
      insert into route_aanmeldingen (groep_id, adres, postcode, plaats, latitude, longitude, naam, email, wat_verkoop,
        taal, mag_uitnodigen, status)
      select nieuw_groep, a.adres, a.postcode, a.plaats, a.latitude, a.longitude, a.naam, a.email, a.wat_verkoop,
        a.taal, true, 'uitgenodigd'
      from route_aanmeldingen a where a.id = r.a_id
      returning token into nieuw_token;
      n_uitgenodigd := n_uitgenodigd + 1;
    else
      nieuw_token := gen_random_uuid();
      links := links || jsonb_build_object('adres', r.address, 'label', r.confirmation_address_label, 'token', nieuw_token);
    end if;

    insert into listings (user_id, title, description, category, address, city, postal_code, latitude, longitude,
      date_start, date_end, time_start, time_end, images, tags, status, neighborhood_group_id, address_reveal_mode,
      confirmation_token, confirmation_status, confirmation_method, confirmation_address_label, placed_by)
    values (h.user_id, h.title, r.description, 'buurtverkoop', r.address, r.city, r.postal_code, r.latitude, r.longitude,
      p_datum, case when span > 0 then p_datum + span end,
      coalesce(p_tijd_van, h.time_start), coalesce(p_tijd_tot, h.time_end), h.images, h.tags, 'active', nieuw_groep,
      h.address_reveal_mode, nieuw_token, 'pending', 'self_confirmed', r.confirmation_address_label, 'user');

    if r.a_id is not null then
      update route_aanmeldingen set listing_id = (select id from listings where confirmation_token = nieuw_token)
        where token = nieuw_token;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'groep_id', nieuw_groep, 'hoofd_id', nieuw_hoofd,
    'links', links, 'uitgenodigd', n_uitgenodigd);
end $$;

-- ── 4. Buur (openbaar, via code of token) ───────────────────

create or replace function public.route_aanmelding_context(p_code text)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'titel', h.title, 'plaats', h.city, 'datum', h.date_start, 'datum_eind', h.date_end,
    'tijd_van', to_char(h.time_start, 'HH24:MI'), 'tijd_tot', to_char(h.time_end, 'HH24:MI'),
    'organisator', coalesce(nullif(split_part(p.display_name, ' ', 1), ''), null),
    'open', m.inschrijving_open and h.status = 'active',
    'voorbij', coalesce(h.date_end, h.date_start) < current_date,
    -- Grof (ca. 1 km) zodat het adres van de organisator niet uitlekt; alleen om
    -- de adreszoeker in de buurt te laten zoeken.
    'lat', round(h.latitude::numeric, 2), 'lng', round(h.longitude::numeric, 2),
    'hoofd_id', h.id)
  from rommelroutes m
  cross join lateral (select * from route_hoofd(m.groep_id)) h
  left join profiles p on p.id = h.user_id
  where m.inschrijf_code = p_code and h.id is not null
$$;

create or replace function public.route_aanmelden(
  p_code text, p_adres text, p_postcode text, p_plaats text, p_lat double precision, p_lng double precision,
  p_naam text default null, p_email text default null, p_wat text default null, p_taal text default 'nl',
  p_mag_uitnodigen boolean default false, p_website text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  m rommelroutes;
  h listings;
  ip text := ip_hash_verzoek();
  km double precision;
  nieuw_token uuid;
begin
  -- Honeypot: bots vullen dit verborgen veld in. Doe alsof het gelukt is.
  if coalesce(p_website, '') <> '' then return jsonb_build_object('ok', true, 'status', 'nieuw'); end if;

  select * into m from rommelroutes where inschrijf_code = p_code;
  if not found then return jsonb_build_object('ok', false, 'reden', 'onbekend'); end if;
  h := route_hoofd(m.groep_id);
  if h.id is null or h.status <> 'active' or not m.inschrijving_open then
    return jsonb_build_object('ok', false, 'reden', 'gesloten');
  end if;
  if coalesce(h.date_end, h.date_start) < current_date then
    return jsonb_build_object('ok', false, 'reden', 'voorbij');
  end if;

  p_adres := nullif(trim(p_adres), ''); p_plaats := nullif(trim(p_plaats), '');
  p_postcode := nullif(upper(trim(p_postcode)), ''); p_naam := nullif(trim(p_naam), '');
  p_email := nullif(lower(trim(p_email)), ''); p_wat := nullif(trim(p_wat), '');
  if p_adres is null or length(p_adres) > 120 or length(coalesce(p_plaats, '')) > 80 or length(coalesce(p_postcode, '')) > 10
     or length(coalesce(p_naam, '')) > 60 or length(coalesce(p_wat, '')) > 300 or length(coalesce(p_email, '')) > 120
     or (p_email is not null and p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
     or p_lat is null or p_lng is null then
    return jsonb_build_object('ok', false, 'reden', 'ongeldig');
  end if;

  -- Het adres moet in de buurt van de route liggen (max 15 km van de organisator).
  km := sqrt(power((p_lat - h.latitude) * 111.2, 2) + power((p_lng - h.longitude) * 111.2 * cos(radians(h.latitude)), 2));
  if km > 15 then return jsonb_build_object('ok', false, 'reden', 'te_ver'); end if;

  -- Misbruik afremmen: max 5 aanmeldingen per uur per IP, max 150 open per route.
  if (select count(*) from route_aanmeldingen where ip_hash = ip and created_at > now() - interval '1 hour') >= 5
     or (select count(*) from route_aanmeldingen where groep_id = m.groep_id and status = 'nieuw') >= 150 then
    return jsonb_build_object('ok', false, 'reden', 'limiet');
  end if;

  -- Dubbel? Zelfde adres al aangemeld, of al een adres op (vrijwel) dezelfde plek.
  if exists (select 1 from route_aanmeldingen
             where groep_id = m.groep_id and status in ('nieuw', 'uitgenodigd', 'goedgekeurd')
               and lower(adres) = lower(p_adres) and coalesce(postcode, '') = coalesce(p_postcode, ''))
     or exists (select 1 from listings
                where neighborhood_group_id = m.groep_id and confirmation_status in ('confirmed', 'pending')
                  and latitude between p_lat - 0.0002 and p_lat + 0.0002
                  and longitude between p_lng - 0.0003 and p_lng + 0.0003) then
    return jsonb_build_object('ok', true, 'status', 'bestaat_al');
  end if;

  insert into route_aanmeldingen (groep_id, adres, postcode, plaats, latitude, longitude, naam, email, wat_verkoop,
    taal, mag_uitnodigen, status, toestemming_at, ip_hash)
  values (m.groep_id, p_adres, p_postcode, p_plaats, p_lat, p_lng, p_naam, p_email, p_wat,
    case when p_taal in ('nl', 'en', 'fr', 'de') then p_taal else 'nl' end,
    coalesce(p_mag_uitnodigen, false) and p_email is not null, 'nieuw', now(), ip)
  returning token into nieuw_token;
  return jsonb_build_object('ok', true, 'status', 'nieuw', 'token', nieuw_token);
end $$;

create or replace function public.route_aanmelding_status(p_token uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'status', a.status, 'adres', a.adres, 'plaats', a.plaats, 'naam', a.naam,
    'titel', h.title, 'datum', h.date_start, 'datum_eind', h.date_end,
    'tijd_van', to_char(h.time_start, 'HH24:MI'), 'tijd_tot', to_char(h.time_end, 'HH24:MI'),
    'voorbij', coalesce(h.date_end, h.date_start) < current_date,
    'hoofd_id', h.id, 'listing_id', a.listing_id)
  from route_aanmeldingen a
  cross join lateral (select * from route_hoofd(a.groep_id)) h
  where a.token = p_token
$$;

-- Een uitgenodigde buur (volgende editie) zegt ja: direct online, de
-- organisator heeft hem zelf uitgenodigd.
create or replace function public.route_aanmelding_bevestig(p_token uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  a route_aanmeldingen;
  h listings;
begin
  select * into a from route_aanmeldingen where token = p_token for update;
  if not found then return jsonb_build_object('ok', false, 'reden', 'onbekend'); end if;
  if a.status = 'goedgekeurd' then return jsonb_build_object('ok', true, 'status', 'goedgekeurd', 'al_gedaan', true); end if;
  if a.status <> 'uitgenodigd' then return jsonb_build_object('ok', false, 'reden', a.status); end if;
  h := route_hoofd(a.groep_id);
  if h.id is null or coalesce(h.date_end, h.date_start) < current_date then
    return jsonb_build_object('ok', false, 'reden', 'voorbij');
  end if;
  update listings set confirmation_status = 'confirmed', confirmation_responded_at = now(), status = 'active'
    where confirmation_token = a.token and confirmation_status = 'pending';
  if not found then return jsonb_build_object('ok', false, 'reden', 'verlopen'); end if;
  update route_aanmeldingen set status = 'goedgekeurd', toestemming_at = now(), beoordeeld_at = now(),
    buur_gemaild_at = coalesce(buur_gemaild_at, now())
    where id = a.id;
  return jsonb_build_object('ok', true, 'status', 'goedgekeurd');
end $$;

-- Afmelden (toestemming intrekken): gegevens direct wissen, listing offline.
create or replace function public.route_afmelden(p_token uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare a route_aanmeldingen;
begin
  select * into a from route_aanmeldingen where token = p_token for update;
  if not found then return jsonb_build_object('ok', false, 'reden', 'onbekend'); end if;
  if a.status in ('ingetrokken', 'afgewezen', 'verlopen') then return jsonb_build_object('ok', true, 'al_gedaan', true); end if;
  update listings
    set confirmation_status = 'declined', confirmation_responded_at = now(), status = 'cancelled',
        address = '', postal_code = null, latitude = null, longitude = null, participant_display_name = null
    where confirmation_token = a.token;
  update route_aanmeldingen
    set status = 'ingetrokken', beoordeeld_at = now(), mag_uitnodigen = false,
        adres = null, postcode = null, latitude = null, longitude = null, naam = null, email = null, wat_verkoop = null
    where id = a.id;
  return jsonb_build_object('ok', true);
end $$;

-- ── 5. Weergaven en "ik ga" ─────────────────────────────────

-- +1 per keer dat een listing geopend wordt (de app doet dit max één keer per sessie).
create or replace function public.listing_bekeken(p_id uuid)
returns void
language sql security definer set search_path = public
as $$
  insert into listing_weergaven (listing_id, aantal)
  select id, 1 from listings where id = p_id and status = 'active'
  on conflict (listing_id) do update set aantal = listing_weergaven.aantal + 1
$$;

-- Echte "gaan erheen"-aantallen. De app toonde tot nu toe view_count.
-- listing_interests is al openbaar leesbaar; dit telt alleen samen.
create or replace function public.listing_ik_ga_aantallen()
returns table(listing_id uuid, aantal integer)
language sql stable security definer set search_path = public
as $$
  select i.listing_id, count(*)::int
  from listing_interests i join listings l on l.id = i.listing_id
  where l.status = 'active' and coalesce(l.date_end, l.date_start) >= current_date
  group by 1
$$;

-- Weergaven, "ik ga" en favorieten van je eigen listings (Mijn verkopen).
create or replace function public.mijn_listing_stats()
returns table(listing_id uuid, weergaven integer, ik_ga integer, favorieten integer)
language sql stable security definer set search_path = public
as $$
  select l.id,
    coalesce((select w.aantal from listing_weergaven w where w.listing_id = l.id), 0),
    (select count(*)::int from listing_interests i where i.listing_id = l.id),
    (select count(*)::int from favorites f where f.listing_id = l.id)
  from listings l
  where l.user_id = auth.uid() and l.status = 'active' and coalesce(l.date_end, l.date_start) >= current_date - 400
$$;

-- ── 6. Voor de edge function rommelroute (service role) ─────

-- Routes die gisteren t/m 3 dagen geleden afliepen en nog geen rapport kregen.
create or replace function public.route_rapport_kandidaten()
returns table(groep_id text, organisator_id uuid, titel text, datum date, stats jsonb)
language sql stable security definer set search_path = public
as $$
  with g as (
    select neighborhood_group_id as groep_id, max(coalesce(date_end, date_start)) as eind
    from listings where neighborhood_group_id is not null and status <> 'cancelled'
    group by 1
    having max(coalesce(date_end, date_start)) between current_date - 3 and current_date - 1
  )
  select g.groep_id, h.user_id, h.title, h.date_start, route_stats(g.groep_id)
  from g cross join lateral (select * from route_hoofd(g.groep_id)) h
  left join rommelroutes m on m.groep_id = g.groep_id
  where h.id is not null and coalesce(h.placed_by, 'user') = 'user' and m.rapport_verstuurd_at is null
$$;

create or replace function public.route_rapport_gedaan(p_groep text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform route_meta(p_groep);
  update rommelroutes set rapport_verstuurd_at = now() where groep_id = p_groep;
end $$;

-- Dataminimalisatie. Dagelijks via de edge function.
--   - Aanmeldingen die nooit beoordeeld werden en waarvan de route voorbij is: wissen.
--   - Uitnodigingen waarvan de pending-listing verlopen is: wissen.
--   - 30 dagen na de route: e-mail weg, tenzij de buur "mail me bij een
--     volgende editie" aanvinkte.
--   - 400 dagen na de route: alles weg.
create or replace function public.route_opruimen()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare n1 int; n2 int; n3 int; n4 int;
begin
  update route_aanmeldingen a
    set status = 'verlopen', adres = null, postcode = null, latitude = null, longitude = null,
        naam = null, email = null, wat_verkoop = null, mag_uitnodigen = false
    where a.status = 'nieuw'
      and exists (select 1 from listings l where l.neighborhood_group_id = a.groep_id
                  group by l.neighborhood_group_id having max(coalesce(l.date_end, l.date_start)) < current_date);
  get diagnostics n1 = row_count;

  update route_aanmeldingen a
    set status = 'verlopen', adres = null, postcode = null, latitude = null, longitude = null,
        naam = null, email = null, wat_verkoop = null, mag_uitnodigen = false
    where a.status = 'uitgenodigd'
      and not exists (select 1 from listings l where l.confirmation_token = a.token and l.confirmation_status = 'pending');
  get diagnostics n2 = row_count;

  update route_aanmeldingen a set email = null
    where a.email is not null and not a.mag_uitnodigen
      and exists (select 1 from listings l where l.neighborhood_group_id = a.groep_id
                  group by l.neighborhood_group_id having max(coalesce(l.date_end, l.date_start)) < current_date - 30);
  get diagnostics n3 = row_count;

  delete from route_aanmeldingen a
    where not exists (select 1 from listings l where l.neighborhood_group_id = a.groep_id
                      and coalesce(l.date_end, l.date_start) >= current_date - 400);
  get diagnostics n4 = row_count;

  return jsonb_build_object('nieuw_verlopen', n1, 'uitnodiging_verlopen', n2, 'email_gewist', n3, 'verwijderd', n4);
end $$;

-- ── 7. Bugfix bestaande buur-bevestiging ────────────────────

create or replace function public.decline_buurt_listing(p_token uuid, p_reason text default null)
returns table(success boolean, message text)
language plpgsql security definer set search_path = public
as $$
declare r record;
begin
  select id, confirmation_status into r from public.listings where confirmation_token = p_token limit 1;
  if not found then
    return query select false, 'Onbekende of ongeldige link.'; return;
  end if;
  if r.confirmation_status = 'declined' then
    return query select true, 'Je adres was al verwijderd. Geen probleem.'; return;
  end if;
  -- Adresgegevens direct wissen (AVG art. 5c). Was status 'inactive', dat de
  -- check op listings.status niet toestaat; daardoor faalde dit stil.
  update public.listings
    set confirmation_status = 'declined', confirmation_responded_at = now(),
        confirmation_declined_reason = nullif(trim(p_reason), ''),
        address = '', postal_code = null, latitude = null, longitude = null, status = 'cancelled'
    where id = r.id;
  -- Kwam deze buur via de open inschrijving? Dan ook daar wissen.
  update public.route_aanmeldingen
    set status = 'ingetrokken', beoordeeld_at = now(), mag_uitnodigen = false,
        adres = null, postcode = null, latitude = null, longitude = null, naam = null, email = null, wat_verkoop = null
    where token = p_token and status not in ('ingetrokken', 'afgewezen', 'verlopen');
  return query select true, 'Je adres is verwijderd. De organisator ziet dit direct in zijn/haar overzicht.';
end $$;

create or replace function public.expire_old_pending_confirmations()
returns integer
language plpgsql security definer set search_path = public
as $$
declare affected integer;
begin
  update public.listings
    set confirmation_status = 'expired', confirmation_responded_at = now(),
        address = '', postal_code = null, latitude = null, longitude = null, status = 'cancelled'
    where confirmation_status = 'pending' and created_at < now() - interval '7 days';
  get diagnostics affected = row_count;
  return affected;
end $$;

-- ── 8. Rechten ──────────────────────────────────────────────

revoke all on function public.mijn_rommelroutes() from public, anon;
revoke all on function public.route_beheer(text) from public, anon;
revoke all on function public.route_inschrijving_zet(text, boolean) from public, anon;
revoke all on function public.route_aanmelding_beoordelen(uuid, boolean) from public, anon;
revoke all on function public.route_opnieuw(text, date, time, time) from public, anon;
revoke all on function public.mijn_listing_stats() from public, anon;
grant execute on function public.mijn_rommelroutes() to authenticated;
grant execute on function public.route_beheer(text) to authenticated;
grant execute on function public.route_inschrijving_zet(text, boolean) to authenticated;
grant execute on function public.route_aanmelding_beoordelen(uuid, boolean) to authenticated;
grant execute on function public.route_opnieuw(text, date, time, time) to authenticated;
grant execute on function public.mijn_listing_stats() to authenticated;

-- De code of token in de link is het bewijs (onraadbaar); de pagina is openbaar.
grant execute on function public.route_aanmelding_context(text) to anon, authenticated;
grant execute on function public.route_aanmelden(text, text, text, text, double precision, double precision, text, text, text, text, boolean, text) to anon, authenticated;
grant execute on function public.route_aanmelding_status(uuid) to anon, authenticated;
grant execute on function public.route_aanmelding_bevestig(uuid) to anon, authenticated;
grant execute on function public.route_afmelden(uuid) to anon, authenticated;
grant execute on function public.listing_bekeken(uuid) to anon, authenticated;
grant execute on function public.listing_ik_ga_aantallen() to anon, authenticated;

revoke all on function public.route_rapport_kandidaten() from public, anon, authenticated;
revoke all on function public.route_rapport_gedaan(text) from public, anon, authenticated;
revoke all on function public.route_opruimen() from public, anon, authenticated;
grant execute on function public.route_rapport_kandidaten() to service_role;
grant execute on function public.route_rapport_gedaan(text) to service_role;
grant execute on function public.route_opruimen() to service_role;

-- Cron (20 okt 2026, ingesteld): elk uur op :20 (meldingen, uitnodigingen, rapporten, opruimen).
-- select cron.schedule('yardigo-rommelroute', '20 * * * *', $$
--   select net.http_post(url := 'https://fwehqudhwzcnkcuypuqw.supabase.co/functions/v1/rommelroute',
--     headers := jsonb_build_object('Content-Type', 'application/json',
--                                   'x-cron-secret', (select value from public.app_config where key = 'cron_secret')),
--     body := '{}'::jsonb, timeout_milliseconds := 120000);
-- $$);

-- Cron (20 okt 2026, akkoord Christian): pending buur-adressen verlopen na 7 dagen.
-- Stond nooit ingepland; bij de eerste run zijn 2 adressen uit mei gewist.
-- select cron.schedule('yardigo-buur-bevestiging-verlopen', '40 3 * * *',
--   $$ select public.expire_old_pending_confirmations(); $$);

-- Analytics (20 okt 2026): de analytics_*-functies hadden al een admincheck,
-- maar waren voor anon aanroepbaar. Nu alleen nog voor ingelogde gebruikers:
-- do $$ declare f regprocedure; begin
--   for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--            where n.nspname = 'public' and p.proname like 'analytics\_%' loop
--     execute format('revoke execute on function %s from public, anon', f);
--     execute format('grant execute on function %s to authenticated', f);
--   end loop; end $$;
