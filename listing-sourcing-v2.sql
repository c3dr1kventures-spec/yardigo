-- YardiGo – listing-sourcing v2 (okt 2026)
--
-- 1. pending_events krijgt organisator- en contactvelden, een externe
--    referentie (bv. 'meukisleuk:119192') zodat een bron-item maar één keer
--    binnenkomt, en de uitkomst van de auto-publiceer-check.
-- 2. listing_contacts: contactgegevens van de organisator bij een curated
--    listing. Apart van listings omdat listings voor iedereen (ook anon)
--    leesbaar is; contact is alleen voor ingelogde gebruikers.
-- 3. Status 'tip' voor particuliere verkopen die niet automatisch live
--    mogen en via Telegram aan de admin worden voorgelegd.

alter table public.pending_events
  add column if not exists organizer_name    text,
  add column if not exists organizer_url     text,
  add column if not exists contact_email     text,
  add column if not exists contact_phone     text,
  add column if not exists is_private_seller boolean,
  add column if not exists external_ref      text,
  add column if not exists auto_check        jsonb,
  add column if not exists telegram_sent_at  timestamptz;

create unique index if not exists pending_events_external_ref_uq
  on public.pending_events (external_ref) where external_ref is not null;

create table if not exists public.listing_contacts (
  listing_id     uuid primary key references public.listings(id) on delete cascade,
  organizer_name text,
  website_url    text,
  email          text,
  phone          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.listing_contacts enable row level security;

drop policy if exists "Ingelogde gebruikers zien organisator-contact" on public.listing_contacts;
create policy "Ingelogde gebruikers zien organisator-contact"
  on public.listing_contacts for select to authenticated using (true);

drop policy if exists "Admins beheren organisator-contact" on public.listing_contacts;
create policy "Admins beheren organisator-contact"
  on public.listing_contacts for all to authenticated
  using (public.is_yg_admin(auth.uid())
         or exists (select 1 from public.profiles where id = auth.uid() and is_admin))
  with check (public.is_yg_admin(auth.uid())
         or exists (select 1 from public.profiles where id = auth.uid() and is_admin));

revoke all on public.listing_contacts from anon;

-- Status 'tip': particuliere verkoop, niet automatisch live, via Telegram voorleggen.
alter table public.pending_events drop constraint if exists pending_events_status_check;
alter table public.pending_events add constraint pending_events_status_check
  check (status = any (array['nieuw','goedgekeurd','afgewezen','tip']));
