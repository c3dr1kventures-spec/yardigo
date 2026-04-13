-- ============================================================
-- YardiGo — Rate Limiting (server-side bescherming)
-- Plak dit in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- ── 1. Max 10 actieve listings per gebruiker ─────────────────
-- Voorkomt dat een gebruiker de database volspaamt met listings.

CREATE OR REPLACE FUNCTION check_listing_limit()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    SELECT COUNT(*)
    FROM public.listings
    WHERE user_id = NEW.user_id
      AND status = 'active'
  ) >= 10 THEN
    RAISE EXCEPTION 'Je hebt het maximale aantal van 10 actieve listings bereikt. Verwijder eerst een bestaande listing.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Verwijder trigger als die al bestaat (voor herhaald uitvoeren)
DROP TRIGGER IF EXISTS enforce_listing_limit ON public.listings;

CREATE TRIGGER enforce_listing_limit
  BEFORE INSERT ON public.listings
  FOR EACH ROW
  EXECUTE FUNCTION check_listing_limit();

-- ── 2. Max 5 listings per uur per gebruiker ──────────────────
-- Aanvullende bescherming tegen snelle spam-bursts.

CREATE OR REPLACE FUNCTION check_listing_rate()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    SELECT COUNT(*)
    FROM public.listings
    WHERE user_id = NEW.user_id
      AND created_at > NOW() - INTERVAL '1 hour'
  ) >= 5 THEN
    RAISE EXCEPTION 'Je hebt het afgelopen uur te veel listings aangemaakt. Probeer het later opnieuw.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_listing_rate ON public.listings;

CREATE TRIGGER enforce_listing_rate
  BEFORE INSERT ON public.listings
  FOR EACH ROW
  EXECUTE FUNCTION check_listing_rate();

-- ── Verificatie ───────────────────────────────────────────────
-- Controleer of beide triggers actief zijn:
SELECT trigger_name, event_manipulation, event_object_table, action_timing
FROM information_schema.triggers
WHERE event_object_table = 'listings'
  AND trigger_schema = 'public';
-- Verwacht: enforce_listing_limit en enforce_listing_rate (beide BEFORE INSERT)
