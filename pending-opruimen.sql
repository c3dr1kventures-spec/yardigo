-- ═══════════════════════════════════════════════════════════════════════
-- Telegram-wachtrij opruimen (29 okt 2026).
--
-- Kaartjes in pending_events met status 'nieuw' of 'tip' waarvan de
-- (eind)datum voorbij is, komen nooit meer aan bod: de bot en de mini-app
-- tonen alleen items vanaf vandaag. Ze gaan elke nacht weg.
-- 'goedgekeurd' en 'afgewezen' blijven staan (dubbelcheck bij imports).
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.pending_verlopen_opruimen()
returns integer
language sql security definer set search_path = public
as $$
  with weg as (
    delete from pending_events
    where status in ('nieuw', 'tip')
      and coalesce(date_end, date_start) < current_date
    returning 1
  )
  select count(*)::int from weg;
$$;
revoke all on function public.pending_verlopen_opruimen() from public, anon, authenticated;

select cron.unschedule(jobname) from cron.job where jobname = 'yardigo-wachtrij-opruimen';
select cron.schedule('yardigo-wachtrij-opruimen', '50 3 * * *', $$select public.pending_verlopen_opruimen()$$);
