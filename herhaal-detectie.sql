-- Fase 2 (19 okt 2026): jaarlijks terugkerende markten herkennen.
--
-- Elke nacht (edge function herhaal-check) zoeken we markten van vorig jaar
-- waarvan de verwachte nieuwe editie over 6 tot 8 weken is en die er nog niet
-- op staan. Verwachte datum = 52 weken later (zelfde weekdag).
--   Organisator met account (zelf geplaatst of geclaimd): mail met een link
--   naar /herhaal?t=<token>. Daar één klik: zelfde markt, nieuwe datum.
--   Geïmporteerd zonder account: kaartje in Telegram voor Christian.
-- Particuliere verkopen (garagesale/opritverkoop) en buurtverkopen (meerdere
-- adressen met bevestigingen) doen niet mee.

create table if not exists public.herhaal_verzoeken (
  id               bigserial primary key,
  vorig_listing_id uuid not null unique references public.listings(id) on delete cascade,
  eigenaar_id      uuid references public.profiles(id) on delete set null,
  kanaal           text not null check (kanaal in ('mail', 'telegram')),
  verwachte_datum  date not null,
  token            uuid not null unique default gen_random_uuid(),
  status           text not null default 'open' check (status in ('open', 'bevestigd', 'niet_dit_jaar')),
  nieuw_listing_id uuid references public.listings(id) on delete set null,
  verstuurd_at     timestamptz not null default now(),
  beantwoord_at    timestamptz
);
-- RLS aan, bewust geen policies: alleen de service role (edge function) en
-- de security-definer functies hieronder komen erbij.
alter table public.herhaal_verzoeken enable row level security;

-- Kandidaten voor vannacht. Eén per markt (een wekelijkse markt van vorig
-- jaar telt één keer), en alleen als er rond die plek nog niets staat.
create or replace function public.herhaal_kandidaten()
returns table(listing_id uuid, verwachte_datum date, eigenaar_id uuid, title text, city text, date_start date)
language sql stable security definer set search_path = public
as $$
  select distinct on (lower(l.title), round(l.latitude::numeric, 2), round(l.longitude::numeric, 2))
    l.id, l.date_start + 364,
    coalesce(l.claimed_by_user_id, case when l.placed_by = 'user' then l.user_id end),
    l.title, l.city, l.date_start
  from listings l
  where l.status = 'active'
    and l.category not in ('garagesale', 'buurtverkoop')
    and coalesce(l.event_subtype, '') <> 'opritverkoop'
    and l.latitude is not null
    and l.date_start + 364 between current_date + 42 and current_date + 56
    and not exists (select 1 from herhaal_verzoeken h where h.vorig_listing_id = l.id)
    and not exists (
      select 1 from listings n
      where n.id <> l.id and n.status = 'active'
        and n.date_start between l.date_start + 300 and l.date_start + 430
        and n.latitude between l.latitude - 0.01 and l.latitude + 0.01
        and n.longitude between l.longitude - 0.015 and l.longitude + 0.015)
  order by lower(l.title), round(l.latitude::numeric, 2), round(l.longitude::numeric, 2), l.date_start desc
$$;
revoke all on function public.herhaal_kandidaten() from public, anon, authenticated;
grant execute on function public.herhaal_kandidaten() to service_role;

-- Voor de pagina /herhaal: wat staat er klaar bij deze link?
create or replace function public.herhaal_context(p_token uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'status', case when h.status = 'open' and h.verwachte_datum < current_date - 30 then 'verlopen' else h.status end,
    'titel', l.title, 'plaats', l.city, 'adres', case when l.address_reveal_mode = 'instant' then l.address end,
    'vorige_datum', l.date_start, 'verwachte_datum', h.verwachte_datum,
    'meerdaags', coalesce(l.date_end - l.date_start, 0),
    'tijd_van', to_char(l.time_start, 'HH24:MI'), 'tijd_tot', to_char(l.time_end, 'HH24:MI'),
    'nieuw_listing_id', h.nieuw_listing_id)
  from herhaal_verzoeken h join listings l on l.id = h.vorig_listing_id
  where h.token = p_token and h.kanaal = 'mail'
