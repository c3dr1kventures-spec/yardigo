# YardiGo Setup Guide

## Stap 1: GitHub CLI installeren & inloggen

### macOS
```bash
brew install gh
```

### Windows
```bash
winget install --id GitHub.cli
```

Login daarna:
```bash
gh auth login
```
Kies: GitHub.com → HTTPS → Login with a web browser

## Stap 2: Repo aanmaken en pushen

Open een terminal in de YardiGo map en voer uit:

```bash
cd /pad/naar/YardiGo
git add .
git commit -m "Initial commit: YardiGo PWA"
gh repo create yardigo --public --source=. --remote=origin --push
```

Controleer daarna op https://github.com/JOUW-USERNAME/yardigo

## Stap 3: Vercel koppelen

1. Ga naar https://vercel.com/dashboard
2. Klik "Add New..." → "Project"
3. Klik "Import Git Repository" en selecteer de `yardigo` repo
4. Settings:
   - Framework Preset: Other
   - Build Command: (leeg laten)
   - Output Directory: `.` (punt)
5. Klik "Deploy"

## Stap 4: Custom domain (yardigo.nl)

1. In Vercel: ga naar je project → Settings → Domains
2. Voeg `yardigo.nl` toe
3. Vercel geeft je DNS-instellingen. Ga naar je domeinregistrar en stel in:
   - Type: A record → `76.76.21.21`
   - Type: CNAME voor `www` → `cname.vercel-dns.com`
4. Wacht tot DNS is gepropageerd (kan tot 48 uur duren, meestal sneller)

## Stap 5: Supabase database

1. Ga naar https://supabase.com/dashboard
2. Open je project → SQL Editor
3. Plak de inhoud van `supabase-schema.sql` en klik "Run"
4. Ga naar Settings → API en kopieer je:
   - Project URL (bijv. `https://xxx.supabase.co`)
   - Anon/public key
5. Voeg deze toe aan je `index.html` of een `.env` bestand

## Stap 6: Supabase koppelen aan de app

Voeg in je `index.html` toe (in de `<head>`):

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
```

En initialiseer:

```javascript
const supabase = supabase.createClient(
  'https://jouw-project.supabase.co',
  'jouw-anon-key'
);
```
