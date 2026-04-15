-- ═══════════════════════════════════════════════════════════════════
-- Admin DELETE policy voor listings en profiles
-- ═══════════════════════════════════════════════════════════════════
-- Probleem: Admins (is_admin=true) konden geen andermans listings verwijderen
-- via admin.html. RLS liet alleen de eigenaar deleten, dus de delete faalde
-- stilletjes met 0 affected rows en geen error.
--
-- Draai dit in Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- ═══════════════════════════════════════════════════════════════════

-- 1. Listings: admin mag alles deleten
DROP POLICY IF EXISTS "Admins can delete any listing" ON public.listings;
CREATE POLICY "Admins can delete any listing"
  ON public.listings
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  );

-- 2. Listings: admin mag alles updaten (voor status toggle, blokkeren etc.)
DROP POLICY IF EXISTS "Admins can update any listing" ON public.listings;
CREATE POLICY "Admins can update any listing"
  ON public.listings
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  );

-- 3. Profiles: admin mag andere profiles aanpassen (is_blocked, admin_note)
DROP POLICY IF EXISTS "Admins can update any profile" ON public.profiles;
CREATE POLICY "Admins can update any profile"
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.is_admin = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.is_admin = true
    )
  );

-- 4. Verificatie — draai deze query om de policies te controleren:
-- SELECT policyname, cmd, qual FROM pg_policies WHERE tablename IN ('listings','profiles') ORDER BY tablename, cmd;
