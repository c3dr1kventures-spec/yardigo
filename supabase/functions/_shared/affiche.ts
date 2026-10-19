// YardiGo – affiche van de organisator zelf vinden en bewaren.
//
// Besluit Christian (19 okt 2026): een affiche/flyer mag als foto bij de
// listing, want die maakt de organisator om te verspreiden. Maar alleen van
// de website van de organisator zelf (nooit van een verzamelsite), alleen als
// robots.txt dat toestaat, en alleen als de AI bevestigt dat het de affiche
// van DIT event is (zelfde datum en plaats). Een logo, sfeerfoto of de
// affiche van vorig jaar telt niet. De afbeelding gaat naar onze eigen
// storage, zodat we niet hotlinken.

const UA = 'Mozilla/5.0 (compatible; YardiGoDiscover/1.0; +https://www.yardigo.nl)';
const MAX_BYTES = 4_500_000;
const MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function hex(n: number): string {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Eenvoudige robots.txt-check: alleen de groep voor '*' en Disallow-prefixen.
const robotsCache = new Map<string, string[]>();
export async function robotsToegestaan(url: string): Promise<boolean> {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (!robotsCache.has(u.origin)) {
    let regels: string[] = [];
    try {
      const r = await fetch(u.origin + '/robots.txt', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        let inGroep = false;
        for (const raw of (await r.text()).split('\n')) {
          const l = raw.split('#')[0].trim();
          const m = l.match(/^([a-z-]+)\s*:\s*(.*)$/i);
          if (!m) continue;
          const [k, v] = [m[1].toLowerCase(), m[2].trim()];
          if (k === 'user-agent') inGroep = v === '*';
          else if (k === 'disallow' && inGroep && v) regels.push(v);
        }
      }
    } catch { regels = []; }
    robotsCache.set(u.origin, regels);
  }
  return !robotsCache.get(u.origin)!.some((p) => u.pathname.startsWith(p.replace(/\*.*$/, '')));
}

// Kandidaat-afbeeldingen op een organisatorpagina: og:image plus <img>'s
// waarvan de bestandsnaam of alt-tekst op een affiche wijst.
function kandidaten(html: string, base: string): string[] {
  const out: string[] = [];
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (og) out.push(og[1]);
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = tag.match(/\b(?:data-src|src)=["']([^"']+)["']/i)?.[1];
    const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1] || '';
    if (src && /affiche|poster|flyer|aankondiging/i.test(src + ' ' + alt)) out.push(src);
  }
  const abs = out.map((s) => { try { return new URL(s, base).toString(); } catch { return ''; } })
    .filter((s) => s && !/\.svg(\?|$)/i.test(s) && !/logo|icon|favicon/i.test(s));
  return [...new Set(abs)].slice(0, 3);
}

async function haalAfbeelding(url: string): Promise<{ data: string; media_type: string; bin: Uint8Array } | null> {
  if (!(await robotsToegestaan(url))) return null;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!r.ok || !MEDIA.has(type)) return null;
    const bin = new Uint8Array(await r.arrayBuffer());
    if (bin.length < 15_000 || bin.length > MAX_BYTES) return null;      // icoontjes en te grote bestanden niet
    let s = '';
    for (let i = 0; i < bin.length; i += 0x8000) s += String.fromCharCode(...bin.subarray(i, i + 0x8000));
    return { data: btoa(s), media_type: type, bin };
  } catch { return null; }
}

async function isAfficheVanEvent(key: string, img: { data: string; media_type: string },
  ev: { titel: string; datum: string; plaats: string | null }): Promise<boolean> {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-5-5', max_tokens: 100,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } },
          { type: 'text', text: `Is dit de affiche of flyer van dit evenement: "${ev.titel}" op ${ev.datum}${ev.plaats ? ' in ' + ev.plaats : ''}? ` +
            'Alleen true als het een affiche/flyer met tekst is EN de datum (dag en maand) overeenkomt. Een logo, foto, sfeerbeeld of een affiche van een andere datum is false. ' +
            'Antwoord alleen met JSON: {"affiche": true|false}' },
        ] }],
      }),
    });
    if (!r.ok) return false;
    const j = await r.json();
    const txt = (j?.content || []).map((b: any) => b?.text || '').join('');
    return /"affiche"\s*:\s*true/.test(txt);
  } catch { return false; }
}

// Zoek op de pagina van de organisator naar de affiche van dit event.
// Geeft de publieke URL in onze storage terug, of null.
export async function zoekAffiche(sb: any, key: string, pagina: string,
  ev: { titel: string; datum: string; plaats: string | null }, map = 'import'): Promise<string | null> {
  if (/facebook\.com|instagram\.com/i.test(pagina)) return null;       // vereist login/JS
  if (!(await robotsToegestaan(pagina))) return null;
  let html = '';
  try {
    const r = await fetch(pagina, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    html = await r.text();
  } catch { return null; }
  for (const url of kandidaten(html, pagina)) {
    const img = await haalAfbeelding(url);
    if (!img || !(await isAfficheVanEvent(key, img, ev))) continue;
    const ext = img.media_type.split('/')[1].replace('jpeg', 'jpg');
    const path = `${map}/${new Date().toISOString().slice(0, 10)}/${hex(8)}.${ext}`;
    const up = await sb.storage.from('listings').upload(path, img.bin, { contentType: img.media_type, upsert: false });
    if (up.error) return null;
    return sb.storage.from('listings').getPublicUrl(path).data.publicUrl;
  }
  return null;
}
