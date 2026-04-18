-- ============================================================
-- YardiGo — Buurtverkoop: AVG-conforme bevestigingslink
-- Plak dit in: Supabase Dashboard → SQL Editor → New query
--
-- Achtergrond (AVG art. 6a):
--  Bij een buurtverkoop voert de organisator ook adressen van
--  buren in. Dat is een persoonsgegeven van die buren, dus er
--  is een geldige grondslag nodig. De enige werkbare grondslag
--  is TOESTEMMING — en die moet aantoonbaar zijn. Daarom:
--   - Een neighbor-listing wordt aangemaakt met status='pending'
--     en is ONZICHTBAAR voor iedereen (behalve de organisator
--     zelf, zodat hij/zij het kan beheren).
--   - De organisator deelt een unieke bevestigingslink met de
--     buur. Pas na 'confirmed' via die link komt de listing
--     online.
--   - Bij 'declined' wissen we alle adres-gegevens direct.
--   - Na 7 dagen 'pending' zetten we automatisch op 'expired'
--     en wissen we adres-gegevens.
--
-- Wat dit script doet:
--  1. Voegt kolommen confirmation_* toe aan listings
--  2. Zet bestaande listings op 'confirmed' (backfill)
--  3. Update get_listings_for_user() RPC: filter pending/declined/expired
--  4. RPC get_confirmation_context(token)  — voor bevestig.html
--  5. RPC confirm_buurt_listing(token, name)  — buur zegt ja
--  6. RPC decline_buurt_listing(token, reason) — buur zegt nee
--  7. Functie expire_old_pending_confirmations() voor pg_cron
-- ============================================================

-- ── Stap 1: nieuwe kolommen ──────────────────────────────────
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS confirmation_token UUID UNIQUE,
  ADD COLUMN IF NOT EXISTS confirmation_status TEXT
    NOT NULL DEFAULT 'confirmed'
    CHECK (confirmation_status IN ('pending', 'confirmed', 'declined', 'expired')),
  ADD COLUMN IF NOT EXISTS confirmation_responded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS participant_display_name TEXT,
  ADD COLUMN IF NOT EXISTS confirmation_declined_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_listings_confirmation_token
  ON public.listings (confirmation_token)
  WHERE confirmation_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_listings_confirmation_pending
  ON public.listings (created_at)
  WHERE confirmation_status = 'pending';

COMMENT ON COLUMN public.listings.confirmation_token IS
  'Unieke UUID die per (deelnemer-)listing wordt gedeeld via bevestigingslink. NULL voor eigen adres / niet-buurt listings.';
COMMENT ON COLUMN public.listings.confirmation_status IS
  'pending = wacht op toestemming buur · confirmed = toestemming gegeven of nvt (eigen adres) · declined = buur heeft geweigerd · expired = 7 dagen geen reactie';
COMMENT ON COLUMN public.listings.participant_display_name IS
  'Optionele naam die de deelnemer zelf opgeeft via bevestigingslink (bv. "Fam. de Vries"). Niet verplicht.';
COMMENT ON COLUMN public.listings.confirmation_declined_reason IS
  'Optionele reden van weigering — puur voor logging / support. Niet zichtbaar voor anderen.';


-- ── Stap 2: RPC get_listings_for_user uitbreiden ─────────────
-- Verschil t.o.v. vorige versie: filtert pending/declined/expired
-- listings weg, TENZIJ ze van de ingelogde user zelf zijn
-- (die moet wel eigen pending rows zien om te beheren).
DROP FUNCTION IF EXISTS public.get_listings_for_user();

