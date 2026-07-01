-- ══════════════════════════════════════════════════════════════════
-- YardiGo — Discovery-laag: queries, blocklist, discovered_urls + seed
-- ══════════════════════════════════════════════════════════════════

-- ── discovery_queries ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.discovery_queries (
  id           bigserial PRIMARY KEY,
  query_tekst  text NOT NULL,
  land         text NOT NULL CHECK (land IN ('NL','BE','FR','DE')),
  actief       boolean NOT NULL DEFAULT true,
  laatste_run  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS discovery_queries_uniq
  ON public.discovery_queries (land, lower(query_tekst));

ALTER TABLE public.discovery_queries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS discovery_queries_admin_all ON public.discovery_queries;
CREATE POLICY discovery_queries_admin_all ON public.discovery_queries
  FOR ALL USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));

-- ── discovery_blocklist ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.discovery_blocklist (
  id         bigserial PRIMARY KEY,
  domein     text NOT NULL,
  reden      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS discovery_blocklist_domein_uniq
  ON public.discovery_blocklist (lower(domein));

ALTER TABLE public.discovery_blocklist ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS discovery_blocklist_admin_all ON public.discovery_blocklist;
CREATE POLICY discovery_blocklist_admin_all ON public.discovery_blocklist
  FOR ALL USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));

-- ── discovered_urls ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.discovered_urls (
  id                  bigserial PRIMARY KEY,
  url                 text NOT NULL,
  domein              text NOT NULL,
  gevonden_via_query  text,
  status              text NOT NULL DEFAULT 'nieuw'
                      CHECK (status IN ('nieuw','beoordeeld','afgewezen')),
  beoordeling         jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS discovered_urls_url_uniq   ON public.discovered_urls (url);
CREATE INDEX        IF NOT EXISTS discovered_urls_domein_idx ON public.discovered_urls (lower(domein));
CREATE INDEX        IF NOT EXISTS discovered_urls_status_idx ON public.discovered_urls (status);

ALTER TABLE public.discovered_urls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS discovered_urls_admin_all ON public.discovered_urls;
CREATE POLICY discovered_urls_admin_all ON public.discovered_urls
  FOR ALL USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true));

-- ── Seed: discovery_queries ──────────────────────────────────────
INSERT INTO public.discovery_queries (query_tekst, land) VALUES
  ('rommelroute {maand} {jaar}',             'NL'),
  ('garageverkoop {maand} {jaar}',           'NL'),
  ('buurtverkoop {maand} {jaar}',            'NL'),
  ('rommelmarkt agenda {jaar}',              'NL'),
  ('rommelmarkt {maand} {jaar} België',      'BE'),
  ('garageverkoop Vlaanderen {maand} {jaar}','BE'),
  ('brocante {maand} {jaar} Belgique',       'BE'),
  ('vide-grenier {maand} {annee}',           'FR'),
  ('brocante agenda {annee}',                'FR'),
  ('Hofflohmarkt {Monat} {Jahr}',            'DE'),
  ('Flohmarkt Termine {Jahr}',               'DE')
ON CONFLICT DO NOTHING;

-- ── Seed: discovery_blocklist ────────────────────────────────────
INSERT INTO public.discovery_blocklist (domein, reden) VALUES
  ('facebook.com',        'social media, geen originele bron + auteursrecht'),
  ('marktplaats.nl',      'marktplaats-aggregator'),
  ('meukisleuk.nl',       'aggregator (verzamelsite)'),
  ('rommelmarkten.nl',    'aggregator (verzamelsite)'),
  ('ebay.nl',             'marktplaats-aggregator'),
  ('2dehands.be',         'marktplaats-aggregator'),
  ('leboncoin.fr',        'marktplaats-aggregator'),
  ('yardigo.nl',          'eigen domein'),
  ('yardigo.be',          'eigen domein'),
  ('yardigo.app',         'eigen domein')
ON CONFLICT DO NOTHING;
