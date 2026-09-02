-- ═══════════════════════════════════════════════════════════════════
-- AI-invulling: gebruiksteller  (edge function `parse-event`, mode 'organizer')
-- ═══════════════════════════════════════════════════════════════════
-- De AI-invulling in het plaatsingsformulier staat open voor elke ingelogde
-- gebruiker. Elke parse is een echte, betaalde API-call, dus zonder rem is
-- dat endpoint een open kostenpost. Deze tabel houdt bij wie hoeveel parses
-- doet; de edge function weigert boven de limiet (nu 10/uur, 30/dag — de
-- waarden staan in AI_PARSE_LIMIT_HOUR / AI_PARSE_LIMIT_DAY).
--
-- Draai in Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- ═══════════════════════════════════════════════════════════════════

-- 1. Tabel aanmaken
CREATE TABLE IF NOT EXISTS public.ai_parse_usage (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 2. Index waarop de limietcheck draait: per gebruiker, nieuwste eerst.
CREATE INDEX IF NOT EXISTS idx_ai_parse_usage_user_created
  ON public.ai_parse_usage (user_id, created_at DESC);

-- 3. RLS aan, en bewust géén policies.
--    De edge function schrijft en leest met de service-role key, en die gaat
--    langs RLS heen. Zonder policies kan verder niemand bij deze rijen —
--    ook niet de gebruiker zelf, die zijn eigen teller anders zou kunnen
--    uitlezen of (erger) proberen te legen.
ALTER TABLE public.ai_parse_usage ENABLE ROW LEVEL SECURITY;

-- 4. Opruimen. De limiet kijkt nooit verder terug dan 24 uur, dus alles
--    ouder dan een week is ballast. Draai dit periodiek, of laat het staan:
--    de tabel groeit met hooguit 30 rijen per gebruiker per dag.
-- DELETE FROM public.ai_parse_usage WHERE created_at < now() - interval '7 days';

-- ═══════════════════════════════════════════════════════════════════
-- Verificatie:
--   SELECT count(*) FROM public.ai_parse_usage;
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'ai_parse_usage';
-- ═══════════════════════════════════════════════════════════════════
