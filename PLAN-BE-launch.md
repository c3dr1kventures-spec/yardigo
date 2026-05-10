# YardiGo Belgium-launch plan

**Doel:** yardigo.be live krijgen als volwaardig Belgisch domein, met Vlaams (NL) als default en Frans (FR) als optie. Frankrijk pakken we later als losse stap als de tijd er is.

**Aanpak:** één codebase, twee domeinen (yardigo.nl en yardigo.be), taalkeuze afhankelijk van het domein. Geen redirect tussen .nl en .be.

**Geschatte doorlooptijd:** ongeveer 4 sessies van 1 tot 3 uur. Volgorde is belangrijk omdat fase 2 het fundament is voor fase 3 en verder.

---

## Beslispunten waar ik input van je nodig heb

Voordat we beginnen, drie keuzes die het plan beïnvloeden. Beantwoord deze in de volgende sessie.

1. **Default-taal voor Brusselse bezoekers?** Brussel is officieel tweetalig. Twee opties:
   - Default NL met FR-toggle (consistent met de rest van .be)
   - Een keuzescherm bij het eerste bezoek (NL of FR knop) waarna je voorkeur in localStorage wordt onthouden

   Ik leun zelf naar het keuzescherm omdat Brussel-bezoekers anders altijd één klik moeten zetten om naar hun voorkeurstaal te gaan. Maar het is jouw call.

2. **Cookie-banner: wel of niet?** Ik moet eerst zelf in de code checken of YardiGo nu tracking heeft die onder GDPR consent vereist. Als alleen Supabase auth-cookies (functional, geen consent vereist) en de session-id in localStorage worden gebruikt, kun je zonder banner. Als er Google Analytics, Brevo-tracking of vergelijkbaar in zit moet er een banner komen voor BE.

3. **Brevo-outreach voor BE: gelijktijdig met launch of pas later?** Outreach is iets aparts van de site. Als je eerst de site live wilt zien op .be voordat je een mailing inschiet, plannen we dat in fase 6 als optie.

---

## Fase 1: Eerst form-verlies bug fixen

**Waarom voor BE-launch:** elke nieuwe BE-gebruiker die zijn halve aanmaak-flow kwijtraakt vlak voor publish gaat dat onthouden. Klein klusje, grote irritatie-besparing op schaal.

**Wat:**

- LocalStorage-backup van het concept-listing-formulier. Elke 2 seconden serialiseer de huidige form-state naar `yg-draft-listing` in localStorage. Bij het openen van de plaats-flow checken: bestaat er een draft? Toon een toast "Je had een onafgemaakte verkoop. Verder werken?" met Ja-knop die de form rehydrate, en Nee-knop die de draft wist.
- Sessie-check verplaatsen naar het OPENEN van de plaats-flow (niet meer pas op publish). Dan ontdekt de gebruiker direct dat hij moet inloggen, voordat hij iets invult.
- Draft wissen na succesvolle publish.

**Effort:** 1 uur. Eén focus-sessie.

**Risico's:** localStorage-quota voor de foto-data-URLs. Foto's zijn dataURLs, makkelijk 1-2 MB elk. Als je 5 foto's hebt staat de draft op 5-10 MB. localStorage limit is doorgaans 5-10 MB per origin. Oplossing: foto-data-URLs niet opslaan in de draft, alleen het feit dat er N foto's waren plus tekst-velden. Bij rehydrate vragen we de gebruiker de foto's opnieuw te selecteren. Suboptimaal maar veilig.

---

## Fase 2: i18n-fundering uitbreiden

**Doel:** alle UI-strings in `index.html` zijn vertaalbaar via `data-i18n`-attributen, het `I18N`-object bevat NL, EN, FR (en DE alvast leeg of vertaald als je toch al bezig bent). De taalswitch werkt voor 100% van de zichtbare tekst.

**Wat:**

### 2a. Audit hardgecodeerde strings

Grep door `index.html` op alle Nederlandse strings die nog niet in een `data-i18n`-attribuut zitten. Lijst maken van plekken die handmatig gelabeld moeten worden. Categorieën om te checken:

- HTML-tekstinhoud (`<button>Plaatsen</button>` zonder data-i18n)
- Placeholder-attributen op inputs (`placeholder="Vul een titel in"`)
- aria-label en title-attributen
- JS-strings in `toast()`-calls (vereist een aparte aanpak: `t('key')` helper die uit I18N pakt)
- HTML-inhoud die met `innerHTML` of string-concatenation wordt opgebouwd
- Meta-tags (og:title, og:description, twitter:card)

**Effort:** 2 uur audit, plus 2-3 uur labels uitrollen. Saai maar mechanisch.

### 2b. I18N-object uitbreiden

Op dit moment heeft `I18N` alleen `nl` en `en`. Toevoegen:

- `fr`: volledige vertaling van alle keys. Doe dit via een vertaalbureau, ChatGPT met review-stap, of zelf als je goed Frans spreekt. Voor het bulk-consent-modaal is dat ongeveer 200 strings, voor de hele app schat ik 600-800 strings.
- `de` (optioneel): kun je nu al voorbereiden of openlaten met fallback naar EN. Aanrader: alvast leeg blok aanmaken zodat de structuur klopt, vullen als DE-launch echt op de planning komt.

