// YardiGo: startpagina per domein en oude app-links (Vercel Routing Middleware)
//
// index.html is de website (één bestand voor alle domeinen). Op yardigo.be
// serveren we de variant uit build/prerender.mjs, zodat Google in de ruwe HTML
// meteen de juiste taal, titel en canonical ziet:
//   yardigo.be/   → /locale/be-nl
//   */fr          → /locale/be-fr  (Frans, canonical yardigo.be/fr)
// Een middleware is nodig omdat een rewrite in vercel.json "/" niet kan
// overnemen: index.html bestaat al en het bestand wint.
//
// Tot 27 okt 2026 stond de web-app op /. Links uit e-mails, de app en oude
// deelberichten gebruiken nog /?v=, /?route=, /?uitschrijven= enz. Die sturen
// we door: een verkoop naar zijn eigen pagina, de rest naar /app.

//
// Gedeelde routes (/route/<code>, /route?stops=…): crawlers van WhatsApp,
// Facebook enz. krijgen api/route-deel (eigen titel en plaatje per route);
// bezoekers gewoon route.html.

import { CRAWLER_RE } from './api/_route.js';

export const config = { matcher: ['/', '/fr', '/route', '/route/:code*'] };

const APP_PARAMS = ['plaatsen', 'route', 'uitschrijven', 'uitschrijven-promo', 'token', 'reset', 'tab', 'action', 'country', 'code', 'instellingen'];

export default function middleware(req) {
  const url = new URL(req.url);
  if (url.pathname.startsWith('/route')) {
    if (!CRAWLER_RE.test(req.headers.get('user-agent') || '')) return;
    const m = /^\/route\/([A-Za-z0-9]{8,16})\/?$/.exec(url.pathname);
    const stops = url.searchParams.get('stops');
    if (!m && !stops) return;
    const doel = new URL('/api/route-deel', url);
    if (m) doel.searchParams.set('code', m[1]); else doel.searchParams.set('stops', stops);
    return new Response(null, { headers: { 'x-middleware-rewrite': doel.toString() } });
  }
  if (url.pathname === '/fr') {
    return new Response(null, { headers: { 'x-middleware-rewrite': new URL('/locale/be-fr' + url.search, url).toString() } });
  }

  const v = url.searchParams.get('v');
  if (v && /^[0-9a-f-]{36}$/i.test(v)) return Response.redirect(new URL('/v/' + v, url), 308);
  if (APP_PARAMS.some((p) => url.searchParams.has(p))) return Response.redirect(new URL('/app' + url.search, url), 308);

  const host = url.hostname.toLowerCase();
  // Preview-deploys: ?land=be om dit te testen zonder het .be-domein
  const isBe = host.endsWith('yardigo.be') ||
    (host.endsWith('.vercel.app') && url.searchParams.get('land') === 'be');
  if (!isBe) return;
  return new Response(null, {
    headers: { 'x-middleware-rewrite': new URL('/locale/be-nl' + url.search, url).toString() },
  });
}