CREATE OR REPLACE FUNCTION public.get_listings_for_user()
RETURNS TABLE (
  id UUID,
  user_id UUID,
  title TEXT,
  description TEXT,
  category TEXT,
  address TEXT,
  city TEXT,
  postal_code TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  date_start DATE,
  date_end DATE,
  time_start TIME,
  time_end TIME,
  images TEXT[],
  tags TEXT[],
  status TEXT,
  view_count INTEGER,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  address_reveal_mode TEXT,
  address_visible_at TIMESTAMPTZ,
  neighborhood_group_id TEXT,
  confirmation_status TEXT            -- nieuw: zodat frontend 'pending' kan labelen
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN
    -- Anonieme user: adres altijd verborgen + alleen confirmed rijen
    RETURN QUERY
      SELECT
        l.id, l.user_id, l.title, l.description, l.category,
        NULL::TEXT AS address,
        l.city, l.postal_code, l.latitude, l.longitude,
        l.date_start, l.date_end, l.time_start, l.time_end,
        l.images, l.tags, l.status, l.view_count,
        l.created_at, l.updated_at,
        l.address_reveal_mode,
        CASE
          WHEN l.address_reveal_mode = 'day_before'
            THEN ((l.date_start + COALESCE(l.time_start, TIME '08:00'))::timestamp
                  AT TIME ZONE 'Europe/Amsterdam') - INTERVAL '24 hours'
          ELSE NULL
        END AS address_visible_at,
        l.neighborhood_group_id::TEXT,
        l.confirmation_status
      FROM public.listings l
      WHERE l.status = 'active'
        AND l.date_start >= CURRENT_DATE
        AND l.confirmation_status = 'confirmed';
  ELSE
    -- Ingelogde user: zie confirmed rijen + eigen rijen (alle statussen)
    RETURN QUERY
      SELECT
        l.id, l.user_id, l.title, l.description, l.category,
        CASE
          WHEN l.user_id = uid THEN l.address
          WHEN l.confirmation_status <> 'confirmed' THEN NULL
          WHEN l.address_reveal_mode = 'instant' THEN l.address
          WHEN l.address_reveal_mode = 'day_before' AND NOW() >=
               (((l.date_start + COALESCE(l.time_start, TIME '08:00'))::timestamp
                  AT TIME ZONE 'Europe/Amsterdam') - INTERVAL '24 hours')
               THEN l.address
          ELSE NULL
        END AS address,
        l.city, l.postal_code, l.latitude, l.longitude,
        l.date_start, l.date_end, l.time_start, l.time_end,
        l.images, l.tags, l.status, l.view_count,
        l.created_at, l.updated_at,
        l.address_reveal_mode,
        CASE
          WHEN l.user_id = uid THEN NULL
          WHEN l.address_reveal_mode = 'instant' THEN NULL
          ELSE ((l.date_start + COALESCE(l.time_start, TIME '08:00'))::timestamp
                AT TIME ZONE 'Europe/Amsterdam') - INTERVAL '24 hours'
        END AS address_visible_at,
        l.neighborhood_group_id::TEXT,
        l.confirmation_status
      FROM public.listings l
      WHERE l.status = 'active'
        AND l.date_start >= CURRENT_DATE
        AND (l.confirmation_status = 'confirmed' OR l.user_id = uid);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_listings_for_user() TO anon, authenticated;


-- ── Stap 3: RPC get_confirmation_context(token) ─────────────
-- Voor bevestig.html: laat zien om welke sale het gaat
-- VOORDAT de buur bevestigt. Geeft alleen minimale info.
CREATE OR REPLACE FUNCTION public.get_confirmation_context(p_token UUID)
RETURNS TABLE (
  title TEXT,
  organizer_name TEXT,
  address TEXT,
  city TEXT,
  date_start DATE,
  time_start TIME,
  time_end TIME,
  current_status TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
    SELECT
      l.title,
      COALESCE(p.display_name, p.username, 'De organisator')::TEXT AS organizer_name,
      l.address,
      l.city,
      l.date_start,
      l.time_start,
      l.time_end,
      l.confirmation_status,
      l.created_at
    FROM public.listings l
    LEFT JOIN public.profiles p ON p.id = l.user_id
    WHERE l.confirmation_token = p_token
    LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_confirmation_context(UUID) TO anon, authenticated;


-- ── Stap 4: RPC confirm_buurt_listing(token, name) ──────────
-- Buur zegt "ja, mijn adres mag meedoen".
-- Alleen pending → confirmed is toegestaan.
CREATE OR REPLACE FUNCTION public.confirm_buurt_listing(
  p_token UUID,
  p_display_name TEXT DEFAULT NULL
)
RETURNS TABLE (
  success BOOLEAN,
  message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  SELECT id, confirmation_status INTO r
    FROM public.listings
    WHERE confirmation_token = p_token
    LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'Onbekende of ongeldige link.';
    RETURN;
  END IF;

  IF r.confirmation_status = 'confirmed' THEN
    RETURN QUERY SELECT TRUE, 'Je had dit adres al bevestigd. Dank je wel!';
    RETURN;
  END IF;

  IF r.confirmation_status IN ('declined', 'expired') THEN
    RETURN QUERY SELECT FALSE, 'Deze link is niet meer geldig (al geweigerd of verlopen).';
    RETURN;
  END IF;

  UPDATE public.listings
    SET confirmation_status = 'confirmed',
        confirmation_responded_at = NOW(),
        participant_display_name = NULLIF(TRIM(p_display_name), '')
    WHERE id = r.id;

  RETURN QUERY SELECT TRUE, 'Bedankt! Je adres staat nu online voor de buurtverkoop.';
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_buurt_listing(UUID, TEXT) TO anon, authenticated;


-- ── Stap 5: RPC decline_buurt_listing(token, reason) ────────
-- Buur zegt "nee" — we wissen het adres direct (AVG).
CREATE OR REPLACE FUNCTION public.decline_buurt_listing(
  p_token UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS TABLE (
  success BOOLEAN,
  message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  SELECT id, confirmation_status INTO r
    FROM public.listings
    WHERE confirmation_token = p_token
    LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'Onbekende of ongeldige link.';
    RETURN;
  END IF;

  IF r.confirmation_status = 'declined' THEN
    RETURN QUERY SELECT TRUE, 'Je adres was al verwijderd. Geen probleem.';
    RETURN;
  END IF;

  -- Adres-gegevens direct wissen — minimalisatie volgens AVG art. 5c
  UPDATE public.listings
    SET confirmation_status = 'declined',
        confirmation_responded_at = NOW(),
        confirmation_declined_reason = NULLIF(TRIM(p_reason), ''),
        address = NULL,
        postal_code = NULL,
        latitude = NULL,
        longitude = NULL,
        status = 'inactive'
    WHERE id = r.id;

  RETURN QUERY SELECT TRUE, 'Je adres is verwijderd. De organisator ziet dit direct in zijn/haar overzicht.';
END;
$$;

GRANT EXECUTE ON FUNCTION public.decline_buurt_listing(UUID, TEXT) TO anon, authenticated;


-- ── Stap 6: cleanup — 7 dagen pending → expired ─────────────
-- Roep dit dagelijks aan via pg_cron:
--   SELECT cron.schedule('expire-pending-buurt', '0 3 * * *',
--     $$SELECT public.expire_old_pending_confirmations()$$);
CREATE OR REPLACE FUNCTION public.expire_old_pending_confirmations()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected INTEGER;
BEGIN
  UPDATE public.listings
    SET confirmation_status = 'expired',
        confirmation_responded_at = NOW(),
        address = NULL,
        postal_code = NULL,
        latitude = NULL,
        longitude = NULL,
        status = 'inactive'
    WHERE confirmation_status = 'pending'
      AND created_at < NOW() - INTERVAL '7 days';

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

GRANT EXECUTE ON FUNCTION public.expire_old_pending_confirmations() TO service_role;


-- ── Stap 7: verificatie ─────────────────────────────────────
SELECT
  'confirmation_token kolom' AS check_item,
  COUNT(*)::text AS result
FROM information_schema.columns
WHERE table_name = 'listings'
  AND column_name = 'confirmation_token'
  AND table_schema = 'public'
UNION ALL
SELECT 'confirmation_status kolom',
  COUNT(*)::text
FROM information_schema.columns
WHERE table_name = 'listings'
  AND column_name = 'confirmation_status'
  AND table_schema = 'public'
UNION ALL
SELECT 'get_listings_for_user functie',
  COUNT(*)::text
FROM information_schema.routines
WHERE routine_name = 'get_listings_for_user' AND routine_schema = 'public'
UNION ALL
SELECT 'confirm_buurt_listing functie',
  COUNT(*)::text
FROM information_schema.routines
WHERE routine_name = 'confirm_buurt_listing' AND routine_schema = 'public'
UNION ALL
SELECT 'decline_buurt_listing functie',
  COUNT(*)::text
FROM information_schema.routines
WHERE routine_name = 'decline_buurt_listing' AND routine_schema = 'public'
UNION ALL
SELECT 'get_confirmation_context functie',
  COUNT(*)::text
FROM information_schema.routines
WHERE routine_name = 'get_confirmation_context' AND routine_schema = 'public'
UNION ALL
SELECT 'expire_old_pending_confirmations functie',
  COUNT(*)::text
FROM information_schema.routines
WHERE routine_name = 'expire_old_pending_confirmations' AND routine_schema = 'public';
-- Verwacht: alle zes = 1
