-- Winkels openbaar voor de website (kringloop per plaats, laag op de kaart).
-- De tabel winkels houdt RLS zonder policies; deze functie geeft alleen de
-- openbare velden van actieve winkels (uit OpenStreetMap), zonder
-- claimed_by_user_id of interne velden. Ontbreekt de plaats in OSM, dan de
-- dichtstbijzijnde plaats met inwoners uit `plaatsen` (geen wijken, binnen
-- ~8 km), zodat een volgende
-- OSM-sync dat niet terugdraait.
create or replace function public.get_winkels_publiek()
returns table (
  id bigint, naam text, soort text, straat text, huisnummer text, postcode text,
  plaats text, land text, latitude double precision, longitude double precision,
  openingstijden text, website text
)
language sql
stable
security definer
set search_path = public
as $$
  select w.id, w.naam, w.soort, w.straat, w.huisnummer, w.postcode,
    coalesce(nullif(w.plaats, ''), p.naam) as plaats,
    w.land, w.latitude, w.longitude, w.openingstijden, w.website
  from winkels w
  left join lateral (
    select pl.naam from plaatsen pl
    where nullif(w.plaats, '') is null
      and pl.soort <> 'PPLX' and pl.inwoners > 0
      and pl.lat between w.latitude - 0.08 and w.latitude + 0.08
      and pl.lng between w.longitude - 0.12 and w.longitude + 0.12
    order by (pl.lat - w.latitude) ^ 2 + ((pl.lng - w.longitude) * 0.62) ^ 2
    limit 1
  ) p on true
  where w.actief and w.latitude is not null and w.longitude is not null;
$$;

revoke all on function public.get_winkels_publiek() from public;
grant execute on function public.get_winkels_publiek() to anon, authenticated;