$$;

-- "Ja, zet hem erop": kopie van vorig jaar met de nieuwe datum en tijden.
create or replace function public.herhaal_bevestig(p_token uuid, p_datum date, p_tijd_van time default null, p_tijd_tot time default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  h herhaal_verzoeken;
  l listings;
  nieuw_id uuid;
begin
  select * into h from herhaal_verzoeken where token = p_token and kanaal = 'mail' for update;
  if not found then raise exception 'onbekende link' using errcode = 'P0002'; end if;
  if h.status = 'bevestigd' then return jsonb_build_object('ok', true, 'listing_id', h.nieuw_listing_id, 'al_gedaan', true); end if;
  if p_datum is null or p_datum < current_date or p_datum > current_date + 400 then
    raise exception 'datum moet tussen vandaag en volgend jaar liggen' using errcode = '22023';
  end if;
  select * into l from listings where id = h.vorig_listing_id;

  insert into listings (user_id, title, description, category, address, city, postal_code, location, latitude, longitude,
    date_start, date_end, time_start, time_end, images, tags, status, address_reveal_mode, confirmation_status,
    event_subtype, placed_by, source_url, source_label, claimed_by_user_id, claimed_at, curator_user_id)
  values (l.user_id, l.title, l.description, l.category, l.address, l.city, l.postal_code, l.location, l.latitude, l.longitude,
    p_datum, case when l.date_end > l.date_start then p_datum + (l.date_end - l.date_start) end,
    coalesce(p_tijd_van, l.time_start), coalesce(p_tijd_tot, l.time_end), l.images, l.tags, 'active', l.address_reveal_mode, 'confirmed',
    l.event_subtype, l.placed_by, l.source_url, l.source_label, l.claimed_by_user_id, l.claimed_at, l.curator_user_id)
  returning id into nieuw_id;

  -- Contactgegevens van de organisator gaan mee.
  insert into listing_contacts (listing_id, organizer_name, website_url, email, phone)
  select nieuw_id, c.organizer_name, c.website_url, c.email, c.phone from listing_contacts c where c.listing_id = l.id
  on conflict (listing_id) do nothing;

  update herhaal_verzoeken set status = 'bevestigd', nieuw_listing_id = nieuw_id, beantwoord_at = now() where id = h.id;
  return jsonb_build_object('ok', true, 'listing_id', nieuw_id);
end $$;

-- "Dit jaar niet": niets aanmaken, niet nog eens vragen.
create or replace function public.herhaal_niet_dit_jaar(p_token uuid)
returns jsonb
language sql security definer set search_path = public
as $$
  update herhaal_verzoeken set status = 'niet_dit_jaar', beantwoord_at = now()
  where token = p_token and kanaal = 'mail' and status = 'open'
  returning jsonb_build_object('ok', true)
$$;

-- De link in de mail is het bewijs (onraadbare uuid); de pagina is openbaar.
grant execute on function public.herhaal_context(uuid) to anon, authenticated;
grant execute on function public.herhaal_bevestig(uuid, date, time, time) to anon, authenticated;
grant execute on function public.herhaal_niet_dit_jaar(uuid) to anon, authenticated;

-- Cron (19 okt 2026): dagelijks 07:15 UTC.
-- select cron.schedule('yardigo-herhaal-check', '15 7 * * *', $$
--   select net.http_post(url := 'https://fwehqudhwzcnkcuypuqw.supabase.co/functions/v1/herhaal-check',
--     headers := jsonb_build_object('Content-Type', 'application/json',
--                                   'x-cron-secret', (select value from public.app_config where key = 'cron_secret')),
--     body := '{}'::jsonb, timeout_milliseconds := 120000);
-- $$);
