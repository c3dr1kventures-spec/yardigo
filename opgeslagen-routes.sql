-- ═══════════════════════════════════════════════════════════════════════
-- Opgeslagen routes van de dagplanner (site/route.js), 28 okt 2026.
--
-- Ingelogde bezoekers bewaren hun routes in hun account; gasten alleen in de
-- browser. client_id is het id van de route in de browser, zodat dezelfde
-- route niet dubbel wordt bewaard.
-- start/eind zijn privé (kunnen een woonadres zijn) en komen nooit mee in
-- een gedeelde route: get_gedeelde_route() geeft ze niet terug.
-- deel_code: alleen gezet als de eigenaar een openbare link maakt.
-- Later (niet nu): openbaar/favoriet/statistieken als losse kolommen of
-- tabellen hiernaast.
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.opgeslagen_routes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id   text not null check (char_length(client_id) between 1 and 40),
  naam        text not null default '' check (char_length(naam) <= 80),
  datum       date,
  vertrek     time,
  vervoer     text not null default 'auto' check (vervoer in ('auto', 'fiets', 'lopen')),
  start       jsonb,
  eind        jsonb,
  stops       jsonb not null default '[]'::jsonb
              check (jsonb_typeof(stops) = 'array' and jsonb_array_length(stops) <= 50 and pg_column_size(stops) < 60000),
  deel_code   text unique check (deel_code ~ '^[A-Za-z0-9]{8,16}$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, client_id)
);

alter table public.opgeslagen_routes enable row level security;

drop policy if exists "eigen routes lezen" on public.opgeslagen_routes;
drop policy if exists "eigen routes toevoegen" on public.opgeslagen_routes;
drop policy if exists "eigen routes wijzigen" on public.opgeslagen_routes;
drop policy if exists "eigen routes verwijderen" on public.opgeslagen_routes;
create policy "eigen routes lezen" on public.opgeslagen_routes
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "eigen routes toevoegen" on public.opgeslagen_routes
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "eigen routes wijzigen" on public.opgeslagen_routes
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "eigen routes verwijderen" on public.opgeslagen_routes
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.opgeslagen_routes from anon;
grant select, insert, update, delete on public.opgeslagen_routes to authenticated;

-- updated_at bijhouden en hooguit 200 routes per account.
create or replace function public.opgeslagen_routes_bij()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and (select count(*) from public.opgeslagen_routes where user_id = new.user_id) >= 200 then
    raise exception 'Maximaal 200 routes per account';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists opgeslagen_routes_bij on public.opgeslagen_routes;
create trigger opgeslagen_routes_bij
  before insert or update on public.opgeslagen_routes
  for each row execute function public.opgeslagen_routes_bij();

-- Openbare deellink: iedereen met de code ziet naam, datum, vervoer en stops.
-- Nooit start of eind (privé).
create or replace function public.get_gedeelde_route(p_code text)
returns table (naam text, datum date, vervoer text, stops jsonb, bijgewerkt timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select r.naam, r.datum, r.vervoer, r.stops, r.updated_at
  from public.opgeslagen_routes r
  where p_code ~ '^[A-Za-z0-9]{8,16}$' and r.deel_code = p_code
  limit 1;
$$;

revoke all on function public.get_gedeelde_route(text) from public;
grant execute on function public.get_gedeelde_route(text) to anon, authenticated;
revoke all on function public.opgeslagen_routes_bij() from public, anon, authenticated;
