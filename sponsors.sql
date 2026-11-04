-- Sponsorvakken op de homepage (3 nov 2026).
-- Zes plekken (1-3 links, 4-6 rechts) naast de inhoud op brede schermen.
-- Beheer via de Telegram-bot (/sponsor), die met de service role schrijft.
-- Bezoekers lezen alleen lopende sponsors; tellen gaat via sponsor_tel(),
-- zonder cookies of iets over de bezoeker.

create table if not exists public.sponsors (
  id         bigint generated always as identity primary key,
  plek       smallint not null check (plek between 1 and 6),
  naam       text not null check (char_length(naam) between 1 and 40),
  tekst      text check (char_length(tekst) <= 90),
  url        text not null check (url ~ '^https://'),
  logo_url   text check (logo_url ~ '^https://'),
  kleur      text not null default '#3A6B4A' check (kleur ~ '^#[0-9A-Fa-f]{6}$'),
  begint     date not null default current_date,
  eindigt    date not null,
  actief     boolean not null default true,
  created_at timestamptz not null default now(),
  check (eindigt >= begint)
);

-- Eén lopende sponsor per plek.
create unique index if not exists sponsors_plek_actief on public.sponsors (plek) where actief;

create table if not exists public.sponsor_stats (
  sponsor_id bigint not null references public.sponsors (id) on delete cascade,
  dag        date not null default current_date,
  weergaven  integer not null default 0,
  kliks      integer not null default 0,
  primary key (sponsor_id, dag)
);

alter table public.sponsors enable row level security;
alter table public.sponsor_stats enable row level security;

-- Bezoekers zien alleen wat nu loopt. sponsor_stats is niet leesbaar.
drop policy if exists "sponsors lopend" on public.sponsors;
create policy "sponsors lopend" on public.sponsors for select
  to anon, authenticated
  using (actief and current_date between begint and eindigt);

revoke all on public.sponsors from anon, authenticated;
grant select (id, plek, naam, tekst, url, logo_url, kleur, begint, eindigt, actief) on public.sponsors to anon, authenticated;
revoke all on public.sponsor_stats from anon, authenticated;

-- Telt weergaven (p_klik false) of een klik (p_klik true). Alleen voor
-- lopende sponsors en hooguit zes ids per keer, zodat er niets anders mee kan.
create or replace function public.sponsor_tel(p_ids bigint[], p_klik boolean default false)
returns void
language sql
security definer
set search_path to ''
as $$
  insert into public.sponsor_stats as s (sponsor_id, dag, weergaven, kliks)
  select sp.id, current_date, case when p_klik then 0 else 1 end, case when p_klik then 1 else 0 end
  from public.sponsors sp
  where sp.id = any (p_ids[1:6]) and sp.actief and current_date between sp.begint and sp.eindigt
  on conflict (sponsor_id, dag) do update
    set weergaven = s.weergaven + excluded.weergaven,
        kliks     = s.kliks + excluded.kliks;
$$;

revoke execute on function public.sponsor_tel(bigint[], boolean) from public;
grant execute on function public.sponsor_tel(bigint[], boolean) to anon, authenticated, service_role;