**Effort:** 4-6 uur voor FR vertaling als je het zelf doet of via AI met review. 1 uur voor de structurele code-wijziging.

### 2c. Taalswitch-logica per land

Het `LANG_FLAGS`-object en de dropdown moeten weten welke talen voor welk land relevant zijn:

```javascript
var LANG_AVAILABILITY_BY_COUNTRY = {
  NL: ['nl', 'en'],         // Nederland: NL + EN
  BE: ['nl', 'fr'],         // België: Vlaams + Frans
  DE: ['de', 'en'],         // Duitsland (toekomst): DE + EN
  default: ['nl', 'en']
};
```

Bij het opbouwen van de dropdown filteren we op deze lijst. Dat voorkomt dat een Belg verwarrend EN als optie ziet.

**Effort:** 1 uur.

---

## Fase 3: Domain en country-detectie

**Doel:** yardigo.be serveert dezelfde codebase als yardigo.nl, maar default naar Vlaams en kent BE-specifieke instellingen.

**Wat:**

### 3a. Vercel: yardigo.be toevoegen

In het YardiGo Vercel-project: Settings → Domains → Add. Voeg toe: `yardigo.be` en `www.yardigo.be`. Vercel geeft DNS-records die je bij je registrar moet zetten (A-record + CNAME). Wachten tot de SSL geldig is.

**Effort:** 15 minuten plus eventueel wachttijd op DNS.

### 3b. Country-detectie in de app

Bovenin `index.html`, voor de I18N-init:

```javascript
// Country op basis van TLD. Override via ?country=XX query-param mogelijk
// voor lokaal testen.
var YG_COUNTRY = (function() {
  var override = new URLSearchParams(location.search).get('country');
  if (override) return override.toUpperCase();
  var host = (location.hostname || '').toLowerCase();
  if (host.endsWith('.be')) return 'BE';
  if (host.endsWith('.fr')) return 'FR';
  if (host.endsWith('.de')) return 'DE';
  return 'NL';
})();

var COUNTRY_DEFAULTS = {
  NL: { lang: 'nl', dpaName: 'Autoriteit Persoonsgegevens', dpaUrl: 'https://autoriteitpersoonsgegevens.nl' },
  BE: { lang: 'nl', dpaName: 'Gegevensbeschermingsautoriteit (APD/GBA)', dpaUrl: 'https://www.gegevensbeschermingsautoriteit.be' },
  DE: { lang: 'de', dpaName: 'Bundesbeauftragte für den Datenschutz', dpaUrl: 'https://www.bfdi.bund.de' }
};
```

De default-taal voor BE is NL (Vlaams). Voor FR die later komt, default FR.

**Effort:** 30 minuten.

### 3c. Default-taal-toepassing

Bij eerste bezoek: als er geen taalkeuze in localStorage staat, gebruik `COUNTRY_DEFAULTS[YG_COUNTRY].lang`. Daarna wordt de keuze van de gebruiker bewaard.

Edge case: als je beslist voor het Brussel-keuzescherm (zie beslispunt 1), check je bij eerste bezoek aan yardigo.be of `navigator.language` met `fr` begint. Zo ja: toon een eenmalig keuzescherm "NL of FR?" voordat je iets defaulet.

**Effort:** 1 uur.

---

## Fase 4: BE-specifieke content

**Doel:** privacy, cookies en juridische pagina's zijn volledig conform voor BE-bezoekers in NL en FR.

**Wat:**

### 4a. Privacy- en gebruiksvoorwaarden-pagina's

Conditional rendering op basis van `YG_COUNTRY`:

- DPA-vermelding: voor NL wijst de tekst naar Autoriteit Persoonsgegevens, voor BE naar APD/GBA. Hetzelfde voor het klacht-stuk: "Je hebt het recht om een klacht in te dienen bij {dpaName}".
- E-mailadres en bedrijfsgegevens consistent (info@yardigo.nl werkt voor beide, of je registreert info@yardigo.be voor branding).
- Volledige FR-vertaling van privacy + voorwaarden. Dit zijn lange teksten, schat 3000-5000 woorden vertaald via AI met menselijke review (jij of een vriend met goed Frans).

**Effort:** 1 uur conditional rendering. 3-4 uur vertaal- en reviewwerk afhankelijk van scope.

### 4b. Cookie-banner

Eerst checken: heeft YardiGo nu een banner? Ik kijk in de volgende sessie. Als niet:

- Implementeren als simpele banner onderin scherm met opties Accepteren / Weigeren / Voorkeuren.
- Voor functionele cookies (auth, session-id): geen consent vereist, mag altijd.
- Voor analytics of tracking (als die er is): consent vereist voor BE en aan te raden voor NL.
- Banner-state in localStorage onthouden, niet opnieuw tonen na keuze.

