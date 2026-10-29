// YardiGo – advies per wachtrij-item (telegram-bot: kaartjes en mini-app)
//
// Eén advies per item, zodat de admin niet elk kaartje hoeft uit te pluizen:
//   afwijzen     staat al live (dubbel), of lijkt een winkel / geen tweedehandsmarkt
//   toestemming  particuliere verkoop: eerst vragen
//   controleren  twijfel: mogelijk dubbel, type of soort verkoper onduidelijk,
//                bron spreekt zichzelf tegen, of een bron die je vaak afwees
//   aanvullen    alles goed, maar er mist nog iets (meestal contact)
//   plaatsen     compleet en geen twijfel
// Regels, geen AI-call: snel, gratis en uitlegbaar. De context (live
// advertenties op dezelfde dag en plaats, goedkeur-cijfers per bron) komt uit
// pending_advies_context() (pending-advies.sql).

export type AdviesK = 'plaatsen' | 'toestemming' | 'aanvullen' | 'controleren' | 'afwijzen';
export interface Advies {
  k: AdviesK;
  kop: string;           // korte zin: wat te doen
  waarom: string[];      // redenen en achtergrond, belangrijkste eerst
  dubbel?: { listing_id: string; title: string; zeker: boolean };
  zonderContact?: boolean;   // mist alleen contact, maar de bron is betrouwbaar: zonder plaatsen is verantwoord
  bron?: { naam: string; ok: number; weg: number };
}
export interface AdviesContext {
  kandidaten: { pending_id: number; listing_id: string; title: string; city: string; m: number | null }[];
  bronnen: Record<string, { ok: number; weg: number }>;
}

export async function adviesContext(sb: any, ids: number[]): Promise<AdviesContext> {
  const leeg = { kandidaten: [], bronnen: {} };
  if (!ids.length) return leeg;
  const r = await sb.rpc('pending_advies_context', { p_ids: ids });
  if (r.error) { console.warn('advies context', r.error.message); return leeg; }
  return r.data ?? leeg;
}

// Zelfde indeling als pending_bron_sleutel() in de database.
export function bronSleutel(q: string | null): string {
  if (!q) return 'onbekend';
  return q.includes(':') || q === 'telegram' || q === 'website-tip' ? q : 'zoekopdracht';
}
function bronNaam(k: string): string {
  if (k === 'telegram') return 'zelf gedeeld';
  if (k === 'website-tip') return 'tips via de website';
  if (k === 'zoekopdracht') return 'webzoektocht';
  return k.replace(/^bron:/, '').replace(':', ' · ');
}

// Woorden die in bijna elke titel staan zeggen niets over "zelfde event".
const ALGEMEEN = new Set([
  'markt', 'rommelmarkt', 'vlooienmarkt', 'snuffelmarkt', 'brocante', 'brocantemarkt', 'kofferbakmarkt', 'kofferbakverkoop',
  'garage', 'sale', 'garagesale', 'garageverkoop', 'verkoop', 'tuinverkoop', 'opritverkoop', 'buurtverkoop', 'rommelroute',
  'grote', 'mega', 'jaarlijkse', 'gezellige', 'flohmarkt', 'vide', 'grenier', 'braderie', 'antiek', 'antiekmarkt', 'curiosa',
  'tweedehands', 'vintage', 'boekenmarkt', 'kledingmarkt', 'kinderbeurs', 'beurs', 'kerstmarkt', 'hallen', 'hal',
  'de', 'het', 'een', 'en', 'in', 'op', 'van', 'te', 'met', 'voor', 'bij', 'aan', 'the', 'la', 'le', 'les', 'du', 'des',
  'et', 'am', 'im', 'der', 'die', 'das', 'und', 'belgie', 'nederland',
]);
function woorden(s: string | null, plaats: string | null): Set<string> {
  const norm = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const weg = new Set(norm(plaats || '').split(/[^a-z0-9]+/));
  return new Set(norm(s || '').split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !weg.has(w)));
}

function dubbelVoor(p: any, ctx?: AdviesContext): Advies['dubbel'] | null {
  let best: { listing_id: string; title: string; zeker: boolean; score: number } | null = null;
  for (const k of ctx?.kandidaten || []) {
    if (k.pending_id !== p.id) continue;
    const a = woorden(p.title, p.city), b = woorden(k.title, k.city);
    const gedeeld = [...a].filter(w => b.has(w));
    const eigen = gedeeld.filter(w => !ALGEMEEN.has(w)).length;
    const dichtbij = k.m != null && k.m <= 300;
    if (!gedeeld.length && !dichtbij && (k.m == null || k.m > 1000)) continue;
    // "Mega Vlooienmarkt Goes" ⊂ "Mega vlooienmarkt Zeelandhallen Goes": ook zonder eigen woord dezelfde.
    const binnen = Math.min(a.size, b.size) >= 2 && gedeeld.length === Math.min(a.size, b.size);
    const zeker = eigen > 0 || dichtbij || binnen;
    const score = (zeker ? 100 : 0) + gedeeld.length;
    if (!best || score > best.score) best = { listing_id: k.listing_id, title: k.title, zeker, score };
  }
  return best ? { listing_id: best.listing_id, title: best.title, zeker: best.zeker } : null;
}

