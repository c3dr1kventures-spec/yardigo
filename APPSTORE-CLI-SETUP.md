# YardiGo — App store releases vanaf de command line (fastlane)

Doel: iOS en Android naar de stores uploaden zonder Xcode/Android Studio
handmatig te bedienen. Fastlane is al geïnstalleerd en geconfigureerd
(`ios/App/fastlane/`, `android/fastlane/`) — hieronder de stappen die
alleen jij kunt zetten (accounts, credentials).

## Android — al gedaan

- Nieuwe release-keystore aangemaakt: `~/yardigo-keys/yardigo-release.jks`
  (10.000 dagen geldig, ruim voldoende voor Play Store's eis).
- `android/keystore.properties` aangemaakt (gitignored) met onderstaande
  gegevens — `android/app/build.gradle` leest dit automatisch bij een
  release-build.

**Bewaar dit ergens veilig (password manager) — dit is nu je enige kopie:**
```
Keystore:      ~/yardigo-keys/yardigo-release.jks
Alias:         yardigo
Wachtwoord:    dgWInJmf6uq7psDK9BAW4z39   (zelfde voor store + key)
```
Verlies je dit bestand/wachtwoord, dan kun je de app nooit meer updaten
onder dezelfde package (`nl.yardigo.app`) — tenzij je Play App Signing
gebruikt (zie hieronder), dan kan Google je helpen met een reset van de
upload-key.

### Nog te doen: Play Console service-account

1. Ga naar [Google Cloud Console](https://console.cloud.google.com/) →
   kies (of maak) een project gekoppeld aan je Play Console-account.
2. IAM & Admin → Service Accounts → **Create Service Account** (naam bv.
   "yardigo-fastlane").
3. Maak een JSON-sleutel voor dit account aan (Keys → Add Key → JSON) →
   download het bestand.
4. Play Console → Instellingen → API-toegang → koppel dit service-account
   → geef **Release manager**-rechten (kunnen uploaden, niet per se
   volledig admin).
5. Sla het JSON-bestand op als `~/yardigo-keys/play-console-service-account.json`
   (buiten git, zelfde map als de keystore).
6. Maak `android/fastlane/.env` aan (kopieer van `.env.example`) met:
   ```
   SUPPLY_JSON_KEY_FILE=/Users/christian/yardigo-keys/play-console-service-account.json
   ```

### Eerste keer: nog handmatig via Play Console

Omdat `nl.yardigo.app` in Play Console nog nooit een signed build heeft
gehad (versionCode stond nog op 1 zonder keystore), moet de **allereerste**
upload naar een nieuwe of nog-lege app meestal nog via de Play Console
web-UI (Google vereist dit voor het aanmaken van de eerste release op een
vers pakket). Daarna werkt `fastlane android internal` / `release` gewoon
voor alle volgende updates.

## iOS — al gedaan

- `ios/App/fastlane/Appfile` en `Fastfile` staan klaar, met lanes
  `beta` (TestFlight) en `release` (App Store Connect, upload zonder
  automatisch in te dienen voor review).
- Code signing blijft "Automatic" via je Apple Developer-team
  (`8XQPVYJFUN`) — fastlane hergebruikt gewoon de certificaten die al in
  je Keychain staan via Xcode.

### Nog te doen: App Store Connect API-key

1. [appstoreconnect.apple.com](https://appstoreconnect.apple.com/access/api) →
   Users and Access → Integrations → App Store Connect API.
2. **Generate API Key** → rol minimaal **App Manager** (kan builds
   uploaden en beheren).
3. Download de `.p8`-sleutel — dit kan **maar één keer**, bewaar 'm
   meteen goed.
4. Noteer de **Key ID** en **Issuer ID** (bovenaan de pagina).
5. Zet de `.p8` op: `~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8`
   (standaardlocatie, of een andere map — maakt niet uit zolang het pad
   klopt in `.env`).
6. Maak `ios/App/fastlane/.env` aan (kopieer van `.env.example`) met:
   ```
   ASC_KEY_ID=<jouw Key ID>
   ASC_ISSUER_ID=<jouw Issuer ID>
   ASC_KEY_FILEPATH=/Users/christian/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8
   ```

## Gebruik (zodra de .env-bestanden er staan)

```bash
# iOS: bouwen + naar TestFlight (goed om eerst te testen)
cd ios/App && fastlane beta

# iOS: bouwen + naar App Store Connect (jij dient zelf in voor review)
cd ios/App && fastlane release

# Android: bouwen + naar het interne testspoor
cd android && fastlane internal

# Android: bouwen + naar productie (staged rollout op 10%, jij zet 'm verder open)
cd android && fastlane release
```

Zorg dat `npm run sync:all` gedraaid is vóór een release-lane, zodat de
`www/`-bundel de laatste code bevat.
