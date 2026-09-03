// YardiGo – parse-event Edge Function
// Neemt geplakte tekst en/of een screenshot van een lokale-verkoop-post
// (Facebook, gemeente-site, poster) en laat Claude er een gestructureerd
// event uithalen. Response is altijd JSON conform het schema hieronder —
// nooit een letterlijke overname van de brontekst.
//
// Twee modi, met verschillende auth, prompt én uitvoerschema:
//
//   mode: 'admin'      (standaard) — admin neemt een vermelding over van een
//                      openbare bron. Privéadressen worden bewust weggelaten
//                      en er wordt bronvermelding gevraagd.
//                      Auth: profiles.is_admin = true of badge 'admin'.
//
//   mode: 'organizer'  — een organisator vult zijn EIGEN advertentie in vanaf
//                      een affiche/flyer. Het adres hoort er hier juist wél
//                      in (het is zijn eigen verkoop), bronvelden vervallen,
//                      en de uitvoer gebruikt de vocabulaire van het
//                      plaatsingsformulier. Auth: elke ingelogde gebruiker,
//                      met een gebruikslimiet (zie AI_PARSE_LIMIT_*).
//
// Aanroep (POST, JSON):
//   {
//     "mode":          "admin" | "organizer"     (optioneel, default 'admin')
//     "text":          "<geplakte tekst>"        (optioneel als er een image is)
//     "image": {
//       "data":       "<base64 zonder data: prefix>",
//       "media_type": "image/jpeg" | "image/png" | "image/webp" | "image/gif"
//     }                                          (optioneel als er tekst is)
//     "hint_country": "NL" | "BE"                (optioneel)
//
//     // alleen bij mode 'organizer':
//     "listing_type":  "particulier" | "buurt" | "evenement"   (verplicht)
//     "categories":    ["👗 Kleding", ...]        (optioneel, max 40)
//     "subtypes":      ["Vlooienmarkt", ...]      (optioneel, max 20)
//   }
//
// De client stuurt zijn eigen categorie- en subtypelijst mee zodat die niet
// op twee plekken onderhouden hoeft te worden. Het model mag daar alleen uit
// kiezen, en de client matcht de teruggegeven strings daarna nogmaals tegen
// zijn eigen lijst — wat niet exact matcht wordt genegeerd.
//
// Response:
//   { "ok": true, "data": { ...event schema... } }
//   { "ok": false, "reason": "no_event", "message": "geen event gevonden" }
//   { "error": "..." }
//
// Required secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (auto-injected)
//   ANTHROPIC_API_KEY                        (handmatig zetten)
//
// Vereist voor mode 'organizer': tabel public.ai_parse_usage
// (zie ai-parse-usage-setup.sql in de repo-root).

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

// Gebruikslimiet voor mode 'organizer'. Een parse kost een echte API-call,
// dus zonder limiet is dit endpoint een open kostenpost. Admins vallen hier
// buiten — die hebben hun eigen (impliciete) rem.
const AI_PARSE_LIMIT_HOUR = 10;
const AI_PARSE_LIMIT_DAY  = 30;

// Wat de client mag meesturen aan keuzelijsten.
const MAX_CATEGORIES = 40;
const MAX_SUBTYPES   = 20;
const MAX_CHOICE_LEN = 60;

const LISTING_TYPES = new Set(['particulier', 'buurt', 'evenement']);
const COUNTRIES     = new Set(['NL', 'BE', 'FR', 'DE']);

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

// Uitvoer voor mode 'organizer'. Volgt de velden van het plaatsingsformulier,
// niet die van de admin-curatie. `type_suggestie` is expres een suggestie: het
// type is al door de organisator gekozen en stuurt de rest van het formulier
// aan (categorieën, adres-UI), dus dat overschrijven we nooit stilzwijgend.
interface OrganizerSchema {
  titel: string | null;
  datum: string | null;
  starttijd: string | null;
  eindtijd: string | null;
  adres: string | null;
  plaats: string | null;
  land: string | null;
  beschrijving: string | null;
  categorieen: string[];
  type_suggestie: string | null;
  evenement_subtype: string | null;
  contactgegevens_zichtbaar: boolean;
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

    // ── Auth: geldige bearer JWT (welke rol nodig is, hangt van de modus af) ──
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