**Effort:** als banner nog niet bestaat: 3-4 uur inclusief tekst en triggers. Als er al een banner staat: 1 uur uitbreiden met BE-tekst.

### 4c. hreflang-tags

In de `<head>`:

```html
<link rel="alternate" hreflang="nl-nl" href="https://www.yardigo.nl/">
<link rel="alternate" hreflang="nl-be" href="https://www.yardigo.be/">
<link rel="alternate" hreflang="fr-be" href="https://www.yardigo.be/?lang=fr">
<link rel="alternate" hreflang="x-default" href="https://www.yardigo.nl/">
```

Belangrijk: de FR-versie heeft op dit moment dezelfde URL als de Vlaamse versie van .be, alleen met `?lang=fr`. Voor sterkere SEO-onderscheid kun je later subpaths overwegen (`/fr` en `/nl`) maar voor nu is de querystring acceptabel.

**Effort:** 30 minuten.

---

## Fase 5: Email-templates FR

**Doel:** Brevo-mails en Supabase-emails kunnen automatisch in de juiste taal worden verstuurd.

**Wat:**

- **Supabase confirmation-email**: aanpassen naar tweetalige versie of conditional op basis van een `lang` flag in de user metadata. Het template bestand bewerken in Supabase Dashboard → Authentication → Email Templates.
- **Buurtverkoop-bevestigingslinks**: deze worden via een YardiGo-functie gegenereerd in `confirmAddressEmail` of vergelijkbaar (check de code). Tekst moet beschikbaar zijn in NL en FR, gekozen op basis van de organisator-taal of de buur-taal als die bekend is.
- **Brevo outreach-template**: voor BE-mailings. Zelfde script als NL, vertaald naar Vlaams en Frans als afzonderlijke campagnes.

**Effort:** 2-3 uur.

---

## Fase 6: Testen en launch

**Wat:**

- Lokaal testen met `?country=BE` query-parameter zonder dat yardigo.be hoeft te resolven.
- Op staging (Vercel preview branch) checken: domain-detectie, taalkeuze, hreflang in head, privacy-pagina FR-versie.
- Live deploy naar yardigo.be.
- Manuele test op je iPhone vanuit een Belgisch IP (eventueel via VPN of letterlijk vanuit BE) of via Vercel-edge-routing simuleren.
- BE-specifieke seed-content: een paar Belgische voorbeeld-buurtverkopen plaatsen zodat de kaart in BE niet leeg is bij de eerste bezoeker.
- Optional: Brevo-mailing naar BE-lijst (als je die hebt) met FR + NL versie.

**Effort:** 2-4 uur.

---

## Wat we expliciet NIET doen in deze fase

- yardigo.fr registreren of bouwen. Frankrijk komt als losse stap later.
- DE-vertaling volledig afmaken. Alleen het structurele blok in I18N voorbereiden, vullen als DE-launch op de planning komt.
- Locale-aware datum- en valuta-formatting (kan later, prio is laag voor garage sales).
- Multi-currency. EUR is overal, geen werk nodig.
- iOS App Store-listing voor BE. Dit is alleen web-launch.

---

## Risico's en aandachtspunten

- **SEO-overgang:** als je vroeger ergens tijdelijk yardigo.be naar yardigo.nl had geredirect, valt die "redirect history" weg op het moment dat we het loskoppelen. Niet erg voor een nieuw domein, maar checken voor de zekerheid.
- **Vertaalkwaliteit:** een halve FR-vertaling is slechter dan geen FR. Liever in fasen FR-content lanceren waarvan we 100% zeker weten dat de tekst klopt, dan alles in één keer half uitrollen.
- **Brusselse bezoekers:** als beslispunt 1 niet glashelder beantwoord wordt, ofwel default je 'm op NL ofwel bouw je het keuzescherm. Neem die beslissing voordat je 3c bouwt.
- **Email deliverability:** Brevo vanuit yardigo.app@gmail.com kan in BE strenger gefilterd worden dan in NL. Op tijd checken hoe je SPF, DKIM en DMARC nu staan en of je yardigo.be domein nog moet warmen.

---

## Voorgestelde volgorde

1. **Sessie A (1 uur):** Form-verlies bug + cookie-banner check + beslispunt 1 t/m 3 beantwoorden.
2. **Sessie B (3 uur):** i18n-audit + I18N-uitbreiding met leeg FR-blok + structurele wijzigingen voor data-i18n-uitrol.
3. **Sessie C (3-4 uur):** FR-vertaling van alle UI-strings (extern proces of intern, niet noodzakelijk Claude-sessie) + reviewen.
4. **Sessie D (2 uur):** Vercel-domain + country-detectie + hreflang + BE-specifieke privacy/voorwaarden conditional rendering.
5. **Sessie E (2-3 uur):** Cookie-banner uitbouwen indien nodig + email-templates FR.
6. **Sessie F (2 uur):** Test + deploy + seed BE-content + outreach voorbereiden.

Totaal: rond de 14-18 uur werk verdeeld over een week of twee, afhankelijk van hoe snel de FR-vertaling rondkomt.
