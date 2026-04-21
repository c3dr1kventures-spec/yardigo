-- ============================================================
-- Event subtype kolom toevoegen aan listings + RPC uitbreiden
-- ============================================================
-- Doel: onderscheid maken tussen soorten evenementen op de kaart
-- (Vlooienmarkt, Rommelmarkt, Kofferbakverkoop, Braderie,
--  Kerstmarkt, Boekenmarkt, Antiekmarkt, Anders).
--
-- Deze kolom is optioneel (nullable) en heeft alleen een waarde
-- voor listings waarbij type = 'evenement'. Bij particulier en
-- buurtverkoop blijft de kolom leeg.
--
-- Let op: de RPC get_listings_for_user() heeft een expliciete
-- RETURNS TABLE lijst, dus die moet worden uitgebreid met
-- event_subtype anders komt de waarde niet door naar de frontend.
-- Deze migratie bouwt voort op buurt-label-column.sql.
-- ============================================================

-- ── Stap 1: Kolom toevoegen ──────────────────────────────────
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS event_subtype TEXT;

CREATE INDEX IF NOT EXISTS idx_listings_event_subtype
  ON public.listings (event_subtype)
  WHERE event_subtype IS NOT NULL;

COMMENT ON COLUMN public.listings.event_subtype IS
  'Subtype van evenement: Vlooienmarkt, Rommelmarkt, Kofferbakverkoop, Braderie, Kerstmarkt, Boekenmarkt, Antiekmarkt, of eigen omschrijving via Anders. Alleen ingevuld voor listings met type evenement.';


-- ── Stap 2: RPC get_listings_for_user uitbreiden ─────────────
-- Zelfde logica als buurt-label-column.sql, maar met event_subtype
-- toegevoegd aan de RETURNS TABLE en beide SELECT blokken.
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
  confirmation_status TEXT,
  confirmation_token UUID,
  confirmation_address_label TEXT,
  event_subtype TEXT                      -- nieuw: voor marker-differentiatie
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN
    -- Anonieme user: adres altijd verborgen, geen token/label, alleen confirmed rijen
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
        l.confirmation_status,
        NULL::UUID AS confirmation_token,
        NULL::TEXT AS confirmation_address_label,
        l.event_subtype
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
        l.confirmation_status,
        CASE WHEN l.user_id = uid THEN l.confirmation_token ELSE NULL END AS confirmation_token,
        CASE WHEN l.user_id = uid THEN l.confirmation_address_label ELSE NULL END AS confirmation_address_label,
        l.event_subtype
      FROM public.listings l
      WHERE l.status = 'active'
        AND l.date_start >= CURRENT_DATE
        AND (l.confirmation_status = 'confirmed' OR l.user_id = uid);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_listings_for_user() TO anon, authenticated;


-- ── Stap 3: verificatie ──────────────────────────────────────
SELECT 'event_subtype kolom' AS check_item,
  COUNT(*)::text AS count
FROM information_schema.columns
WHERE table_name = 'listings'
  AND table_schema = 'public'
  AND column_name = 'event_subtype'
UNION ALL
SELECT 'get_listings_for_user functie',
  COUNT(*)::text
FROM information_schema.routines
WHERE routine_name = 'get_listings_for_user' AND routine_schema = 'public';
