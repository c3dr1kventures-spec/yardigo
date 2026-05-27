# YardiGo — Android App Build Guide

## Wat je nodig hebt

- **Mac of Windows** (Android Studio werkt op beide)
- **Android Studio** (gratis) — https://developer.android.com/studio
- **Node.js 18+** (`node -v`)
- **Java JDK 21** — komt mee met Android Studio (geen aparte install nodig)
- **Google Play Console account** — €25 eenmalig, https://play.google.com/console/signup

---

## Eenmalige setup (alleen de eerste keer)

### 1. Android Studio installeren
1. Download van https://developer.android.com/studio
2. Open installer → "Standard" setup → laat alles aanvinken (SDK + Emulator)
3. Eerste keer openen duurt ~10 min (downloadt SDK + system images)

### 2. Node dependencies
```bash
cd /Users/christian/.openclaw/workspace/YardiGo
npm install
```

### 3. Open Android-project in Android Studio
```bash
npm run open:android
```
Eerste keer duurt 5-10 min (Gradle sync). Daarna in Android Studio:
- Klik op het 🔨 hamer-icoon → "Make Project" om te checken of alles bouwt
- Plug een Android-telefoon in (USB-debugging aan) of start emulator
- Klik op ▶ Play om de app te starten

---

## Dagelijkse workflow: web-code wijzigen + testen op Android

```bash
# 1. Wijzig index.html zoals normaal
# 2. Sync naar Android:
npm run sync:android

# 3. Open Android Studio (alleen 1ste keer of na native config-wijzigingen):
npm run open:android

# 4. Druk op ▶ Play in Android Studio
```

Voor parallel testen op iOS én Android tegelijk:
```bash
npm run sync:all   # sync naar beide platforms
```

---

## Eerste release naar Play Store

### Fase 1 — Voorbereiden (ééns)

1. **Play Console-account aanmaken**
   - https://play.google.com/console/signup
   - €25 eenmalig, identiteitsverificatie (ID-document + selfie) duurt 1-2 dagen
   - Bewaar de inloggegevens veilig

2. **Upload keystore aanmaken** (de sleutel die JOUW app uniek maakt)
   In Android Studio:
   - Build → Generate Signed Bundle / APK
   - Kies "Android App Bundle"
   - "Create new..." → kies pad **buiten** de git-repo, bv:
     `~/yardigo-keys/yardigo-release.jks`
   - Vul in: validity 25+ jaar, password (BEWAAR DIT — zonder dit kun je
     nooit meer updates publiceren), key alias `yardigo`
   - Bewaar wachtwoord in een password manager (1Password, Bitwarden)

3. **App registreren in Play Console**
   - Klik "Create app"
   - App-naam: YardiGo
   - Default taal: Nederlands
   - App of game: App
   - Free/paid: Free
   - Accepteer Play Console policies

### Fase 2 — Store-listing invullen

Verzamel deze content alvast:

- **App-beschrijving (kort, 80 tekens):**
  "Vind garage sales, opritverkopen en rommelmarkten bij jou in de buurt."
- **Volledige beschrijving (4000 tekens max)** — schrijven in NL
- **App-icon 512×512 PNG** — `play-store-assets/play-store-icon-512.png` ✓
- **Feature graphic 1024×500 PNG** — moet nog gemaakt worden (placeholder
  staat in `play-store-assets/`)
- **Phone screenshots** — min 2, max 8, 1080×1920 of vergelijkbaar
  Maak deze via Android Studio's emulator (Cmd-S in emulator)
- **Privacybeleid-URL** — https://yardigo.nl/privacy (controleer of deze
  bereikbaar is, Google checkt dit automatisch)

### Fase 3 — Play Console-formulieren (~30 min werk)

1. **Content rating** — questionnaire over leeftijd/inhoud
2. **Doelgroep en inhoud** — kies "13+ en ouder"
3. **Data veiligheid** — wat verzamel je?
   - YardiGo: e-mailadres (verplicht voor account), locatie (optioneel),
     foto's die gebruiker zelf upload
4. **Advertentiebeleid** — geen advertenties → "Bevat geen advertenties"
5. **App-toegang** — werkt zonder login? Vermeld dat gast-modus mogelijk is

### Fase 4 — Release

```bash
# Genereer Android App Bundle (.aab) in Android Studio:
# Build → Generate Signed Bundle / APK → kies bestaande keystore
# Output: android/app/release/app-release.aab
```

Upload `app-release.aab` in Play Console → "Production" → "Create release".

**Eerste review duurt 3-7 dagen.** Updates daarna meestal binnen 24 uur.

---

## Versie verhogen voor een update

In `android/app/build.gradle`:
```gradle
versionCode 2        // verhoog met 1 elke release
versionName "1.0.1"  // semver, zichtbaar voor gebruiker
```

---

## Troubleshooting

**"SDK location not found" bij Android Studio open**
→ Maak `android/local.properties` met:
```
sdk.dir=/Users/christian/Library/Android/sdk
```
(dit bestand niet committen — staat in .gitignore)

**Gradle sync failed**
→ File → Invalidate Caches → Restart

**App crash bij start in emulator**
→ Check `adb logcat` in terminal, of bekijk de Logcat-tab in Android Studio

**Map laadt niet in de native app**
→ Capacitor blokkeert geen cross-origin requests, maar check
`AndroidManifest.xml` heeft `INTERNET` permission (al toegevoegd)
