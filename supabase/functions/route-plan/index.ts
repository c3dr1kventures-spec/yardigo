// YardiGo – route-plan Edge Function (dagplanner fase 2, zie PLAN-routeplanner.md)
//
// Doorgeefluik naar OpenRouteService (ORS) zodat de sleutel nooit in de
// browser komt. Drie acties (POST, JSON):
//
//   { "actie": "lijn", "vervoer": "auto|fiets|lopen", "punten": [[lng,lat], …] }
//     → { afstand, duur, delen: [{ afstand, duur }], lijn: [[lat,lng], …] }
//     Reistijd per stuk in de gegeven volgorde (voor aankomsttijden) en de
//     route over de weg voor op de kaart.
//
//   { "actie": "matrix", "vervoer": …, "punten": [[lng,lat], …] }
//     → { duur: [[s]], afstand: [[m]] }   (voor omrijtijd van suggesties)
//
//   { "actie": "optimaliseer", "vervoer": …, "start": [lng,lat], "eind": [lng,lat]|null,
//     "vertrek": seconden sinds middernacht,
//     "stops": [{ "id": "…", "plek": [lng,lat], "bezoek": s, "vensters": [[s,e]] }] }
//     → { volgorde: [id], aankomst: { id: s }, niet: [id] }
//     ORS /optimization (VROOM): kortste dag die past in de openingstijden.
//
// Afstand in meters, tijd in seconden. Antwoorden 7 dagen in route_cache
// (route-plan.sql); hooguit 30 verzoeken per minuut per IP.
// Secrets: ORS_API_KEY (+ standaard SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const ORS = 'https://api.openrouteservice.org';
const PROFIEL: Record<string, string> = { auto: 'driving-car', fiets: 'cycling-regular', lopen: 'foot-walking' };
const MAX_PUNTEN = 27;          // 25 stops + start + eind
const CACHE_DAGEN = 7;
const PER_MINUUT = 30;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

// Per instantie; genoeg om een losgeslagen pagina of script af te remmen.
const teller = new Map<string, { minuut: number; n: number }>();
function teVaak(ip: string): boolean {
  const minuut = Math.floor(Date.now() / 60000);
  const t = teller.get(ip);
  if (!t || t.minuut !== minuut) { teller.set(ip, { minuut, n: 1 }); return false; }
  return ++t.n > PER_MINUUT;
}

type Punt = [number, number];
function geldigPunt(p: unknown): p is Punt {
  return Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'number' && isFinite(x)) &&
    Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
}
// Afronden op ~10 m: beter voor de cache en geen exacte adressen naar ORS.
const rond = (p: Punt): Punt => [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4];

async function sleutelVan(x: unknown): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(x)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function uitCache(sleutel: string): Promise<unknown | null> {
  const { data } = await db.from('route_cache').select('antwoord, gemaakt').eq('sleutel', sleutel).maybeSingle();
  if (!data) return null;
  if (Date.parse(data.gemaakt) < Date.now() - CACHE_DAGEN * 86400000) return null;
  return data.antwoord;
}
async function inCache(sleutel: string, antwoord: unknown) {
  await db.from('route_cache').upsert({ sleutel, antwoord, gemaakt: new Date().toISOString() });
}

