// YardiGo: Belgische startpagina (Vercel Routing Middleware)
//
// index.html is één bestand voor alle domeinen. Op yardigo.be serveren we in
// plaats daarvan de variant uit build/prerender.mjs, zodat Google in de ruwe
// HTML meteen de juiste taal, titel en canonical ziet:
//   yardigo.be/  → /locale/be-nl  (cleanUrls: be-nl.html)
// yardigo.be/fr is fr.html, de Franstalige landingspagina.
// Een middleware is nodig omdat een rewrite in vercel.json "/" niet kan
// overnemen: index.html bestaat al en het bestand wint.

export const config = { matcher: ['/'] };

export default function middleware(req) {
  const url = new URL(req.url);
  const host = url.hostname.toLowerCase();
  // Preview-deploys: ?land=be om dit te testen zonder het .be-domein
  const isBe = host.endsWith('yardigo.be') ||
    (host.endsWith('.vercel.app') && url.searchParams.get('land') === 'be');
  if (!isBe) return;
  return new Response(null, {
    headers: { 'x-middleware-rewrite': new URL('/locale/be-nl' + url.search, url).toString() },
  });
}
