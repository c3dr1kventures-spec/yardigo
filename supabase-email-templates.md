# Supabase email templates voor BE-launch

Pragmatische tweetalige aanpak: omdat Supabase Auth email-templates niet per gebruiker een andere taal kunnen serveren zonder custom SMTP, sturen we tweetalige mails (NL + FR onder elkaar). Vlaamse en Nederlandse bezoekers lezen het bovenste blok, Waalse en Brusselse FR-bezoekers het onderste.

## Waar plakken

1. Log in op https://supabase.com/dashboard
2. Open project `fwehqudhwzcnkcuypuqw`
3. Links in de zijbalk: **Authentication** → **Email Templates**
4. Voor elke template hieronder: klik de template-naam open, vervang het Subject en de Message body met de versie hieronder, klik **Save**

## 1. Confirm signup

**Subject:**

```
Bevestig je YardiGo-account · Confirmez votre compte YardiGo
```

**Message body (HTML):**

```html
<h2 style="color:#E07B39;font-family:'Helvetica Neue',Arial,sans-serif">Welkom bij YardiGo</h2>

<p>Bedankt voor je registratie. Klik op de knop hieronder om je e-mailadres te bevestigen en je account te activeren.</p>

<p style="margin:24px 0">
  <a href="{{ .ConfirmationURL }}" style="background:#E07B39;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block">Bevestig e-mail</a>
</p>

<p style="font-size:13px;color:#7A6E62">Werkt de knop niet? Kopieer deze link in je browser:<br>
<a href="{{ .ConfirmationURL }}" style="color:#E07B39;word-break:break-all">{{ .ConfirmationURL }}</a></p>

<hr style="border:none;border-top:1px solid #EDE8DF;margin:32px 0">

<h2 style="color:#E07B39;font-family:'Helvetica Neue',Arial,sans-serif">Bienvenue chez YardiGo</h2>

<p>Merci pour votre inscription. Cliquez sur le bouton ci-dessous pour confirmer votre adresse e-mail et activer votre compte.</p>

<p style="margin:24px 0">
  <a href="{{ .ConfirmationURL }}" style="background:#E07B39;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block">Confirmer l'e-mail</a>
</p>

<p style="font-size:13px;color:#7A6E62">Le bouton ne fonctionne pas ? Copiez ce lien dans votre navigateur :<br>
<a href="{{ .ConfirmationURL }}" style="color:#E07B39;word-break:break-all">{{ .ConfirmationURL }}</a></p>

<p style="font-size:12px;color:#7A6E62;margin-top:32px">YardiGo · <a href="https://www.yardigo.nl" style="color:#7A6E62">yardigo.nl</a> · <a href="https://www.yardigo.be" style="color:#7A6E62">yardigo.be</a></p>
```

## 2. Reset password

**Subject:**

```
Wachtwoord opnieuw instellen · Réinitialiser votre mot de passe
```

**Message body (HTML):**

```html
<h2 style="color:#E07B39;font-family:'Helvetica Neue',Arial,sans-serif">Wachtwoord opnieuw instellen</h2>

<p>Je hebt gevraagd om je wachtwoord opnieuw in te stellen. Klik op de knop om een nieuw wachtwoord te kiezen.</p>

<p style="margin:24px 0">
  <a href="{{ .ConfirmationURL }}" style="background:#E07B39;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block">Wachtwoord wijzigen</a>
</p>

<p style="font-size:13px;color:#7A6E62">Heb je dit niet aangevraagd? Negeer deze e-mail dan, je wachtwoord blijft ongewijzigd.</p>

<hr style="border:none;border-top:1px solid #EDE8DF;margin:32px 0">

<h2 style="color:#E07B39;font-family:'Helvetica Neue',Arial,sans-serif">Réinitialiser votre mot de passe</h2>

<p>Vous avez demandé à réinitialiser votre mot de passe. Cliquez sur le bouton pour choisir un nouveau mot de passe.</p>

<p style="margin:24px 0">
  <a href="{{ .ConfirmationURL }}" style="background:#E07B39;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block">Modifier le mot de passe</a>
</p>

<p style="font-size:13px;color:#7A6E62">Vous n'avez pas fait cette demande ? Ignorez cet e-mail, votre mot de passe restera inchangé.</p>

<p style="font-size:12px;color:#7A6E62;margin-top:32px">YardiGo · <a href="https://www.yardigo.nl" style="color:#7A6E62">yardigo.nl</a> · <a href="https://www.yardigo.be" style="color:#7A6E62">yardigo.be</a></p>
```

