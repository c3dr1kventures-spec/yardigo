# YardiGo — iOS App Build Guide

## Wat je nodig hebt

- **Mac** met macOS 13 of nieuwer
- **Xcode 15+** (gratis via App Store)
- **Node.js 18+** (check: `node -v`)
- **CocoaPods** (check: `pod --version`)
- **Apple Developer Account** — https://developer.apple.com (€99/jaar)

---

## Eenmalige setup (alleen de eerste keer)

### 1. CocoaPods installeren (als je dat nog niet hebt)
```bash
sudo gem install cocoapods
```

### 2. Node dependencies installeren
```bash
cd ~/YardiGo
npm install
```

### 3. iOS dependencies installeren
```bash
cd ios/App
pod install
cd ../..
```

---

## Dagelijkse workflow — na elke aanpassing aan YardiGo

```bash
cd ~/YardiGo
npm run sync
```

Dit doet automatisch:
1. Kopieert `yardigo-v20.html` naar `www/`
2. Synchroniseert alle bestanden naar het Xcode project

Daarna open je Xcode met:
```bash
npm run open
```

Of doe alles in één keer:
```bash
npm run build
```

---

## Eerste keer bouwen in Xcode

1. Open Xcode via `npm run open`
2. Selecteer bovenin het apparaat (simulator of jouw iPhone)
3. Klik op **▶ Run** (of `Cmd + R`)
4. De app start in de simulator

---

## App naar de App Store uploaden

### Stap 1: Bundle Identifier instellen
In Xcode → klik op **App** in de sidebar → **Signing & Capabilities**
- Team: selecteer jouw Apple Developer account
- Bundle Identifier: `nl.yardigo.app`

### Stap 2: Versie ophogen
In Xcode → **App** → **General**
- Version: `1.0.0` (gebruikersversie, zichtbaar in App Store)
- Build: `1` (verhoog dit bij elke upload)

### Stap 3: Archiveer de app
- Bovenin Xcode: selecteer **Any iOS Device (arm64)** als target
- Menu: **Product → Archive**
- Wacht (~2 min) totdat het Organizer venster opent

### Stap 4: Upload naar App Store Connect
- In het Organizer venster: klik **Distribute App**
- Kies **App Store Connect → Upload**
- Volg de wizard (alles op default laten)
- Na upload: ga naar https://appstoreconnect.apple.com

### Stap 5: App Store Connect invullen
- Voeg screenshots toe (vereist: 6.7" iPhone)
- Vul beschrijving in (Nederlands)
- Stel prijs in (gratis)
- Voeg privacy policy URL toe (verplicht!)
- Dien in voor review → gemiddeld 1-2 dagen

---

## Updates uitbrengen

### Kleine wijziging (HTML/CSS/JS)
```bash
cd ~/YardiGo
# pas yardigo-v20.html aan
npm run sync
npm run open
# Build + Archive + Upload in Xcode
```
Verhoog altijd het **Build** nummer in Xcode bij elke upload.

### Tip: Capgo voor live updates (optioneel)
Met Capgo kun je HTML/JS updates direct naar gebruikers pushen zonder App Store review.
Meer info: https://capgo.app

---

## Veelgestelde vragen

**Q: Xcode zegt "No signing certificate"**
A: Ga naar Xcode → Preferences → Accounts → voeg je Apple ID toe.

**Q: `pod install` faalt**
A: Probeer eerst `sudo gem update cocoapods` en daarna opnieuw.

**Q: De app laadt een witte pagina**
A: Run `npm run sync` opnieuw en herstart de app in de simulator.

**Q: App Store review duurt lang**
A: Gemiddeld 24-48 uur. Expedited review aanvragen kan via App Store Connect als het urgent is.
