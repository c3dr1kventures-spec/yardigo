// YardiGo – parse-event Edge Function
// Neemt geplakte tekst en/of een screenshot van een lokale-verkoop-post
// (Facebook, gemeente-site, poster) en laat Claude er een gestructureerd
// event uithalen. Response is altijd JSON conform het schema hieronder —
// nooit een letterlijke overname van de brontekst.
//
// Auth: Bearer JWT van een ingelogde admin (profiles.is_admin = true of
// admin_badges bevat 'admin').
//
// Aanroep (POST, JSON):
//   {
//     "text":          "<geplakte tekst>"      (optioneel als er een image is)
//     "image": {
//       "data":       "<base64 zonder data: prefix>",
//       "media_type": "image/jpeg" | "image/png" | "image/webp" | "image/gif"
//     }                                          (optioneel als er tekst is)
//     "hint_country": "NL" | "BE"                (optioneel)
//   }
//
// Response:
//   { "ok": true, "data": { ...event schema... } }
//   { "ok": false, "reason": "no_event", "message": "geen event gevonden" }
//   { "error": "..." }
//
// Required secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (auto-injected)
//   ANTHROPIC_API_KEY                        (handmatig zetten)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const MAX_INPUT_CHARS = 8000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Anthropic-limiet
const ALLOWED_MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

interface EventSchema {
  titel: string | null;
  event_type: 'opritverkoop' | 'rommelroute' | 'rommelmarkt' | 'buurtverkoop' | 'overig' | null;
  datum: string | null;
  starttijd: string | null;
  eindtijd: string | null;
  plaats: string | null;
  adres: string | null;
  beschrijving: string | null;
  bron_naam: string | null;
  bron_url: string | null;
}

interface ImagePayload {
  data: string;
  media_type: string;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const supabaseUrl  = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
    if (!supabaseUrl || !serviceKey) {
      return json({ error: 'Server misconfigured: SUPABASE env missing' }, 500);
    }
    if (!anthropicKey) {
      return json({ error: 'Server misconfigured: ANTHROPIC_API_KEY missing' }, 500);
    }

    // ── Auth: bearer JWT van een admin ──
    const authHeader = req.headers.get('Authorization') ?? '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return json({ error: 'Missing Authorization Bearer token' }, 401);
    }
    const jwt = match[1];

    const adminClient = createClient(supabaseUrl, serviceKey);
    const userRes = await adminClient.auth.getUser(jwt);
    if (userRes.error || !userRes.data?.user) {
      return json({ error: 'Invalid token' }, 401);
    }
    const callerId = userRes.data.user.id;

    const profRes = await adminClient
      .from('profiles')
      .select('is_admin, admin_badges')
      .eq('id', callerId)
      .maybeSingle();
    if (profRes.error) {
      return json({ error: 'Cannot verify admin: ' + profRes.error.message }, 500);
    }
    const isAdmin = profRes.data?.is_admin === true;
    const badges = parseBadges(profRes.data?.admin_badges);
    if (!isAdmin && !badges.includes('admin')) {
      return json({ error: 'Forbidden: admin role required' }, 403);
    }

    // ── Body parsen ──
    let payload: { text?: string; image?: ImagePayload; hint_country?: string };
    try {
      payload = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    const text = (payload.text ?? '').trim().slice(0, MAX_INPUT_CHARS);
    const hintCountry = (payload.hint_country ?? '').toUpperCase();
    const image = payload.image ?? null;

    if (!text && !image) {
      return json({ error: 'text of image is verplicht' }, 400);
    }
    if (image) {
      if (!image.data || typeof image.data !== 'string') {
        return json({ error: 'image.data ontbreekt' }, 400);
      }
      if (!image.media_type || !ALLOWED_MEDIA.has(image.media_type)) {
        return json({ error: 'image.media_type moet image/jpeg, png, webp of gif zijn' }, 400);
      }
      // Ruwe base64-lengte * 3/4 = bytes
      const approxBytes = Math.floor(image.data.length * 0.75);
      if (approxBytes > MAX_IMAGE_BYTES) {
        return json({ error: 'Afbeelding te groot (max 5 MB)' }, 400);
      }
    }
    if (!image && text.length < 10) {
      return json({ error: 'text is te kort (min 10 chars) en geen image meegegeven' }, 400);
    }

    // ── Claude aanroepen ──
    const today = new Date().toISOString().slice(0, 10);
    const systemPrompt = buildSystemPrompt(today, hintCountry);

    const contentBlocks: unknown[] = [];
    if (image) {
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.media_type,
          data: image.data,
        },
      });
    }
    if (text) {
      contentBlocks.push({ type: 'text', text: text });
    } else if (image) {
      contentBlocks.push({
        type: 'text',
        text: 'Extract het event uit deze afbeelding volgens het JSON-schema.',
      });
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: contentBlocks }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return json({
        error: 'Anthropic API error (' + anthropicRes.status + '): ' + errText.slice(0, 300),
      }, 502);
    }

    const anthropicJson = await anthropicRes.json();
    const rawContent = extractTextContent(anthropicJson);
    if (!rawContent) {
      return json({ error: 'Anthropic returned empty content' }, 502);
    }

    const parsed = safeParseEventJson(rawContent);
    if (!parsed) {
      return json({
        error: 'Kon geen geldige JSON uit de response halen',
        raw_preview: rawContent.slice(0, 300),
      }, 502);
    }

    // Model kan expliciet signaleren dat er geen event te vinden was.
    if (typeof parsed.error === 'string' && /geen event/i.test(parsed.error)) {
      return json({ ok: false, reason: 'no_event', message: parsed.error }, 200);
    }

    const cleaned = normalizeEvent(parsed);

    // Als àlle velden null zijn, tellen we dat als "geen event gevonden".
    const anyFilled = Object.values(cleaned).some((v) => v !== null);
    if (!anyFilled) {
      return json({ ok: false, reason: 'no_event', message: 'geen event gevonden' }, 200);
    }

    return json({ ok: true, data: cleaned }, 200);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});