## 3. Magic Link (als je deze gebruikt)

**Subject:**

```
Je inloglink voor YardiGo · Votre lien de connexion YardiGo
```

**Message body (HTML):**

```html
<h2 style="color:#E07B39;font-family:'Helvetica Neue',Arial,sans-serif">Inloggen bij YardiGo</h2>

<p>Klik op de knop om in te loggen. De link is 1 uur geldig en kan maar 1 keer gebruikt worden.</p>

<p style="margin:24px 0">
  <a href="{{ .ConfirmationURL }}" style="background:#E07B39;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block">Inloggen</a>
</p>

<hr style="border:none;border-top:1px solid #EDE8DF;margin:32px 0">

<h2 style="color:#E07B39;font-family:'Helvetica Neue',Arial,sans-serif">Connexion à YardiGo</h2>

<p>Cliquez sur le bouton pour vous connecter. Le lien est valable 1 heure et utilisable une seule fois.</p>

<p style="margin:24px 0">
  <a href="{{ .ConfirmationURL }}" style="background:#E07B39;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block">Se connecter</a>
</p>

<p style="font-size:12px;color:#7A6E62;margin-top:32px">YardiGo · <a href="https://www.yardigo.nl" style="color:#7A6E62">yardigo.nl</a> · <a href="https://www.yardigo.be" style="color:#7A6E62">yardigo.be</a></p>
```

## 4. Email change confirmation

**Subject:**

```
Bevestig je nieuwe e-mailadres · Confirmez votre nouvelle adresse e-mail
```

**Message body (HTML):**

```html
<h2 style="color:#E07B39;font-family:'Helvetica Neue',Arial,sans-serif">Bevestig je nieuwe e-mailadres</h2>

<p>Klik op de knop om dit nieuwe e-mailadres te koppelen aan je YardiGo-account.</p>

<p style="margin:24px 0">
  <a href="{{ .ConfirmationURL }}" style="background:#E07B39;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block">Bevestig e-mailadres</a>
</p>

<p style="font-size:13px;color:#7A6E62">Heb je dit niet aangevraagd? Mail dan zo snel mogelijk naar info@yardigo.nl.</p>

<hr style="border:none;border-top:1px solid #EDE8DF;margin:32px 0">

<h2 style="color:#E07B39;font-family:'Helvetica Neue',Arial,sans-serif">Confirmez votre nouvelle adresse e-mail</h2>

<p>Cliquez sur le bouton pour associer cette nouvelle adresse e-mail à votre compte YardiGo.</p>

<p style="margin:24px 0">
  <a href="{{ .ConfirmationURL }}" style="background:#E07B39;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block">Confirmer l'adresse e-mail</a>
</p>

<p style="font-size:13px;color:#7A6E62">Vous n'avez pas fait cette demande ? Envoyez un e-mail dès que possible à info@yardigo.nl.</p>

<p style="font-size:12px;color:#7A6E62;margin-top:32px">YardiGo · <a href="https://www.yardigo.nl" style="color:#7A6E62">yardigo.nl</a> · <a href="https://www.yardigo.be" style="color:#7A6E62">yardigo.be</a></p>
```

## Notities

- Supabase ondersteunt de templates `{{ .ConfirmationURL }}`, `{{ .Email }}`, `{{ .Token }}` en `{{ .RedirectTo }}`. Andere tags worden niet vervangen.
- Voor een echt taal-aware mail (alleen NL of alleen FR per ontvanger) is een Edge Function of custom SMTP via Brevo/SendGrid nodig. Dat is een grotere klus die we kunnen doen als de eerste BE-aanmeldingen binnenkomen.
- Test na het opslaan zelf even: log uit, registreer een nieuw test-account met yardigo.app+test@gmail.com (Gmail-aliasing), check de inbox. Beide blokken horen netjes onder elkaar te staan.
- Vergeet niet bij **Authentication** → **URL Configuration** de site URL en Redirect URLs uit te breiden met `https://www.yardigo.be` en `https://yardigo.be` als die er nog niet bij staan, anders weigert Supabase post-login redirects naar het BE-domein.
