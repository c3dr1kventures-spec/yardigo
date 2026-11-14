-- ═══════════════════════════════════════════════════════════════════════
-- Bezoekers met terugwerkende kracht (14 nov 2026).
--
-- Van 27 okt tot 14 nov 2026 telde alleen /app in page_views; de nieuwe site
-- (startpagina, kaart, routeplanner, verkooppagina's) niet. Voor die dagen
-- staat hier een schatting uit de Supabase-API-logs: unieke (IP, browser)
-- per dag met verzoeken vanaf yardigo.nl/.be/.app, zonder bots en zonder de
-- app (localhost). Alleen aantallen, geen IP's.
-- Pagina's die niets bij Supabase ophalen (stads- en provinciepagina's,
-- organisatoren) tellen daarin niet mee: de schatting is aan de lage kant.
-- Ijking: 24 en 25 okt gaven de logs 42/55, page_views 59/61 sessies.
-- weergaven = round(bezoekers * 1.14): de verhouding in page_views 1-26 okt.
--
-- analytics_daily en analytics_summary nemen per dag het hoogste van de
-- echte telling en de schatting; analytics_daily meldt is_schatting.
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.analytics_schatting (
  dag             date primary key,
  bezoekers       integer not null check (bezoekers >= 0),
  weergaven       integer not null check (weergaven >= 0),
  verkoop_detail  integer not null default 0,   -- opgevraagde verkoopdetails (pagina's + kaartpopups)
  bron            text not null default 'supabase edge_logs'
);
alter table public.analytics_schatting enable row level security;
drop policy if exists "admin leest schatting" on public.analytics_schatting;
create policy "admin leest schatting" on public.analytics_schatting
  for select to authenticated using (public.is_yg_admin((select auth.uid())));
revoke all on public.analytics_schatting from anon;
grant select on public.analytics_schatting to authenticated;

insert into public.analytics_schatting (dag, bezoekers, weergaven, verkoop_detail) values
  ('2026-10-27', 38, 43, 64), ('2026-10-28', 23, 26, 37), ('2026-10-29', 29, 33, 64),
  ('2026-10-30', 27, 31, 58), ('2026-10-31', 32, 36, 55), ('2026-11-01', 59, 67, 124),
  ('2026-11-02', 45, 51, 92), ('2026-11-03', 37, 42, 69), ('2026-11-04', 62, 71, 115),
  ('2026-11-05', 97, 111, 236), ('2026-11-06', 119, 136, 247), ('2026-11-07', 102, 116, 217),
  ('2026-11-08', 78, 89, 165), ('2026-11-09', 57, 65, 112), ('2026-11-10', 45, 51, 80),
  ('2026-11-11', 28, 32, 74), ('2026-11-12', 67, 76, 143), ('2026-11-13', 32, 36, 86),
  ('2026-11-14', 41, 47, 91)
on conflict (dag) do update set bezoekers = excluded.bezoekers, weergaven = excluded.weergaven, verkoop_detail = excluded.verkoop_detail;

drop function if exists public.analytics_daily(integer);
create function public.analytics_daily(p_days integer default 30)
returns table (day date, views bigint, unique_sessions bigint, logged_in_users bigint, is_schatting boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_admin boolean;
  v_tz constant text := 'Europe/Amsterdam';
  v_today date;
begin
  select coalesce(is_admin,false) into v_admin from public.profiles where id=auth.uid();
  if not coalesce(v_admin,false) then raise exception 'Not authorized'; end if;
  p_days  := greatest(1, least(coalesce(p_days,30),365));
  v_today := (now() at time zone v_tz)::date;
  return query
  with
  days as (select (v_today - gs)::date as d from generate_series(0, p_days-1) as gs),
  pv_local as (
    select (created_at at time zone v_tz)::date as local_day, id, session_id, user_id
    from public.page_views
    where created_at >= ((v_today-(p_days-1))::timestamp at time zone v_tz)
      and created_at <  ((v_today+1)::timestamp at time zone v_tz)
  ),
  echt as (
    select d.d, count(pv.id)::bigint v, count(distinct pv.session_id)::bigint s, count(distinct pv.user_id)::bigint u
    from days d left join pv_local pv on pv.local_day = d.d group by d.d
  )
  select e.d, greatest(e.v, coalesce(x.weergaven,0))::bigint, greatest(e.s, coalesce(x.bezoekers,0))::bigint, e.u,
         (x.dag is not null and x.bezoekers > e.s)
  from echt e left join public.analytics_schatting x on x.dag = e.d
  order by e.d asc;
end;$function$;
revoke all on function public.analytics_daily(integer) from public, anon;
grant execute on function public.analytics_daily(integer) to authenticated;

create or replace function public.analytics_summary()
returns table(views_today bigint, views_yesterday bigint, views_7d bigint, views_30d bigint, unique_sessions_7d bigint, unique_sessions_30d bigint, new_users_7d bigint, new_users_30d bigint, growth_wow_pct numeric)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_admin boolean; v_prev7 bigint;
  v_tz constant text := 'Europe/Amsterdam';
  v_today date;
begin
  select coalesce(is_admin,false) into v_admin from public.profiles where id=auth.uid();
  if not coalesce(v_admin,false) then raise exception 'Not authorized'; end if;
  v_today := (now() at time zone v_tz)::date;

  -- Per dag: echte telling, aangevuld met de schatting waar die hoger is.
  create temp table if not exists _yg_dag (d date, v bigint, s bigint, extra_s bigint) on commit drop;
  truncate _yg_dag;
  insert into _yg_dag
  select g.d,
         greatest(count(pv.id), coalesce(max(x.weergaven),0)),
         greatest(count(distinct pv.session_id), coalesce(max(x.bezoekers),0)),
         greatest(0, coalesce(max(x.bezoekers),0) - count(distinct pv.session_id))
  from (select (v_today - gs)::date d from generate_series(0, 29) gs) g
  left join public.page_views pv on (pv.created_at at time zone v_tz)::date = g.d
  left join public.analytics_schatting x on x.dag = g.d
  group by g.d;

  select coalesce(sum(v) filter (where d = v_today),0),   coalesce(sum(v) filter (where d = v_today-1),0),
         coalesce(sum(v) filter (where d >= v_today-6),0), coalesce(sum(v),0)
    into views_today, views_yesterday, views_7d, views_30d from _yg_dag;
  select count(distinct session_id) + (select coalesce(sum(extra_s),0) from _yg_dag where d >= v_today-6) into unique_sessions_7d
    from public.page_views where (created_at at time zone v_tz)::date >= v_today-6;
  select count(distinct session_id) + (select coalesce(sum(extra_s),0) from _yg_dag) into unique_sessions_30d
    from public.page_views where (created_at at time zone v_tz)::date >= v_today-29;
  select count(*) into new_users_7d  from auth.users where (created_at at time zone v_tz)::date >= v_today-6;
  select count(*) into new_users_30d from auth.users where (created_at at time zone v_tz)::date >= v_today-29;
  select coalesce(sum(v),0) into v_prev7 from _yg_dag where d between v_today-13 and v_today-7;
  if v_prev7 > 0 then growth_wow_pct := round(((views_7d-v_prev7)::numeric/v_prev7::numeric)*100.0,1);
  else growth_wow_pct := null; end if;
  return next;
end;$function$;
