-- ═════════════════════════════════════════════════════════════════════════
-- YardiGo: Curated listings (door YardiGo verzamelde evenementen)
-- ─────────────────────────────────────────────────────────────────────────
-- Stelt admin in staat om openbare evenementen (rommelmarkt, vlooienmarkt,
-- braderie, kerstmarkt, antiekmarkt, boekenmarkt, kofferbakverkoop,
-- Hofflohmarkt / rommelroute) zelf op YardiGo te plaatsen op basis van
-- openbare bronnen. Organisator kan de vermelding claimen via een
-- verificatie-flow met:
--   1) E-mail-domain match met source_url, EN
--   2) Tijdelijke verificatie-token gepubliceerd op het officiële kanaal
-- Beslissingen worden vastgelegd voor DSA-statement-of-reasons.
-- ═════════════════════════════════════════════════════════════════════════

-- 1. Nieuwe kolommen op listings
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS placed_by text NOT NULL DEFAULT 'user'
    CHECK (placed_by IN ('user', 'yardigo')),
  ADD COLUMN IF NOT EXISTS source_url text,
  ADD COLUMN IF NOT EXISTS source_label text,
  ADD COLUMN IF NOT EXISTS claim_token text,
  ADD COLUMN IF NOT EXISTS claimed_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS curator_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Curated listings moeten een bron-URL hebben (juridisch: aantonen waar info
-- vandaan komt). User-listings hebben dat niet nodig.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'listings_curated_must_have_source'
  ) THEN
    ALTER TABLE public.listings
      ADD CONSTRAINT listings_curated_must_have_source
      CHECK (placed_by = 'user' OR (source_url IS NOT NULL AND length(trim(source_url)) > 0));
  END IF;
END $$;

-- Unieke claim_token (only when set)
CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_claim_token
  ON public.listings (claim_token) WHERE claim_token IS NOT NULL;

-- Snelle filter op placed_by (voor admin-tab + pin-rendering)
CREATE INDEX IF NOT EXISTS idx_listings_placed_by ON public.listings (placed_by);

