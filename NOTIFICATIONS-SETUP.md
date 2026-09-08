# YardiGo — Notificatiesysteem: deploy-stappen

Deze stappen zijn nodig om het herbouwde notificatiesysteem live te zetten.
Code-kant (schema, edge functions, wizard-UI) is al klaar in de repo — dit
zijn de handmatige stappen die alleen jij met toegang tot Supabase/OneSignal/
Apple kunt zetten.

## 1. Database-migratie

Voer `notification-system-rebuild.sql` uit in de Supabase SQL Editor.
Voegt toe: `notification_preferences`, `push_subscriptions`, `device_tokens`,
`notification_log`, en formaliseert een aantal profiles-kolommen die al in
productie werden gebruikt maar nooit in een migratie-bestand stonden.

## 2. Web Push (VAPID) — secrets instellen

VAPID-keypair is gegenereerd (public key staat al in `index.html` als
`VAPID_PUBLIC_KEY`). De **private key is alleen in de chat gedeeld**, niet
in dit bestand of in git — kopieer 'm van daar.

Zet in Supabase → Project Settings → Edge Functions → Secrets:

```
VAPID_PUBLIC_KEY=<zelfde waarde als VAPID_PUBLIC_KEY in index.html>
VAPID_PRIVATE_KEY=<uit de chat, niet in git>
VAPID_SUBJECT=mailto:support@yardigo.nl
NOTIF_CRON_SECRET=<zelf een lang random secret verzinnen>
NOTIF_BASE_URL=https://www.yardigo.nl
```

## 3. Edge functions deployen

```
supabase functions deploy save-push-subscription
supabase functions deploy save-device-token
supabase functions deploy notify-interest
supabase functions deploy process-notifications
```

`notify-interest` hergebruikt de bestaande Brevo-secrets
(`BREVO_API_KEY`, `REMINDER_FROM_EMAIL`, `REMINDER_FROM_NAME`,
`REMINDER_BASE_URL`) die al voor de reminder-mails staan.

## 4. pg_cron schedules

Zie het commentaarblok onderaan
`supabase/functions/process-notifications/index.ts` voor de exacte
`cron.schedule(...)`-statements (6 jobs: nearby, category_direct,
favorites, morning_route, digest_daily, digest_weekly). Vervang
`<PROJECT>` en `<NOTIF_CRON_SECRET>` en voer uit in de SQL Editor.

## 5. OneSignal (native iOS/Android push)

1. Account aanmaken op onesignal.com (gratis tot 10k subscribers)
2. Nieuwe app aanmaken, platform "Apple iOS" + "Google Android" toevoegen
3. iOS: in je Apple Developer account een APNs Auth Key (.p8) genereren
   (Certificates → Keys → nieuwe key met "Apple Push Notifications service")
   en uploaden in OneSignal onder Settings → Apple iOS
4. Android: OneSignal kan een eigen Firebase-project voor je aanmaken, of
   koppel je eigen Firebase-project (Settings → Google Android)
5. Kopieer de **OneSignal App ID** en **REST API Key**
6. Zet als Supabase secret: `ONESIGNAL_APP_ID`, `ONESIGNAL_REST_API_KEY`
7. Vul dezelfde App ID in als `ONESIGNAL_APP_ID`-constante in `index.html`
   (regel bij "ONESIGNAL — native iOS/Android push")
8. `npm install` (haalt `@onesignal/capacitor-plugin` op) → `npm run sync:all`
9. Xcode: Push Notifications capability + Background Modes → Remote
   notifications aanzetten voor de App-target
10. Testen op een echt toestel (push werkt niet in de simulator/emulator
    zonder extra configuratie) — controleer in Safari/Chrome remote debug
    dat `Capacitor.Plugins.OneSignal` bestaat; de exacte plugin-naam kan
    afwijken, zie comment in `initOneSignalIfNative()` in `index.html`

## 6. Testen

- Web: instellingen → Meldingen-wizard doorlopen, browser-permissie
  goedkeuren, controleren dat er een rij in `push_subscriptions` verschijnt
- Handmatig een cron-job triggeren om te testen zonder te wachten:
  `curl -X POST https://<project>.functions.supabase.co/process-notifications?job=nearby -H "x-cron-secret: <secret>"`
- Check Supabase edge function logs bij problemen