    // ── Body parsen ──
    // Moet vóór de rolcheck, want de modus bepaalt wélke check geldt.
    let payload: {
      mode?: string;
      text?: string;
      image?: ImagePayload;
      hint_country?: string;
      listing_type?: string;
      categories?: unknown;
      subtypes?: unknown;
    };
    try {
      payload = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const mode = (payload.mode ?? 'admin').toLowerCase();
    if (mode !== 'admin' && mode !== 'organizer') {
      return json({ error: "mode moet 'admin' of 'organizer' zijn" }, 400);
    }

    // ── Rolcheck ──
    // 'admin' blijft achter de adminrol. 'organizer' staat open voor elke
    // ingelogde gebruiker (de JWT hierboven is al geverifieerd), maar met een
    // gebruikslimiet in plaats van een rol.
    if (mode === 'admin') {
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
    } else {
      const quota = await checkParseQuota(adminClient, callerId);
      if (!quota.ok) {
        return json({ error: quota.message, reason: quota.reason }, quota.status);
      }
    }

    const text = (payload.text ?? '').trim().slice(0, MAX_INPUT_CHARS);
    const hintCountry = (payload.hint_country ?? '').toUpperCase();
    const image = payload.image ?? null;

    // ── Organizer-specifieke invoer ──
    const listingType = (payload.listing_type ?? '').toLowerCase();
    const categories  = sanitizeChoices(payload.categories, MAX_CATEGORIES);
    const subtypes    = sanitizeChoices(payload.subtypes, MAX_SUBTYPES);
    if (mode === 'organizer' && !LISTING_TYPES.has(listingType)) {
      return json({ error: "listing_type moet 'particulier', 'buurt' of 'evenement' zijn" }, 400);
    }

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
    const systemPrompt = mode === 'organizer'
      ? buildOrganizerPrompt(today, hintCountry, listingType, categories, subtypes)
      : buildSystemPrompt(today, hintCountry);

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

    // Registreer het verbruik vlak vóór de betaalde call: dít is het moment
    // dat geld kost. Faalt de registratie, dan gaat de parse gewoon door —
    // een kapotte teller mag de gebruiker niet blokkeren.
    if (mode === 'organizer') {
      const usageRes = await adminClient.from('ai_parse_usage').insert({ user_id: callerId });
      if (usageRes.error) {
        console.warn('ai_parse_usage insert faalde:', usageRes.error.message);
      }
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

    const cleaned = mode === 'organizer'
      ? normalizeOrganizer(parsed, categories, subtypes, today)
      : normalizeEvent(parsed);

    // Als àlle velden leeg zijn, tellen we dat als "geen event gevonden".
    // `contactgegevens_zichtbaar` (false) en `categorieen` (lege array) tellen
    // niet mee — dat zijn geen uit de bron gelezen gegevens.
    const anyFilled = Object.entries(cleaned).some(([k, v]) => {
      if (k === 'contactgegevens_zichtbaar') return false;
      if (Array.isArray(v)) return v.length > 0;
      return v !== null;
    });
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

// ── Gebruikslimiet (alleen mode 'organizer') ──────────────────────
// Haalt het venster van 24 uur in één query op en telt het laatste uur er
// lokaal uit, zodat er maar één database-rondje nodig is.
async function checkParseQuota(
  adminClient: any,
  userId: string,
): Promise<{ ok: true } | { ok: false; status: number; reason: string; message: string }> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const res = await adminClient
    .from('ai_parse_usage')
    .select('created_at')
    .eq('user_id', userId)
    .gte('created_at', dayAgo);

  if (res.error) {
    return {
      ok: false,
      status: 500,
      reason: 'quota_check_failed',
      message: 'Kan de gebruikslimiet niet controleren: ' + res.error.message,
    };
  }

  const rows: Array<{ created_at: string }> = res.data ?? [];
  if (rows.length >= AI_PARSE_LIMIT_DAY) {
    return {
      ok: false,
      status: 429,
      reason: 'rate_limited_day',
      message: 'Je hebt vandaag het maximum van ' + AI_PARSE_LIMIT_DAY +
        ' AI-invullingen bereikt. Vul het formulier handmatig in, of probeer het morgen opnieuw.',
    };
  }

  const hourAgo = Date.now() - 60 * 60 * 1000;
  const lastHour = rows.filter((r) => new Date(r.created_at).getTime() >= hourAgo).length;
  if (lastHour >= AI_PARSE_LIMIT_HOUR) {
    return {
      ok: false,
      status: 429,
      reason: 'rate_limited_hour',
      message: 'Je hebt het maximum van ' + AI_PARSE_LIMIT_HOUR +
        ' AI-invullingen per uur bereikt. Vul het formulier handmatig in, of probeer het over een uur opnieuw.',
    };
  }

  return { ok: true };
}

// Keuzelijst van de client opschonen: alleen korte, niet-lege strings, geen
// duplicaten, en afgekapt op een maximum. Voorkomt dat er via de body een
// eindeloze of rommelige lijst de prompt in glipt.
function sanitizeChoices(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (!t || t.length > MAX_CHOICE_LEN) continue;
    if (out.includes(t)) continue;
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

// ── Prompt voor mode 'organizer' ──────────────────────────────────
// Fundamenteel andere uitgangspositie dan de adminprompt: dit is de EIGEN
// verkoop van degene die het formulier invult, dus het adres hoort er juist
// wél in. Het type is al gekozen en wordt hier als gegeven meegegeven, zodat
// het model gericht kan zoeken in plaats van ook nog te classificeren.
function buildOrganizerPrompt(
  today: string,
  hintCountry: string,
  listingType: string,
  categories: string[],
  subtypes: string[],
): string {
  const typeUitleg: Record<string, string> = {
    particulier: 'een opritverkoop: één huishouden dat eigen spullen verkoopt bij het eigen huis',
    buurt: 'een rommelroute of buurtverkoop: meerdere huizen in dezelfde buurt op dezelfde dag',
    evenement: 'een georganiseerd evenement, zoals een rommelmarkt, vlooienmarkt of braderie',
  };

  const countryLine = hintCountry
    ? 'De organisator zit waarschijnlijk in ' + (hintCountry === 'BE' ? 'België' : 'Nederland') + '.'
    : 'De verkoop is waarschijnlijk in Nederland of België.';

  const lines = [
    'Je vult een advertentieformulier voor van iemand die zijn EIGEN lokale verkoop op YardiGo plaatst.',
    'De bron is zijn eigen affiche, flyer, poster of aankondiging — geen bron van derden.',
    '',
    'De organisator heeft zelf al gekozen dat dit ' + (typeUitleg[listingType] ?? 'een lokale verkoop') + ' is.',
    'Ga daarvan uit bij het lezen; je hoeft het type niet te bepalen.',
    countryLine,
    'Vandaag is ' + today + '. Interpreteer een datum als "zaterdag 20 juni" als de eerstvolgende keer dat die datum valt, in de toekomst.',
    '',
    'Antwoord UITSLUITEND met één JSON-object, geen uitleg, geen markdown-fences:',
    '{',
    '  "titel": string | null,',
    '  "datum": "YYYY-MM-DD" | null,',
    '  "starttijd": "HH:MM" | null,',
    '  "eindtijd": "HH:MM" | null,',
    '  "adres": string | null,',
    '  "plaats": string | null,',
    '  "land": "NL" | "BE" | "FR" | "DE" | null,',
    '  "beschrijving": string | null,',
    '  "categorieen": string[],',
    '  "type_suggestie": "particulier" | "buurt" | "evenement" | null,',
    '  "evenement_subtype": string | null,',
    '  "contactgegevens_zichtbaar": boolean',
    '}',
    '',
    'Regels:',
    '- adres = het volledige adres van de verkoop zoals het er staat (straat, huisnummer, eventueel postcode en plaats). Dit is de eigen verkoop van de invuller, dus een woonadres hoort er gewoon in. Staat er geen adres: null.',
    '- plaats = alleen de plaatsnaam (bijvoorbeeld "Groningen").',
    '- titel = kort en wervend, max 60 tekens. Geen datum of adres in de titel; die staan al in eigen velden.',
    '- beschrijving = je EIGEN korte, feitelijke samenvatting van max 240 tekens. Neem de brontekst niet letterlijk over.',
    '- ZET NOOIT een telefoonnummer, e-mailadres of website in "titel" of "beschrijving", ook niet als die op de bron staan. Het formulier weigert ze, en bezoekers nemen contact op via YardiGo zelf.',
    '- Ontbrekend veld = null. Verzin niets, ook geen plausibele tijden.',
    '- type_suggestie = wat de bron in werkelijkheid lijkt te beschrijven. Meestal gelijk aan het gekozen type; wijk daar alleen van af als de bron duidelijk iets anders is (bijvoorbeeld een markt met tientallen kramen terwijl "particulier" gekozen is). Dit is puur een signaal, geen correctie.',
  ];

  if (categories.length > 0) {
    lines.push(
      '- categorieen = maximaal 6 items, LETTERLIJK overgenomen uit deze lijst (exact dezelfde tekst, inclusief het emoji-teken vooraan). Kies alleen wat de bron echt noemt; noemt de bron niets bruikbaars, geef dan een lege lijst:',
      '  ' + JSON.stringify(categories),
    );
  } else {
    lines.push('- categorieen = lege lijst.');
  }

  if (listingType === 'evenement' && subtypes.length > 0) {
    lines.push(
      '- evenement_subtype = één waarde, LETTERLIJK uit deze lijst, of null als geen enkele past:',
      '  ' + JSON.stringify(subtypes),
    );
  } else {
    lines.push('- evenement_subtype = null.');
  }

  lines.push(
    '- contactgegevens_zichtbaar = true als er in de MEEGESTUURDE AFBEELDING een telefoonnummer, e-mailadres of een volledig woonadres leesbaar in beeld staat. De afbeelding kan als foto bij de advertentie worden gepubliceerd, dus dit is een privacywaarschuwing voor de organisator. Is er geen afbeelding meegestuurd, dan is dit false.',
    '',
    'Als de bron GEEN aankondiging van een lokale verkoop is (onleesbaar, ander onderwerp, alleen een logo of meme), antwoord dan met EXACT:',
    '{"error": "geen event gevonden"}',
  );

  return lines.join('\n');
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

// Normalisatie voor mode 'organizer'. Alles wat niet exact aan het verwachte
// formaat voldoet wordt null — het formulier vult liever niets in dan iets
// verkeerds, want de organisator ziet niet wat hij niet nakijkt.
function normalizeOrganizer(
  raw: Record<string, unknown>,
  allowedCategories: string[],
  allowedSubtypes: string[],
  today: string,
): OrganizerSchema {
  const clean = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t === '' ? null : t;
  };

  const dt = clean(raw.datum);
  const st = clean(raw.starttijd);
  const en = clean(raw.eindtijd);
  const land = (clean(raw.land) ?? '').toUpperCase();
  const typeSug = (clean(raw.type_suggestie) ?? '').toLowerCase();
  const subtype = clean(raw.evenement_subtype);

  // Alleen categorieën die letterlijk in de lijst van de client staan. De
  // client filtert daarna nóg een keer tegen zijn eigen DOM, dus een
  // afwijkende string kan nooit als tag blijven hangen.
  const cats: string[] = [];
  if (Array.isArray(raw.categorieen)) {
    for (const item of raw.categorieen) {
      const t = clean(item);
      if (t && allowedCategories.includes(t) && !cats.includes(t)) cats.push(t);
      if (cats.length >= 6) break;
    }
  }

  // De prompt vraagt om de eerstvolgende toekomstige datum, maar het model
  // volgt dat niet altijd (bijvoorbeeld "zaterdag 20 juni" teruggeven voor
  // dit jaar, ook als die datum al voorbij is). Een datum in het verleden is
  // voor een advertentie die nu geplaatst wordt sowieso nooit correct, dus
  // die vangen we hier hard af i.p.v. te vertrouwen op het model — liever
  // een leeg veld dat de organisator zelf invult dan een stille foute datum.
  const isValidDate = dt && /^\d{4}-\d{2}-\d{2}$/.test(dt) && dt >= today;

  return {
    titel:        clean(raw.titel),
    datum:        isValidDate ? dt : null,
    starttijd:    (st && /^\d{1,2}:\d{2}$/.test(st)) ? padTime(st) : null,
    eindtijd:     (en && /^\d{1,2}:\d{2}$/.test(en)) ? padTime(en) : null,
    adres:        clean(raw.adres),
    plaats:       clean(raw.plaats),
    land:         COUNTRIES.has(land) ? land : null,
    beschrijving: clean(raw.beschrijving),
    categorieen:  cats,
    type_suggestie: LISTING_TYPES.has(typeSug) ? typeSug : null,
    evenement_subtype: (subtype && allowedSubtypes.includes(subtype)) ? subtype : null,
    contactgegevens_zichtbaar: raw.contactgegevens_zichtbaar === true,
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
