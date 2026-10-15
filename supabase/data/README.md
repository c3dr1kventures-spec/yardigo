# plaatsen.psv

Referentielijst van plaatsen voor de locatiecontrole (`public.plaatsen`,
SQL-functie `plek_toets`, zie `supabase/functions/_shared/locatie.ts`).

Bron: [GeoNames](https://www.geonames.org/) (CC BY 4.0): NL, BE en LU volledig
(bewoonde plaatsen + gemeenten), DE plaatsen vanaf 500 inwoners.
Formaat per regel: `naam_norm|naam|lat|lng|cc|soort|inwoners`.

Opnieuw bouwen: download `NL.zip`, `BE.zip`, `LU.zip` en `cities500.zip` van
https://download.geonames.org/export/dump/, pak uit in een map en draai
`python3 bouw_plaatsen.py <map>`. Inladen gaat in de database zelf (pg_net haalt
dit bestand van GitHub op; zie migratie `plaatsen_laden`).
