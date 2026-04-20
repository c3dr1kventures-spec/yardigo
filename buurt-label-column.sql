-- ═══════════════════════════════════════════════════════════════
-- Buurt-label kolom toevoegen aan listings
-- ───────────────────────────────────────────────────────────────
-- Doel: organisator kan optioneel een naam/herkenningslabel
-- meegeven per buuradres, zodat hij later in "Mijn verkopen"
-- ziet welke link bij welke buur hoort.
--
-- AVG-noot: het label is door de organisator zélf ingevoerd over
-- een derde, en wordt alleen aan de organisator getoond (RLS).
-- Het label is bewust NULLABLE en optioneel: de gebruiker mag
-- ook een omschrijving zoals "Buurman links" of "Nr. 14" gebruiken
-- in plaats van een echte naam. De waarde wordt nooit publiek
-- getoond op de kaart of detailpagina, alleen in het dashboard
-- van de organisator.
--
-- E-mailadressen van buren worden NIET in de database opgeslagen;
-- die blijven alleen in het geheugen van de browser staan tijdens
-- de publicatiestap, om mailto-links voor te bereiden. Daarmee
-- is geen verwerkersovereenkomst nodig en is dataminimalisatie
-- gewaarborgd (AVG art. 5.1.c).
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS confirmation_address_label TEXT NULL;

COMMENT ON COLUMN public.listings.confirmation_address_label IS
  'Optioneel label dat de organisator van een buurtverkoop intern gebruikt om het adres te herkennen (bv. naam buur, "nr. 14"). Alleen zichtbaar voor de organisator, nooit publiek.';

-- Geen index nodig: deze kolom wordt alleen via SELECT op user_id
-- + neighborhood_group_id gefilterd, en de bestaande indexen op
-- user_id en neighborhood_group_id volstaan.


-- ═══════════════════════════════════════════════════════════════
-- RPC get_listings_for_user() herbouwen
-- ───────────────────────────────────────────────────────────────
-- Voegt twee velden toe aan de output van de listings-ophaal-RPC:
--   • confirmation_token         → alleen voor eigen (pending) rijen
--   • confirmation_address_label → alleen voor eigen rijen
-- Andere users en anonieme bezoekers krijgen NULL voor beide velden,
-- zodat de bevestigingstoken nooit lekt en het interne label
-- niet publiek wordt.
-- ═══════════════════════════════════════════════════════════════

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
  confirmation_token UUID,               -- nieuw: alleen eigen rijen, anders NULL
  confirmation_address_label TEXT        -- nieuw: alleen eigen rijen, anders NULL
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
        NULL::TEXT AS confirmation_address_label
      FROM public.listings l
      WHERE l.status = 'active'
        AND l.date_start >= CURRENT_DATE
        AND l.confirmation_status = 'confirmed';
  ELSE
    -- Ingelogde user: zie confirmed rijen + eigen rijen (alle statussen)
    -- Token en label zijn alleen gevuld voor eigen rijen.
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
        CASE WHEN l.user_id = uid THEN l.confirmation_address_label ELSE NULL END AS confirmation_address_label
      FROM public.listings l
      WHERE l.status = 'active'
        AND l.date_start >= CURRENT_DATE
        AND (l.confirmation_status = 'confirmed' OR l.user_id = uid);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_listings_for_user() TO anon, authenticated;


-- ═══════════════════════════════════════════════════════════════
-- Verificatie
-- ═══════════════════════════════════════════════════════════════

SELECT
  'confirmation_address_label kolom' AS check_item,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'listings'
      AND column_name = 'confirmation_address_label'
  ) THEN '✅ aanwezig' ELSE '❌ ontbreekt' END AS status
UNION ALL
SELECT
  'get_listings_for_user functie',
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.routines
    WHERE routine_name = 'get_listings_for_user' AND routine_schema = 'public'
  ) THEN '✅ bestaat' ELSE '❌ ontbreekt' END;
