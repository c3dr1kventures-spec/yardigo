-- YardiGo — Notificatiesysteem rebuild
-- Voer uit in Supabase SQL Editor (https://supabase.com/dashboard → SQL Editor)
--
-- Achtergrond: de "Meldingen"-instellingen-UI in index.html bestond al (afstand,
-- timing, stille-uren, categorieën etc.) maar sloeg NIETS op — saveNotifSettings()
-- was een lege stub en er was geen enkel mechanisme om ooit een push te versturen
-- (geen VAPID, geen subscription-tabel, geen native push-plugin). Dit bestand
-- legt het echte fundament: opslag van voorkeuren, web-push subscriptions,
-- native device tokens (OneSignal) en een log-tabel om dubbele sends te voorkomen.
--
-- Bevat ook: formalisatie van profiles-kolommen die al in productie gebruikt
-- worden (index.html queries) maar nooit in een getrackt migratie-bestand
-- terechtkwamen — waarschijnlijk destijds handmatig via Supabase Studio toegevoegd.

-- ============================================
-- 0. Profiles-kolommen formaliseren (al in gebruik, nu pas getrackt)
-- ============================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS bio TEXT,
  ADD COLUMN IF NOT EXISTS name_display_mode TEXT DEFAULT 'full' CHECK (name_display_mode IN ('full', 'first_name', 'initials')),
  ADD COLUMN IF NOT EXISTS notify_interest_email BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS promo_email_opt_in BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS marketing_email_opt_in BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS email_frequency TEXT DEFAULT 'weekly' CHECK (email_frequency IN ('daily', 'weekly', 'never'));

-- Laatst bekende locatie (opt-in via browser-geolocatie, max 1x/uur ververst
-- door de client) — nodig omdat er tot nu toe geen server-side opgeslagen
-- gebruikerslocatie bestond, waardoor "nieuwe verkopen in de buurt" server-side
-- (cron) helemaal niet te berekenen was.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS home_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS home_lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ;

-- ============================================
-- 1. NOTIFICATION_PREFERENCES — echte opslag van de instellingen-UI
-- ============================================
CREATE TABLE IF NOT EXISTS public.notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,

  master_enabled BOOLEAN NOT NULL DEFAULT TRUE,

  -- Kaart 1: nieuwe verkopen in de buurt
  nearby_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  nearby_radius_km INTEGER NOT NULL DEFAULT 2 CHECK (nearby_radius_km IN (1, 2, 5, 10, 25)),
  nearby_timing TEXT NOT NULL DEFAULT 'direct' CHECK (nearby_timing IN ('direct', 'dagelijks')),
  nearby_types TEXT[] NOT NULL DEFAULT ARRAY['particulier', 'buurt', 'evenement'],

  -- Kaart 2: herinneringen favorieten
  favorites_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  favorites_advance_min INTEGER NOT NULL DEFAULT 20 CHECK (favorites_advance_min BETWEEN 5 AND 120),
  favorites_morning_overview BOOLEAN NOT NULL DEFAULT FALSE,
  favorites_route_reminder BOOLEAN NOT NULL DEFAULT TRUE,

  -- Stille uren (gedeeld over notificatietypen die dit respecteren), in minuten sinds middernacht; NULL = geen stille uren
  quiet_hours_start_min INTEGER CHECK (quiet_hours_start_min BETWEEN 0 AND 1439),
  quiet_hours_end_min INTEGER CHECK (quiet_hours_end_min BETWEEN 0 AND 1439),

  -- Kaart 3: ochtendroute-overzicht
  morning_route_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  morning_route_time_min INTEGER NOT NULL DEFAULT 480 CHECK (morning_route_time_min BETWEEN 300 AND 720),
  morning_route_days TEXT[] NOT NULL DEFAULT ARRAY['za', 'zo'],
  morning_route_send_when TEXT NOT NULL DEFAULT 'altijd' CHECK (morning_route_send_when IN ('altijd', 'favorieten')),

  -- Kaart 4: nieuwe items in categorieën
  category_alerts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  category_alerts_categories TEXT[] NOT NULL DEFAULT '{}',
  category_alerts_radius_km INTEGER NOT NULL DEFAULT 25 CHECK (category_alerts_radius_km IN (5, 10, 25, 50)),
  category_alerts_freq TEXT NOT NULL DEFAULT 'direct' CHECK (category_alerts_freq IN ('direct', 'dagelijks', 'wekelijks')),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Gebruikers zien eigen notificatievoorkeuren"
  ON public.notification_preferences FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Gebruikers beheren eigen notificatievoorkeuren"
  ON public.notification_preferences FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION update_updated_at_notification_preferences()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notification_preferences_updated_at ON public.notification_preferences;
CREATE TRIGGER trg_notification_preferences_updated_at
  BEFORE UPDATE ON public.notification_preferences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_notification_preferences();

-- ============================================
-- 2. PUSH_SUBSCRIPTIONS — Web Push (VAPID), browser
-- ============================================
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON public.push_subscriptions(user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Gebruikers beheren eigen push-subscriptions"
  ON public.push_subscriptions FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================
-- 3. DEVICE_TOKENS — native iOS/Android push (OneSignal player id)
-- ============================================
CREATE TABLE IF NOT EXISTS public.device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  onesignal_player_id TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_user_id ON public.device_tokens(user_id);

ALTER TABLE public.device_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Gebruikers beheren eigen device tokens"
  ON public.device_tokens FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================
-- 4. NOTIFICATION_LOG — voorkomt dubbele sends per cron-run
-- ============================================
CREATE TABLE IF NOT EXISTS public.notification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  notif_type TEXT NOT NULL CHECK (notif_type IN ('nearby', 'favorites', 'morning_route', 'category_alert')),
  listing_id UUID REFERENCES public.listings(id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, notif_type, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_log_lookup ON public.notification_log(user_id, notif_type, sent_at);

ALTER TABLE public.notification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Gebruikers zien eigen notificatielog"
  ON public.notification_log FOR SELECT
  USING (auth.uid() = user_id);

-- Alleen service-role (edge functions) mag inserten — geen INSERT policy voor
-- gewone gebruikers nodig, service role omzeilt RLS sowieso.

-- ============================================
-- 5. Helper: index op listings voor "nieuw sinds laatste cron-run" queries
-- ============================================
CREATE INDEX IF NOT EXISTS idx_listings_created_at ON public.listings(created_at);

-- ============================================
-- Klaar. Vervolgstappen (buiten SQL):
--   - VAPID keypair genereren (npx web-push generate-vapid-keys)
--   - Publieke VAPID-key in index.html, private key + service role als
--     Supabase edge function secrets (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT)
--   - OneSignal account: ONESIGNAL_APP_ID, ONESIGNAL_REST_API_KEY als secrets
--   - pg_cron schedules voor de nieuwe edge functions (zie process-*-notifications)
-- ============================================
