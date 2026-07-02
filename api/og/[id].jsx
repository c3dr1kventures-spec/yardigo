// YardiGo — /api/og/[id]  (Vercel Edge runtime, @vercel/og)
//
// Genereert een 1200x630 PNG voor social share-previews van /v/:id.
// Layout in YardiGo-stijl (#E07B39 accent), toont ALLEEN publieke
// info: type-badge, titel (max 2 regels), datum + tijden, plaatsnaam.
// Nooit een exact adres of coördinaten — die zitten niet eens in de
// select-query, ook niet als de listing ze wel heeft.
//
// Vercel transpileert `.jsx` in de api/ folder automatisch; geen extra
// build-stap in package.json nodig.

import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://fwehqudhwzcnkcuypuqw.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3ZWhxdWRod3pjbmtjdXlwdXF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzOTQwNzgsImV4cCI6MjA4OTk3MDA3OH0.A5mPApoGySr97niz6QLZGFSDhsfCqOwi-k8v58mHjMI';

const EVENT_SUBTYPE_LABEL = {
  rommelmarkt:   'Rommelmarkt',
  vlooienmarkt:  'Vlooienmarkt',
  braderie:      'Braderie',
  kerstmarkt:    'Kerstmarkt',
  antiekmarkt:   'Antiekmarkt',
  boekenmarkt:   'Boekenmarkt',
  kofferbak:     'Kofferbakverkoop',
  rommelroute:   'Rommelroute',
  opritverkoop:  'Opritverkoop',
  buurtverkoop:  'Rommelroute',
};

const CATEGORY_LABEL = {
  garagesale:       'Opritverkoop',
  garageverkoop:    'Opritverkoop',
  rommelmarkt:      'Rommelmarkt',
  vlooienmarkt:     'Vlooienmarkt',
  kofferbakverkoop: 'Kofferbakverkoop',
  buurtverkoop:     'Rommelroute',
  overig:           'Verkoop',
};

function typeLabel(ev) {
  return (ev && (EVENT_SUBTYPE_LABEL[ev.event_subtype] || CATEGORY_LABEL[ev.category])) || 'Verkoop';
}

function fmtDateShort(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  const months = ['jan','feb','mrt','apr','mei','jun','jul','aug','sep','okt','nov','dec'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function extractIdFromPath(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  const last = parts[parts.length - 1] || '';
  return /^[A-Za-z0-9._-]{1,80}$/.test(last) ? last : '';
}

async function fetchEvent(id) {
  if (!id) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/listings`
      + `?id=eq.${encodeURIComponent(id)}`
      + `&select=id,title,event_subtype,category,date_start,time_start,time_end,city,status,confirmation_status`;
    const r = await fetch(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    if (row.status && !['active','published'].includes(row.status)) return null;
    if (row.confirmation_status && row.confirmation_status !== 'confirmed') return null;
    return row;
  } catch (_) {
    return null;
  }
}

// Satori (de renderer achter @vercel/og) heeft geen echte
// -webkit-line-clamp; om 2 regels + ellipsis te hebben knippen we vooraf.
// ~44 tekens per regel bij fontSize 68 op ~1080px breedte = ~90 chars voor
// 2 regels met word-breaks. We houden ruime marge en gebruiken 80.
function truncateForTitle(s, maxChars) {
  if (!s) return '';
  const t = String(s).trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars - 1).trimEnd() + '…';
}

const CACHE_HEADERS = {
  'cache-control': 'public, s-maxage=3600, stale-while-revalidate=86400',
};

export default async function handler(req) {
  const url = new URL(req.url);
  const id  = extractIdFromPath(url.pathname);
  const ev  = await fetchEvent(id);

  const isFallback = !ev;
  const title  = isFallback
    ? 'Garagesales bij jou in de buurt'
    : truncateForTitle(ev.title || typeLabel(ev), 80);
  const label  = isFallback ? '' : typeLabel(ev);
  const date   = isFallback ? '' : fmtDateShort(ev.date_start);
  const from   = isFallback ? '' : (ev.time_start || '').slice(0, 5);
  const till   = isFallback ? '' : (ev.time_end   || '').slice(0, 5);
  const tijden = from && till ? `${from}–${till}` : (from || till);
  const city   = isFallback ? '' : (ev.city || '');

  return new ImageResponse(
    (
      <div style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: 'linear-gradient(135deg, #FEF6EE 0%, #FBE7D3 100%)',
        padding: '52px 60px',
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        color: '#2C2416',
      }}>
        {/* Header: logo + naam */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{
            width: 64, height: 64, borderRadius: 14,
            background: '#E07B39',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'white', fontSize: 34, fontWeight: 900,
            boxShadow: '0 4px 14px rgba(224,123,57,.30)',
          }}>Y</div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 34, fontWeight: 900, lineHeight: 1 }}>YardiGo</div>
            <div style={{ fontSize: 18, color: '#7A6E62', marginTop: 4 }}>Find · Sell · Go</div>
          </div>
        </div>

        {/* Body */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {label && (
            <div style={{
              padding: '10px 22px',
              borderRadius: 999,
              background: '#E07B39',
              color: 'white',
              fontSize: 22,
              fontWeight: 700,
              alignSelf: 'flex-start',
              letterSpacing: 0.3,
            }}>{label}</div>
          )}
          <div style={{
            fontSize: 68,
            fontWeight: 900,
            lineHeight: 1.08,
            maxWidth: 1080,
            letterSpacing: -0.5,
          }}>{title}</div>
          {(date || city) && (
            <div style={{
              display: 'flex',
              gap: 30,
              alignItems: 'center',
              fontSize: 32,
              color: '#4A3E32',
              marginTop: 6,
              flexWrap: 'wrap',
            }}>
              {date && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>📅</span>
                  <span>{date}{tijden ? ` · ${tijden}` : ''}</span>
                </div>
              )}
              {city && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>📍</span>
                  <span>{city}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
        }}>
          <div style={{ fontSize: 22, color: '#7A6E62' }}>
            {isFallback ? 'Bekijk verkopen op yardigo.nl' : 'Bekijk op de kaart via yardigo.nl'}
          </div>
          <div style={{
            fontSize: 18,
            color: '#7A6E62',
            fontWeight: 600,
          }}>yardigo.nl</div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: CACHE_HEADERS,
    }
  );
}
