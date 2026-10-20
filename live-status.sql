-- Fase 4 (20 okt 2026): live op de dag zelf.
--
-- Per listing een live-status voor de dag van de verkoop: open, bijna leeg of
-- gesloten, eventueel met "nog veel <categorie>" (een tag van die listing).
--   - De eigenaar zet hem met één tik (Mijn verkopen). De organisator van een
--     rommelroute is eigenaar van alle adressen, dus kan het voor iedereen.
--   - Een buur zonder account zet hem via zijn persoonlijke token (dezelfde
--     uuid als listings.confirmation_token; ook route_aanmeldingen.token is
--     daaraan gelijk), op /doe-mee?t=<token>.
--   - Zetten kan alleen op de dag zelf (Europe/Amsterdam). De status geldt tot
--     de eindtijd van die dag (of middernacht als er geen eindtijd is); de app
--     leest alleen geldige rijen, route_opruimen wist de rest.
-- Bewust een aparte tabel: niet in get_listings_map (anti-scraping) en een
-- update op listings zou updated_at (SEO lastmod) laten verspringen.

create table if not exists public.listing_live_status (
  listing_id uuid primary key references public.listings(id) on delete cascade,
  status     text not null check (status in ('open', 'bijna_leeg', 'gesloten')),
  categorie  text,
  geldig_tot timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists idx_live_status_geldig on public.listing_live_status (geldig_tot);
-- RLS aan, bewust geen policies: alleen via de RPC's hieronder.
alter table public.listing_live_status enable row level security;

-- ── Interne kern (niet via de API aanroepbaar) ──────────────

create or replace function public.live_status_schrijf(p_listing uuid, p_status text, p_categorie text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  l listings;
  vandaag date := (now() at time zone 'Europe/Amsterdam')::date;
  tot timestamptz;
  vorige timestamptz;
begin
  if p_status not in ('open', 'bijna_leeg', 'gesloten') then
    return jsonb_build_object('ok', false, 'reden', 'status');
  end if;
  select * into l from listings where id = p_listing;
  if not found or l.status <> 'active' or coalesce(l.confirmation_status, 'confirmed') <> 'confirmed' then
    return jsonb_build_object('ok', false, 'reden', 'onbekend');
  end if;
  if vandaag < l.date_start or vandaag > coalesce(l.date_end, l.date_start) then
    return jsonb_build_object('ok', false, 'reden', 'niet_vandaag');
  end if;
  -- Categorie alleen uit de eigen tags, anders leeg.
  if p_categorie is not null and not (p_categorie = any(coalesce(l.tags, '{}'))) then
    p_categorie := null;
  end if;
  if p_status = 'gesloten' then p_categorie := null; end if;
  tot := case when l.time_end is not null and l.time_end > coalesce(l.time_start, '00:00')
              then (vandaag + l.time_end) at time zone 'Europe/Amsterdam'
              else (vandaag + 1)::timestamp at time zone 'Europe/Amsterdam' end;
  if tot <= now() then
    return jsonb_build_object('ok', false, 'reden', 'voorbij');
  end if;
  -- Eenvoudige rem tegen spammen: max één wijziging per 5 seconden.
  select updated_at into vorige from listing_live_status where listing_id = l.id;
  if vorige is not null and vorige > now() - interval '5 seconds' then
    return jsonb_build_object('ok', false, 'reden', 'te_snel');
  end if;
  insert into listing_live_status (listing_id, status, categorie, geldig_tot, updated_at)
    values (l.id, p_status, p_categorie, tot, now())
    on conflict (listing_id) do update
      set status = excluded.status, categorie = excluded.categorie,
          geldig_tot = excluded.geldig_tot, updated_at = now();
  return jsonb_build_object('ok', true, 'status', p_status, 'categorie', p_categorie, 'geldig_tot', tot);
end $$;

revoke all on function public.live_status_schrijf(uuid, text, text) from public, anon, authenticated;

-- ── Eigenaar (ingelogd) ─────────────────────────────────────

create or replace function public.live_status_zet(p_listing uuid, p_status text, p_categorie text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from listings where id = p_listing and user_id = (select auth.uid())) then
    return jsonb_build_object('ok', false, 'reden', 'geen_eigenaar');
  end if;
  return live_status_schrijf(p_listing, p_status, p_categorie);
end $$;

revoke all on function public.live_status_zet(uuid, text, text) from public, anon;
grant execute on function public.live_status_zet(uuid, text, text) to authenticated;

-- ── Buur zonder account (token) ─────────────────────────────

create or replace function public.live_status_token_context(p_token uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'listing_id', l.id,
    'vandaag', (now() at time zone 'Europe/Amsterdam')::date between l.date_start and coalesce(l.date_end, l.date_start),
    'tags', coalesce(l.tags, '{}'),
    'status', s.status, 'categorie', s.categorie, 'updated_at', s.updated_at)
  from listings l
  left join listing_live_status s on s.listing_id = l.id and s.geldig_tot > now()
  where l.confirmation_token = p_token and l.status = 'active' and l.confirmation_status = 'confirmed'
$$;

create or replace function public.live_status_zet_token(p_token uuid, p_status text, p_categorie text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare lid uuid;
begin
  select id into lid from listings where confirmation_token = p_token;
  if lid is null then return jsonb_build_object('ok', false, 'reden', 'onbekend'); end if;
  return live_status_schrijf(lid, p_status, p_categorie);
end $$;

revoke all on function public.live_status_token_context(uuid) from public;
revoke all on function public.live_status_zet_token(uuid, text, text) from public;
grant execute on function public.live_status_token_context(uuid) to anon, authenticated;
grant execute on function public.live_status_zet_token(uuid, text, text) to anon, authenticated;

-- ── Openbaar: alle geldige statussen (kaart, lijst, route) ──

create or replace function public.live_statussen()
returns table(listing_id uuid, status text, categorie text, updated_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select s.listing_id, s.status, s.categorie, s.updated_at
  from listing_live_status s join listings l on l.id = s.listing_id
  where s.geldig_tot > now() and l.status = 'active'
$$;

revoke all on function public.live_statussen() from public;
grant execute on function public.live_statussen() to anon, authenticated;

-- ── Opruimen: verlopen statussen wissen (via route_opruimen, elk uur) ──

create or replace function public.live_status_opruimen()
returns integer
language sql security definer set search_path = public
as $$
  with d as (delete from listing_live_status where geldig_tot < now() returning 1)
  select count(*)::int from d
$$;

revoke all on function public.live_status_opruimen() from public, anon, authenticated;
grant execute on function public.live_status_opruimen() to service_role;

-- ── Ochtendmail aan buren op de dag van de route ────────────
-- Kandidaten: bevestigde buur-adressen (met token) van routes die vandaag
-- zijn, met een e-mailadres uit route_aanmeldingen, nog niet gemaild.

alter table public.route_aanmeldingen add column if not exists live_gemaild_at timestamptz;

create or replace function public.route_live_kandidaten()
returns table(aanmelding_id uuid, email text, taal text, token uuid, naam text, titel text, tijd_van text, tijd_tot text)
language sql stable security definer set search_path = public
as $$
  select a.id, a.email, a.taal, a.token, a.naam, l.title,
         to_char(l.time_start, 'HH24:MI'), to_char(l.time_end, 'HH24:MI')
  from route_aanmeldingen a
  join listings l on l.confirmation_token = a.token
  where a.status = 'goedgekeurd' and a.email is not null and a.live_gemaild_at is null
    and l.status = 'active' and l.confirmation_status = 'confirmed'
    and (now() at time zone 'Europe/Amsterdam')::date between l.date_start and coalesce(l.date_end, l.date_start)
    and (now() at time zone 'Europe/Amsterdam')::time >= time '07:00'
    and (l.time_end is null or (now() at time zone 'Europe/Amsterdam')::time < l.time_end)
$$;

create or replace function public.route_live_gemaild(p_id uuid)
returns void
language sql security definer set search_path = public
as $$
  update route_aanmeldingen set live_gemaild_at = now() where id = p_id
$$;

revoke all on function public.route_live_kandidaten() from public, anon, authenticated;
revoke all on function public.route_live_gemaild(uuid) from public, anon, authenticated;
grant execute on function public.route_live_kandidaten() to service_role;
grant execute on function public.route_live_gemaild(uuid) to service_role;
