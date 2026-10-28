-- ═══════════════════════════════════════════════════════════════════════
-- Kringloopwinkels automatisch bijhouden (28 okt 2026).
--
-- winkels_import_osm() (winkels-schema.sql) draaide alleen met de hand.
-- Nu:
--   - elke zondagnacht via pg_cron, NL en BE apart (Overpass niet tegelijk
--     belasten);
--   - elke wijziging komt in winkels_wijzigingen: nieuw, gewijzigd (naam,
--     adres, openingstijden, website, telefoon), weg (niet meer in OSM) of
--     terug (stond op inactief, weer in OSM);
--   - veiligheidsrem: komt Overpass met minder dan 80% van het aantal actieve
--     winkels terug (half antwoord, storing), dan zetten we niets op inactief;
--   - zondagochtend stuurt de Edge Function winkels-melding een overzicht
--     naar de Telegram-adminchat en zet de regels op gemeld.
-- De /kringloop-pagina's volgen vanzelf via de nachtelijke build.
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.winkels_wijzigingen (
  id         bigint generated always as identity primary key,
  winkel_id  bigint not null references public.winkels (id) on delete cascade,
  land       text not null,
  wat        text not null check (wat in ('nieuw', 'gewijzigd', 'weg', 'terug')),
  oud        jsonb,
  nieuw      jsonb,
  gemaakt    timestamptz not null default now(),
  gemeld     boolean not null default false
);
create index if not exists idx_winkels_wijzigingen_open on public.winkels_wijzigingen (gemaakt) where not gemeld;
create index if not exists idx_winkels_wijzigingen_winkel on public.winkels_wijzigingen (winkel_id);

-- Alleen service role (Edge Function) en pg_cron: RLS aan, geen policies.
alter table public.winkels_wijzigingen enable row level security;
revoke all on public.winkels_wijzigingen from anon, authenticated;

create or replace function public.winkels_import_osm(p_land text)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  resp extensions.http_response;
  doc jsonb;
  q text;
  n_in int; n_actief int; n_nieuw int; n_gewijzigd int; n_terug int; n_weg int := 0;
  rem boolean;
  server text;
  fout text := '';
