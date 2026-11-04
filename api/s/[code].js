// YardiGo — /api/s/[code]  (Vercel Edge runtime)
//
// Korte deellink: yardigo.nl/s/<short_code> → 301 naar /v/<listing-id>.
// /v/:id regelt daarna OG-tags voor crawlers en de SPA voor bezoekers.
// Onbekende code → naar de kaart.

export const config = { runtime: 'edge' };

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://fwehqudhwzcnkcuypuqw.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3ZWhxdWRod3pjbmtjdXlwdXF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzOTQwNzgsImV4cCI6MjA4OTk3MDA3OH0.A5mPApoGySr97niz6QLZGFSDhsfCqOwi-k8v58mHjMI';
const BASE_NL = 'https://www.yardigo.nl';

export default async function handler(req) {
  const url = new URL(req.url);
  const code = url.pathname.split('/').pop().toLowerCase();
  // Op het domein blijven waar de link op staat (yardigo.be/s/... → yardigo.be/v/...).
  const BASE_URL = /(^|\.)yardigo\.(nl|be|de|app)$/.test(url.hostname) ? url.origin : BASE_NL;
  if (!/^[a-z0-9]{4,12}$/.test(code)) return Response.redirect(BASE_URL + '/', 302);
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/listings?select=id&limit=1&short_code=eq.' + code, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
    });
    const rows = r.ok ? await r.json() : [];
    if (rows[0]?.id) {
      return new Response(null, { status: 301, headers: { Location: BASE_URL + '/v/' + rows[0].id + (['nl', 'fr', 'de', 'en'].includes(url.searchParams.get('lang')) ? '?lang=' + url.searchParams.get('lang') : ''), 'Cache-Control': 'public, max-age=86400' } });
    }
  } catch (_) { /* naar de kaart */ }
  return Response.redirect(BASE_URL + '/', 302);
}
