-- ============================================================
-- Herinneringsmails voor niet-bevestigde buur-adressen
-- ============================================================
-- Doel: als een buur na 3 dagen de confirmation link nog niet
-- heeft aangeklikt, krijgt de organisator automatisch een
-- herinnerings-e-mail met alle pending adressen zodat hij/zij
-- opnieuw kan delen. Na 7 dagen een laatste reminder voor
-- het adres automatisch wordt gewist.
--
-- Deze migratie voegt alleen de tracking-kolommen toe + een
-- helper-functie die gebruikt wordt door de Supabase Edge
-- Function (zie supabase/functions/send-reminder-emails/).
-- ============================================================

-- ── Stap 1: tracking-kolommen ────────────────────────────────
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS reminder_3d_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_7d_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN public.listings.reminder_3d_sent_at IS
  'Moment waarop de 3-dagen reminder naar de organisator is verstuurd voor deze buur-listing. NULL = nog niet verstuurd.';
COMMENT ON COLUMN public.listings.reminder_7d_sent_at IS
  'Moment waarop de 7-dagen reminder is verstuurd. Na 7 dagen zonder bevestiging vervalt het adres.';

-- ── Stap 2: helper-functie voor de Edge Function ─────────────
-- Geeft één rij per (organisator, buurtverkoop) met daarin een
-- JSON array van pending buren. De Edge Function loopt hier
-- doorheen en stuurt per organisator-buurtverkoop één reminder.
DROP FUNCTION IF EXISTS public.get_pending_reminders(TEXT);

CREATE OR REPLACE FUNCTION public.get_pending_reminders(reminder_type TEXT)
RETURNS TABLE (
  organiser_id UUID,
  organiser_email TEXT,
  neighborhood_group_id UUID,
  buurtverkoop_title TEXT,
  buurtverkoop_date DATE,
  pending_listings JSONB,
  listing_ids UUID[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  threshold_days INT;
  sent_column TEXT;
BEGIN
  -- Validatie: alleen '3d' of '7d' toegestaan
  IF reminder_type NOT IN ('3d', '7d') THEN
    RAISE EXCEPTION 'reminder_type must be 3d or 7d, got: %', reminder_type;
  END IF;

  threshold_days := CASE WHEN reminder_type = '3d' THEN 3 ELSE 7 END;
  sent_column   := CASE WHEN reminder_type = '3d' THEN 'reminder_3d_sent_at' ELSE 'reminder_7d_sent_at' END;

  -- Dynamic SQL omdat de kolomnaam afhangt van reminder_type.
  RETURN QUERY EXECUTE format($f$
    SELECT
      l.user_id AS organiser_id,
      u.email::text AS organiser_email,
      l.neighborhood_group_id,
      MAX(l.title) AS buurtverkoop_title,
      MAX(l.date_start) AS buurtverkoop_date,
      jsonb_agg(jsonb_build_object(
        'listing_id', l.id,
        'address_label', l.confirmation_address_label,
        'address', l.address,
        'token', l.confirmation_token
      ) ORDER BY l.created_at) AS pending_listings,
      array_agg(l.id) AS listing_ids
    FROM public.listings l
    LEFT JOIN auth.users u ON u.id = l.user_id
    WHERE l.confirmation_status = 'pending'
      AND l.neighborhood_group_id IS NOT NULL
      AND l.created_at <= NOW() - INTERVAL '%s days'
      AND l.%I IS NULL
      -- Gaten tussen adres-uitnodigingen: als 7d reminder al gestuurd is, geen 3d meer.
      AND (l.reminder_7d_sent_at IS NULL OR %L = '7d')
    GROUP BY l.user_id, u.email, l.neighborhood_group_id
  $f$, threshold_days, sent_column, reminder_type);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_pending_reminders(TEXT) TO service_role;

-- ── Stap 3: markeer reminder als verstuurd ───────────────────
DROP FUNCTION IF EXISTS public.mark_reminders_sent(UUID[], TEXT);

CREATE OR REPLACE FUNCTION public.mark_reminders_sent(p_listing_ids UUID[], reminder_type TEXT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count INT;
BEGIN
  IF reminder_type NOT IN ('3d', '7d') THEN
    RAISE EXCEPTION 'reminder_type must be 3d or 7d';
  END IF;

  IF reminder_type = '3d' THEN
    UPDATE public.listings
      SET reminder_3d_sent_at = NOW()
      WHERE id = ANY(p_listing_ids)
        AND reminder_3d_sent_at IS NULL;
  ELSE
    UPDATE public.listings
      SET reminder_7d_sent_at = NOW()
      WHERE id = ANY(p_listing_ids)
        AND reminder_7d_sent_at IS NULL;
  END IF;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_reminders_sent(UUID[], TEXT) TO service_role;

-- ── Stap 4: index voor snelle queries ────────────────────────
CREATE INDEX IF NOT EXISTS idx_listings_pending_reminders
  ON public.listings (created_at)
  WHERE confirmation_status = 'pending' AND neighborhood_group_id IS NOT NULL;

-- ── Stap 5: verificatie ──────────────────────────────────────
SELECT 'reminder_3d kolom' AS check_item,
  COUNT(*)::text AS count
FROM information_schema.columns
WHERE table_name = 'listings' AND table_schema = 'public'
  AND column_name = 'reminder_3d_sent_at'
UNION ALL
SELECT 'reminder_7d kolom', COUNT(*)::text
FROM information_schema.columns
WHERE table_name = 'listings' AND table_schema = 'public'
  AND column_name = 'reminder_7d_sent_at'
UNION ALL
SELECT 'get_pending_reminders RPC', COUNT(*)::text
FROM information_schema.routines
WHERE routine_name = 'get_pending_reminders' AND routine_schema = 'public'
UNION ALL
SELECT 'mark_reminders_sent RPC', COUNT(*)::text
FROM information_schema.routines
WHERE routine_name = 'mark_reminders_sent' AND routine_schema = 'public';