begin
  if p_land not in ('nl', 'be', 'de', 'fr', 'lu') then
    return jsonb_build_object('ok', false, 'reden', 'land');
  end if;
  q := format('[out:json][timeout:200];area["ISO3166-1"="%s"][admin_level=2]->.a;(nwr["shop"~"^(second_hand|charity|antiques)$"](area.a););out center tags;', upper(p_land));
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '280');
  -- Overpass zit soms vol (502/504/429): dan de volgende server proberen.
  foreach server in array array['https://overpass-api.de/api/interpreter',
                                'https://overpass.private.coffee/api/interpreter',
                                'https://maps.mail.ru/osm/tools/overpass/api/interpreter'] loop
    begin
      select * into resp from extensions.http((
        'POST', server,
        array[extensions.http_header('User-Agent', 'YardiGo-shops-import/1.1 (+https://www.yardigo.nl)')],
        'application/x-www-form-urlencoded',
        'data=' || extensions.urlencode(q)
      )::extensions.http_request);
      exit when resp.status = 200;
      fout := fout || server || ' ' || resp.status || '; ';
    exception when others then
      fout := fout || server || ' ' || left(sqlerrm, 60) || '; ';
      resp := null;
    end;
  end loop;
  if resp is null or resp.status <> 200 then
    return jsonb_build_object('ok', false, 'reden', 'overpass', 'fouten', fout);
  end if;
  doc := resp.content::jsonb;
  if doc->>'remark' is not null and doc->>'remark' ~* 'timed out|out of memory|error' then
    return jsonb_build_object('ok', false, 'reden', 'overpass', 'remark', left(doc->>'remark', 200));
  end if;

  create temp table if not exists _osm_in (
    osm_type text, osm_id bigint, naam text, soort text, osm_shop text, straat text, huisnummer text,
    postcode text, plaats text, latitude float8, longitude float8, openingstijden text, website text,
    telefoon text, rolstoel text
  ) on commit drop;
  truncate _osm_in;

  insert into _osm_in
  select osm_type, osm_id, naam,
         case when shop = 'antiques' then 'antiek'
              when shop = 'charity' then 'goede_doel'
              when (naam || ' ' || coalesce(t->>'brand', '')) ~* 'kringloop|kringwinkel|rataplan|emmaus|wawollie|het goed|noppes|snuffel|ecokring|terre des hommes|leger des heils|dorcas|weggeef'
                   or t->>'second_hand' = 'only' then 'kringloop'
              else 'tweedehands' end,
         shop, t->>'addr:street', t->>'addr:housenumber', t->>'addr:postcode', t->>'addr:city',
         lat, lon, t->>'opening_hours', coalesce(t->>'website', t->>'contact:website'),
         coalesce(t->>'phone', t->>'contact:phone'), t->>'wheelchair'
  from (
    select x->>'type' as osm_type, (x->>'id')::bigint as osm_id,
           left(btrim(coalesce(nullif(x->'tags'->>'name', ''), x->'tags'->>'brand')), 200) as naam,
           x->'tags'->>'shop' as shop, x->'tags' as t,
           coalesce((x->>'lat')::float8, (x->'center'->>'lat')::float8) as lat,
           coalesce((x->>'lon')::float8, (x->'center'->>'lon')::float8) as lon
    from jsonb_array_elements(doc->'elements') x
  ) r
  where coalesce(naam, '') <> '' and lat is not null;
  get diagnostics n_in = row_count;

  -- Wijzigingen vastleggen vóór het bijwerken (oud tegen nieuw).
  insert into winkels_wijzigingen (winkel_id, land, wat, oud, nieuw)
  select w.id, p_land, case when w.actief then 'gewijzigd' else 'terug' end,
         jsonb_strip_nulls(jsonb_build_object('naam', w.naam, 'straat', w.straat, 'huisnummer', w.huisnummer, 'postcode', w.postcode,
           'plaats', w.plaats, 'openingstijden', w.openingstijden, 'website', w.website, 'telefoon', w.telefoon)),
         jsonb_strip_nulls(jsonb_build_object('naam', i.naam, 'straat', i.straat, 'huisnummer', i.huisnummer, 'postcode', i.postcode,
           'plaats', i.plaats, 'openingstijden', i.openingstijden, 'website', i.website, 'telefoon', i.telefoon))
  from _osm_in i join winkels w on w.osm_type = i.osm_type and w.osm_id = i.osm_id
  where not w.actief
     or (w.naam, w.straat, w.huisnummer, w.postcode, w.plaats, w.openingstijden, w.website, w.telefoon)
        is distinct from (i.naam, i.straat, i.huisnummer, i.postcode, i.plaats, i.openingstijden, i.website, i.telefoon);
  select count(*) filter (where wat = 'gewijzigd'), count(*) filter (where wat = 'terug')
    into n_gewijzigd, n_terug
  from winkels_wijzigingen where land = p_land and gemaakt = now();

  with ins as (
    insert into winkels (osm_type, osm_id, naam, soort, osm_shop, straat, huisnummer, postcode, plaats, land,
                         latitude, longitude, openingstijden, website, telefoon, rolstoel)
    select osm_type, osm_id, naam, soort, osm_shop, straat, huisnummer, postcode, plaats, p_land,
           latitude, longitude, openingstijden, website, telefoon, rolstoel
    from _osm_in
    on conflict (osm_type, osm_id) do update set
      naam = excluded.naam, soort = excluded.soort, osm_shop = excluded.osm_shop, straat = excluded.straat,
      huisnummer = excluded.huisnummer, postcode = excluded.postcode, plaats = excluded.plaats, land = excluded.land,
      latitude = excluded.latitude, longitude = excluded.longitude, openingstijden = excluded.openingstijden,
      website = excluded.website, telefoon = excluded.telefoon, rolstoel = excluded.rolstoel,
      actief = true, laatst_gesynct = now()
    returning id, (xmax = 0) as is_nieuw, naam, straat, huisnummer, postcode, plaats, openingstijden, website, telefoon
  )
  insert into winkels_wijzigingen (winkel_id, land, wat, nieuw)
  select id, p_land, 'nieuw',
         jsonb_strip_nulls(jsonb_build_object('naam', naam, 'straat', straat, 'huisnummer', huisnummer, 'postcode', postcode,
           'plaats', plaats, 'openingstijden', openingstijden, 'website', website, 'telefoon', telefoon))
  from ins where is_nieuw;
  get diagnostics n_nieuw = row_count;

  -- Niet meer in OSM: op inactief (nooit weggooien; geclaimde winkels blijven).
  select count(*) into n_actief from winkels where land = p_land and bron = 'osm' and actief;
  rem := n_in < n_actief * 0.8;
  if not rem then
    with uit as (
      update winkels w set actief = false
      where w.land = p_land and w.bron = 'osm' and w.actief and w.claimed_by_user_id is null
        and not exists (select 1 from _osm_in i where i.osm_type = w.osm_type and i.osm_id = w.osm_id)
      returning w.id, w.naam, w.plaats
    )
    insert into winkels_wijzigingen (winkel_id, land, wat, oud)
    select id, p_land, 'weg', jsonb_strip_nulls(jsonb_build_object('naam', naam, 'plaats', plaats)) from uit;
    get diagnostics n_weg = row_count;
  end if;

  return jsonb_build_object('ok', true, 'land', p_land, 'uit_osm', n_in, 'nieuw', n_nieuw, 'gewijzigd', n_gewijzigd,
                            'terug', n_terug, 'weg', n_weg, 'rem', rem);
end;
$$;
revoke all on function public.winkels_import_osm(text) from public, anon, authenticated;

-- Zondag: NL 02:10 UTC, BE 02:40 UTC, melding 06:15 UTC (na de nachtelijke build).
select cron.unschedule(jobname) from cron.job where jobname in ('winkels-sync-nl', 'winkels-sync-be', 'winkels-melding');
select cron.schedule('winkels-sync-nl', '10 2 * * 0', $$select public.winkels_import_osm('nl')$$);
select cron.schedule('winkels-sync-be', '40 2 * * 0', $$select public.winkels_import_osm('be')$$);
select cron.schedule('winkels-melding', '15 6 * * 0', $$
  select net.http_post(
    url     := 'https://fwehqudhwzcnkcuypuqw.supabase.co/functions/v1/winkels-melding',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-secret', (select value from public.app_config where key = 'cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$$);
