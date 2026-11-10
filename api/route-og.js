// YardiGo — /api/route-og  (Vercel Edge runtime, @vercel/og)
//
// 1200x630 PNG voor de voorvertoning van een gedeelde route (zie api/route-deel.js):
// links de naam, de dag en de stops, rechts een kaartje met de stops als
// genummerde punten in volgorde. Geen kaarttegels (geen externe verzoeken, en
// de punten blijven grof: garagesales staan in de link al op ~1 km).
// ?code=<deelcode> of ?stops=<deellink>.

import { ImageResponse } from '@vercel/og';
import { leesRoute, routeDag, datumKort, routeTitel } from './_route.js';

export const config = { runtime: 'edge' };

function h(type, props, ...kids) {
  const children = kids.flat().filter((k) => k !== null && k !== undefined && k !== false && k !== '');
  return { type, props: { ...(props || {}), children: children.length === 1 ? children[0] : children } };
}

const C = { forest: '#3A6B4A', forestDark: '#2A5038', terra: '#E07B39', ink: '#1E2922', muted: '#55625A', land: '#E6EDE2', tint: '#F3F6F1', line: '#D3DACF' };
const VERVOER = { auto: 'Met de auto', fiets: 'Op de fiets', lopen: 'Te voet' };
const SOORT = { oprit: 'Garagesale', route: 'Rommelroute', markt: 'Markt', winkel: 'Kringloopwinkel' };
const kort = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

// Stops naar pixels in een vak van b×h (hoekgetrouw genoeg voor een dagroute).
function projecteer(stops, b, hoog, rand) {
  const midLat = stops.reduce((a, s) => a + s.lat, 0) / stops.length;
  const k = Math.cos((midLat * Math.PI) / 180);
  const xs = stops.map((s) => s.lng * k), ys = stops.map((s) => -s.lat);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const bw = Math.max(maxX - minX, 0.02), bh = Math.max(maxY - minY, 0.02);
  const schaal = Math.min((b - 2 * rand) / bw, (hoog - 2 * rand) / bh);
  const ox = (b - (maxX - minX) * schaal) / 2, oy = (hoog - (maxY - minY) * schaal) / 2;
  return stops.map((s, i) => ({ x: ox + (xs[i] - minX) * schaal, y: oy + (ys[i] - minY) * schaal }));
}

function kaart(stops, B, H) {
  const p = projecteer(stops, B, H, 56);
  const lijn = p.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ');
  const r = stops.length > 12 ? 15 : 21;
  // Wat 'land' in de achtergrond: een paar zachte vlakken en wegen.
  const decor = h('svg', { width: B, height: H, viewBox: `0 0 ${B} ${H}`, style: { position: 'absolute', left: 0, top: 0 } },
    h('path', { d: `M0 ${H * 0.72} C ${B * 0.25} ${H * 0.6}, ${B * 0.45} ${H * 0.9}, ${B} ${H * 0.7}`, stroke: '#FFFFFF', strokeWidth: 10, fill: 'none', opacity: 0.8 }),
    h('path', { d: `M${B * 0.3} 0 C ${B * 0.38} ${H * 0.3}, ${B * 0.2} ${H * 0.6}, ${B * 0.35} ${H}`, stroke: '#FFFFFF', strokeWidth: 7, fill: 'none', opacity: 0.7 }),
    h('path', { d: `M${B} ${H * 0.18} C ${B * 0.7} ${H * 0.25}, ${B * 0.6} ${H * 0.1}, ${B * 0.45} 0`, stroke: '#FFFFFF', strokeWidth: 6, fill: 'none', opacity: 0.6 }),
    h('circle', { cx: B * 0.82, cy: H * 0.82, r: 70, fill: '#D5E3D0', opacity: 0.7 }),
    h('circle', { cx: B * 0.12, cy: H * 0.2, r: 50, fill: '#D5E3D0', opacity: 0.6 }),
    stops.length > 1 ? h('polyline', { points: lijn, fill: 'none', stroke: C.forest, strokeWidth: 12, strokeLinecap: 'round', strokeLinejoin: 'round', opacity: 0.25 }) : null,
    stops.length > 1 ? h('polyline', { points: lijn, fill: 'none', stroke: C.forest, strokeWidth: 5, strokeLinecap: 'round', strokeLinejoin: 'round', strokeDasharray: '2 12' }) : null);
  const pins = p.map((q, i) => h('div', { style: {
    position: 'absolute', left: q.x - r, top: q.y - r, width: r * 2, height: r * 2, borderRadius: r,
    background: stops[i].soort === 'winkel' ? C.forest : C.terra, border: '4px solid #FFFFFF', color: '#FFFFFF',
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: r > 16 ? 20 : 14, fontWeight: 700,
    boxShadow: '0 3px 8px rgba(30,41,34,.25)',
  } }, String(i + 1)));
  return h('div', { style: { position: 'relative', display: 'flex', width: B, height: H, borderRadius: 28, background: C.land, overflow: 'hidden' } }, decor, ...pins);
}

