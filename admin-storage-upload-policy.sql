-- ═══════════════════════════════════════════════════════════════════
-- Admin storage upload/update policy
-- ═══════════════════════════════════════════════════════════════════
-- Probleem: admins kunnen via het admin-dashboard foto's uploaden
-- naar de 'listings' bucket, maar de bestaande INSERT-policy staat
-- alleen uploads toe naar de map van de ingelogde gebruiker zelf
-- (foldername(name)[1] = auth.uid()). Admins uploaden naar de map
-- van de listing-eigenaar, dus die check faalt.
--
-- Al toegepast: "Admins can delete any storage object" (DELETE policy)
-- Nog nodig:    INSERT + UPDATE policy voor admins (dit bestand)
--
-- Draai in Supabase SQL Editor.
-- ═══════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Admins can insert any storage object" ON storage.objects;
CREATE POLICY "Admins can insert any storage object"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can update any storage object" ON storage.objects;
CREATE POLICY "Admins can update any storage object"
  ON storage.objects FOR UPDATE
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

-- ═══════════════════════════════════════════════════════════════════
-- Verificatie
-- SELECT policyname, cmd FROM pg_policies
-- WHERE tablename='objects' AND schemaname='storage'
-- ORDER BY cmd, policyname;
-- ═══════════════════════════════════════════════════════════════════
