-- ══════════════════════════════════════════════════════════════════
-- YardiGo — bron-resolver
--
-- Voegt de administratie toe die nodig is om bij een event dat via een
-- verzamelsite binnenkwam de ORIGINELE bron (organisator, vereniging,
-- gemeente) op te zoeken en de bronvermelding daarmee te vervangen.
--
-- Belangrijk: de "lead" (waar de tip vandaan kwam) mag NOOIT publiek
-- zichtbaar zijn. `listings` is wereldleesbaar, dus daar kan die kolom
-- niet bij. Vandaar een aparte admin-only tabel listing_source_leads.
-- `pending_events` heeft al admin-only RLS, daar kunnen de kolommen wel
-- gewoon bij.
--
-- Wijzigt de discovery_blocklist NIET.
-- ══════════════════════════════════════════════════════════════════

-- ── 1. pending_events: herkomst-administratie ─────────────────────
ALTER TABLE public.pending_events
  ADD COLUMN IF NOT EXISTS lead_source_url    text,
  ADD COLUMN IF NOT EXISTS lead_source_domain text,
  ADD COLUMN IF NOT EXISTS source_status      text NOT NULL DEFAULT 'onbekend',
  ADD COLUMN IF NOT EXISTS source_confidence  smallint,
  ADD COLUMN IF NOT EXISTS source_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_notes       text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pending_events_source_status_chk'
  ) THEN
    ALTER TABLE public.pending_events
      ADD CONSTRAINT pending_events_source_status_chk
      CHECK (source_status IN ('onbekend','origineel','aggregator','onopgelost'));
  END IF;
END $$;

COMMENT ON COLUMN public.pending_events.lead_source_url IS
  'Waar de tip vandaan kwam als dat een verzamelsite was. Intern, nooit tonen.';
COMMENT ON COLUMN public.pending_events.source_status IS
  'onbekend = nog niet beoordeeld; origineel = source_url is de organisator/gemeente; '
  'aggregator = wacht op resolver; onopgelost = resolver vond geen originele bron.';

-- Wachtrij voor de resolver: alles wat nog opgezocht moet worden.
CREATE INDEX IF NOT EXISTS pending_events_source_status_idx
  ON public.pending_events (source_status, created_at)
  WHERE source_status = 'aggregator';

-- ── 2. listing_source_leads: hetzelfde, maar voor gepubliceerde ───
--    listings. Aparte tabel omdat listings publiek leesbaar is.
CREATE TABLE IF NOT EXISTS public.listing_source_leads (
  listing_id      uuid PRIMARY KEY REFERENCES public.listings(id) ON DELETE CASCADE,
  lead_url        text NOT NULL,
  lead_domain     text NOT NULL,
  resolved_url    text,
  resolved_domain text,
  resolved_label  text,
  status          text NOT NULL DEFAULT 'aggregator'
                  CHECK (status IN ('aggregator','origineel','onopgelost')),
  confidence      smallint,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);

CREATE INDEX IF NOT EXISTS listing_source_leads_status_idx
  ON public.listing_source_leads (status, created_at);

ALTER TABLE public.listing_source_leads ENABLE ROW LEVEL SECURITY;

-- Admin-only. Zelfde patroon als de andere discovery-tabellen: de edge
-- function draait op de service role en gaat sowieso langs RLS heen; deze
-- policy is er voor het beheerpaneel.
DROP POLICY IF EXISTS listing_source_leads_admin_all ON public.listing_source_leads;
CREATE POLICY listing_source_leads_admin_all ON public.listing_source_leads
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND (p.is_admin = true OR p.admin_badges::text LIKE '%admin%')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND (p.is_admin = true OR p.admin_badges::text LIKE '%admin%')
    )
  );

-- ── 3. Helper: domein uit een URL, zonder protocol, www en pad ────
CREATE OR REPLACE FUNCTION public.extract_domain_simple(url text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(split_part(
    regexp_replace(regexp_replace(coalesce(url, ''), '^https?://', ''), '^www\.', ''),
    '/', 1
  ));
$$;

-- ── 4. Overzicht voor het beheerpaneel ────────────────────────────
-- Welke gepubliceerde listings hebben nog een bron die opgezocht moet
-- worden, en wat is de stand. Toont bewust geen lead_url in de listing
-- zelf, alleen in deze admin-view.
CREATE OR REPLACE VIEW public.v_listing_bronnen AS
SELECT
  l.id,
  l.title,
  l.city,
  l.date_start,
  l.source_label,
  l.source_url,
  extract_domain_simple(l.source_url) AS source_domain,
  sl.status        AS lead_status,
  sl.lead_domain,
  sl.confidence,
  sl.resolved_at,
  sl.notes
FROM public.listings l
LEFT JOIN public.listing_source_leads sl ON sl.listing_id = l.id
WHERE l.source_url IS NOT NULL;
