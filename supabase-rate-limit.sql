-- ============================================================
-- YardiGo — Rate Limiting (server-side bescherming)
-- Plak dit in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- ── 1. Max 10 actieve verkopen per gebruiker ─────────────────
-- Voorkomt dat een gebruiker de database volspaamt met listings.
-- Een buurtverkoop telt als 1 slot, niet als N adressen. Een nieuwe rij
-- die bij een bestaande buurtverkoop-groep van dezelfde user hoort,
-- gebruikt geen extra slot, anders zou de eerste buur al falen zodra
-- het eigen-adres net is toegevoegd en de teller op 10 staat.

CREATE OR REPLACE FUNCTION check_listing_limit()
RETURNS TRIGGER AS $$
DECLARE
  current_groups INTEGER;
  new_is_existing_group BOOLEAN := FALSE;
BEGIN
  -- Hoort de nieuwe rij bij een buurtverkoop-groep die al bestaat voor deze user?
  IF NEW.neighborhood_group_id IS NOT NULL THEN
    SELECT EXISTS(
      SELECT 1 FROM public.listings
      WHERE user_id = NEW.user_id
        AND neighborhood_group_id = NEW.neighborhood_group_id
        AND status = 'active'
    ) INTO new_is_existing_group;
  END IF;

  IF new_is_existing_group THEN
    RETURN NEW;
  END IF;

  -- Nieuwe groep of solo-listing: tel huidige distinct groepen.
  SELECT COUNT(DISTINCT COALESCE(neighborhood_group_id, id::text))
    INTO current_groups
    FROM public.listings
    WHERE user_id = NEW.user_id
      AND status = 'active';

  IF current_groups >= 10 THEN
    RAISE EXCEPTION 'Je hebt het maximale aantal van 10 actieve verkopen bereikt. Verwijder eerst een bestaande listing.';
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
-- Buur-rijen (met confirmation_token) tellen niet mee, anders zou een
-- buurtverkoop met meer dan 5 buren al de rate-limit raken.

CREATE OR REPLACE FUNCTION check_listing_rate()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    SELECT COUNT(*)
    FROM public.listings
    WHERE user_id = NEW.user_id
      AND created_at > NOW() - INTERVAL '1 hour'
      AND (neighborhood_group_id IS NULL OR confirmation_token IS NULL)
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