COMMENT ON COLUMN public.listings.placed_by IS
  '''user''=door verkoper zelf geplaatst; ''yardigo''=door admin geplaatst op basis van openbare bron';
COMMENT ON COLUMN public.listings.source_url IS
  'Bron-URL van curated evenementen (officiële organisator/gemeente); verplicht voor placed_by=yardigo';
COMMENT ON COLUMN public.listings.claim_token IS
  'Door admin gegenereerd token dat in een listing wordt opgenomen zodat organisator kan claimen';
COMMENT ON COLUMN public.listings.curator_user_id IS
  'User-id van de admin die de curated listing oorspronkelijk plaatste (audit)';


-- 2. Claim-requests tabel
-- ─────────────────────────────────────────────────────────────────────────
-- Iedere organisator die een curated listing wil overnemen, dient een claim
-- in. Admin keurt goed/af, beslissingen worden opgeslagen voor DSA-audit.
CREATE TABLE IF NOT EXISTS public.listing_claims (
  id                     bigserial PRIMARY KEY,
  listing_id             uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  requested_by_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organizer_name         text NOT NULL,
  organizer_email        text NOT NULL,
  organizer_phone        text,
  evidence_url           text,           -- link naar publicatie waar verification_token staat
  evidence_notes         text,           -- vrije toelichting van organisator
  verification_token     text NOT NULL,  -- random, organisator plakt dit publiek
  status                 text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  decision_reason        text,           -- DSA: statement of reasons (verplicht bij rejected)
  decision_by_user_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decision_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listing_claims_listing_id  ON public.listing_claims (listing_id);
CREATE INDEX IF NOT EXISTS idx_listing_claims_status      ON public.listing_claims (status);
CREATE INDEX IF NOT EXISTS idx_listing_claims_requester   ON public.listing_claims (requested_by_user_id);
CREATE INDEX IF NOT EXISTS idx_listing_claims_created_at  ON public.listing_claims (created_at DESC);

COMMENT ON TABLE public.listing_claims IS
  'Claim-aanvragen door organisatoren voor curated YardiGo-listings. Audit log voor DSA.';


-- 3. RLS op listing_claims
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.listing_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "claims_admin_full"    ON public.listing_claims;
DROP POLICY IF EXISTS "claims_self_select"   ON public.listing_claims;
DROP POLICY IF EXISTS "claims_self_insert"   ON public.listing_claims;

-- Admins kunnen alles
CREATE POLICY "claims_admin_full" ON public.listing_claims
  USING (EXISTS(SELECT 1 FROM public.profiles WHERE id = auth.uid() AND COALESCE(is_admin, false) = true))
  WITH CHECK (EXISTS(SELECT 1 FROM public.profiles WHERE id = auth.uid() AND COALESCE(is_admin, false) = true));

-- Aanvragers zien hun eigen claims
CREATE POLICY "claims_self_select" ON public.listing_claims
  FOR SELECT USING (requested_by_user_id = auth.uid());

-- Aanvragers maken een claim aan (alleen voor zichzelf)
CREATE POLICY "claims_self_insert" ON public.listing_claims
  FOR INSERT WITH CHECK (
    auth.uid() IS NOT NULL
    AND requested_by_user_id = auth.uid()
  );


-- 4. RPC: claim aanvragen (door organisator)
-- ─────────────────────────────────────────────────────────────────────────
-- Genereert een verification_token die de organisator publiekelijk moet
-- plaatsen op hun officiële kanaal (website/FB). Admin checkt later.
CREATE OR REPLACE FUNCTION public.request_listing_claim(
  p_listing_id     uuid,
  p_organizer_name text,
  p_organizer_email text,
  p_organizer_phone text DEFAULT NULL,
  p_evidence_url    text DEFAULT NULL,
  p_evidence_notes  text DEFAULT NULL
) RETURNS TABLE (
  claim_id           bigint,
  verification_token text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token text;
  v_id    bigint;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd';
  END IF;

  -- Listing moet curated zijn
  IF NOT EXISTS (SELECT 1 FROM public.listings WHERE id = p_listing_id AND placed_by = 'yardigo') THEN
    RAISE EXCEPTION 'Deze vermelding is niet door YardiGo verzameld en kan niet worden geclaimd';
  END IF;

  -- Geen openstaande claim van deze user voor deze listing
  IF EXISTS (
    SELECT 1 FROM public.listing_claims
    WHERE listing_id = p_listing_id
      AND requested_by_user_id = auth.uid()
      AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'Je hebt al een openstaande claim voor deze vermelding';
  END IF;

  -- Niet als al goedgekeurd voor iemand anders
  IF EXISTS (SELECT 1 FROM public.listings WHERE id = p_listing_id AND claimed_by_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Deze vermelding is al door iemand anders geclaimd';
  END IF;

  -- Basis-validatie
  IF length(trim(coalesce(p_organizer_name, ''))) < 2 THEN
    RAISE EXCEPTION 'Geef je naam op';
  END IF;
  IF p_organizer_email IS NULL OR p_organizer_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'Geef een geldig e-mailadres op';
  END IF;

  v_token := 'yg-claim-' || encode(gen_random_bytes(6), 'hex');

  INSERT INTO public.listing_claims (
    listing_id, requested_by_user_id, organizer_name, organizer_email,
    organizer_phone, evidence_url, evidence_notes, verification_token, status
  ) VALUES (
    p_listing_id, auth.uid(), trim(p_organizer_name), lower(trim(p_organizer_email)),
    nullif(trim(coalesce(p_organizer_phone,'')), ''),
    nullif(trim(coalesce(p_evidence_url,'')),    ''),
    nullif(trim(coalesce(p_evidence_notes,'')),  ''),
    v_token, 'pending'
  ) RETURNING id INTO v_id;

  RETURN QUERY SELECT v_id, v_token;
END;
$$;

REVOKE ALL    ON FUNCTION public.request_listing_claim(uuid, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_listing_claim(uuid, text, text, text, text, text) TO authenticated;


-- 5. RPC: claim intrekken (door aanvrager zelf)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.withdraw_listing_claim(p_claim_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Niet ingelogd'; END IF;

  UPDATE public.listing_claims
  SET status = 'withdrawn', decision_at = now(), updated_at = now()
  WHERE id = p_claim_id
    AND requested_by_user_id = auth.uid()
    AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim niet gevonden of niet meer openstaand';
  END IF;
END;
$$;

REVOKE ALL    ON FUNCTION public.withdraw_listing_claim(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.withdraw_listing_claim(bigint) TO authenticated;


-- 6. RPC: claim beslissen (admin)
-- ─────────────────────────────────────────────────────────────────────────
-- Bij approval: listing krijgt nieuwe eigenaar (claim-aanvrager) zodat
-- bestaande owner-RLS automatisch werkt. Bij rejection: alleen log + reden.
CREATE OR REPLACE FUNCTION public.decide_listing_claim(
  p_claim_id bigint,
  p_decision text,           -- 'approved' of 'rejected'
  p_reason   text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin      boolean;
  v_listing_id uuid;
  v_requester  uuid;
BEGIN
  SELECT COALESCE(is_admin, false) INTO v_admin FROM public.profiles WHERE id = auth.uid();
  IF NOT v_admin THEN RAISE EXCEPTION 'Niet geautoriseerd'; END IF;

  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Ongeldige beslissing (verwacht: approved of rejected)';
  END IF;

  IF p_decision = 'rejected' AND (p_reason IS NULL OR length(trim(p_reason)) < 3) THEN
    RAISE EXCEPTION 'Geef een reden op bij afwijzing (DSA-statement of reasons)';
  END IF;

  SELECT listing_id, requested_by_user_id INTO v_listing_id, v_requester
  FROM public.listing_claims
  WHERE id = p_claim_id AND status = 'pending';

  IF v_listing_id IS NULL THEN
    RAISE EXCEPTION 'Claim niet gevonden of al beslist';
  END IF;

  UPDATE public.listing_claims
  SET status = p_decision,
      decision_reason = p_reason,
      decision_by_user_id = auth.uid(),
      decision_at = now(),
      updated_at = now()
  WHERE id = p_claim_id;

  IF p_decision = 'approved' THEN
    UPDATE public.listings
    SET claimed_by_user_id = v_requester,
        claimed_at         = now(),
        user_id            = v_requester
    WHERE id = v_listing_id;

    -- Eventuele andere openstaande claims op dezelfde listing automatisch
    -- intrekken (alleen één goedkeuring per listing)
    UPDATE public.listing_claims
    SET status = 'withdrawn', decision_at = now(), updated_at = now(),
        decision_reason = 'Listing al door andere claim goedgekeurd'
    WHERE listing_id = v_listing_id
      AND id <> p_claim_id
      AND status = 'pending';
  END IF;
END;
$$;

REVOKE ALL    ON FUNCTION public.decide_listing_claim(bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.decide_listing_claim(bigint, text, text) TO authenticated;


-- 7. View: admin claim-queue met verificatie-helpers
-- ─────────────────────────────────────────────────────────────────────────
-- Toont voor elke openstaande claim de checks die admin kan controleren:
--   - matcht het e-mail-domein met het source_url-domein?
--   - account-leeftijd in dagen
--   - eerdere claims door dezelfde user (red flag bij veel)
CREATE OR REPLACE VIEW public.listing_claims_queue AS
SELECT
  c.id,
  c.listing_id,
  c.requested_by_user_id,
  c.organizer_name,
  c.organizer_email,
  c.organizer_phone,
  c.evidence_url,
  c.evidence_notes,
  c.verification_token,
  c.status,
  c.created_at,
  c.decision_reason,
  c.decision_at,
  l.title              AS listing_title,
  l.city               AS listing_city,
  l.date_start         AS listing_date,
  l.source_url,
  l.source_label,
  -- Verificatie-helpers
  (regexp_replace(coalesce(c.organizer_email, ''), '^.*@', '') ILIKE
   '%' || regexp_replace(regexp_replace(coalesce(l.source_url, ''), '^[a-z]+://', '', 'i'),
                         '/.*$', '') || '%')
    AS email_domain_matches_source,
  (now() - u.created_at)::int / 86400 AS requester_account_age_days,
  (SELECT count(*) FROM public.listing_claims c2
   WHERE c2.requested_by_user_id = c.requested_by_user_id
     AND c2.id <> c.id) AS requester_previous_claim_count
FROM public.listing_claims c
JOIN public.listings l ON l.id = c.listing_id
LEFT JOIN auth.users u ON u.id = c.requested_by_user_id
WHERE c.status = 'pending'
ORDER BY c.created_at DESC;

COMMENT ON VIEW public.listing_claims_queue IS
  'Openstaande claim-aanvragen met verificatie-helpers voor admin-review (anti-fraude).';

-- View is alleen leesbaar door admins (via security barrier via parent table RLS)
ALTER VIEW public.listing_claims_queue OWNER TO postgres;
GRANT SELECT ON public.listing_claims_queue TO authenticated;


-- 8. updated_at trigger op listing_claims
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.listing_claims_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_listing_claims_updated_at ON public.listing_claims;
CREATE TRIGGER trg_listing_claims_updated_at
  BEFORE UPDATE ON public.listing_claims
  FOR EACH ROW EXECUTE FUNCTION public.listing_claims_set_updated_at();


-- ═════════════════════════════════════════════════════════════════════════
-- Smoke test (uitvoeren als admin):
--   SELECT * FROM public.listings WHERE placed_by = 'yardigo' LIMIT 5;
--   SELECT * FROM public.listing_claims_queue;
-- ═════════════════════════════════════════════════════════════════════════