async function ors(pad: string, body: unknown): Promise<any> {
  const r = await fetch(ORS + pad, {
    method: 'POST',
    headers: { Authorization: Deno.env.get('ORS_API_KEY') ?? '', 'Content-Type': 'application/json', Accept: 'application/json, application/geo+json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) {
    const tekst = await r.text().catch(() => '');
    throw Object.assign(new Error('ors ' + r.status + ' ' + tekst.slice(0, 200)), { status: r.status });
  }
  return r.json();
}

async function lijn(profiel: string, punten: Punt[]) {
  // Met instructions: false laat ORS de stukken (segments) weg; de stappen zelf gooien we weg.
  const j = await ors(`/v2/directions/${profiel}/geojson`, { coordinates: punten, instructions: true, geometry_simplify: true });
  const f = j.features?.[0];
  const segs = (f?.properties?.segments ?? []) as { distance: number; duration: number }[];
  return {
    afstand: Math.round(f?.properties?.summary?.distance ?? 0),
    duur: Math.round(f?.properties?.summary?.duration ?? 0),
    delen: segs.map((s) => ({ afstand: Math.round(s.distance ?? 0), duur: Math.round(s.duration ?? 0) })),
    // [lat,lng] voor Leaflet, op 5 decimalen
    lijn: ((f?.geometry?.coordinates ?? []) as Punt[]).map((c) => [Math.round(c[1] * 1e5) / 1e5, Math.round(c[0] * 1e5) / 1e5]),
  };
}

async function matrix(profiel: string, punten: Punt[]) {
  const j = await ors(`/v2/matrix/${profiel}`, { locations: punten, metrics: ['duration', 'distance'] });
  const r = (m: (number | null)[][]) => m.map((rij) => rij.map((x) => (x == null ? null : Math.round(x))));
  return { duur: r(j.durations ?? []), afstand: r(j.distances ?? []) };
}

type Stop = { id: string; plek: Punt; bezoek: number; vensters: [number, number][] };
async function optimaliseer(profiel: string, start: Punt, eind: Punt | null, vertrek: number, stops: Stop[]) {
  const ids = stops.map((s) => s.id);
  const j = await ors('/optimization', {
    jobs: stops.map((s, i) => ({
      id: i + 1, location: s.plek, service: s.bezoek,
      ...(s.vensters.length ? { time_windows: s.vensters } : {}),
    })),
    vehicles: [{ id: 1, profile: profiel, start, ...(eind ? { end: eind } : {}), time_window: [vertrek, 24 * 3600] }],
  });
  const stappen = (j.routes?.[0]?.steps ?? []) as { type: string; job?: number; arrival: number }[];
  const aankomst: Record<string, number> = {};
  const volgorde: string[] = [];
  for (const s of stappen) {
    if (s.type !== 'job' || !s.job) continue;
    volgorde.push(ids[s.job - 1]);
    aankomst[ids[s.job - 1]] = s.arrival;
  }
  const niet = ((j.unassigned ?? []) as { id: number }[]).map((u) => ids[u.id - 1]);
  return { volgorde, aankomst, niet };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ fout: 'alleen POST' }, 405);
  if (!Deno.env.get('ORS_API_KEY')) return json({ fout: 'geen-sleutel' }, 503);

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'onbekend';
  if (teVaak(ip)) return json({ fout: 'te-vaak' }, 429);

  let b: any;
  try { b = await req.json(); } catch { return json({ fout: 'geen JSON' }, 400); }
  const profiel = PROFIEL[b?.vervoer];
  if (!profiel) return json({ fout: 'vervoer' }, 400);

  try {
    if (b.actie === 'lijn' || b.actie === 'matrix') {
      const punten = Array.isArray(b.punten) ? b.punten : [];
      if (punten.length < 2 || punten.length > MAX_PUNTEN || !punten.every(geldigPunt)) return json({ fout: 'punten' }, 400);
      const p = punten.map(rond);
      const sleutel = await sleutelVan([b.actie, 2, profiel, p]);   // 2: lijn met stukken (segments)
      const oud = await uitCache(sleutel);
      if (oud) return json(oud);
      const uit = b.actie === 'lijn' ? await lijn(profiel, p) : await matrix(profiel, p);
      await inCache(sleutel, uit);
      return json(uit);
    }

    if (b.actie === 'optimaliseer') {
      const stops: Stop[] = (Array.isArray(b.stops) ? b.stops : []).slice(0, MAX_PUNTEN - 2).map((s: any) => ({
        id: String(s?.id ?? '').slice(0, 60),
        plek: s?.plek,
        bezoek: Math.max(0, Math.min(6 * 3600, Math.round(Number(s?.bezoek) || 0))),
        vensters: (Array.isArray(s?.vensters) ? s.vensters : [])
          .filter((v: any) => Array.isArray(v) && v.length === 2 && v.every((x: any) => Number.isFinite(x)) && v[0] < v[1])
          .slice(0, 4).map((v: number[]) => [Math.max(0, Math.round(v[0])), Math.min(48 * 3600, Math.round(v[1]))]),
      }));
      if (stops.length < 2 || stops.some((s) => !s.id || !geldigPunt(s.plek)) || !geldigPunt(b.start) || (b.eind != null && !geldigPunt(b.eind)))
        return json({ fout: 'stops' }, 400);
      const vertrek = Math.max(0, Math.min(23 * 3600, Math.round(Number(b.vertrek) || 9 * 3600)));
      const invoer = { profiel, start: rond(b.start), eind: b.eind ? rond(b.eind) : null, vertrek,
        stops: stops.map((s) => ({ ...s, plek: rond(s.plek) })) };
      const sleutel = await sleutelVan(['opt', invoer]);
      const oud = await uitCache(sleutel);
      if (oud) return json(oud);
      const uit = await optimaliseer(profiel, invoer.start, invoer.eind, vertrek, invoer.stops);
      await inCache(sleutel, uit);
      return json(uit);
    }

    return json({ fout: 'actie' }, 400);
  } catch (e) {
    const status = (e as { status?: number }).status;
    console.error('route-plan', (e as Error).message);
    // ORS-limiet of storing: de site valt dan terug op de schatting.
    return json({ fout: status === 429 ? 'limiet' : 'routedienst' }, status === 429 ? 429 : 502);
  }
});