const CACHE = { 'cache-control': 'public, s-maxage=3600, stale-while-revalidate=86400' };

export default async function handler(req) {
  const url = new URL(req.url);
  const r = await leesRoute({ code: url.searchParams.get('code') || '', stops: url.searchParams.get('stops') || '' });

  if (!r) {
    // Onbekende route: algemene kaart van de routeplanner.
    return new ImageResponse(
      h('div', { style: { width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 80, background: C.tint, color: C.ink } },
        h('div', { style: { fontSize: 30, color: C.forest, fontWeight: 700 } }, 'YardiGo Routeplanner'),
        h('div', { style: { fontSize: 66, fontWeight: 800, marginTop: 16, lineHeight: 1.1 } }, 'Plan je snuffeldag'),
        h('div', { style: { fontSize: 32, color: C.muted, marginTop: 20 } }, 'Rommelmarkten, garagesales en kringloopwinkels in één slimme route.')),
      { width: 1200, height: 630, headers: CACHE });
  }

  const d = datumKort(routeDag(r));
  const n = r.stops.length;
  const toon = r.stops.slice(0, n > 4 ? 3 : 4);
  const meta = [d, `${n} ${n === 1 ? 'stop' : 'stops'}`, VERVOER[r.vervoer] || ''].filter(Boolean).join('  ·  ');

  return new ImageResponse(
    h('div', { style: { width: '100%', height: '100%', display: 'flex', background: C.tint, color: C.ink, padding: 44, gap: 40 } },
      h('div', { style: { display: 'flex', flexDirection: 'column', width: 560, justifyContent: 'space-between' } },
        h('div', { style: { display: 'flex', flexDirection: 'column' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
            h('div', { style: { width: 44, height: 44, borderRadius: 12, background: C.forest, color: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, fontWeight: 800 } }, 'Y'),
            h('div', { style: { display: 'flex', fontSize: 26, fontWeight: 700 } }, 'YardiGo', h('span', { style: { color: C.muted, fontWeight: 400, marginLeft: 10 } }, 'Routeplanner'))),
          h('div', { style: { display: 'flex', fontSize: r.naam && r.naam.length > 28 ? 46 : 54, fontWeight: 800, lineHeight: 1.08, marginTop: 28, letterSpacing: -0.5 } }, kort(routeTitel(r), 52)),
          h('div', { style: { display: 'flex', fontSize: 26, color: C.forestDark, marginTop: 14, fontWeight: 600 } }, meta)),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          ...toon.map((s, i) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 14 } },
            h('div', { style: { width: 34, height: 34, borderRadius: 17, flexShrink: 0, background: s.soort === 'winkel' ? C.forest : C.terra, color: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700 } }, String(i + 1)),
            h('div', { style: { display: 'flex', flexDirection: 'column' } },
              h('div', { style: { display: 'flex', fontSize: 24, fontWeight: 600 } }, kort(s.titel || SOORT[s.soort], 34)),
              h('div', { style: { display: 'flex', fontSize: 18, color: C.muted } }, [SOORT[s.soort], s.plaats].filter(Boolean).join(' · '))))),
          n > toon.length ? h('div', { style: { display: 'flex', fontSize: 20, color: C.muted, marginLeft: 48 } }, `+ ${n - toon.length} ${n - toon.length === 1 ? 'stop' : 'stops'} meer`) : null),
        h('div', { style: { display: 'flex', fontSize: 19, color: C.muted } }, 'Start in Google Maps, Apple Kaarten of Waze')),
      kaart(r.stops, 512, 542)),
    { width: 1200, height: 630, headers: CACHE });
}