function buildSystemPrompt(today: string, hintCountry: string): string {
  const countryLine = hintCountry
    ? `Context: de bron gaat waarschijnlijk over een evenement in ${hintCountry === 'BE' ? 'België' : 'Nederland'}.`
    : 'Context: de bron gaat over een lokale verkoop in Nederland of België.';

  return [
    'Je bent een strikte JSON-extractor voor lokale-verkoop-evenementen (rommelmarkten, rommelroutes, opritverkoop, buurtverkopen).',
    'Bronnen kunnen tekst zijn (Facebook-post, gemeente-aankondiging) of een screenshot / poster (image).',
    countryLine,
    `Vandaag is ${today}. Interpreteer datums (zoals "zaterdag 20 juni") als de eerstvolgende bezetting van die datum in de toekomst.`,
    '',
    'Antwoord UITSLUITEND met één JSON-object, geen uitleg, geen markdown-fences.',
    '',
    'Bij een geldig event, gebruik dit schema:',
    '{',
    '  "titel": string | null,',
    '  "event_type": "opritverkoop" | "rommelroute" | "rommelmarkt" | "buurtverkoop" | "overig" | null,',
    '  "datum": "YYYY-MM-DD" | null,',
    '  "starttijd": "HH:MM" | null,',
    '  "eindtijd": "HH:MM" | null,',
    '  "plaats": string | null,',
    '  "adres": string | null,',
    '  "beschrijving": string | null,',
    '  "bron_naam": string | null,',
    '  "bron_url": string | null',
    '}',
    '',
    'Regels:',
    '- adres = straat + huisnummer ALLEEN bij een duidelijk publieke locatie (sporthal, plein, markthal, gemeentekantoor, kerk, schoolplein). Bij een privéadres van een particulier: adres = null (privacy).',
    '- beschrijving = EIGEN korte formulering (max 240 tekens), feitelijk. NIET de brontekst letterlijk overnemen.',
    '- event_type: "opritverkoop" bij één huis / eigen oprit, "rommelroute" bij meerdere adressen in een buurt, "rommelmarkt" bij georganiseerde markt met kramen, "buurtverkoop" bij aangekondigde buurt-actie, anders "overig".',
    '- Ontbrekend veld = null. Verzin niets.',
    '- bron_url alleen als er een URL zichtbaar is; anders null.',
    '',
    'Als de bron GEEN lokaal-verkoop-evenement bevat (onleesbaar, ander onderwerp, alleen een meme, enz.), antwoord dan met EXACT:',
    '{"error": "geen event gevonden"}',
  ].join('\n');
}

function extractTextContent(anthropicJson: any): string {
  if (!anthropicJson || !Array.isArray(anthropicJson.content)) return '';
  const parts: string[] = [];
  for (const block of anthropicJson.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

function safeParseEventJson(raw: string): Record<string, unknown> | null {
  let s = raw.trim();
  const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) s = fenceMatch[1].trim();
  const firstBrace = s.indexOf('{');
  const lastBrace  = s.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    return null;
  } catch {
    return null;
  }
}

const ALLOWED_TYPES = new Set(['opritverkoop', 'rommelroute', 'rommelmarkt', 'buurtverkoop', 'overig']);

function normalizeEvent(raw: Record<string, unknown>): EventSchema {
  const clean = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t === '' ? null : t;
  };
  const et = clean(raw.event_type as string);
  const dt = clean(raw.datum as string);
  const st = clean(raw.starttijd as string);
  const en = clean(raw.eindtijd as string);
  return {
    titel:        clean(raw.titel),
    event_type:   (et && ALLOWED_TYPES.has(et)) ? (et as EventSchema['event_type']) : null,
    datum:        (dt && /^\d{4}-\d{2}-\d{2}$/.test(dt)) ? dt : null,
    starttijd:    (st && /^\d{1,2}:\d{2}$/.test(st)) ? padTime(st) : null,
    eindtijd:     (en && /^\d{1,2}:\d{2}$/.test(en)) ? padTime(en) : null,
    plaats:       clean(raw.plaats),
    adres:        clean(raw.adres),
    beschrijving: clean(raw.beschrijving),
    bron_naam:    clean(raw.bron_naam),
    bron_url:     clean(raw.bron_url),
  };
}

function padTime(t: string): string {
  const [h, m] = t.split(':');
  return h.padStart(2, '0') + ':' + m;
}

function parseBadges(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.map(String);
    } catch {}
    return [];
  }
  return [];
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
