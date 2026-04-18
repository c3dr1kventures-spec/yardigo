-- ============================================================
-- YardiGo — Optie C: Adres-onthulling per verkoop instellen
-- Plak dit in: Supabase Dashboard → SQL Editor → New query
--
-- Wat dit doet:
--  1. Voegt kolom `address_reveal_mode` toe aan listings
--     ('instant' = direct zichtbaar na inloggen,
--      'day_before' = pas 24u voor start zichtbaar — default)
--  2. Update RPC get_listings_for_user() zodat:
--     - Anonieme users: adres altijd NULL (ongewijzigd)
--     - Ingelogde users + mode='instant': volledig adres
--     - Ingelogde users + mode='day_before': adres NULL tot
--       24u voor event_start (date_start + time_start)
--     - Eigen listings: altijd volledig adres zichtbaar
--  3. Geeft `address_reveal_mode` en `address_visible_at` mee
--     zodat de frontend een countdown kan tonen
-- ============================================================

-- ── Stap 1: nieuwe kolom ─────────────────────────────────────
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS address_reveal_mode TEXT
    NOT NULL DEFAULT 'day_before'
    CHECK (address_reveal_mode IN ('instant', 'day_before'));

COMMENT ON COLUMN public.listings.address_reveal_mode IS
  'Wie mag het adres zien: instant = direct na inloggen, day_before = pas 24u voor start van de verkoop.';


-- ── Stap 2: RPC uitbreiden ───────────────────────────────────
-- Belangrijk: DROP eerst, want RETURNS TABLE wijzigt (nieuwe kolommen)
DROP FUNCTION IF EXISTS public.get_listings_for_user();

CREATE OR REPLACE FUNCTION public.get_listings_for_user()
RETURNS TABLE (
  id UUID,
  user_id UUID,
  title TEXT,
  description TEXT,
  category TEXT,
  address TEXT,                     -- NULL als verborgen
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
  address_reveal_mode TEXT,         -- nieuw: 'instant' | 'day_before'
  address_visible_at TIMESTAMPTZ    -- nieuw: moment waarop adres zichtbaar wordt (NULL als 'instant' of al zichtbaar)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN
    -- Anonieme user: adres altijd verborgen
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
        END AS address_visible_at
      FROM public.listings l
      WHERE l.status = 'active'
        AND l.date_start >= CURRENT_DATE;
  ELSE
    -- Ingelogde user
    RETURN QUERY
      SELECT
        l.id, l.user_id, l.title, l.description, l.category,
        CASE
          -- Eigen listing: altijd adres zichtbaar
          WHEN l.user_id = uid THEN l.address
          -- Instant-mode: adres zichtbaar
          WHEN l.address_reveal_mode = 'instant' THEN l.address
          -- Day-before mode: alleen zichtbaar als binnen 24u van event-start
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
          WHEN l.user_id = uid THEN NULL                  -- eigen listing: nvt
          WHEN l.address_reveal_mode = 'instant' THEN NULL -- geen wachtmoment
          ELSE ((l.date_start + COALESCE(l.time_start, TIME '08:00'))::timestamp
                AT TIME ZONE 'Europe/Amsterdam') - INTERVAL '24 hours'
        END AS address_visible_at
      FROM public.listings l
      WHERE l.status = 'active'
        AND l.date_start >= CURRENT_DATE;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_listings_for_user() TO anon, authenticated;


-- ── Stap 3: verificatie ──────────────────────────────────────
SELECT
  'address_reveal_mode kolom' AS check_item,
  COUNT(*)::text AS result
FROM information_schema.columns
WHERE table_name = 'listings'
  AND column_name = 'address_reveal_mode'
  AND table_schema = 'public'
UNION ALL
SELECT
  'get_listings_for_user functie',
  COUNT(*)::text
FROM information_schema.routines
WHERE routine_name = 'get_listings_for_user'
  AND routine_schema = 'public'
UNION ALL
SELECT
  'aantal listings met day_before',
  COUNT(*)::text
FROM public.listings
WHERE address_reveal_mode = 'day_before';
-- Verwacht: kolom=1, functie=1, aantal = aantal bestaande + nieuwe listings (default day_before)