const kortOntbreekt = (o: string[]) => o.map(x => x.split(' (')[0]
  .replace('locatie op de kaart', 'locatie').replace('contactweg', 'contact').replace('datum in de toekomst', 'datum')).join(', ');

export function advies(p: any, ontbreekt: string[], ctx?: AdviesContext): Advies {
  const redenen: string[] = p.auto_check?.redenen || [];
  const heeft = (r: string) => redenen.includes(r);
  const waarom: string[] = [];

  const sleutel = bronSleutel(p.discovered_via_query);
  const s = ctx?.bronnen?.[sleutel];
  const bron = s ? { naam: bronNaam(sleutel), ok: s.ok, weg: s.weg } : undefined;
  const n = bron ? bron.ok + bron.weg : 0;
  const pct = n ? Math.round((bron!.ok / n) * 100) : null;
  const bronRegel = bron && n >= 5 ? `Bron ${bron.naam}: ${bron.ok} van ${n} eerder goedgekeurd (${pct}%)` : null;
  const betrouwbaar = pct != null && n >= 20 && pct >= 85;
  const wankel = pct != null && n >= 10 && pct < 60;

  const dagen = p.date_start ? Math.round((Date.parse(p.date_start) - Date.now()) / 86400000) : null;
  const extra = () => {
    if (bronRegel) waarom.push(bronRegel);
    if (dagen != null && dagen > 120) waarom.push(`Ver vooruit: over ${dagen} dagen`);
  };
  const uit = (k: AdviesK, kop: string, dubbel?: Advies['dubbel']): Advies => { extra(); return { k, kop, waarom, dubbel: dubbel || undefined, bron }; };

  const dubbel = dubbelVoor(p, ctx);
  if (dubbel?.zeker) {
    waarom.push(`Zelfde dag en plaats: "${dubbel.title}" staat al op de kaart`);
    return uit('afwijzen', 'Afwijzen: staat al live', dubbel);
  }
  if (heeft('past niet bij YardiGo')) {
    waarom.push('De AI denkt: een winkel of geen tweedehandsmarkt');
    if (wankel) waarom.push(`Uit deze bron wees je vaker af`);
    return uit('afwijzen', 'Afwijzen: past niet bij YardiGo');
  }
  if (p.status === 'tip' || p.is_private_seller === true) {
    waarom.push('Verkoop bij iemand thuis: eerst toestemming, het adres blijft tot de dag ervoor verborgen');
    if (ontbreekt.length) waarom.push('Daarna nog aanvullen: ' + kortOntbreekt(ontbreekt));
    return uit('toestemming', 'Vraag toestemming, dan plaatsen');
  }
  const twijfel: string[] = [];
  if (dubbel) twijfel.push(`Op dezelfde dag staat in ${p.city || 'de buurt'} al "${dubbel.title}". Zelfde markt?`);
  if (heeft('bron spreekt zichzelf tegen')) twijfel.push('De bron spreekt zichzelf tegen (datum of plaats)');
  if (heeft('type onduidelijk')) twijfel.push('Soort verkoop onduidelijk');
  if (heeft('onbekend of particulier')) twijfel.push('Particulier of organisator? Onbekend');
  if (heeft('plaats onbekend (buiten NL/BE/DE?)')) twijfel.push('Plaats niet gevonden, mogelijk buiten ons gebied');
  if (wankel) twijfel.push(`Uit deze bron keurde je maar ${pct}% goed`);
  if (twijfel.length) {
    waarom.push(...twijfel);
    if (ontbreekt.length) waarom.push('Mist ook: ' + kortOntbreekt(ontbreekt));
    return uit('controleren', 'Even controleren', dubbel || undefined);
  }
  if (ontbreekt.length) {
    const alleenContact = ontbreekt.length === 1 && ontbreekt[0].startsWith('contact');
    waarom.push('Mist: ' + kortOntbreekt(ontbreekt));
    if (alleenContact && betrouwbaar) waarom.push('Betrouwbare bron: zonder contact plaatsen kan ook');
    else if (alleenContact) waarom.push('Zoek de website of Facebook-pagina van de organisator');
    const a = uit('aanvullen', alleenContact && betrouwbaar ? 'Aanvullen of zonder contact plaatsen' : 'Eerst aanvullen');
    if (alleenContact && betrouwbaar) a.zonderContact = true;
    return a;
  }
  waarom.push('Compleet, geen twijfelpunten');
  return uit('plaatsen', 'Plaatsen');
}

const ICOON: Record<AdviesK, string> = { plaatsen: '✅', toestemming: '🏠', aanvullen: '✏️', controleren: '🤔', afwijzen: '🗑' };
export function adviesIcoon(k: AdviesK): string { return ICOON[k]; }
