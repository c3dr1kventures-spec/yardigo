-- ═══════════════════════════════════════════════════════════════════
-- Error Logs tabel + RLS policies
-- ═══════════════════════════════════════════════════════════════════
-- Vangt client-side JavaScript-fouten op zodat je als admin kunt zien
-- welke errors gebruikers tegenkomen — zonder dat zij iets hoeven te melden.
--
-- Draai in Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- ═══════════════════════════════════════════════════════════════════

-- 1. Tabel aanmaken
CREATE TABLE IF NOT EXISTS public.error_logs (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at  timestamptz DEFAULT now(),
  message     text NOT NULL,
  stack       text,
  url         text,
  user_id     uuid,
  user_agent  text,
  context     jsonb DEFAULT '{}'::jsonb
);

-- 2. Index op created_at voor snelle recente-fouten queries
CREATE INDEX IF NOT EXISTS idx_error_logs_created_at ON public.error_logs (created_at DESC);

-- 3. RLS inschakelen
ALTER TABLE public.error_logs ENABLE ROW LEVEL SECURITY;

-- 4. Iedereen (ook niet-ingelogde bezoekers) mag fouten loggen
DROP POLICY IF EXISTS "Anyone can insert error logs" ON public.error_logs;
CREATE POLICY "Anyone can insert error logs"
  ON public.error_logs FOR INSERT
  TO public
  WITH CHECK (true);

-- 5. Alleen admins mogen fouten lezen
DROP POLICY IF EXISTS "Admins can read error logs" ON public.error_logs;
CREATE POLICY "Admins can read error logs"
  ON public.error_logs FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  );

-- 6. Admins mogen oude logs opruimen
DROP POLICY IF EXISTS "Admins can delete error logs" ON public.error_logs;
CREATE POLICY "Admins can delete error logs"
  ON public.error_logs FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  );

-- ═══════════════════════════════════════════════════════════════════
-- Verificatie:
-- SELECT policyname, cmd FROM pg_policies WHERE tablename='error_logs' ORDER BY cmd;
-- ═══════════════════════════════════════════════════════════════════
