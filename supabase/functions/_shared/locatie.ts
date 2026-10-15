// YardiGo – ligt de pin echt in de opgegeven plaats?
//
// Geocoders geven bij twijfel zomaar een gelijknamige straat elders terug
// (PDOK kent alleen NL: "Kerkplein, Beerse" werd het Kerkplein in Deurne).
// Daarom elke plek toetsen aan de plaatsnaam, met een eigen referentielijst
// in de database (public.plaatsen, GeoNames; geladen door laad-plaatsen) en
// de SQL-functie plek_toets. Geen externe dienst nodig, dus geen storingen
// of limieten (Nominatim blokkeert de Supabase-servers, Photon is traag).
//
// Gebruikt bij publiceren (_shared/publish.ts), bij het geocoderen in de
// importroutes, en door de uurlijkse controle (telegram-bot ?action=locaties).

export interface Plek { lat: number; lng: number }
export interface Toets {
  status: 'ok' | 'afwijkend' | 'onbekend' | 'storing';
  km: number | null;
  kandidaten: number;        // aantal plaatsen met deze naam
  centrum: Plek | null;      // grootste plaats met deze naam
  eenduidig: boolean;        // alle plaatsen met deze naam liggen bij elkaar
}

export function norm(x: unknown): string {
  return String(x ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
}

// Varianten van een plaatsnaam om te proberen, in volgorde:
// "'s-Gravenhage" → Den Haag; "B 2390 Malle (Oostmalle)" → "Malle", "Oostmalle";
// "Rosekapellewijk, Borsbeek" → beide delen; "Schiedam noord" → "Schiedam".
const ALIAS: Record<string, string> = { sgravenhage: 'Den Haag', thehague: 'Den Haag', sgravenzande: "'s-Gravenzande" };
function plaatsVarianten(plaats: string): string[] {
  const binnenHaakjes = [...plaats.matchAll(/\((.*?)\)/g)].map(m => m[1].trim());
  const schoon = plaats.replace(/\(.*?\)/g, ' ')
    .replace(/\b(?:[A-Za-z]{1,2}[- ]?)?\d{4}(?:\s?[A-Za-z]{2})?\b/g, ' ')   // postcodes, ook "B-2390" en "1234 AB"
    .replace(/\s+/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '').trim();
  const delen = schoon.split(',').map(d => d.trim()).filter(d => d.length > 1);
  const eersteWoord = schoon.includes(' ') ? schoon.split(/[ ,]+/)[0] : '';
  const alias = ALIAS[norm(plaats)] || ALIAS[norm(schoon)];
  return [...new Set([alias, schoon, ...delen, ...binnenHaakjes, eersteWoord].filter(v => v && v.length > 1))].slice(0, 5) as string[];
}

export async function toetsPlek(sb: any, p: Plek | null, plaats: string | null): Promise<Toets> {
  const leeg: Toets = { status: 'onbekend', km: null, kandidaten: 0, centrum: null, eenduidig: false };
  if (!plaats) return leeg;
  const v = plaatsVarianten(plaats).map(norm).filter(n => n.length >= 2);
  if (!v.length) return leeg;
  const r = await sb.rpc('plek_toets', { p_lat: p?.lat ?? null, p_lng: p?.lng ?? null, p_varianten: v });
  if (r.error) { console.log('plek_toets', r.error.message); return { ...leeg, status: 'storing' }; }
  const x = r.data?.[0];
  if (!x) return leeg;
  return {
    status: x.kandidaten ? (p ? x.status : 'onbekend') : 'onbekend',
    km: x.km, kandidaten: x.kandidaten, eenduidig: !!x.eenduidig,
    centrum: x.beste_lat != null ? { lat: x.beste_lat, lng: x.beste_lng } : null,
  };
}

// PDOK (alleen NL): exacte adressen.
async function pdok(q: string): Promise<Plek | null> {
  try {
    const r = await fetch('https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?rows=1&fl=centroide_ll&fq=type:(adres+woonplaats+weg)&q=' + encodeURIComponent(q),
      { signal: AbortSignal.timeout(6000) });
    const c = (await r.json())?.response?.docs?.[0]?.centroide_ll;
    const m = typeof c === 'string' ? c.match(/POINT\(([-\d.]+)\s+([-\d.]+)\)/) : null;
    return m ? { lng: parseFloat(m[1]), lat: parseFloat(m[2]) } : null;
  } catch { return null; }
}

// Zoek een plek die gegarandeerd bij de plaats past: eerst het exacte adres
// (alleen als dat in de plaats ligt), anders het centrum van de plaats als die
// naam maar op één plek voorkomt (bij_benadering), anders null.
export async function veiligeGeocode(sb: any, adres: string | null, plaats: string | null): Promise<(Plek & { bij_benadering: boolean }) | null> {
  if (!plaats) return null;
  if (adres && norm(adres) !== norm(plaats)) {
    const a = await pdok(`${adres}, ${plaats}`);
    if (a && (await toetsPlek(sb, a, plaats)).status === 'ok') return { ...a, bij_benadering: false };
  }
  const t = await toetsPlek(sb, null, plaats);
  return t.eenduidig && t.centrum ? { ...t.centrum, bij_benadering: true } : null;
}

// Na een gewone geocode: klopt de plek, houden; anders veilig opnieuw zoeken.
// Alleen een exact adres telt; een plaatscentrum als gok gebruiken we hier
// niet (dan liever geen pin, zodat er een mens naar kijkt).
export async function borgPlek(sb: any, geo: Plek | null, adres: string | null, plaats: string | null): Promise<Plek | null> {
  if (!geo || !plaats) return geo;
  const t = await toetsPlek(sb, geo, plaats);
  if (t.status !== 'afwijkend') return geo;
  console.log('borgPlek: afwijkend', plaats, t.km, 'km');
  const v = await veiligeGeocode(sb, adres, plaats);
  return v && !v.bij_benadering ? { lat: v.lat, lng: v.lng } : null;
}
