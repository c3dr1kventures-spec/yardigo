-- ═════════════════════════════════════════════════════════════════════════
-- YardiGo: dagelijkse breakdown voor verkeer-herkomst / apparaat / taal
-- ─────────────────────────────────────────────────────────────────────────
-- Drie nieuwe RPC's met dezelfde shape als de bestaande aggregate-versies
-- (analytics_referrers / analytics_devices / analytics_languages), maar
-- gefilterd op één enkele dag (Europe/Amsterdam).
--
-- Frontend (admin.html → Analytics tab) heeft een date-picker; bij wisselen
-- van datum worden deze 3 RPC's gevraagd voor díe ene dag.
-- ═════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Verkeer-herkomst voor één dag
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.analytics_referrers_for_day(
  p_date date,
  p_limit int DEFAULT 10
)
RETURNS TABLE (
  source text,
  visits bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin boolean;
  v_tz    constant text := 'Europe/Amsterdam';
BEGIN
  SELECT COALESCE(is_admin, false) INTO v_admin FROM public.profiles WHERE id = auth.uid();
  IF NOT COALESCE(v_admin, false) THEN RAISE EXCEPTION 'Not authorized'; END IF;

  p_limit := GREATEST(1, LEAST(COALESCE(p_limit, 10), 50));

  RETURN QUERY
  WITH normalized AS (
    SELECT
      CASE
        WHEN COALESCE(NULLIF(trim(pv.referrer), ''), '') = '' THEN '(direct)'
        WHEN pv.referrer ILIKE '%yardigo.nl%' OR pv.referrer ILIKE '%yardigo.be%'
          OR pv.referrer ILIKE '%yardigo.de%' OR pv.referrer ILIKE '%yardigo.app%' THEN '(internal)'
        WHEN pv.referrer ILIKE '%google.%'         THEN 'google'
        WHEN pv.referrer ILIKE '%facebook.%' OR pv.referrer ILIKE '%fb.com%' THEN 'facebook'
        WHEN pv.referrer ILIKE '%instagram.%'      THEN 'instagram'
        WHEN pv.referrer ILIKE '%bing.%'           THEN 'bing'
        WHEN pv.referrer ILIKE '%duckduckgo.%'     THEN 'duckduckgo'
        WHEN pv.referrer ILIKE '%whatsapp%' OR pv.referrer ILIKE '%wa.me%' THEN 'whatsapp'
        WHEN pv.referrer ILIKE '%yahoo.%'          THEN 'yahoo'
        WHEN pv.referrer ILIKE '%ecosia.%'         THEN 'ecosia'
        WHEN pv.referrer ILIKE '%t.co/%' OR pv.referrer ILIKE '%twitter.%' OR pv.referrer ILIKE '%x.com%' THEN 'twitter'
        WHEN pv.referrer ILIKE '%linkedin.%'       THEN 'linkedin'
        WHEN pv.referrer ILIKE '%tiktok.%'         THEN 'tiktok'
        WHEN pv.referrer ILIKE '%reddit.%'         THEN 'reddit'
        ELSE
          -- Pak alleen de host, zonder protocol/path
          regexp_replace(
            regexp_replace(pv.referrer, '^[a-z]+://', '', 'i'),
            '/.*$', ''
          )
      END AS source
    FROM public.page_views pv
    WHERE pv.created_at >= (p_date::timestamp AT TIME ZONE v_tz)
      AND pv.created_at <  ((p_date + 1)::timestamp AT TIME ZONE v_tz)
  )
  SELECT n.source, COUNT(*)::bigint AS visits
  FROM normalized n
  WHERE n.source IS NOT NULL AND n.source <> ''
  GROUP BY n.source
  ORDER BY visits DESC, n.source ASC
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_referrers_for_day(date,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.analytics_referrers_for_day(date,int) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────
-- 2. Apparaat-split voor één dag
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.analytics_devices_for_day(
  p_date date
)
RETURNS TABLE (
  device text,
  visits bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin boolean;
  v_tz    constant text := 'Europe/Amsterdam';
BEGIN
  SELECT COALESCE(is_admin, false) INTO v_admin FROM public.profiles WHERE id = auth.uid();
  IF NOT COALESCE(v_admin, false) THEN RAISE EXCEPTION 'Not authorized'; END IF;

  RETURN QUERY
  WITH classified AS (
    SELECT
      CASE
        WHEN COALESCE(NULLIF(trim(pv.user_agent), ''), '') = '' THEN 'unknown'
        WHEN pv.user_agent ~* '(ipad|tablet|playbook|silk|nexus 7|nexus 10|kindle)' THEN 'tablet'
        -- Android Mobile, iPhone, andere mobiele indicatoren
        WHEN pv.user_agent ~* '(iphone|ipod|android.*mobile|mobile.*android|windows phone|iemobile|blackberry|webos|opera mini|opera mobi)' THEN 'mobile'
        -- Generieke "Mobile" zonder Android (vaak iOS WebView of mini-browsers)
        WHEN pv.user_agent ~* 'mobile' THEN 'mobile'
        ELSE 'desktop'
      END AS device
    FROM public.page_views pv
    WHERE pv.created_at >= (p_date::timestamp AT TIME ZONE v_tz)
      AND pv.created_at <  ((p_date + 1)::timestamp AT TIME ZONE v_tz)
  )
  SELECT c.device, COUNT(*)::bigint AS visits
  FROM classified c
  GROUP BY c.device
  ORDER BY visits DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_devices_for_day(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.analytics_devices_for_day(date) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────
-- 3. Taal-split voor één dag
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.analytics_languages_for_day(
  p_date date
)
RETURNS TABLE (
  lang   text,
  visits bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin boolean;
  v_tz    constant text := 'Europe/Amsterdam';
BEGIN
  SELECT COALESCE(is_admin, false) INTO v_admin FROM public.profiles WHERE id = auth.uid();
  IF NOT COALESCE(v_admin, false) THEN RAISE EXCEPTION 'Not authorized'; END IF;

  RETURN QUERY
  WITH normalized AS (
    SELECT
      CASE
        WHEN COALESCE(NULLIF(trim(pv.lang), ''), '') = '' THEN 'unknown'
        ELSE lower(substring(trim(pv.lang) FROM 1 FOR 2))
      END AS lang
    FROM public.page_views pv
    WHERE pv.created_at >= (p_date::timestamp AT TIME ZONE v_tz)
      AND pv.created_at <  ((p_date + 1)::timestamp AT TIME ZONE v_tz)
  )
  SELECT n.lang, COUNT(*)::bigint AS visits
  FROM normalized n
  GROUP BY n.lang
  ORDER BY visits DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_languages_for_day(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.analytics_languages_for_day(date) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────
-- Smoke test (uitvoeren als admin):
--   SELECT * FROM public.analytics_referrers_for_day(CURRENT_DATE, 10);
--   SELECT * FROM public.analytics_devices_for_day(CURRENT_DATE);
--   SELECT * FROM public.analytics_languages_for_day(CURRENT_DATE);
-- ═════════════════════════════════════════════════════════════════════════
