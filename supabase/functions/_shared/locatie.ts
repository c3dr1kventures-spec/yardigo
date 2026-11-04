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
  // Duitse stadsdelen: "Meerbusch-Strümp" → "Meerbusch", "Strümp".
  const streepDelen = delen.length === 1 && /\p{L}-\p{L}/u.test(schoon) && !/^'s-/i.test(schoon)
    ? schoon.split('-').map(d => d.trim()).filter(d => d.length >= 4) : [];
  const alias = ALIAS[norm(plaats)] || ALIAS[norm(schoon)];
  return [...new Set([alias, schoon, ...delen, ...binnenHaakjes, eersteWoord, ...streepDelen].filter(v => v && v.length > 1))].slice(0, 6) as string[];
}

export async function toetsPlek(sb: any, p: Plek | null, plaats: string | null): Promise<Toets> {
  const leeg: Toets = { status: 'onbekend', km: null, kandidaten: 0, centrum: null, eenduidig: false };
  if (!plaats) return leeg;
  const v = plaatsVarianten(plaats).map(norm).filter(n => n.length >= 2);
  if (!v.length) return leeg;
  const r = await sb.rpc('plek_toets', { p_lat: p?.lat ?? null, p_lng: p?.lng ?? null, p_varianten: v });
  if (r.error) { console.log('plek_toets', r.error.message); return { ...leeg, status: 'storing' }; }
  const x = r.data?.[0];
  // Naam staat niet in de lijst (bv. Frankrijk): vraag de kaart in welke
  // plaats de pin ligt en vergelijk de namen.
  if (!x?.kandidaten && p && await pinInPlaats(p, v)) return { ...leeg, status: 'ok', km: 0 };
  if (!x) return leeg;
  return {
    status: x.kandidaten ? (p ? x.status : 'onbekend') : 'onbekend',
    km: x.km, kandidaten: x.kandidaten, eenduidig: !!x.eenduidig,
    centrum: x.beste_lat != null ? { lat: x.beste_lat, lng: x.beste_lng } : null,
  };
}

async function pinInPlaats(p: Plek, varianten: string[]): Promise<boolean> {
  try {
    const r = await fetch(`https://photon.komoot.io/reverse?limit=1&lat=${p.lat}&lon=${p.lng}`,
      { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'YardiGo/1.0 (https://www.yardigo.nl)' } });
    const x = (await r.json())?.features?.[0]?.properties || {};
    const namen = [x.city, x.district, x.locality, x.town, x.village, x.name].filter(Boolean).map(norm);
    return varianten.some(v => namen.includes(v));
  } catch { return false; }
}

// PDOK (alleen NL): exacte adressen.
async function pdok(q: string): Promise<Plek | null> {
  try {
    const r = await fetch('https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?rows=1&fl=centroide_ll&fq=type:(adres+woonplaats+weg)&q=' + encodeURIComponent(q),
      { signal: AbortSignal.timeout(5000) });
    const c = (await r.json())?.response?.docs?.[0]?.centroide_ll;
    const m = typeof c === 'string' ? c.match(/POINT\(([-\d.]+)\s+([-\d.]+)\)/) : null;
    return m ? { lng: parseFloat(m[1]), lat: parseFloat(m[2]) } : null;
  } catch { return null; }
}

// Geopunt (alleen Vlaanderen): exacte adressen uit het adressenregister.
// Kan niet tegen haakjes ("Leuven (Heverlee)"), die halen we eruit.
export async function vlaanderen(q: string): Promise<Plek | null> {
  try {
    const r = await fetch('https://geo.api.vlaanderen.be/geolocation/v4/Location?c=1&q=' + encodeURIComponent(q.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ')),
      { signal: AbortSignal.timeout(6000) });
    const l = (await r.json())?.LocationResult?.[0]?.Location;
    return l?.Lat_WGS84 ? { lat: l.Lat_WGS84, lng: l.Lon_WGS84 } : null;
  } catch { return null; }
}

// Photon (OpenStreetMap, heel Europa): vangnet voor Wallonië, Brussel en
// Duitsland. Trager, dus als laatste.
// Met land: alleen treffers in dat land.
export async function photon(q: string, land?: string | null): Promise<Plek | null> {
  try {
    const r = await fetch('https://photon.komoot.io/api/?limit=5&q=' + encodeURIComponent(q.replace(/[()]/g, ' ')),
      { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'YardiGo/1.0 (https://www.yardigo.nl)' } });
    const landen = land ? [land] : ['NL', 'BE', 'DE', 'LU'];
    const f = ((await r.json())?.features || []).find((x: any) => landen.includes(x?.properties?.countrycode));
    const c = f?.geometry?.coordinates;
    return c ? { lng: c[0], lat: c[1] } : null;
  } catch { return null; }
}

// Een plek zoeken voor een affiche of bericht, met het land dat de AI las.
// PDOK kent alleen NL en Geopunt alleen Vlaanderen; beide geven bij een
// Duitse plaats toch iets terug ("Hamm" wordt het Belgische Hamme), dus per
// land alleen de diensten die daar iets weten. Een treffer telt pas als hij
// in de plaats ligt, anders de volgende dienst. Postcode gaat mee in de
// zoekvraag: "59063 Hamm" is Hamm in Westfalen, "57577 Hamm" die aan de Sieg.
// geschat = alleen de plaats gevonden, en die naam bestaat op meer plekken.
export async function zoekPlek(sb: any, adres: string | null, plaats: string | null,
  land?: string | null, postcode?: string | null): Promise<(Plek & { geschat: boolean }) | null> {
  const pc = postcode && !`${adres ?? ''} ${plaats ?? ''}`.replace(/\s/g, '').includes(postcode.replace(/\s/g, '')) ? postcode : null;
  const plaatsQ = [pc, plaats].filter(Boolean).join(' ');
  const diensten: Array<(q: string) => Promise<Plek | null>> =
    land === 'NL' ? [pdok, q => photon(q, 'NL')]
    : land === 'BE' ? [vlaanderen, q => photon(q, 'BE')]
    : land ? [q => photon(q, land)]
    : [pdok, vlaanderen, q => photon(q)];
  const vragen = [...new Set([[adres, plaatsQ].filter(Boolean).join(', '), plaatsQ].filter(Boolean))];
  for (const q of vragen) {
    const alleenPlaats = q === plaatsQ;
    for (const dienst of diensten) {
      const p = await dienst(q);
      if (!p) continue;
      if (!plaats) return { ...p, geschat: false };
      const t = await toetsPlek(sb, p, plaats);
      if (t.status === 'afwijkend') continue;
      return { ...p, geschat: alleenPlaats && !pc && t.kandidaten > 1 && !t.eenduidig };
    }
  }
  return null;
}

// Zoek een plek die gegarandeerd bij de plaats past: eerst het exacte adres
// (alleen als dat in de plaats ligt), anders het centrum van de plaats als die
// naam maar op één plek voorkomt (bij_benadering), anders null.
export async function veiligeGeocode(sb: any, adres: string | null, plaats: string | null): Promise<(Plek & { bij_benadering: boolean }) | null> {
  if (!plaats) return null;
  if (adres && norm(adres) !== norm(plaats)) {
    for (const zoek of [pdok, vlaanderen, photon]) {
      const a = await zoek(`${adres}, ${plaats}`);
      if (a && (await toetsPlek(sb, a, plaats)).status === 'ok') return { ...a, bij_benadering: false };
    }
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
