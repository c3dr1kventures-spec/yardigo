// ═══════════════════════════════════════════════════════════════════════
// YardiGo website: je route (garagesales, rommelroutes, markten en
// kringloopwinkels op een rij) en die openen in Google Maps, Apple Maps of
// Waze. Google Maps en Apple Maps krijgen alle stops met het vervoer erbij
// (Apple: het 'unified Maps URL'-formaat met waypoint, iOS 18.4 / macOS 15.4;
// het oude daddr-formaat werkt niet meer met coördinaten). Waze neemt via een
// link maar één bestemming: daar kies je per stop.
//
// Een stop: { id, titel, soort (oprit|route|markt|winkel), lat, lng,
// plaats, sub, benadering }. Bij garagesales en rommelroutes kent de site
// zonder account alleen het gebied (benadering): dat staat erbij.
// Opslag: localStorage (alleen in deze browser). Delen gaat via een link
// /kaart?stops=… met de stops erin; wie hem opent krijgt ze in zijn route.
// Knoppen elders: YGRoute.knop(stop) geeft HTML; klikken gaat via één
// luisteraar op het document. Vereist: site.js (window.YG).
// ═══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var SLEUTEL = 'yg-route-1', VERVOER = 'yg-route-vervoer';
  var MAX_GOOGLE = 10;
  var bekend = {};
  var stops = lees(SLEUTEL) || [];
  var vervoer = lees(VERVOER) || 'auto';
  var knopEl, paneel;

  function lees(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function schrijf(k, w) { try { localStorage.setItem(k, JSON.stringify(w)); } catch (e) { /* privévenster: alleen deze pagina */ } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function plek(id) { for (var i = 0; i < stops.length; i++) if (stops[i].id === id) return i; return -1; }
  function heeft(id) { return plek(id) > -1; }

  function bewaar() { schrijf(SLEUTEL, stops); werkKnoppenBij(); tekenPaneel(); }

  function wissel(stop) {
    var i = plek(stop.id);
    if (i > -1) stops.splice(i, 1); else stops.push(stop);
    bewaar();
    meld(YG.t(i > -1 ? 'rt.removed' : 'rt.added', { t: stop.titel }));
  }

  // ── Knoppen op popups en pagina's ────────────────────────────────────
  function knop(stop, klasse) {
    bekend[stop.id] = stop;
    var aan = heeft(stop.id);
    return '<button type="button" class="yg-btn yg-routeknop ' + (klasse || 'yg-btn--outline') + '" data-route-id="' + esc(stop.id) + '" aria-pressed="' + aan + '">' +
      esc(YG.t(aan ? 'rt.in' : 'rt.add')) + '</button>';
  }

  function werkKnoppenBij() {
    document.querySelectorAll('[data-route-id]').forEach(function (b) {
      var aan = heeft(b.getAttribute('data-route-id'));
      b.setAttribute('aria-pressed', String(aan));
      b.textContent = YG.t(aan ? 'rt.in' : 'rt.add');
    });
    if (!knopEl) return;
    knopEl.hidden = !stops.length;
    document.body.classList.toggle('yg-route-actief', stops.length > 0);
    knopEl.querySelector('span').textContent = YG.t('rt.open', { n: stops.length });
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-route-id]');
    if (!b) return;
    var id = b.getAttribute('data-route-id');
    var stop = bekend[id] || stops[plek(id)];
    if (stop) wissel(stop);
  });

  // ── Links naar de kaart-apps ─────────────────────────────────────────
  function punt(s) { return s.lat.toFixed(5) + ',' + s.lng.toFixed(5); }

  function googleLink() {
    var rij = stops.slice(0, MAX_GOOGLE);
    var modus = { auto: 'driving', fiets: 'bicycling', lopen: 'walking' }[vervoer] || 'driving';
    var url = 'https://www.google.com/maps/dir/?api=1&travelmode=' + modus + '&destination=' + punt(rij[rij.length - 1]);
    if (rij.length > 1) url += '&waypoints=' + rij.slice(0, -1).map(punt).join('%7C');
    return url;
  }
  function appleLink() {
    var modus = { auto: 'driving', fiets: 'cycling', lopen: 'walking' }[vervoer] || 'driving';
    return 'https://maps.apple.com/directions?destination=' + punt(stops[stops.length - 1]) +
      stops.slice(0, -1).map(function (s) { return '&waypoint=' + punt(s); }).join('') + '&mode=' + modus;
  }
  function wazeLink(s) { return 'https://waze.com/ul?ll=' + punt(s).replace(',', '%2C') + '&navigate=yes'; }

  // Kortste volgorde (dichtstbijzijnde eerst), vanaf je plek als die bekend is.
  function afstand(a, b) {
    var r = Math.PI / 180, x = (b.lng - a.lng) * Math.cos((a.lat + b.lat) / 2 * r);
    return Math.sqrt(x * x + (b.lat - a.lat) * (b.lat - a.lat));
  }
  function kortste() {
    var start = lees('yg-plek');
    var rest = stops.slice(), uit = [], hier;
    if (start && typeof start.lat === 'number') hier = start;
    else { hier = rest.shift(); uit.push(hier); }
    while (rest.length) {
      var beste = 0;
      for (var i = 1; i < rest.length; i++) if (afstand(hier, rest[i]) < afstand(hier, rest[beste])) beste = i;
      hier = rest.splice(beste, 1)[0];
      uit.push(hier);
    }
    stops = uit;
    bewaar();
  }

  // ── Paneel ───────────────────────────────────────────────────────────
  function bouw() {
    knopEl = document.createElement('button');
    knopEl.type = 'button';
    knopEl.className = 'yg-routebalk';
    knopEl.setAttribute('aria-controls', 'yg-route');
    knopEl.setAttribute('aria-expanded', 'false');
    knopEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5"/></svg><span></span>';
    knopEl.addEventListener('click', function () { open(true); });
    document.body.appendChild(knopEl);

    paneel = document.createElement('aside');
    paneel.id = 'yg-route';
    paneel.className = 'yg-routepaneel';
    paneel.setAttribute('role', 'dialog');
    paneel.setAttribute('aria-labelledby', 'yg-route-kop');
    paneel.hidden = true;
    document.body.appendChild(paneel);

    var live = document.createElement('p');
    live.id = 'yg-route-live';
    live.className = 'yg-sr';
    live.setAttribute('aria-live', 'polite');
    document.body.appendChild(live);

    paneel.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      var i = Number(b.getAttribute('data-i'));
      var actie = b.getAttribute('data-actie');
      if (actie === 'sluit') open(false);
      else if (actie === 'op' && i > 0) { stops.splice(i - 1, 0, stops.splice(i, 1)[0]); bewaar(); focusOp('op', i - 1); }
      else if (actie === 'neer' && i < stops.length - 1) { stops.splice(i + 1, 0, stops.splice(i, 1)[0]); bewaar(); focusOp('neer', i + 1); }
      else if (actie === 'weg') { stops.splice(i, 1); bewaar(); if (!stops.length) open(false); }
      else if (actie === 'leeg') { stops = []; bewaar(); open(false); }
      else if (actie === 'kortste') kortste();
      else if (actie === 'deel') deel(b);
      else if (b.hasAttribute('data-vervoer')) { vervoer = b.getAttribute('data-vervoer'); schrijf(VERVOER, vervoer); tekenPaneel(); }
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !paneel.hidden) open(false); });
    werkKnoppenBij();
    leesDeelLink();
  }

  function focusOp(actie, i) {
    var b = paneel.querySelector('[data-actie="' + actie + '"][data-i="' + i + '"]') || paneel.querySelector('[data-i="' + i + '"]');
    if (b) b.focus();
  }

  function open(aan) {
    paneel.hidden = !aan;
    knopEl.setAttribute('aria-expanded', String(aan));
    document.body.classList.toggle('yg-route-open', aan);
    if (aan) { tekenPaneel(); paneel.querySelector('h2').focus(); } else knopEl.focus();
  }

  function tekenPaneel() {
    if (!paneel || paneel.hidden) return;
    var gebied = stops.some(function (s) { return s.benadering; });
    var html = '<div class="yg-routepaneel__kop"><h2 id="yg-route-kop" tabindex="-1">' + esc(YG.t('rt.title')) + '</h2>' +
      '<button type="button" class="yg-routepaneel__dicht" data-actie="sluit" aria-label="' + esc(YG.t('rt.close')) + '">×</button></div>';
    if (!stops.length) {
      paneel.innerHTML = html + '<p class="yg-meta">' + esc(YG.t('rt.empty')) + '</p>';
      return;
    }
    html += '<ol class="yg-routelijst">' + stops.map(function (s, i) {
      return '<li><span class="yg-stop yg-stop--' + s.soort + '" aria-hidden="true">' + (i + 1) + '</span>' +
        '<span class="yg-routelijst__txt"><strong>' + esc(s.titel) + '</strong><span class="yg-meta">' + esc([s.sub, s.plaats].filter(Boolean).join(', ')) + '</span></span>' +
        '<span class="yg-routelijst__btns">' +
          '<button type="button" data-actie="op" data-i="' + i + '" aria-label="' + esc(YG.t('rt.up') + ': ' + s.titel) + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button type="button" data-actie="neer" data-i="' + i + '" aria-label="' + esc(YG.t('rt.down') + ': ' + s.titel) + '"' + (i === stops.length - 1 ? ' disabled' : '') + '>↓</button>' +
          '<button type="button" data-actie="weg" data-i="' + i + '" aria-label="' + esc(YG.t('rt.remove') + ': ' + s.titel) + '">×</button>' +
        '</span></li>';
    }).join('') + '</ol>';
    if (stops.length > 2) html += '<button type="button" class="yg-btn yg-btn--ghost" data-actie="kortste">' + esc(YG.t('rt.order')) + '</button>';
    html += '<div class="yg-field"><span class="yg-label" id="yg-rt-hoe">' + esc(YG.t('rt.how')) + '</span><div class="yg-seg" role="group" aria-labelledby="yg-rt-hoe">' +
      [['auto', 'rt.car'], ['fiets', 'rt.bike'], ['lopen', 'rt.walk']].map(function (o) {
        return '<button type="button" data-vervoer="' + o[0] + '" aria-pressed="' + (vervoer === o[0]) + '">' + esc(YG.t(o[1])) + '</button>';
      }).join('') + '</div></div>';
    if (gebied) html += '<p class="yg-routepaneel__let">' + esc(YG.t('rt.approx')) + '</p>';
    html += '<a class="yg-btn yg-btn--primary yg-btn--block" href="' + esc(googleLink()) + '" target="_blank" rel="noopener">' + esc(YG.t('rt.google')) + '</a>';
    if (stops.length > MAX_GOOGLE) html += '<p class="yg-meta">' + esc(YG.t('rt.max', { n: MAX_GOOGLE })) + '</p>';
    html += '<a class="yg-btn yg-btn--outline yg-btn--block" href="' + esc(appleLink()) + '" target="_blank" rel="noopener">' + esc(YG.t('rt.apple')) + '</a>';
    // Waze: één bestemming per link, dus een knop per stop.
    html += '<div class="yg-routepaneel__waze"><span class="yg-label">' + esc(YG.t(stops.length > 1 ? 'rt.wazeEach' : 'rt.waze')) + '</span><div class="yg-routepaneel__apps">' +
      stops.map(function (s, i) {
        return '<a class="yg-btn yg-btn--outline" href="' + esc(wazeLink(s)) + '" target="_blank" rel="noopener" aria-label="' + esc(YG.t('rt.wazeTo', { t: s.titel })) + '">' +
          (stops.length > 1 ? '<span class="yg-stop yg-stop--' + s.soort + '" aria-hidden="true">' + (i + 1) + '</span>' : esc(YG.t('rt.waze'))) + '</a>';
      }).join('') + '</div></div>';
    html += '<button type="button" class="yg-btn yg-btn--outline yg-btn--block" data-actie="deel">' + esc(YG.t('rt.share')) + '</button>';
    html += '<button type="button" class="yg-btn yg-btn--ghost" data-actie="leeg">' + esc(YG.t('rt.clear')) + '</button>';
    paneel.innerHTML = html;
  }

  // ── Delen: de stops gaan mee in de link (base64url van compacte JSON) ──
  // Alleen wat de site toch al toont: titel, soort, plek (bij garagesales het
  // gebied) en plaats. Geen account nodig, niets op de server.
  var SOORTEN = ['oprit', 'route', 'markt', 'winkel'];
  function deelLink() {
    var rij = stops.map(function (s) {
      return [s.id, s.titel, s.soort, +s.lat.toFixed(5), +s.lng.toFixed(5), s.plaats || '', s.sub || '', s.benadering ? 1 : 0];
    });
    var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(rij)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return location.origin + '/kaart?stops=' + b64;
  }
  function leesDeelLink() {
    var ruw = new URLSearchParams(location.search).get('stops');
    if (!ruw) return;
    var rij;
    try { rij = JSON.parse(decodeURIComponent(escape(atob(ruw.replace(/-/g, '+').replace(/_/g, '/'))))); } catch (e) { return; }
    if (!Array.isArray(rij)) return;
    var tekst = function (x) { return typeof x === 'string' ? x.slice(0, 120) : ''; };
    var nieuw = rij.slice(0, 25).filter(function (x) {
      return Array.isArray(x) && typeof x[0] === 'string' && SOORTEN.indexOf(x[2]) > -1 && isFinite(x[3]) && isFinite(x[4]) && Math.abs(x[3]) <= 90 && Math.abs(x[4]) <= 180;
    }).map(function (x) {
      return { id: tekst(x[0]), titel: tekst(x[1]), soort: x[2], lat: +x[3], lng: +x[4], plaats: tekst(x[5]), sub: tekst(x[6]), benadering: !!x[7] };
    });
    try { var u = new URL(location.href); u.searchParams.delete('stops'); history.replaceState(history.state, '', u.pathname + u.search + u.hash); } catch (e) { /* oude browser: link blijft staan */ }
    if (!nieuw.length) return;
    nieuw.forEach(function (s) { if (!heeft(s.id)) stops.push(s); });
    bewaar();
    meld(YG.t('rt.loaded', { n: nieuw.length }));
    open(true);
  }
  function deel(b) {
    var url = deelLink();
    if (navigator.share) { navigator.share({ title: YG.t('rt.shareTitle'), url: url }).catch(function () {}); return; }
    var klaar = function () { b.textContent = YG.t('rt.copied'); meld(YG.t('rt.copied')); setTimeout(function () { b.textContent = YG.t('rt.share'); }, 2500); };
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(klaar, function () { window.prompt(YG.t('rt.share'), url); });
    else window.prompt(YG.t('rt.share'), url);
  }

  function meld(t) { var p = document.getElementById('yg-route-live'); if (p) p.textContent = t; }

  window.YGRoute = { knop: knop, heeft: heeft, open: function () { open(true); } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bouw); else bouw();
})();
