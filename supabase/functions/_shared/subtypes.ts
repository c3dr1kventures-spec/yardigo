// Soort + subcategorie van een verkoop, gedeeld door telegram-bot,
// discover-events, import-meukisleuk en publish.
//
// Drie soorten (kleur op de kaart):
//   opritverkoop             → amber, particulier (adres pas 24u vooraf)
//   rommelroute/buurtverkoop → oranje
//   markten (alle overige)   → groen, met subcategorie hieronder
// Moet gelijk lopen met YG_SUBTYPES in index.html.

export const MARKT_SUBTYPES = [
  'rommelmarkt', 'vlooienmarkt', 'snuffelmarkt', 'jaarmarkt', 'kofferbak', 'boekenmarkt',
  'antiekmarkt', 'kerstmarkt', 'braderie', 'kinderbeurs', 'kledingmarkt',
];
export const SUBTYPES = new Set([...MARKT_SUBTYPES, 'opritverkoop', 'rommelroute', 'buurtverkoop', 'overig']);

// Uitleg voor AI-prompts.
export const SUBCATEGORIE_UITLEG =
  'subcategorie (alleen bij een markt, anders null): één van ' + MARKT_SUBTYPES.join(', ') +
  '. snuffelmarkt/vlooienmarkt/jaarmarkt alleen als de bron dat woord gebruikt; ' +
  'kinderbeurs = kinderkleding-/speelgoedbeurs; kledingmarkt = (tweedehands) kledingbeurs/-markt; ' +
  'kofferbak = kofferbakverkoop/carboot. Een gemengde markt (bv. "rommel- en antiekmarkt") = de eerstgenoemde soort.';

const ALIASES: Record<string, string> = {
  garagesale: 'opritverkoop', garageverkoop: 'opritverkoop', tuinverkoop: 'opritverkoop',
  'garage sale': 'opritverkoop', kofferbakverkoop: 'kofferbak', carboot: 'kofferbak',
  vlooienmarkt: 'vlooienmarkt', brocante: 'vlooienmarkt', kledingbeurs: 'kledingmarkt',
  speelgoedbeurs: 'kinderbeurs', 'kinderkledingbeurs': 'kinderbeurs', rommelbeurs: 'rommelmarkt',
};

// Herkenbare soort in de titel. Alleen gebruikt als de titel er precies één
// noemt (bij "Rommel- en kerstmarkt" laten we het AI-oordeel staan).
const TITEL_REGELS: [RegExp, string][] = [
  [/snuffel/i, 'snuffelmarkt'],
  [/kerst(vlooien)?markt|kerstfair/i, 'kerstmarkt'],
  [/boekenmarkt|boekenbeurs/i, 'boekenmarkt'],
  [/braderie/i, 'braderie'],
  [/kofferbak/i, 'kofferbak'],
  [/antiekmarkt|antiek- en curiosa|antiekbeurs/i, 'antiekmarkt'],
  [/jaarmarkt/i, 'jaarmarkt'],
  [/kinder(kleding|speelgoed)?beurs|speelgoedbeurs|kinderrommelmarkt/i, 'kinderbeurs'],
  [/kleding(beurs|markt)/i, 'kledingmarkt'],
];
const ALGEMEEN = /rommel|vlooien|markt en |en markt/i;

// Bepaalt het uiteindelijke subtype uit wat de AI gaf (event_type en evt.
// subcategorie) plus de titel.
export function bepaalSubtype(eventType: string | null | undefined, subcategorie: string | null | undefined, titel: string | null | undefined): string {
  const norm = (v: string | null | undefined) => {
    const k = (v || '').trim().toLowerCase();
    return ALIASES[k] || k;
  };
  const t = titel || '';
  let st = norm(eventType);
  const sub = norm(subcategorie);

  // Titel wint bij duidelijke particuliere verkoop of route.
  if (/rommelroute/i.test(t) && st !== 'opritverkoop') return 'rommelroute';
  if (st === 'opritverkoop' || st === 'rommelroute' || st === 'buurtverkoop') return st;
  if (/opritverkoop|garage ?sale|tuinverkoop/i.test(t) && (!st || st === 'overig')) return 'opritverkoop';

  // Markt: subcategorie van de AI, anders wat er al stond.
  if (MARKT_SUBTYPES.includes(sub)) st = sub;
  if (!SUBTYPES.has(st)) st = 'overig';

  // Algemene of onduidelijke soort → kijk naar de titel.
  if (['overig', 'rommelmarkt', 'vlooienmarkt'].includes(st)) {
    const treffers = [...new Set(TITEL_REGELS.filter(([re]) => re.test(t)).map(([, v]) => v))];
    if (treffers.length === 1 && !(ALGEMEEN.test(t) && st !== 'overig')) return treffers[0];
    if (st === 'overig' && /rommel|brocante/i.test(t)) return 'rommelmarkt';
    if (st === 'overig' && /vlooien/i.test(t)) return 'vlooienmarkt';
  }
  return st;
}

export const isParticulierSubtype = (st: string | null | undefined) =>
  ['opritverkoop', 'garagesale', 'garageverkoop', 'tuinverkoop'].includes((st || '').toLowerCase());
