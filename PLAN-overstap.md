# Overstap: nieuwe site op `/`, web-app naar `/app` (27 okt 2026)

## SEO-check (stand vóór de overstap)

| # | Bevinding | Impact | Oplossing bij overstap |
|---|---|---|---|
| 1 | `/` is de web-app: in de ruwe HTML staat vooral app-schil, weinig echte tekst | hoog | nieuwe startpagina met kaart, uitleg en lijsten wordt `/` |
| 2 | Nieuwe pagina's staan op `noindex,nofollow` | hoog (bewust) | `noindex` weg op `/` en `/kaart` |
| 3 | `/nieuw...` is al gedeeld/getest; na verhuizen zou dat 404 geven | middel | 301: `/nieuw` → `/`, `/nieuw/kaart` → `/kaart`, `/nieuw/verkoop?id=` → `/v/{id}` |
| 4 | `/v/{id}` stuurt bezoekers nog door naar de app (`NIEUWE_SITE = false`) | hoog | `NIEUWE_SITE = true`: bezoekers blijven op de verkooppagina |
| 5 | yardigo.be/ en /fr tonen de app (be-nl) en de oude landingspagina (fr.html) | middel | beide gebouwd uit de nieuwe startpagina, met eigen taal, titel, canonical en hreflang |
| 6 | hreflang-set nl-nl / nl-be / fr-be / x-default klopt en is wederkerig | ok | zelfde set op de nieuwe startpagina's |
| 7 | Nieuwe startpagina mist canonical, og-tags en JSON-LD (WebSite/Organization) | middel | toegevoegd; SearchAction (`?q=`) vervalt, Google gebruikt die sinds 2024 niet meer |
| 8 | Kaartpagina-titel "rommelmarkten en opritverkopen" (verkeerde volgorde, geen garagesales) | laag | "Kaart: garagesales, rommelroutes en rommelmarkten bij jou in de buurt" |
| 9 | Sitemap mist de kaartpagina | laag | `/kaart` erbij |
| 10 | `/app` zou een tweede startpagina met dezelfde titel worden | middel | `/app`: canonical naar zichzelf, `noindex,follow` |
| 11 | robots.txt: zoekmachines toegestaan, AI-trainers/scrapers geblokkeerd, sitemaps vermeld | ok | ongewijzigd |
| 12 | Live-check met curl niet mogelijk (Vercel-firewall geeft 429 aan scripts) | info | na de push controleren in een browser + Search Console |

## Welke URL's verhuizen

| Nu | Na de overstap |
|---|---|
| `/` (web-app) | `/` = nieuwe startpagina; web-app op `/app` |
| `/?v={id}` | 308 → `/v/{id}` (nieuwe verkooppagina) |
| `/?plaatsen=` `/?route=` `/?uitschrijven=` `/?uitschrijven-promo=` `/?token=` `/?reset=1` `/?tab=` `/?action=` `/?country=` | 308 → `/app?…` (zelfde parameters; e-mails en oude links blijven werken) |
| inlog-/bevestiglinks met `#access_token` of `?code=` op `/` | startpagina stuurt ze direct door naar `/app` (hash gaat niet naar de server) |
| `/aanmelden`, `/verkoop` | blijven korte links, openen het plaatsformulier in de web-app |
| `/nieuw`, `/nieuw/kaart`, `/nieuw/verkoop?id=` | 308 → `/`, `/kaart`, `/v/{id}` |
| yardigo.be/ | nieuwe startpagina (nl-BE) |
| yardigo.be/fr | nieuwe startpagina in het Frans (fr-BE), vervangt fr.html |
| `/home` | blijft 308 → `/` |
| `/v/{id}` | nieuwe verkooppagina; nieuwe verkopen tussen twee builds via `/api/share` ook op de nieuwe pagina |

## Apps (iOS/Android/Mac)

De apps laden hun eigen kopie (`www/`, Capacitor `webDir`) en openen `yardigo.nl/` niet. Er zijn geen universal links. Ze delen `yardigo.nl/v/{id}`, en dat wordt de nieuwe verkooppagina. Er hoeft dus niets in de apps te veranderen. `npm run sync` kopieert voortaan `app.html` naar `www/index.html`.

## Na de push (Christian)

1. Controleren op iPhone + desktop: `/`, `/kaart`, `/app`, een `/v/`-link, inloggen in `/app`, yardigo.be/ en /fr.
2. Search Console (nl en be): sitemap opnieuw insturen, URL-inspectie op `/` en `/kaart`, "Indexering aanvragen".
3. Over 1-2 weken: dekkingsrapport bekijken (geen stijging in 404's of "Gecrawld, niet geïndexeerd").
