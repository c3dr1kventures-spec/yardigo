-- ═══════════════════════════════════════════════════════════════════
-- Storage RLS policies voor listings + avatars buckets
-- ═══════════════════════════════════════════════════════════════════
-- Probleem: publishSale gaf "new row violates row-level security policy"
-- bij foto-upload, zelfs terwijl individuele test-uploads door dezelfde
-- gebruiker wel doorkwamen. Oorzaak: bij upsert:true kan Supabase een
-- UPDATE triggeren i.p.v. INSERT. Als de bucket alleen een INSERT-policy
-- heeft, faalt de UPDATE met deze misleidende RLS-foutmelding.
--
-- Deze SQL zet een complete policy-set neer voor INSERT, UPDATE, DELETE
-- en publieke SELECT — zodat de uploads altijd werken ongeacht of het
-- een nieuwe file is of een upsert.
--
-- Draai in Supabase SQL Editor.
-- ═══════════════════════════════════════════════════════════════════

-- ┌─────────────────────────────────────────────┐
-- │ LISTINGS bucket                              │
-- └─────────────────────────────────────────────┘
DROP POLICY IF EXISTS "Listings upload own folder"   ON storage.objects;
DROP POLICY IF EXISTS "Listings update own"          ON storage.objects;
DROP POLICY IF EXISTS "Listings delete own"          ON storage.objects;
DROP POLICY IF EXISTS "Listings read public"         ON storage.objects;

CREATE POLICY "Listings upload own folder"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'listings'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Listings update own"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'listings'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'listings'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Listings delete own"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'listings'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Listings read public"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'listings');

-- ┌─────────────────────────────────────────────┐
-- │ AVATARS bucket                               │
-- └─────────────────────────────────────────────┘
DROP POLICY IF EXISTS "Avatars upload own folder" ON storage.objects;
DROP POLICY IF EXISTS "Avatars update own"        ON storage.objects;
DROP POLICY IF EXISTS "Avatars delete own"        ON storage.objects;
DROP POLICY IF EXISTS "Avatars read public"       ON storage.objects;

CREATE POLICY "Avatars upload own folder"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Avatars update own"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Avatars delete own"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Avatars read public"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'avatars');

-- ┌─────────────────────────────────────────────┐
-- │ Admin override — admins mogen alle listing-foto's deleten │
-- └─────────────────────────────────────────────┘
-- Zodat admin.html ook foto's van andere gebruikers kan opruimen
-- (bijv. bij het verwijderen van een gerapporteerde advertentie).
DROP POLICY IF EXISTS "Admins can delete any storage object" ON storage.objects;
CREATE POLICY "Admins can delete any storage object"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  );

-- ═══════════════════════════════════════════════════════════════════
-- Verificatie: lijst alle policies op storage.objects
-- SELECT policyname, cmd FROM pg_policies WHERE tablename='objects' AND schemaname='storage' ORDER BY cmd, policyname;
-- ═══════════════════════════════════════════════════════════════════
