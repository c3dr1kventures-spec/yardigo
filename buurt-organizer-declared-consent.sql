-- ============================================================
-- YardiGo — Buurtverkoop: organisator-verklaarde toestemming
-- Plak dit in: Supabase Dashboard → SQL Editor → New query
--
-- Achtergrond:
--  De huidige flow vraagt elke buur zelf via /bevestig om akkoord
--  (confirmation_token + click). Voor organisatoren die al persoonlijk
--  toestemming hebben verzameld (whatsapp, e-mail, papier) is dat een
--  dubbele stap. Daarom: optie om bij bulk-upload één vinkje te zetten
--  "ik heb van iedereen toestemming". Adressen gaan dan direct online,
--  maar:
--    - we leggen vast dat de organisator dit verklaard heeft (audit)
--    - we tonen een visueel onderscheid in Mijn verkopen (🛡️ badge)
--    - bij klacht van een bewoner kunnen we direct offline halen
--      en de organisator om bewijs vragen
--
-- Wat dit script doet:
--  1. Voegt confirmation_method en organizer_consent_declared_at toe
--  2. Maakt audit-tabel consent_declarations met RLS
--  3. Update get_listings_for_user RPC zodat method naar de frontend gaat
-- ============================================================

-- Stap 1: nieuwe kolommen op listings
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS confirmation_method TEXT
    DEFAULT 'self_confirmed'
    CHECK (confirmation_method IN ('self_confirmed', 'organizer_declared')),
  ADD COLUMN IF NOT EXISTS organizer_consent_declared_at TIMESTAMPTZ;

COMMENT ON COLUMN public.listings.confirmation_method IS
  'self_confirmed = buur klikte zelf op de bevestigingslink. organizer_declared = organisator verklaarde via bulk-vinkje toestemming te hebben. Bij organizer_declared moet de organisator op verzoek bewijs kunnen leveren (AVG art 6.1.a, art 7.1).';
COMMENT ON COLUMN public.listings.organizer_consent_declared_at IS
  'Timestamp waarop de organisator heeft verklaard van alle adressen in de bulk-upload toestemming te hebben. NULL bij self_confirmed of bij eigen adres organisator.';

-- Stap 2: audit-tabel
CREATE TABLE IF NOT EXISTS public.consent_declarations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  neighborhood_group_id TEXT NOT NULL,
  declared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  address_count INTEGER NOT NULL,
  user_agent TEXT,
  ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_consent_decl_user ON public.consent_declarations(user_id);
CREATE INDEX IF NOT EXISTS idx_consent_decl_group ON public.consent_declarations(neighborhood_group_id);

ALTER TABLE public.consent_declarations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS consent_decl_owner_select ON public.consent_declarations;
CREATE POLICY consent_decl_owner_select ON public.consent_declarations
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS consent_decl_owner_insert ON public.consent_declarations;
CREATE POLICY consent_decl_owner_insert ON public.consent_declarations
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Stap 3: get_listings_for_user uitgebreid met confirmation_method
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
  confirmation_method TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN
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
        l.confirmation_method
      FROM public.listings l
      WHERE l.status = 'active'
        AND l.date_start >= CURRENT_DATE
        AND l.confirmation_status = 'confirmed';
  ELSE
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
        l.confirmation_method
      FROM public.listings l
      WHERE l.status = 'active'
        AND l.date_start >= CURRENT_DATE
        AND (l.confirmation_status = 'confirmed' OR l.user_id = uid);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_listings_for_user() TO anon, authenticated;
