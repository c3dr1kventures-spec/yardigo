-- YardiGo — Gastenboek (ouderwetse "messagebox") op de homepage.
-- Iedereen mag een kort berichtje achterlaten, geen account nodig — net als
-- de gastenboeken van vroeger. Schrijven gaat NIET via de client/anon-key
-- rechtstreeks (zou rate-limiting en link-filtering omzeilbaar maken), maar
-- uitsluitend via de edge function post-guestbook-message (service role).
CREATE TABLE IF NOT EXISTS public.guestbook_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  ip_hash TEXT,                    -- SHA-256(ip + salt), nooit het ruwe IP — AVG-vriendelijk
  created_at TIMESTAMPTZ DEFAULT NOW(),
  is_visible BOOLEAN NOT NULL DEFAULT TRUE  -- admin kan een bericht verbergen zonder te verwijderen
);

CREATE INDEX IF NOT EXISTS idx_guestbook_ip_hash_created ON public.guestbook_messages(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_guestbook_visible_created ON public.guestbook_messages(is_visible, created_at DESC);

ALTER TABLE public.guestbook_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Iedereen kan zichtbare gastenboek-berichten lezen"
  ON public.guestbook_messages FOR SELECT
  USING (is_visible = true);

-- Bewust geen INSERT/UPDATE/DELETE policy voor anon/authenticated: alleen de
-- edge function (service role, omzeilt RLS) mag schrijven.

-- ============================================
-- Vervolgstappen (buiten SQL, al uitgevoerd in Supabase):
--   - GUESTBOOK_IP_SALT als edge function secret gezet (willekeurige string,
--     alleen gebruikt om IP-adressen te hashen vóór opslag)
--   - Edge function post-guestbook-message gedeployed
--   - Om een bericht te verbergen: UPDATE guestbook_messages SET is_visible
--     = false WHERE id = '...';
-- ============================================
