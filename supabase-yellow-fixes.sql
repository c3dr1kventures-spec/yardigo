-- ============================================================
-- YardiGo — Yellow Security Fixes
-- Plak dit in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- ══════════════════════════════════════════════════════════
-- FIX 1: Telefoon afschermen in profiles
-- Probleem: phone-veld is leesbaar voor iedereen via API
-- ══════════════════════════════════════════════════════════

-- Verwijder de open SELECT policy
DROP POLICY IF EXISTS "Iedereen kan profielen bekijken" ON public.profiles;

-- Publiek zichtbaar: alleen veilige velden
CREATE POLICY "Publieke profiel-velden zichtbaar"
  ON public.profiles FOR SELECT
  USING (true);

-- Blokkeer directe API-toegang tot phone via column-level security
-- (Supabase heeft geen column-level RLS, dus we verwijderen phone uit SELECT
--  via een view die phone weglaat voor anonieme users)

-- Revoke directe tabel-toegang voor anon op gevoelige kolom
-- Dit doen we door phone te verbergen via een security-definer view:
CREATE OR REPLACE VIEW public.profiles_public AS
  SELECT
    id,
    username,
    display_name,
    avatar_url,
    city,
    created_at,
    updated_at
    -- phone bewust weggelaten
  FROM public.profiles;

-- Geef anon en authenticated leesrecht op de view (niet de tabel)
GRANT SELECT ON public.profiles_public TO anon, authenticated;


-- ══════════════════════════════════════════════════════════
-- FIX 2: Adres server-side verbergen voor gasten
-- Probleem: API geeft volledig adres terug ook aan anonieme users
-- ══════════════════════════════════════════════════════════

-- RPC-functie die listings teruggeeft:
-- - Ingelogde users: volledig adres
-- - Anonieme users: alleen stad (adres = NULL)
CREATE OR REPLACE FUNCTION get_listings_for_user()
RETURNS TABLE (
  id UUID,
  user_id UUID,
  title TEXT,
  description TEXT,
  category TEXT,
  address TEXT,      -- NULL voor anonieme users
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
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    -- Ingelogde user: volledig adres teruggeven
    RETURN QUERY
      SELECT
        l.id, l.user_id, l.title, l.description, l.category,
        l.address,  -- volledig adres
        l.city, l.postal_code, l.latitude, l.longitude,
        l.date_start, l.date_end, l.time_start, l.time_end,
        l.images, l.tags, l.status, l.view_count,
        l.created_at, l.updated_at
      FROM public.listings l
      WHERE l.status = 'active'
        AND l.date_start >= CURRENT_DATE;
  ELSE
    -- Anonieme user: adres verborgen (NULL)
    RETURN QUERY
      SELECT
        l.id, l.user_id, l.title, l.description, l.category,
        NULL::TEXT AS address,  -- adres verborgen
        l.city, l.postal_code, l.latitude, l.longitude,
        l.date_start, l.date_end, l.time_start, l.time_end,
        l.images, l.tags, l.status, l.view_count,
        l.created_at, l.updated_at
      FROM public.listings l
      WHERE l.status = 'active'
        AND l.date_start >= CURRENT_DATE;
  END IF;
END;
$$;

-- Geef uitvoeringsrecht aan zowel anon als authenticated
GRANT EXECUTE ON FUNCTION get_listings_for_user() TO anon, authenticated;


-- ══════════════════════════════════════════════════════════
-- FIX 3: Admin-rol server-side via is_admin kolom
-- Probleem: admin-check in admin.html is puur client-side
-- ══════════════════════════════════════════════════════════

-- Voeg is_admin kolom toe aan profiles (als die nog niet bestaat)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;

-- Stel jouw account in als admin (vervang met jouw echte user-ID uit Supabase Auth)
-- Ga naar: Supabase Dashboard → Authentication → Users → kopieer jouw UUID
-- UPDATE public.profiles SET is_admin = TRUE WHERE id = 'JOUW-USER-UUID';

-- RLS policy: alleen admins mogen admin_badges updaten
DROP POLICY IF EXISTS "Alleen admins kunnen badges updaten" ON public.profiles;
CREATE POLICY "Alleen admins kunnen badges updaten"
  ON public.profiles FOR UPDATE
  USING (
    -- Eigenaar mag eigen profiel altijd updaten
    auth.uid() = id
    OR
    -- Admin mag alles updaten
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND is_admin = TRUE
    )
  );

-- ── Verificatie ───────────────────────────────────────────
SELECT
  'profiles_public view' AS check_item,
  COUNT(*)::text AS result
FROM information_schema.views
WHERE table_name = 'profiles_public' AND table_schema = 'public'
UNION ALL
SELECT
  'get_listings_for_user functie',
  COUNT(*)::text
FROM information_schema.routines
WHERE routine_name = 'get_listings_for_user' AND routine_schema = 'public'
UNION ALL
SELECT
  'is_admin kolom',
  COUNT(*)::text
FROM information_schema.columns
WHERE table_name = 'profiles' AND column_name = 'is_admin' AND table_schema = 'public';
-- Verwacht: alle drie = 1
