-- Land van een advertentie (2 nov 2026), voor het juiste domein in de
-- deellinks van de Telegram-bot (yardigo.be voor België, enz.).
-- Zelfde aanpak als get_listings_seo (seo-listings-land.sql): eerst de
-- plaatsnaam die binnen 25 km van de pin bestaat, anders de dichtstbijzijnde
-- plaats. Uitkomst: nl, be, de, lu of null. Frankrijk staat niet in de
-- plaatsenlijst en geeft dus null (of het land van de dichtstbijzijnde
-- grensplaats).
-- Alleen voor de edge functions (service_role).

create or replace function public.listing_land(p_id uuid)
returns text
language sql stable
set search_path to ''
as $$
  select coalesce(
    (select p.cc from public.plaatsen p
      where p.naam_norm = public.plaats_norm(l.city)
        and abs(p.lat - l.latitude) < 0.23 and abs(p.lng - l.longitude) < 0.37
      order by (p.lat - l.latitude)^2 + (p.lng - l.longitude)^2 limit 1),
    (select p.cc from public.plaatsen p
      where abs(p.lat - l.latitude) < 0.2 and abs(p.lng - l.longitude) < 0.3
      order by (p.lat - l.latitude)^2 + (p.lng - l.longitude)^2 limit 1))
  from public.listings l
  where l.id = p_id and l.latitude is not null
$$;

revoke execute on function public.listing_land(uuid) from public, anon, authenticated;
grant execute on function public.listing_land(uuid) to service_role;
