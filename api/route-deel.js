// YardiGo — /api/route-deel  (Vercel Edge runtime)
//
// Voorvertoning van een gedeelde route voor WhatsApp, Facebook, Telegram enz.
// middleware.js stuurt alleen crawlers hierheen (/route/<code> en /route?stops=…);
// gewone bezoekers krijgen gewoon route.html. og:image wijst naar /api/route-og
// met dezelfde code of stops. Nooit een startpunt of exact adres (zie api/_route.js).

import { leesRoute, routeDag, datumKort, plaatsen, routeTitel, esc } from './_route.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const url = new URL(req.url);
  const BASIS = /(^|\.)yardigo\.(nl|be|de|app)$/.test(url.hostname) ? url.origin : 'https://www.yardigo.nl';
  const code = url.searchParams.get('code') || '';
  const stops = url.searchParams.get('stops') || '';
  const r = await leesRoute({ code, stops });

  const deel = code ? `${BASIS}/route/${encodeURIComponent(code)}` : stops ? `${BASIS}/route?stops=${encodeURIComponent(stops)}` : `${BASIS}/route`;
  const beeld = r ? `${BASIS}/api/route-og?${code ? 'code=' + encodeURIComponent(code) : 'stops=' + encodeURIComponent(stops)}` : `${BASIS}/og-image.png`;
  let titel, tekst;
  if (r) {
    const d = datumKort(routeDag(r));
    titel = `${routeTitel(r)} | YardiGo`;
    tekst = [plaatsen(r), d, `${r.stops.length} ${r.stops.length === 1 ? 'stop' : 'stops'}`].filter(Boolean).join(' · ') +
      '. Open de route en start in Google Maps, Apple Kaarten of Waze.';
  } else {
    titel = 'Routeplanner: plan je snuffeldag | YardiGo';
    tekst = 'Rommelmarkten, garagesales en kringloopwinkels in één slimme route.';
  }

  const html = `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titel)}</title>
<meta name="description" content="${esc(tekst)}">
<meta name="robots" content="noindex">
<meta property="og:type" content="website">
<meta property="og:site_name" content="YardiGo">
<meta property="og:locale" content="nl_NL">
<meta property="og:url" content="${esc(deel)}">
<meta property="og:title" content="${esc(titel)}">
<meta property="og:description" content="${esc(tekst)}">
<meta property="og:image" content="${esc(beeld)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">
<meta property="og:image:alt" content="${esc(titel)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(titel)}">
<meta name="twitter:description" content="${esc(tekst)}">
<meta name="twitter:image" content="${esc(beeld)}">
</head>
<body style="font-family:system-ui,sans-serif;margin:0;padding:32px;color:#1E2922;background:#F3F6F1">
<h1 style="font-size:22px">${esc(titel)}</h1>
<p style="font-size:16px;line-height:1.5;max-width:640px">${esc(tekst)}</p>
<p><a href="${esc(deel)}" style="color:#3A6B4A;font-weight:700">Open de route op YardiGo →</a></p>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-robots-tag': 'noindex',
      'cache-control': code ? 'public, s-maxage=600, stale-while-revalidate=86400' : 'public, s-maxage=86400',
    },
  });
}
