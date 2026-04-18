-- ═══════════════════════════════════════════════════════════════
-- YardiGo – Analytics schema (pageviews + admin-dashboard RPC's)
-- Versie: 1.0 · 18 april 2026
--
-- Doel:
--   * Inzicht krijgen in hoeveel bezoekers de website/app gebruiken.
--   * Groei per dag/week/maand zichtbaar maken in het Admin Panel.
--   * AVG-proof: géén persoonlijke gegevens, alleen anonieme session-id
--     (UUID in localStorage) en – indien ingelogd – auth.user_id.
--
-- Draai dit bestand éénmalig in de Supabase SQL Editor.
-- Herhaalbaar: alle statements zijn idempotent (IF NOT EXISTS / CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────
-- 1. Tabel: page_views
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.page_views (
  id           bigserial PRIMARY KEY,
  path         text        NOT NULL,
  session_id   text        NOT NULL,
  user_id      uuid        NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  referrer     text        NULL,
  lang         text        NULL,
  user_agent   text        NULL,
  ip_hash      text        NULL,            -- gehashte IP, nooit raw IP
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pv_created_at     ON public.page_views (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pv_session_day    ON public.page_views (session_id, (created_at::date));
CREATE INDEX IF NOT EXISTS idx_pv_path_day       ON public.page_views (path, (created_at::date));
CREATE INDEX IF NOT EXISTS idx_pv_user_id        ON public.page_views (user_id) WHERE user_id IS NOT NULL;

COMMENT ON TABLE public.page_views IS
  'Anonieme paginaweergaven voor YardiGo analytics. Geen persoonsgegevens; alleen session-UUID + optionele user_id.';

-- ──────────────────────────────────────────────────────────────
-- 2. RLS: niemand mag rechtstreeks lezen, alleen admins
-- ──────────────────────────────────────────────────────────────
ALTER TABLE public.page_views ENABLE ROW LEVEL SECURITY;

-- Oude policies verwijderen (schone herstart)
DROP POLICY IF EXISTS "page_views_admin_read"    ON public.page_views;
DROP POLICY IF EXISTS "page_views_block_all"     ON public.page_views;
DROP POLICY IF EXISTS "page_views_no_direct_ins" ON public.page_views;

-- Insert gaat uitsluitend via RPC (SECURITY DEFINER), dus blokkeer direct INSERT
CREATE POLICY "page_views_no_direct_ins" ON public.page_views
  FOR INSERT WITH CHECK (false);

-- Alleen admins (profiles.is_admin = true) mogen lezen
CREATE POLICY "page_views_admin_read" ON public.page_views
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND COALESCE(p.is_admin, false) = true
    )
  );

-- ──────────────────────────────────────────────────────────────
-- 3. RPC: track_page_view (SECURITY DEFINER, door iedereen aan te roepen)
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.track_page_view(
  p_path       text,
  p_session_id text,
  p_user_id    uuid   DEFAULT NULL,
  p_referrer   text   DEFAULT NULL,
  p_lang       text   DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ip    text;
  v_ua    text;
  v_hash  text;
BEGIN
  -- Basale validatie
  IF p_path IS NULL OR length(p_path) = 0 OR length(p_path) > 400 THEN RETURN; END IF;
  IF p_session_id IS NULL OR length(p_session_id) < 8 OR length(p_session_id) > 64 THEN RETURN; END IF;

  -- IP-adres uit request-header en hash'n (AVG — geen raw IP opslaan)
  BEGIN
    v_ip := coalesce(
      current_setting('request.headers', true)::json ->> 'x-forwarded-for',
      current_setting('request.headers', true)::json ->> 'cf-connecting-ip',
      ''
    );
  EXCEPTION WHEN OTHERS THEN v_ip := ''; END;
  BEGIN
    v_ua := coalesce(current_setting('request.headers', true)::json ->> 'user-agent', '');
  EXCEPTION WHEN OTHERS THEN v_ua := ''; END;

  IF v_ip <> '' THEN
    v_hash := encode(digest(v_ip || ':' || to_char(now(),'YYYY-MM-DD'), 'sha256'), 'hex');
  ELSE
    v_hash := NULL;
  END IF;

  -- Dedup: als dezelfde sessie-id binnen 30 minuten hetzelfde path logde,
  -- sla deze over (verdere bescherming tegen spam/refresh-loops)
  IF EXISTS (
    SELECT 1 FROM public.page_views
    WHERE session_id = p_session_id
      AND path = p_path
      AND created_at > now() - interval '30 minutes'
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.page_views (path, session_id, user_id, referrer, lang, user_agent, ip_hash)
  VALUES (
    substr(p_path,      1, 400),
    substr(p_session_id,1, 64),
    p_user_id,
    substr(coalesce(p_referrer,''), 1, 200),
    substr(coalesce(p_lang,''),     1, 10),
    substr(v_ua,        1, 220),
    v_hash
  );
END;
$$;

REVOKE ALL ON FUNCTION public.track_page_view(text,text,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.track_page_view(text,text,uuid,text,text) TO anon, authenticated;

-- ──────────────────────────────────────────────────────────────
-- 4. Helper: profiles.is_admin kolom (alleen toevoegen als die nog niet bestaat)
-- ──────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='profiles' AND column_name='is_admin'
  ) THEN
    EXECUTE 'ALTER TABLE public.profiles ADD COLUMN is_admin boolean NOT NULL DEFAULT false';
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────
-- 5. Admin-RPC's: cijfers voor het dashboard
-- Alle admin-RPC's controleren zelf of auth.uid() een admin is.
-- ──────────────────────────────────────────────────────────────

-- 5a. Overzicht vandaag / gisteren / week / maand + groei
CREATE OR REPLACE FUNCTION public.analytics_summary()
RETURNS TABLE (
  views_today          bigint,
  views_yesterday      bigint,
  views_7d             bigint,
  views_30d            bigint,
  unique_sessions_7d   bigint,
  unique_sessions_30d  bigint,
  new_users_7d         bigint,
  new_users_30d        bigint,
  growth_wow_pct       numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin boolean;
  v_prev7 bigint;
BEGIN
  SELECT COALESCE(is_admin, false) INTO v_admin FROM public.profiles WHERE id = auth.uid();
  IF NOT COALESCE(v_admin, false) THEN RAISE EXCEPTION 'Not authorized'; END IF;

  SELECT count(*) INTO views_today     FROM public.page_views WHERE created_at::date = current_date;
  SELECT count(*) INTO views_yesterday FROM public.page_views WHERE created_at::date = current_date - 1;
  SELECT count(*) INTO views_7d        FROM public.page_views WHERE created_at >= current_date - interval '6 days';
  SELECT count(*) INTO views_30d       FROM public.page_views WHERE created_at >= current_date - interval '29 days';

  SELECT count(DISTINCT session_id) INTO unique_sessions_7d
    FROM public.page_views WHERE created_at >= current_date - interval '6 days';
  SELECT count(DISTINCT session_id) INTO unique_sessions_30d
    FROM public.page_views WHERE created_at >= current_date - interval '29 days';

  SELECT count(*) INTO new_users_7d  FROM auth.users WHERE created_at >= current_date - interval '6 days';
  SELECT count(*) INTO new_users_30d FROM auth.users WHERE created_at >= current_date - interval '29 days';

  -- Groei week-op-week: (afgelopen 7 dagen) vs (7 dagen daarvoor)
  SELECT count(*) INTO v_prev7
    FROM public.page_views
    WHERE created_at >= current_date - interval '13 days'
      AND created_at <  current_date - interval '6 days';
  IF v_prev7 > 0 THEN
    growth_wow_pct := round(((views_7d - v_prev7)::numeric / v_prev7::numeric) * 100.0, 1);
  ELSE
    growth_wow_pct := NULL;
  END IF;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.analytics_summary() TO authenticated;

-- 5b. Bezoekers per dag (laatste N dagen) — voor grafiek
CREATE OR REPLACE FUNCTION public.analytics_daily(p_days int DEFAULT 30)
RETURNS TABLE (
  day             date,
  views           bigint,
  unique_sessions bigint,
  logged_in_users bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin boolean;
BEGIN
  SELECT COALESCE(is_admin, false) INTO v_admin FROM public.profiles WHERE id = auth.uid();
  IF NOT COALESCE(v_admin, false) THEN RAISE EXCEPTION 'Not authorized'; END IF;

  p_days := GREATEST(1, LEAST(COALESCE(p_days, 30), 365));

  RETURN QUERY
  WITH days AS (
    SELECT (current_date - (gs || ' days')::interval)::date AS d
    FROM generate_series(0, p_days - 1) AS gs
  )
  SELECT
    d.d AS day,
    COALESCE(count(pv.id), 0)::bigint AS views,
    COALESCE(count(DISTINCT pv.session_id), 0)::bigint AS unique_sessions,
    COALESCE(count(DISTINCT pv.user_id), 0)::bigint AS logged_in_users
  FROM days d
  LEFT JOIN public.page_views pv ON pv.created_at::date = d.d
  GROUP BY d.d
  ORDER BY d.d ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_daily(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.analytics_daily(int) TO authenticated;

-- 5c. Meest bezochte pagina's (laatste 30 dagen)
CREATE OR REPLACE FUNCTION public.analytics_top_paths(p_limit int DEFAULT 10, p_days int DEFAULT 30)
RETURNS TABLE (
  path            text,
  views           bigint,
  unique_sessions bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin boolean;
BEGIN
  SELECT COALESCE(is_admin, false) INTO v_admin FROM public.profiles WHERE id = auth.uid();
  IF NOT COALESCE(v_admin, false) THEN RAISE EXCEPTION 'Not authorized'; END IF;

  p_days  := GREATEST(1, LEAST(COALESCE(p_days, 30), 365));
  p_limit := GREATEST(1, LEAST(COALESCE(p_limit, 10), 50));

  RETURN QUERY
  SELECT
    pv.path,
    count(*)::bigint                           AS views,
    count(DISTINCT pv.session_id)::bigint      AS unique_sessions
  FROM public.page_views pv
  WHERE pv.created_at >= current_date - (p_days || ' days')::interval
  GROUP BY pv.path
  ORDER BY views DESC
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_top_paths(int,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.analytics_top_paths(int,int) TO authenticated;

-- 5d. Nieuwe advertenties per dag (groei-indicator)
CREATE OR REPLACE FUNCTION public.analytics_listings_daily(p_days int DEFAULT 30)
RETURNS TABLE (
  day   date,
  count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin boolean;
BEGIN
  SELECT COALESCE(is_admin, false) INTO v_admin FROM public.profiles WHERE id = auth.uid();
  IF NOT COALESCE(v_admin, false) THEN RAISE EXCEPTION 'Not authorized'; END IF;

  p_days := GREATEST(1, LEAST(COALESCE(p_days, 30), 365));

  RETURN QUERY
  WITH days AS (
    SELECT (current_date - (gs || ' days')::interval)::date AS d
    FROM generate_series(0, p_days - 1) AS gs
  )
  SELECT
    d.d AS day,
    COALESCE(count(l.id), 0)::bigint AS count
  FROM days d
  LEFT JOIN public.listings l ON l.created_at::date = d.d
  GROUP BY d.d
  ORDER BY d.d ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_listings_daily(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.analytics_listings_daily(int) TO authenticated;

-- ──────────────────────────────────────────────────────────────
-- 6. Opruim-job: page_views ouder dan 180 dagen wissen
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cleanup_old_page_views()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  DELETE FROM public.page_views WHERE created_at < now() - interval '180 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_old_page_views() FROM PUBLIC;
-- (draai handmatig of plan via pg_cron: SELECT cron.schedule('cleanup_pv','0 4 * * *', $$SELECT public.cleanup_old_page_views();$$); )

-- ═══════════════════════════════════════════════════════════════
-- Klaar. Gebruik:
--   SELECT * FROM public.analytics_summary();
--   SELECT * FROM public.analytics_daily(30);
--   SELECT * FROM public.analytics_top_paths(10, 30);
--   SELECT * FROM public.analytics_listings_daily(30);
--
-- Maak één account admin:
--   UPDATE public.profiles SET is_admin = true WHERE id = '<jouw-user-id>';
-- ═══════════════════════════════════════════════════════════════
