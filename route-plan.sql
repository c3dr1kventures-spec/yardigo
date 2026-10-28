-- ═══════════════════════════════════════════════════════════════════════
-- Cache voor de Edge Function route-plan (OpenRouteService), 28 okt 2026.
-- Sleutel = sha256 van actie, vervoer en afgeronde coördinaten; 7 dagen
-- geldig (de functie kijkt naar 'gemaakt'). Alleen de functie (service role)
-- leest en schrijft: RLS aan, geen policies, geen rechten voor anon/authenticated.
-- Er staan geen personen in: alleen coördinaten (op ~10 m afgerond) en
-- reistijden.
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.route_cache (
  sleutel  text primary key,
  antwoord jsonb not null,
  gemaakt  timestamptz not null default now()
);

alter table public.route_cache enable row level security;
revoke all on public.route_cache from anon, authenticated;

-- Oude regels opruimen: elke maandag 04:15 via pg_cron.
create or replace function public.route_cache_opruimen()
returns void
language sql
set search_path = ''
as $$
  delete from public.route_cache where gemaakt < now() - interval '14 days';
$$;
revoke all on function public.route_cache_opruimen() from public, anon, authenticated;

select cron.unschedule('route-cache-opruimen') where exists (select 1 from cron.job where jobname = 'route-cache-opruimen');
select cron.schedule('route-cache-opruimen', '15 4 * * 1', 'select public.route_cache_opruimen()');
