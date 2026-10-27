# Slimme dagplanner (28 okt 2026)

Keuzes van Christian: **website** (`site/route.js`, `/kaart`) wordt de dagplanner, met opslaan in het account van `/app`; routedienst **OpenRouteService** (ORS).

## 1. Hoe het nu werkt

**Website (`site/route.js`, ~250 regels, geen afhankelijkheden)**
- Stop = `{ id, titel, soort (oprit|route|markt|winkel), lat, lng, plaats, sub, benadering }`, gemaakt door `YGKaart.stopVan()` / `stopWinkel()`.
- Toevoegen via "+ Route" in kaartpopups, kaartjes en de verkooppagina; één luisteraar op `[data-route-id]`.
- Eén route in localStorage `yg-route-1`, vervoer in `yg-route-vervoer`. Geen account, geen naam, geen datum.
- Paneel (aside, rechts) met ↑/↓/×, "kortste volgorde" (dichtstbijzijnde-buur, **hemelsbreed**), vervoer.
- Export: Google (max 10 punten), Apple (alle stops, unified URL), Waze per stop. Deellink `/kaart?stops=` (stops in de URL).
- Kaart: Leaflet + markercluster (unpkg), CARTO-tegels. Geocoding: PDOK, terugval Nominatim (`YGKaart.zoekPlaats`).
- Privacy: garagesales/rommelroutes zonder account alleen als gebied (`benadering`), coördinaten verschoven in de DB.

**Web-app (`app.html`)**: aparte planner (`routeSet`/`routeOrder` in localStorage), alleen verkopen, geen winkels, hemelsbrede km en minuten (40/15/5 km/u). Blijft zoals hij is.

**Gegevens**
- Verkopen: `listings` (`date_start`, `date_end`, `time_start`, `time_end`, `status`), publiek via `get_listings_map()` / `get_listing_detail()`.
- Winkels: `winkels.openingstijden` = ruwe OSM-notatie (`Mo-Sa 10:00-17:00; PH off`), publiek via `get_winkels_publiek()`.
- Accounts: Supabase Auth in `/app`; sessie in localStorage `sb-fwehqudhwzcnkcuypuqw-auth-token` (zelfde domein, dus ook leesbaar voor de website).
- Geen tabel voor bewaarde routes. `rommelroutes` gaat over georganiseerde buurtroutes, iets anders.

## 2. Wat er is en wat ontbreekt

| Wens | Nu | Fase |
|---|---|---|
| Toevoegen vanuit kaart, lijsten, detail | ja | - |
| Verwijderen | ja | - |
| Volgorde: knoppen | ja (↑/↓) | blijft (toegankelijk) |
| Volgorde: slepen | nee | 1 |
| Startpunt (mijn plek / plaats / adres), eindpunt | nee | 1 |
| Datum + vertrektijd | nee | 1 |
| Naam + meerdere routes bewaren | nee (1 route, lokaal) | 1 (lokaal), 1b (account) |
| Export in segmenten bij lange routes | nee (Google kapt af) | 1 |
| Route als lijn op de kaart, genummerde stops | nee | 1 (rechte lijnen), 2 (over de weg) |
| Waarschuwing: verkoop niet op gekozen datum / winkel dicht | nee | 1 (op basis van datum en openingstijden) |
| Echte reistijd/afstand, aankomsttijden | nee (hemelsbreed) | 2 (ORS) |
| Slimme volgorde met tijdvensters en bezoekduur | nee | 2 (ORS optimization) |
| Suggesties langs de route + omrijtijd | nee | 3 (kandidaten lokaal, omrijtijd via ORS) |
| Openbare deellink, bekijken en kopiëren | deels (stops in URL) | 3 (korte code in DB) |
| Dupliceren, hernoemen, verwijderen | nee | 1 |
| Melding: verkoop afgelopen/verwijderd/gewijzigd | nee | 1 (bij openen controleren) |

## 3. Plan per fase

