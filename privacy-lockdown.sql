-- YardiGo – privacy lockdown (okt 2026)
--
-- Probleem: de listings-tabel was voor anon/authenticated volledig leesbaar
-- (alle kolommen). Het verbergen van het adres gebeurde alleen in de app;
-- via /rest/v1/listings?select=address kon iedereen alle adressen ophalen.
--
-- Oplossing:
-- 1. listing_is_private(): opritverkoop/garagesale en buurtverkoop-deelnemers
--    (thuisadressen). Markten, braderieën, rommelroutes blijven exact.
-- 2. listing_fuzz(): vaste (deterministische) verschuiving van 80–200 m, zodat
--    herhaald opvragen het echte punt niet verraadt.
-- 3. Kolom-grants: anon/authenticated mogen adres, coördinaten, postcode en
--    tokens niet meer rechtstreeks lezen. Alles loopt via de RPC's:
--      get_listings_for_user()  – de kaart (app)
--      get_listings_seo()       – prerender (SEO-pagina's)
--      admin_listings()         – admin.html
-- 4. Particuliere curated listings krijgen reveal-mode 'day_before'.
-- 5. Server-only functies niet meer aanroepbaar door anon/authenticated.
-- 6. Rate-limit: max 300 kaart-opvragingen met adres per gebruiker per uur.

-- ── 1/2. Helpers ───────────────────────────────────────────────────
create or replace function public.listing_is_private(p_category text, p_subtype text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_category, '') in ('garagesale', 'buurtverkoop')
      or lower(coalesce(p_subtype, '')) in ('opritverkoop', 'garagesale', 'garageverkoop', 'tuinverkoop')
$$;

create or replace function public.listing_fuzz(p_id uuid, p_lat float8, p_lng float8,
                                               out lat float8, out lng float8)
language plpgsql immutable set search_path = '' as $$
declare
  h bytea := decode(md5(p_id::text), 'hex');
  a float8 := get_byte(h, 0) / 255.0 * 2 * pi();
  r float8 := 80 + get_byte(h, 1) / 255.0 * 120;   -- meters
begin
  if p_lat is null or p_lng is null then lat := null; lng := null; return; end if;
  lat := round((p_lat + r * cos(a) / 111320.0)::numeric, 4)::float8;
  lng := round((p_lng + r * sin(a) / (111320.0 * cos(radians(p_lat))))::numeric, 4)::float8;
end $$;

-- ── 4. Particuliere curated listings: adres pas 24u vooraf ─────────
update public.listings set address_reveal_mode = 'day_before'
 where placed_by = 'yardigo' and public.listing_is_private(category, event_subtype)
   and address_reveal_mode <> 'day_before';

-- ── 6. Rate-limit-log ──────────────────────────────────────────────
create table if not exists public.address_access_log (
  user_id uuid not null,
  hour    timestamptz not null,
  calls   int not null default 0,
  primary key (user_id, hour)
);
alter table public.address_access_log enable row level security;
revoke all on public.address_access_log from anon, authenticated;

-- ── Kaart-RPC ──────────────────────────────────────────────────────
drop function if exists public.get_listings_for_user();
create function public.get_listings_for_user()
returns table (
  id uuid, user_id uuid, title text, description text, category text,
  address text, city text, postal_code text, latitude float8, longitude float8,
  date_start date, date_end date, time_start time, time_end time,
  images text[], tags text[], status text, view_count int,
  created_at timestamptz, updated_at timestamptz,
  address_reveal_mode text, address_visible_at timestamptz,
  neighborhood_group_id text, confirmation_status text, confirmation_method text,
  event_subtype text, placed_by text, source_url text, source_label text,
  claim_token text, claimed_by_user_id uuid, claimed_at timestamptz,
  location_approx boolean, short_code text
)
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  calls int := 0;
  throttled boolean := false;
begin
  if uid is not null then
    insert into address_access_log as a (user_id, hour, calls)
    values (uid, date_trunc('hour', now()), 1)
    on conflict (user_id, hour) do update set calls = a.calls + 1
    returning a.calls into calls;
    throttled := calls > 300 and not coalesce(is_yg_admin(uid), false);
  end if;

  return query
  with base as (
    select l.*,
      listing_is_private(l.category, l.event_subtype) as priv,
      case when l.address_reveal_mode = 'instant' then null
           else ((l.date_start + coalesce(l.time_start, time '08:00'))::timestamp
                 at time zone 'Europe/Amsterdam') - interval '24 hours' end as vis_at
    from listings l
    where l.status = 'active'
      and coalesce(l.date_end, l.date_start) >= current_date
      and (l.confirmation_status = 'confirmed' or (uid is not null and l.user_id = uid))
  ), shown as (
    select b.*,
      case
        when uid is not null and b.user_id = uid then true
        when uid is null or throttled then false
        when b.confirmation_status <> 'confirmed' then false
        when b.vis_at is null or now() >= b.vis_at then true
        else false
      end as addr_ok
    from base b
  )
  select s.id, s.user_id, s.title, s.description, s.category,
    case when s.addr_ok then s.address end,
    s.city,
    case when s.addr_ok or not s.priv then s.postal_code else left(s.postal_code, 4) end,
    case when s.priv and not s.addr_ok then (listing_fuzz(s.id, s.latitude, s.longitude)).lat else s.latitude end,
    case when s.priv and not s.addr_ok then (listing_fuzz(s.id, s.latitude, s.longitude)).lng else s.longitude end,
    s.date_start, s.date_end, s.time_start, s.time_end,
    s.images, s.tags, s.status, s.view_count, s.created_at, s.updated_at,
    s.address_reveal_mode,
    case when s.addr_ok then null else s.vis_at end,
    s.neighborhood_group_id::text, s.confirmation_status, s.confirmation_method,
    s.event_subtype, s.placed_by, s.source_url, s.source_label,
    null::text, s.claimed_by_user_id, s.claimed_at,
    (s.priv and not s.addr_ok), s.short_code
  from shown s;
end $$;
revoke all on function public.get_listings_for_user() from public;
grant execute on function public.get_listings_for_user() to anon, authenticated;

-- ── SEO-RPC voor build/prerender.mjs ───────────────────────────────
-- Markten: adres + exacte coördinaten (goed voor vindbaarheid).
-- Particulier: geen adres, verschoven coördinaten.
create or replace function public.get_listings_seo()
returns table (
  id uuid, title text, category text, event_subtype text,
  date_start date, date_end date, time_start time, time_end time,
  address text, city text, latitude float8, longitude float8,
  address_reveal_mode text, description text, images text[],
  confirmation_status text, user_id uuid, status text
)
language sql stable security definer set search_path = public as $$
  select l.id, l.title, l.category, l.event_subtype,
    l.date_start, l.date_end, l.time_start, l.time_end,
    case when listing_is_private(l.category, l.event_subtype) or l.address_reveal_mode <> 'instant'
         then null else l.address end,
    l.city,
    case when listing_is_private(l.category, l.event_subtype) then (listing_fuzz(l.id, l.latitude, l.longitude)).lat else l.latitude end,
    case when listing_is_private(l.category, l.event_subtype) then (listing_fuzz(l.id, l.latitude, l.longitude)).lng else l.longitude end,
    case when listing_is_private(l.category, l.event_subtype) then 'day_before' else l.address_reveal_mode end,
    l.description, l.images, l.confirmation_status, l.user_id, l.status
  from listings l
  where l.status = 'active' and coalesce(l.confirmation_status, 'confirmed') = 'confirmed'
  order by l.date_start desc
  limit 2000
$$;
revoke all on function public.get_listings_seo() from public;
grant execute on function public.get_listings_seo() to anon, authenticated;

-- ── Admin-RPC (admin.html laadt hiermee alle kolommen) ──────────────
create or replace function public.admin_listings()
returns setof public.listings
language plpgsql stable security definer set search_path = public as $$
begin
  if not (coalesce(is_yg_admin(auth.uid()), false)
          or exists (select 1 from profiles where id = auth.uid() and is_admin)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query select * from listings order by created_at desc;
end $$;
revoke all on function public.admin_listings() from public, anon;
grant execute on function public.admin_listings() to authenticated;

-- ── 3. Kolom-grants op listings ────────────────────────────────────
revoke select, truncate, trigger, references on public.listings from anon, authenticated;
grant select (
  id, user_id, title, description, category, city, date_start, date_end,
  time_start, time_end, is_recurring, recurrence_rule, images, tags, status,
  view_count, created_at, updated_at, neighborhood_group_id, address_reveal_mode,
  confirmation_status, confirmation_responded_at, participant_display_name,
  event_subtype, floorplan_url, confirmation_method, organizer_consent_declared_at,
  placed_by, source_url, source_label, claimed_by_user_id, claimed_at,
  curator_user_id, short_code, reminder_3d_sent_at, reminder_7d_sent_at
) on public.listings to anon, authenticated;

-- ── 5. Server-only functies ─────────────────────────────────────────
revoke execute on function public.get_pending_reminders(text) from public, anon, authenticated;
revoke execute on function public.mark_reminders_sent(uuid[], text) from public, anon, authenticated;
revoke execute on function public.expire_old_pending_confirmations() from public, anon, authenticated;
revoke execute on function public.cleanup_old_page_views() from public, anon, authenticated;
revoke execute on function public.discovery_find_similar(text, float8, float8, date, int) from public, anon, authenticated;
revoke execute on function public.discovery_find_similar_ref(text, float8, float8, date, int) from public, anon, authenticated;
revoke execute on function public.nearby_listings(float8, float8, float8) from public, anon, authenticated;

-- ── 7. Views ────────────────────────────────────────────────────────
-- listing_claims_queue liep als view-eigenaar en omzeilde zo RLS: elke
-- ingelogde gebruiker kon e-mail/telefoon/verificatiecode van alle claims
-- lezen. Met security_invoker gelden de policies van listing_claims weer
-- (admin: alles, gebruiker: eigen claims).
alter view public.listing_claims_queue set (security_invoker = on);
-- v_listing_bronnen (bronnen/leads) is alleen voor beheer.
revoke all on public.v_listing_bronnen from anon, authenticated;
