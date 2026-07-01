-- ══════════════════════════════════════════════════════════════════
-- YardiGo — Basis-infrastructuur voor de discovery-laag
--
-- Wat het opzet:
--   1. scrape_sources     — geregistreerde bronnen (agenda's, gemeenten)
--   2. pending_events     — events die op admin-review wachten voordat
--                           ze in listings gepubliceerd worden
--   3. discovery_runs     — samenvatting per discover-events run
--   + dedupe-helpers: content_hash + PostGIS 500m-check tegen listings
--     en pending_events (zodat we nooit dubbele events importeren).
--
-- Alle nieuwe tabellen hebben admin-only RLS.
-- ══════════════════════════════════════════════════════════════════

-- ── 1. scrape_sources ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.scrape_sources (
  id              bigserial PRIMARY KEY,
  domain          text NOT NULL,
  base_url        text,
  country         text CHECK (country IN ('NL','BE','FR','DE')),
  actief          boolean NOT NULL DEFAULT false,
  voorgesteld     boolean NOT NULL DEFAULT false,
  voorstel_reden  text,
  last_scraped_at timestamptz,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS scrape_sources_domain_uniq ON public.scrape_sources (lower(domain));
CREATE INDEX IF NOT EXISTS scrape_sources_actief_idx ON public.scrape_sources (actief) WHERE actief;
CREATE INDEX IF NOT EXISTS scrape_sources_voorgesteld_idx ON public.scrape_sources (voorgesteld) WHERE voorgesteld;

-- ── 2. pending_events ─────────────────────────────────────────────
-- Kolomstructuur volgt listings zodat approval een simpele copy is.
CREATE TABLE IF NOT EXISTS public.pending_events (
  id                   bigserial PRIMARY KEY,
  title                text NOT NULL,
  description          text,
  event_subtype        text,
  date_start           date NOT NULL,
  date_end             date,
  time_start           time,
  time_end             time,
  city                 text,
  address              text,
  latitude             double precision,
  longitude            double precision,
  location             geography(Point, 4326),
  source_url           text NOT NULL,
  source_domain        text NOT NULL,
  source_label         text,
  discovered_via_query text,
  content_hash         text NOT NULL,
  status               text NOT NULL DEFAULT 'nieuw'
                       CHECK (status IN ('nieuw','goedgekeurd','afgewezen')),
  review_notes         text,
  reviewer_user_id     uuid,
  raw_ai_response      jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  reviewed_at          timestamptz,
  approved_listing_id  uuid REFERENCES public.listings(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pending_events_content_hash_uniq ON public.pending_events (content_hash);
CREATE INDEX IF NOT EXISTS pending_events_status_created_idx ON public.pending_events (status, created_at DESC);
CREATE INDEX IF NOT EXISTS pending_events_location_gix ON public.pending_events USING gist (location);

CREATE OR REPLACE FUNCTION public.pending_events_sync_location()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    NEW.location := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
  ELSE
    NEW.location := NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS pending_events_location_trg ON public.pending_events;
CREATE TRIGGER pending_events_location_trg
  BEFORE INSERT OR UPDATE OF latitude, longitude ON public.pending_events
  FOR EACH ROW EXECUTE FUNCTION public.pending_events_sync_location();

ALTER TABLE public.pending_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scrape_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pending_events_admin_all ON public.pending_events;
CREATE POLICY pending_events_admin_all ON public.pending_events
  FOR ALL USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));

DROP POLICY IF EXISTS scrape_sources_admin_all ON public.scrape_sources;
CREATE POLICY scrape_sources_admin_all ON public.scrape_sources
  FOR ALL USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));

-- ── 3. discovery_runs (log) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.discovery_runs (
  id            bigserial PRIMARY KEY,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  summary       jsonb,
  error         text
);
ALTER TABLE public.discovery_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS discovery_runs_admin_read ON public.discovery_runs;
CREATE POLICY discovery_runs_admin_read ON public.discovery_runs
  FOR SELECT USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));

-- ── 4. Dedupe helpers ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.discovery_content_hash(
  p_title text, p_date date, p_city text
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT md5(
    coalesce(lower(regexp_replace(p_title, '\s+', ' ', 'g')), '')
    || '|' || coalesce(p_date::text, '')
    || '|' || coalesce(lower(regexp_replace(p_city, '\s+', ' ', 'g')), '')
  );
$$;
COMMENT ON FUNCTION public.discovery_content_hash IS
  'Canonical dedupe-key: title|date|city, gebruikt door discover-events';

CREATE OR REPLACE FUNCTION public.discovery_find_similar(
  p_hash text, p_lat double precision, p_lng double precision,
  p_date date, p_radius_m integer DEFAULT 500
) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_pt geography;
BEGIN
  IF EXISTS (SELECT 1 FROM public.pending_events WHERE content_hash = p_hash) THEN
    RETURN 'pending:hash';
  END IF;

  IF p_lat IS NOT NULL AND p_lng IS NOT NULL THEN
    v_pt := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;

    IF EXISTS (
      SELECT 1 FROM public.pending_events
      WHERE date_start = p_date AND location IS NOT NULL
        AND ST_DWithin(location, v_pt, p_radius_m)
    ) THEN
      RETURN 'pending:spatial';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.listings
      WHERE date_start = p_date AND location IS NOT NULL
        AND ST_DWithin(location, v_pt, p_radius_m)
    ) THEN
      RETURN 'listing:spatial';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;
COMMENT ON FUNCTION public.discovery_find_similar IS
  'Returns non-null als event al bestaat: pending:hash|pending:spatial|listing:spatial';