### Fase 1: basis (geen externe dienst)
- `site/route.js`: model wordt `{ id, naam, datum, vertrek, vervoer, start, eind, stops[], bijgewerkt }`; meerdere routes in localStorage `yg-routes-2` (oude `yg-route-1` wordt automatisch overgenomen).
- Paneel: kop met routenaam + "Mijn routes" (openen, hernoemen, dupliceren, verwijderen); instellingen (datum, vertrek, start, eind, vervoer) in één compacte regel die openklapt.
- Stops: slepen (pointer events, werkt ook op touch) naast de bestaande ↑/↓-knoppen; per stop soort-icoon, plaats, tijden, waarschuwing ("niet op za 1 nov", "gesloten op zondag", "afgelopen").
- Mobiel: paneel als uitschuifbaar onderblad (half/vol); grote knoppen; "Navigeer naar volgende stop".
- Kaart (`/kaart`): genummerde stops en een stippellijn in routevolgorde (gelabeld als volgorde, niet als weg).
- Export: Google per 10 punten in segmenten ("Deel 1: stop 1 t/m 10"), Apple per 15, Waze per stop; melding als een app niet alles meeneemt.
- Startadres staat nooit in deellinks.
- Nieuwe vertalingen in `site/site.js` (NL/EN/FR/DE).

### Fase 1b: opslaan in het account
- Migratie `opgeslagen-routes.sql` + `apply_migration` + `get_advisors`:
  `opgeslagen_routes (id uuid pk, user_id uuid → auth.users, naam text, datum date, vertrek time, vervoer text, start jsonb, eind jsonb, stops jsonb, deel_code text unique, created_at, updated_at)`; RLS: eigenaar alles.
  RPC `get_gedeelde_route(p_code)` (security definer): naam, datum, vervoer, stops, **zonder start/eind**.
- Website leest de sessie van `/app`; verlopen of niet ingelogd → "Log in om in je account te bewaren" (link naar `/app`). Gasten bewaren lokaal.

### Fase 2: slimme planning (ORS)
- Supabase Edge Function `route-plan` (sleutel als secret `ORS_API_KEY`, nooit in de browser):
  - `matrix`: reistijden/afstanden tussen alle punten (1 aanroep per wijziging van stops/vervoer, niet bij slepen).
  - `optimaliseer`: ORS `/optimization` (VROOM) met tijdvensters (markt: `time_start`-`time_end`; winkel: openingstijden van die dag) en bezoekduur per stop.
  - `lijn`: routegeometrie voor de kaart.
  - Cache: tabel `route_cache` (sleutel = hash van afgeronde coördinaten + vervoer, 7 dagen), plus rate limit per IP.
- Aankomsttijden per stop, totale afstand/reistijd/duur van de dag; waarschuwing "je komt aan na sluiting".
- Bezoekduur standaard: garagesale 20 min, rommelroute 90, markt 60, winkel 30; per stop aan te passen.
- Openingstijden: kleine parser voor de gangbare OSM-vormen (`Mo-Sa 10:00-17:00`, meerdere blokken, `off`, `PH`); onbekend = geen tijdvenster, wel melding "openingstijden onbekend".
- Zonder ORS (sleutel ontbreekt of limiet op): volgorde blijft werken op tijdvensters + hemelsbrede afstand, duidelijk gelabeld als schatting, zonder aankomsttijden.

### Fase 3: ontdekken en delen
- Suggesties: kandidaten binnen 2 km (fiets/lopen) of 5 km (auto) van de lijn tussen opeenvolgende stops, open op de gekozen datum; omrijtijd via één ORS-matrix-aanroep voor de top 5. Getoond als losse lijst "Ook langs je route", met "+ Toevoegen"; nooit automatisch toegevoegd. Veld `bron` in de suggestie (later: `gesponsord`).
- Openbare deellink `/kaart?r=<code>` (via `deel_code`), bekijken zonder account en "Kopieer naar mijn routes". De bestaande `?stops=` blijft werken.
- Klaar voor later (niet bouwen): `openbaar`/`favoriet`/statistieken passen als losse kolommen of tabellen naast `opgeslagen_routes`.

## 4. Beperkingen en kosten

| Dienst | Grens | Gevolg |
|---|---|---|
| Google Maps-link | 9 tussenstops + bestemming | lange routes in segmenten |
| Apple Kaarten-link | meerdere stops sinds iOS 18.4 / macOS 15.4; het maximum is niet officieel vastgelegd | segmenten van 15; oudere iOS: alleen bestemming |
| Waze-link | 1 bestemming | knop per stop |
| ORS gratis | 2.000 routes, 500 matrices, 500 optimalisaties per dag; 40/min | cache + alleen rekenen op "Plan mijn dag" en bij gewijzigde stops; bij groei: ORS-abonnement of eigen ORS/VROOM-server |
| Garagesales zonder account | alleen gebied | aankomsttijd is een schatting; huisnummer in de app |

## 5. Wat Christian moet doen voor fase 2
1. Account op openrouteservice.org, sleutel aanmaken (gratis "Standard").
2. Sleutel in Supabase zetten: Dashboard → Edge Functions → Secrets → `ORS_API_KEY`.
