-- ============================================================
-- YardiGo — Security Fix: Privilege Escalation via profiles UPDATE
-- Datum: 23 mei 2026
-- Probleem: Elke ingelogde gebruiker kon is_admin=true op zichzelf zetten
--           via de Supabase REST API (PATCH /profiles?id=eq.<uuid>)
--           omdat de UPDATE-policy geen kolombeperking had.
-- ============================================================

-- Stap 1: Verwijder de kwetsbare brede update-policy
DROP POLICY IF EXISTS "Gebruikers kunnen eigen profiel bewerken" ON public.profiles;

-- Stap 2: Nieuwe policy die is_admin en admin_badges blokkeert voor zelf-update
CREATE POLICY "Gebruikers kunnen eigen profiel bewerken"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id
    -- is_admin mag NIET door de gebruiker zelf worden gewijzigd;
    -- alleen via de service-role key (server-side) mag is_admin worden aangepast.
    AND is_admin IS NOT DISTINCT FROM (
      SELECT is_admin FROM public.profiles WHERE id = auth.uid()
    )
    -- admin_badges mag ook niet via de client worden aangepast
    AND admin_badges IS NOT DISTINCT FROM (
      SELECT admin_badges FROM public.profiles WHERE id = auth.uid()
    )
  );

-- ============================================================
-- Verificatie: voer dit uit na de fix om te controleren
-- ============================================================
-- SELECT policyname, cmd, qual, with_check
-- FROM pg_policies
-- WHERE tablename = 'profiles' AND cmd = 'UPDATE';
