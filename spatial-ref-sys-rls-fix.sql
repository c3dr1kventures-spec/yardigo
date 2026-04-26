-- ============================================================
-- YardiGo — Fix: RLS voor spatial_ref_sys (PostGIS tabel)
-- Plak dit in: Supabase Dashboard → SQL Editor → New query
-- ============================================================
--
-- PROBLEEM:
-- spatial_ref_sys is een PostGIS systeemtabel. Ze staat in het
-- public schema maar heeft geen Row Level Security (RLS) aan.
-- Supabase's Security Advisor geeft hier een Critical error over.
--
-- OORZAAK:
-- De tabel is eigendom van 'supabase_admin', niet van 'postgres'.
-- Via de gewone SQL Editor (postgres-rol) lukt ALTER TABLE niet.
--
-- OPLOSSING (2 stappen):
-- ============================================================

-- Stap 1: Verwijder publieke toegang via de API
-- Dit voorkomt dat anonieme users de tabel kunnen benaderen.
REVOKE ALL ON TABLE public.spatial_ref_sys FROM anon;
REVOKE ALL ON TABLE public.spatial_ref_sys FROM authenticated;

-- Stap 2: RLS inschakelen (vereist superuser/supabase_admin)
-- Voer dit in via het Supabase Dashboard met postgres-rol
-- Als dit een fout geeft, gebruik dan de Supabase CLI:
--   supabase db execute --project-ref fwehqudhwzcnkcuypuqw \
--     "ALTER TABLE public.spatial_ref_sys ENABLE ROW LEVEL SECURITY;"
ALTER TABLE public.spatial_ref_sys ENABLE ROW LEVEL SECURITY;

-- Verificatie: controleer of RLS nu actief is
SELECT tablename, tableowner, rowsecurity
FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'spatial_ref_sys';
-- Verwacht: rowsecurity = true
