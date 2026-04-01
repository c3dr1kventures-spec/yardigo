-- ============================================================
-- YardiGo — RLS Security Fix
-- Plak dit in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- ── 1. Schakel RLS in op alle tabellen ──────────────────────
ALTER TABLE public.profiles  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.favorites ENABLE ROW LEVEL SECURITY;

-- ── 2. Verwijder bestaande policies (clean slate) ────────────
DROP POLICY IF EXISTS "Iedereen kan profielen bekijken"          ON public.profiles;
DROP POLICY IF EXISTS "Gebruikers kunnen eigen profiel bewerken" ON public.profiles;
DROP POLICY IF EXISTS "Gebruikers kunnen eigen profiel aanmaken" ON public.profiles;

DROP POLICY IF EXISTS "Iedereen kan actieve listings zien"         ON public.listings;
DROP POLICY IF EXISTS "Ingelogde gebruikers kunnen listings aanmaken" ON public.listings;
DROP POLICY IF EXISTS "Eigenaren kunnen eigen listings bewerken"   ON public.listings;
DROP POLICY IF EXISTS "Eigenaren kunnen eigen listings verwijderen" ON public.listings;

DROP POLICY IF EXISTS "Gebruikers kunnen eigen favorieten zien"    ON public.favorites;
DROP POLICY IF EXISTS "Gebruikers kunnen favorieten toevoegen"     ON public.favorites;
DROP POLICY IF EXISTS "Gebruikers kunnen favorieten verwijderen"   ON public.favorites;

-- ── 3. Profiles policies ────────────────────────────────────
CREATE POLICY "Iedereen kan profielen bekijken"
  ON public.profiles FOR SELECT
  USING (true);

CREATE POLICY "Gebruikers kunnen eigen profiel aanmaken"
  ON public.profiles FOR INSERT
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Gebruikers kunnen eigen profiel bewerken"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id);

-- ── 4. Listings policies ────────────────────────────────────
CREATE POLICY "Iedereen kan actieve listings zien"
  ON public.listings FOR SELECT
  USING (status = 'active' OR auth.uid() = user_id);

CREATE POLICY "Ingelogde gebruikers kunnen listings aanmaken"
  ON public.listings FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = user_id);

CREATE POLICY "Eigenaren kunnen eigen listings bewerken"
  ON public.listings FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Eigenaren kunnen eigen listings verwijderen"
  ON public.listings FOR DELETE
  USING (auth.uid() = user_id);

-- ── 5. Favorites policies ───────────────────────────────────
CREATE POLICY "Gebruikers kunnen eigen favorieten zien"
  ON public.favorites FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Gebruikers kunnen favorieten toevoegen"
  ON public.favorites FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = user_id);

CREATE POLICY "Gebruikers kunnen favorieten verwijderen"
  ON public.favorites FOR DELETE
  USING (auth.uid() = user_id);

-- ── Klaar! ───────────────────────────────────────────────────
-- Controleer in Supabase Dashboard → Authentication → Policies
-- of alle tabellen groen zijn (RLS enabled).
