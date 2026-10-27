// ═══════════════════════════════════════════════════════════════════════
// YardiGo website: dagplanner. Garagesales, rommelroutes, markten en
// kringloopwinkels op een rij, met datum, vertrektijd, start- en eindpunt,
// en openen in Google Maps, Apple Maps of Waze.
//
// Google Maps neemt per link 9 tussenstops + bestemming; Apple Maps (het
// 'unified Maps URL'-formaat met waypoint, iOS 18.4 / macOS 15.4) houden we op
// 14 per link. Langere routes openen in delen. Waze neemt één bestemming per
// link: daar kies je per stop.
//
// Een stop: { id, titel, soort (oprit|route|markt|winkel), lat, lng, plaats,
// sub, benadering, van, tot, begin, eind, tijden }. Bij garagesales en
// rommelroutes kent de site zonder account alleen het gebied (benadering).
// Een route: { id, naam, datum, vertrek, vervoer, start, eind, stops, geweest,
// bijgewerkt }. start/eind: null | { soort: 'plek'|'plaats'|'terug', naam, lat, lng }.
// Opslag: localStorage (alleen in deze browser). Deellink /kaart?stops=…
// bevat alleen de stops, nooit start of eind.
// Knoppen elders: YGRoute.knop(stop) geeft HTML; klikken gaat via één
// luisteraar op het document. Kaart: YGRoute.opKaart(map) tekent de stops.
// Vereist: site.js (window.YG); kaart.js (window.YGKaart) voor plaatsen zoeken
// en controle van verkopen.
// ═══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var SLEUTEL = 'yg-routes-2', ACTIEF = 'yg-route-actief';
  var OUD = 'yg-route-1', OUD_VERVOER = 'yg-route-vervoer';
  var PER_LINK = { google: 10, apple: 14 };
  var SOORTEN = ['oprit', 'route', 'markt', 'winkel'];
  var bekend = {};
  var routes, actief;
  var knopEl, paneel, weergave = 'route', wisVraag = null, hernoem = null;
  var controle = {};   // id → 'weg' | 'gewijzigd' (na controle bij openen)
  var kaartLaag = null;

  function lees(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function schrijf(k, w) { try { localStorage.setItem(k, JSON.stringify(w)); } catch (e) { /* privévenster: alleen deze pagina */ } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function nieuwId() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function t(k, w) { return YG.t(k, w); }

  // ── Routes laden (en de oude enkele route overnemen) ─────────────────
  function legeRoute(naam) {
    return { id: nieuwId(), naam: naam || '', datum: '', vertrek: '09:00', vervoer: lees(OUD_VERVOER) || 'auto', start: null, eind: null, stops: [], geweest: [], bijgewerkt: Date.now() };
  }
  routes = lees(SLEUTEL);
  if (!Array.isArray(routes) || !routes.length) {
    var eerste = legeRoute();
    var oud = lees(OUD);
    if (Array.isArray(oud)) eerste.stops = oud;
    routes = [eerste];
  }
  actief = routes.filter(function (r) { return r.id === lees(ACTIEF); })[0] || routes[0];
  var stops = actief.stops;

  function bewaar() {
    actief.stops = stops;
    actief.bijgewerkt = Date.now();
    schrijf(SLEUTEL, routes);
    schrijf(ACTIEF, actief.id);
    werkKnoppenBij(); tekenPaneel(); tekenKaart();
  }
  function kies(r) { actief = r; stops = r.stops; controle = {}; bewaar(); controleer(); }

  function plek(id) { for (var i = 0; i < stops.length; i++) if (stops[i].id === id) return i; return -1; }
  function heeft(id) { return plek(id) > -1; }

  function wissel(stop) {
    var i = plek(stop.id);
    if (i > -1) stops.splice(i, 1); else stops.push(stop);
    bewaar();
    meld(t(i > -1 ? 'rt.removed' : 'rt.added', { t: stop.titel }));
  }

  // ── Knoppen op popups en pagina's ────────────────────────────────────
  function knop(stop, klasse) {
    bekend[stop.id] = stop;
    var aan = heeft(stop.id);
    return '<button type="button" class="yg-btn yg-routeknop ' + (klasse || 'yg-btn--outline') + '" data-route-id="' + esc(stop.id) + '" aria-pressed="' + aan + '">' +
      esc(t(aan ? 'rt.in' : 'rt.add')) + '</button>';
  }

  function werkKnoppenBij() {
    document.querySelectorAll('[data-route-id]').forEach(function (b) {
      var aan = heeft(b.getAttribute('data-route-id'));
      b.setAttribute('aria-pressed', String(aan));
      b.textContent = t(aan ? 'rt.in' : 'rt.add');
    });
    if (!knopEl) return;
    knopEl.hidden = !stops.length;
    document.body.classList.toggle('yg-route-actief', stops.length > 0);
    knopEl.querySelector('span').textContent = t('rt.open', { n: stops.length });
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-route-id]');
    if (!b) return;
    var id = b.getAttribute('data-route-id');
    var stop = bekend[id] || stops[plek(id)];
    if (stop) wissel(stop);
  });

  // ── Datum, tijden en openingstijden ──────────────────────────────────
  function vandaag() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
  // De dag van de route: gekozen datum, anders de eerste dag waarop een verkoop in de route is.
  function routeDatum() {
    if (actief.datum) return actief.datum;
    var nu = vandaag(), d = null;
    stops.forEach(function (s) {
      if (!s.van) return;
      var eerst = s.van < nu ? (s.tot >= nu ? nu : null) : s.van;
      if (eerst && (!d || eerst < d)) d = eerst;
    });
    return d || nu;
  }
  function dagNaam(iso, kort) {
    var taal = document.documentElement.lang || 'nl';
    return new Date(iso + 'T12:00:00Z').toLocaleDateString(taal, kort ? { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' } : { weekday: 'long', timeZone: 'UTC' });
  }
  function hhmm(s) { return s ? String(s).slice(0, 5) : ''; }

  // OSM-openingstijden voor één dag: [[van, tot], …] in minuten, [] = dicht,
  // null = onbekend. Alleen de gangbare vormen ('Mo-Sa 10:00-17:00; Su off',
  // meerdere blokken, '24/7'); feestdagen (PH) slaan we over.
  var DAGEN = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  function openOp(tijden, iso) {
    if (!tijden) return null;
    var tekst = String(tijden).trim();
    if (tekst === '24/7') return [[0, 1440]];
    var dag = new Date(iso + 'T12:00:00Z').getUTCDay(), uit = null;
    var regels = tekst.split(';');
    for (var i = 0; i < regels.length; i++) {
      var r = regels[i].trim();
      if (!r) continue;
      var m = /^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?,?)+)\s+(.+)$/.exec(r);
      if (!m) return null;
      if (/^PH/.test(m[1]) && m[1].indexOf(',') < 0) continue;
      var geldt = m[1].split(',').some(function (deel) {
        var ab = deel.split('-'), a = DAGEN.indexOf(ab[0]), b = ab[1] ? DAGEN.indexOf(ab[1]) : a;
        if (a < 0) return false;
        return a <= b ? dag >= a && dag <= b : dag >= a || dag <= b;
      });
      if (!geldt) continue;
      if (/^(off|closed)$/.test(m[2])) { uit = []; continue; }
      var blokken = m[2].split(',').map(function (x) {
        var tm = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(x.trim());
        return tm ? [+tm[1] * 60 + +tm[2], +tm[3] * 60 + +tm[4]] : null;
      });
      if (blokken.some(function (x) { return !x; })) return null;
      uit = blokken;
    }
    return uit || (tekst ? [] : null);
  }
  function blokTekst(b) {
    var f = function (m) { return Math.floor(m / 60) + ':' + ('0' + m % 60).slice(-2); };
    return b.map(function (x) { return f(x[0]) + '-' + f(x[1]); }).join(', ');
  }

  // Wat er bij een stop te melden is op de dag van de route.
  function stopInfo(s) {
    var d = routeDatum(), info = { tijd: '', let: '' };
    if (controle[s.id] === 'weg') { info.let = t('rt.gone'); return info; }
    if (s.soort === 'winkel') {
      var o = openOp(s.tijden, d);
      if (o && o.length) info.tijd = t('rt.openAt', { t: blokTekst(o) });
      else if (o) info.let = t('rt.shut', { d: dagNaam(d) });
      return info;
    }
    if (s.begin) info.tijd = hhmm(s.begin) + (s.eind ? '-' + hhmm(s.eind) : '');
    if (s.tot && s.tot < vandaag()) info.let = t('rt.past');
    else if (s.van && (d < s.van || d > s.tot)) info.let = t('rt.notOn', { d: dagNaam(d, true) });
    if (controle[s.id] === 'gewijzigd' && !info.let) info.let = t('rt.changed', { d: dagNaam(s.van, true) });
    return info;
  }

  // Verkopen in de route naast de actuele lijst leggen: weg of datum gewijzigd?
  function controleer() {
    var K = window.YGKaart;
    var verkopen = stops.filter(function (s) { return s.soort !== 'winkel'; });
    if (!K || !verkopen.length) return;
    K.laad().then(function (lijst) {
      var per = {};
      lijst.forEach(function (v) { per[v.id] = v; });
      var anders = false;
      verkopen.forEach(function (s) {
        var v = per[s.id];
        if (!v) {
          // De kaartlijst toont alleen komende verkopen: iets dat al voorbij is, is niet 'weg'.
          if (!(s.tot && s.tot < vandaag())) { controle[s.id] = 'weg'; anders = true; }
          return;
        }
        if (s.van && (v.van !== s.van || v.tot !== s.tot)) controle[s.id] = 'gewijzigd';
        if (v.van !== s.van || v.tot !== s.tot || v.begin !== s.begin || v.eind !== s.eind) {
          s.van = v.van; s.tot = v.tot; s.begin = v.begin || null; s.eind = v.eind || null; anders = true;
        }
      });
      if (anders) bewaar();
    }).catch(function () { /* geen verbinding: dan zonder controle */ });
  }

  // ── Afstand (alleen als schatting, hemelsbreed) en slimme volgorde ───
  function km(a, b) {
    var r = Math.PI / 180, x = (b.lng - a.lng) * Math.cos((a.lat + b.lat) / 2 * r), y = b.lat - a.lat;
    return Math.sqrt(x * x + y * y) * 111.32;
  }
  function eindPunt() { return actief.eind ? (actief.eind.soort === 'terug' ? actief.start : actief.eind) : null; }
  function punten() {
    var p = stops.slice();
    if (actief.start) p.unshift(actief.start);
    var e = eindPunt();
    if (e) p.push(e);
    return p.filter(Boolean);
  }
  function totaalKm() {
    var p = punten(), som = 0;
    for (var i = 1; i < p.length; i++) som += km(p[i - 1], p[i]);
    return som;
  }

  // Wie vroeg sluit gaat voor; daarbinnen de dichtstbijzijnde. Niet open op
  // de dag van de route: achteraan. Hemelsbreed: een schatting, geen weg.
  function slimmeVolgorde() {
    var d = routeDatum();
    var sluit = function (s) {
      if (stopInfo(s).let) return 2000;
      if (s.soort === 'winkel') { var o = openOp(s.tijden, d); return o && o.length ? o[o.length - 1][1] : 1200; }
      return s.eind ? +hhmm(s.eind).slice(0, 2) * 60 + +hhmm(s.eind).slice(3) : 1200;
    };
    var rest = stops.slice(), uit = [];
    var hier = actief.start || lees('yg-plek');
    if (!hier || typeof hier.lat !== 'number') hier = null;
    while (rest.length) {
      var vroegst = Math.min.apply(null, rest.map(sluit));
      // Kandidaten: alles dat binnen 3 uur na de vroegste sluittijd sluit.
      var kand = rest.filter(function (s) { return sluit(s) <= vroegst + 180; });
      var beste = kand[0];
      if (hier) kand.forEach(function (s) { if (km(hier, s) < km(hier, beste)) beste = s; });
      uit.push(beste);
      rest.splice(rest.indexOf(beste), 1);
      hier = beste;
    }
    stops.splice.apply(stops, [0, stops.length].concat(uit));
    bewaar();
    meld(t('rt.ordered'));
  }

  // ── Links naar de kaart-apps ─────────────────────────────────────────
  function punt(s) { return s.lat.toFixed(5) + ',' + s.lng.toFixed(5); }
  // Wat nog in de navigatie hoort: niet geweest en zonder melding (dicht, voorbij, weg, andere dag).
  function teBezoeken() {
    return stops.filter(function (s) { return actief.geweest.indexOf(s.id) < 0 && !stopInfo(s).let; });
  }
  // Delen van hooguit n punten. Het eerste deel begint bij het startpunt (als
  // dat een plaats is); latere delen bij je locatie op dat moment.
  function delen(n) {
    var rij = teBezoeken().slice(), e = eindPunt();
    if (rij.length && e) rij.push(e);
    var uit = [];
    for (var i = 0; i < rij.length; i += n) uit.push({ van: i + 1, tot: Math.min(i + n, rij.length), p: rij.slice(i, i + n) });
    return uit;
  }
  function googleLink(d, eerste) {
    var modus = { auto: 'driving', fiets: 'bicycling', lopen: 'walking' }[actief.vervoer] || 'driving';
    var p = d.p, url = 'https://www.google.com/maps/dir/?api=1&travelmode=' + modus + '&destination=' + punt(p[p.length - 1]);
    if (eerste && actief.start && actief.start.soort === 'plaats') url += '&origin=' + punt(actief.start);
    if (p.length > 1) url += '&waypoints=' + p.slice(0, -1).map(punt).join('%7C');
    return url;
  }
  function appleLink(d) {
    var modus = { auto: 'driving', fiets: 'cycling', lopen: 'walking' }[actief.vervoer] || 'driving';
    return 'https://maps.apple.com/directions?destination=' + punt(d.p[d.p.length - 1]) +
      d.p.slice(0, -1).map(function (s) { return '&waypoint=' + punt(s); }).join('') + '&mode=' + modus;
  }
  function wazeLink(s) { return 'https://waze.com/ul?ll=' + punt(s).replace(',', '%2C') + '&navigate=yes'; }

  // ── Delen: de stops gaan mee in de link (base64url van compacte JSON) ──
  // Alleen wat de site toch al toont: titel, soort, plek (bij garagesales het
  // gebied) en plaats. Nooit het startpunt. Geen account nodig, niets op de server.
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
    // Een gedeelde route wordt een eigen route in Mijn routes; je huidige blijft bewaard.
    var r = stops.length ? legeRoute(t('rt.sharedName')) : actief;
    if (r !== actief) routes.unshift(r);
    r.stops = nieuw;
    kies(r);
    meld(t('rt.loaded', { n: nieuw.length }));
    open(true);
  }
  function deel(b) {
    var url = deelLink();
    if (navigator.share) { navigator.share({ title: actief.naam || t('rt.shareTitle'), url: url }).catch(function () {}); return; }
    var klaar = function () { b.textContent = t('rt.copied'); meld(t('rt.copied')); setTimeout(function () { b.textContent = t('rt.share'); }, 2500); };
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(klaar, function () { toonLink(url); });
    else toonLink(url);
  }
  // Zonder klembord: de link in een veld om zelf te kopiëren (geen browserdialoog).
  function toonLink(url) {
    var vak = paneel.querySelector('#yg-rt-link');
    if (vak) { vak.hidden = false; vak.value = url; vak.select(); }
  }

  // ── Start- en eindpunt ───────────────────────────────────────────────
  function zetPunt(welk, keuze, invoer) {
    var fout = paneel.querySelector('#yg-rt-' + welk + '-fout');
    if (fout) fout.hidden = true;
    if (keuze === 'geen') { actief[welk] = null; bewaar(); return; }
    if (keuze === 'terug') { actief.eind = { soort: 'terug' }; bewaar(); return; }
    if (keuze === 'plek') {
      if (!navigator.geolocation) { toonFout(welk, 'rt.locFail'); return; }
      navigator.geolocation.getCurrentPosition(function (p) {
        actief[welk] = { soort: 'plek', naam: t('rt.here'), lat: +p.coords.latitude.toFixed(4), lng: +p.coords.longitude.toFixed(4) };
        bewaar();
      }, function () { toonFout(welk, 'rt.locFail'); }, { timeout: 10000, maximumAge: 300000 });
      return;
    }
    if (keuze === 'plaats') {
      var q = (invoer || '').trim();
      if (!q || !window.YGKaart) return;
      window.YGKaart.zoekPlaats(q).then(function (r) {
        if (!r) { toonFout(welk, 'rt.placeFail'); return; }
        actief[welk] = { soort: 'plaats', naam: r.naam, lat: +r.lat.toFixed(4), lng: +r.lng.toFixed(4) };
        bewaar();
      });
    }
  }
  function toonFout(welk, sleutel) {
    var fout = paneel.querySelector('#yg-rt-' + welk + '-fout');
    if (fout) { fout.textContent = t(sleutel); fout.hidden = false; }
  }

  // ── Slepen (muis en touch); de pijltjesknoppen blijven voor wie niet sleept ──
  // Luistert op het document: een element verplaatsen in de lijst laat de pointer-capture los.
  function sleepStart(e, greep) {
    var li = greep.closest('li'), lijst = li && li.parentNode;
    if (!li || e.button > 0) return;
    e.preventDefault();
    li.classList.add('is-sleep');
    var beweeg = function (ev) {
      var y = ev.clientY;
      var anderen = Array.prototype.filter.call(lijst.children, function (x) { return x !== li; });
      var voor = anderen.filter(function (x) { var r = x.getBoundingClientRect(); return y < r.top + r.height / 2; })[0];
      if (voor) { if (li.nextSibling !== voor) lijst.insertBefore(li, voor); } else if (lijst.lastChild !== li) lijst.appendChild(li);
    };
    var los = function () {
      document.removeEventListener('pointermove', beweeg);
      document.removeEventListener('pointerup', los);
      document.removeEventListener('pointercancel', los);
      li.classList.remove('is-sleep');
      var volgorde = Array.prototype.map.call(lijst.children, function (x) { return +x.getAttribute('data-i'); });
      var nieuw = volgorde.map(function (i) { return stops[i]; });
      if (volgorde.some(function (v, i) { return v !== i; })) { stops.splice.apply(stops, [0, stops.length].concat(nieuw)); bewaar(); meld(t('rt.moved')); }
    };
    document.addEventListener('pointermove', beweeg);
    document.addEventListener('pointerup', los);
    document.addEventListener('pointercancel', los);
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

    paneel.addEventListener('click', klik);
    paneel.addEventListener('change', wijzig);
    paneel.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      if (f.getAttribute('data-punt')) zetPunt(f.getAttribute('data-punt'), 'plaats', f.querySelector('input').value);
      else if (f.id === 'yg-rt-naam-form') {
        var r = routes.filter(function (x) { return x.id === hernoem; })[0];
        if (r) { r.naam = f.querySelector('input').value.trim().slice(0, 80); r.bijgewerkt = Date.now(); }
        hernoem = null; schrijf(SLEUTEL, routes); tekenPaneel(); meld(t('rt.renamed'));
      }
    });
    paneel.addEventListener('pointerdown', function (e) {
      var g = e.target.closest('.yg-routelijst__greep');
      if (g) sleepStart(e, g);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !paneel.hidden) open(false); });
    werkKnoppenBij();
    leesDeelLink();
    controleer();
  }

  function klik(e) {
    var b = e.target.closest('button');
    if (!b) return;
    var i = Number(b.getAttribute('data-i'));
    var actie = b.getAttribute('data-actie');
    var rid = b.getAttribute('data-rid');
    var r = rid && routes.filter(function (x) { return x.id === rid; })[0];
    if (actie === 'sluit') open(false);
    else if (actie === 'grootte') { paneel.classList.toggle('is-vol'); tekenPaneel(); var gr = paneel.querySelector('[data-actie="grootte"]'); if (gr) gr.focus(); }
    else if (actie === 'op' && i > 0) { stops.splice(i - 1, 0, stops.splice(i, 1)[0]); bewaar(); focusOp('op', i - 1); }
    else if (actie === 'neer' && i < stops.length - 1) { stops.splice(i + 1, 0, stops.splice(i, 1)[0]); bewaar(); focusOp('neer', i + 1); }
    else if (actie === 'weg') { stops.splice(i, 1); bewaar(); }
    else if (actie === 'leeg') { stops.splice(0, stops.length); actief.geweest = []; bewaar(); }
    else if (actie === 'kortste') slimmeVolgorde();
    else if (actie === 'deel') deel(b);
    else if (actie === 'geweest') {
      var id = stops[i].id, k = actief.geweest.indexOf(id);
      if (k > -1) actief.geweest.splice(k, 1); else actief.geweest.push(id);
      bewaar(); focusOp('geweest', i);
    }
    else if (actie === 'mijn') { weergave = 'lijst'; wisVraag = hernoem = null; tekenPaneel(); focusKop(); }
    else if (actie === 'terug') { weergave = 'route'; tekenPaneel(); focusKop(); }
    else if (actie === 'nieuw') { var n = legeRoute(); routes.unshift(n); weergave = 'route'; kies(n); focusKop(); }
    else if (actie === 'kies' && r) { weergave = 'route'; kies(r); focusKop(); }
    else if (actie === 'hernoem' && r) { hernoem = r.id; wisVraag = null; tekenPaneel(); var inv = paneel.querySelector('#yg-rt-naam'); if (inv) inv.focus(); }
    else if (actie === 'dupliceer' && r) {
      var kopie = JSON.parse(JSON.stringify(r));
      kopie.id = nieuwId(); kopie.naam = t('rt.copyOf', { t: naamVan(r) }); kopie.geweest = []; kopie.bijgewerkt = Date.now();
      routes.splice(routes.indexOf(r) + 1, 0, kopie);
      schrijf(SLEUTEL, routes); tekenPaneel(); meld(t('rt.duplicated'));
    }
    else if (actie === 'wis' && r) { wisVraag = r.id; hernoem = null; tekenPaneel(); }
    else if (actie === 'wisNee') { wisVraag = null; tekenPaneel(); }
    else if (actie === 'wisJa' && r) {
      routes.splice(routes.indexOf(r), 1);
      if (!routes.length) routes.push(legeRoute());
      wisVraag = null;
      if (r === actief) kies(routes[0]); else { schrijf(SLEUTEL, routes); tekenPaneel(); }
      meld(t('rt.deleted'));
    }
    else if (b.hasAttribute('data-vervoer')) { actief.vervoer = b.getAttribute('data-vervoer'); bewaar(); }
  }

  function wijzig(e) {
    var el = e.target;
    if (el.id === 'yg-rt-datum') { actief.datum = el.value || ''; bewaar(); }
    else if (el.id === 'yg-rt-vertrek') { actief.vertrek = el.value || '09:00'; bewaar(); }
    else if (el.getAttribute('data-punt-keuze')) {
      var welk = el.getAttribute('data-punt-keuze');
      var form = paneel.querySelector('form[data-punt="' + welk + '"]');
      if (el.value === 'plaats') { if (form) { form.hidden = false; form.querySelector('input').focus(); } }
      else { if (form) form.hidden = true; zetPunt(welk, el.value); }
    }
  }

  function focusOp(actie, i) {
    var b = paneel.querySelector('[data-actie="' + actie + '"][data-i="' + i + '"]') || paneel.querySelector('[data-i="' + i + '"] button');
    if (b) b.focus();
  }
  function focusKop() { var h = paneel.querySelector('h2'); if (h) h.focus(); }

  function open(aan) {
    paneel.hidden = !aan;
    knopEl.setAttribute('aria-expanded', String(aan));
    document.body.classList.toggle('yg-route-open', aan);
    // De kaartpagina maakt ruimte voor het paneel: Leaflet moet zijn maat opnieuw meten.
    setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 50);
    if (aan) { weergave = 'route'; tekenPaneel(); focusKop(); } else knopEl.focus();
  }

  function naamVan(r) { return r.naam || t('rt.untitled'); }
  function puntKeuze(welk) {
    var p = actief[welk], waarde = !p ? 'geen' : p.soort;
    var opties = [['geen', 'rt.none'], ['plek', 'rt.here'], ['plaats', 'rt.place']];
    if (welk === 'eind') opties.splice(1, 0, ['terug', 'rt.backToStart']);
    var naam = p && p.soort === 'plaats' ? p.naam : '';
    return '<div class="yg-rt-punt"><label for="yg-rt-' + welk + '">' + esc(t(welk === 'start' ? 'rt.start' : 'rt.end')) + '</label>' +
      '<select id="yg-rt-' + welk + '" data-punt-keuze="' + welk + '">' + opties.map(function (o) {
        var tekst = o[0] === 'plaats' && naam ? naam : t(o[1]);
        return '<option value="' + o[0] + '"' + (o[0] === waarde ? ' selected' : '') + '>' + esc(tekst) + '</option>';
      }).join('') + '</select>' +
      '<form data-punt="' + welk + '" hidden><input type="text" autocomplete="address-level2" aria-label="' + esc(t('rt.placePh')) + '" placeholder="' + esc(t('rt.placePh')) + '"><button type="submit" class="yg-btn yg-btn--outline">OK</button></form>' +
      '<p class="yg-error" id="yg-rt-' + welk + '-fout" role="alert" hidden></p></div>';
  }

  // Op de telefoon: greep om het paneel groter of kleiner te maken (kaart blijft zichtbaar).
  function greepHtml() {
    var vol = paneel.classList.contains('is-vol');
    return '<button type="button" class="yg-routepaneel__greep" data-actie="grootte" aria-label="' + esc(t(vol ? 'rt.smaller' : 'rt.bigger')) + '"></button>';
  }

  function tekenLijst() {
    var html = greepHtml() + '<div class="yg-routepaneel__kop"><h2 id="yg-route-kop" tabindex="-1">' + esc(t('rt.myRoutes')) + '</h2>' +
      '<button type="button" class="yg-routepaneel__dicht" data-actie="sluit" aria-label="' + esc(t('rt.close')) + '">×</button></div>';
    html += '<button type="button" class="yg-btn yg-btn--ghost" data-actie="terug">← ' + esc(t('rt.back')) + '</button>';
    html += '<ul class="yg-mijnroutes">' + routes.map(function (r) {
      var rid = esc(r.id), huidig = r === actief;
      if (hernoem === r.id) {
        return '<li><form id="yg-rt-naam-form" class="yg-mijnroutes__naam"><label class="yg-sr" for="yg-rt-naam">' + esc(t('rt.name')) + '</label>' +
          '<input id="yg-rt-naam" type="text" maxlength="80" value="' + esc(r.naam) + '" placeholder="' + esc(t('rt.untitled')) + '">' +
          '<button type="submit" class="yg-btn yg-btn--primary">' + esc(t('rt.save')) + '</button></form></li>';
      }
      var regel = '<li' + (huidig ? ' aria-current="true"' : '') + '><button type="button" class="yg-mijnroutes__open" data-actie="kies" data-rid="' + rid + '">' +
        '<strong>' + esc(naamVan(r)) + '</strong><span class="yg-meta">' + esc(t('rt.stopsN', { n: r.stops.length }) + (r.datum ? ' · ' + dagNaam(r.datum, true) : '')) + '</span></button>';
      if (wisVraag === r.id) {
        regel += '<span class="yg-mijnroutes__vraag" role="group" aria-label="' + esc(t('rt.delAsk')) + '">' + esc(t('rt.delAsk')) +
          ' <button type="button" class="yg-btn yg-btn--primary" data-actie="wisJa" data-rid="' + rid + '">' + esc(t('rt.yes')) + '</button>' +
          '<button type="button" class="yg-btn yg-btn--ghost" data-actie="wisNee">' + esc(t('rt.no')) + '</button></span>';
      } else {
        regel += '<span class="yg-mijnroutes__btns">' +
          '<button type="button" data-actie="hernoem" data-rid="' + rid + '">' + esc(t('rt.rename')) + '</button>' +
          '<button type="button" data-actie="dupliceer" data-rid="' + rid + '">' + esc(t('rt.dup')) + '</button>' +
          '<button type="button" data-actie="wis" data-rid="' + rid + '">' + esc(t('rt.del')) + '</button></span>';
      }
      return regel + '</li>';
    }).join('') + '</ul>';
    html += '<button type="button" class="yg-btn yg-btn--primary yg-btn--block" data-actie="nieuw">+ ' + esc(t('rt.newRoute')) + '</button>';
    paneel.innerHTML = html;
  }

  function tekenPaneel() {
    if (!paneel || paneel.hidden) return;
    if (weergave === 'lijst') { tekenLijst(); return; }
    var gebied = stops.some(function (s) { return s.benadering; });
    var html = greepHtml() + '<div class="yg-routepaneel__kop"><h2 id="yg-route-kop" tabindex="-1">' + esc(naamVan(actief)) + '</h2>' +
      '<button type="button" class="yg-btn yg-btn--ghost yg-routepaneel__mijn" data-actie="mijn">' + esc(t('rt.myRoutes')) + (routes.length > 1 ? ' (' + routes.length + ')' : '') + '</button>' +
      '<button type="button" class="yg-routepaneel__dicht" data-actie="sluit" aria-label="' + esc(t('rt.close')) + '">×</button></div>';
    if (!stops.length) {
      paneel.innerHTML = html + '<p class="yg-meta">' + esc(t('rt.empty')) + '</p>';
      return;
    }
    // Je dag: datum, vertrek, start, einde, vervoer. Ingeklapt met een samenvatting.
    var d = routeDatum();
    var samenvatting = dagNaam(d, true) + ' · ' + (actief.vertrek || '09:00') + ' · ' + t({ auto: 'rt.car', fiets: 'rt.bike', lopen: 'rt.walk' }[actief.vervoer] || 'rt.car') +
      (actief.start ? ' · ' + t('rt.from', { p: actief.start.naam }) : '');
    html += '<details class="yg-rt-dag"><summary><span class="yg-label">' + esc(t('rt.day')) + '</span><span class="yg-meta">' + esc(samenvatting) + '</span></summary>' +
      '<div class="yg-rt-dag__velden">' +
      '<div><label for="yg-rt-datum">' + esc(t('rt.date')) + '</label><input type="date" id="yg-rt-datum" value="' + esc(d) + '" min="' + esc(vandaag()) + '"></div>' +
      '<div><label for="yg-rt-vertrek">' + esc(t('rt.depart')) + '</label><input type="time" id="yg-rt-vertrek" value="' + esc(actief.vertrek || '09:00') + '" step="900"></div>' +
      puntKeuze('start') + puntKeuze('eind') + '</div>' +
      '<div class="yg-field"><span class="yg-label" id="yg-rt-hoe">' + esc(t('rt.how')) + '</span><div class="yg-seg" role="group" aria-labelledby="yg-rt-hoe">' +
      [['auto', 'rt.car'], ['fiets', 'rt.bike'], ['lopen', 'rt.walk']].map(function (o) {
        return '<button type="button" data-vervoer="' + o[0] + '" aria-pressed="' + (actief.vervoer === o[0]) + '">' + esc(t(o[1])) + '</button>';
      }).join('') + '</div></div></details>';

    // Volgende stop: voor onderweg.
    var volgende = teBezoeken()[0];
    if (volgende && stops.length > 1) {
      html += '<div class="yg-rt-volgende"><span class="yg-meta">' + esc(t('rt.next')) + '</span><strong>' + esc(volgende.titel) + '</strong>' +
        '<a class="yg-btn yg-btn--primary" href="' + esc(googleLink({ p: [volgende] }, false)) + '" target="_blank" rel="noopener">' + esc(t('rt.navigate')) + '</a></div>';
    }

    html += '<ol class="yg-routelijst">' + stops.map(function (s, i) {
      var info = stopInfo(s), gehad = actief.geweest.indexOf(s.id) > -1;
      var regel = [s.soort === 'winkel' ? s.sub : '', s.plaats, info.tijd].filter(Boolean).join(' · ');
      return '<li data-i="' + i + '"' + (gehad ? ' class="is-geweest"' : '') + '>' +
        '<span class="yg-routelijst__greep" aria-hidden="true" title="' + esc(t('rt.drag')) + '">⋮⋮</span>' +
        '<span class="yg-stop yg-stop--' + s.soort + '" aria-hidden="true">' + (i + 1) + '</span>' +
        '<span class="yg-routelijst__txt"><strong>' + esc(s.titel) + '</strong><span class="yg-meta">' + esc(regel) + '</span>' +
        (info.let ? '<span class="yg-routelijst__let">' + esc(info.let) + '</span>' : '') + '</span>' +
        '<span class="yg-routelijst__btns">' +
          '<button type="button" data-actie="geweest" data-i="' + i + '" aria-pressed="' + gehad + '" aria-label="' + esc(t('rt.done') + ': ' + s.titel) + '" title="' + esc(t('rt.done')) + '">✓</button>' +
          '<button type="button" data-actie="op" data-i="' + i + '" aria-label="' + esc(t('rt.up') + ': ' + s.titel) + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button type="button" data-actie="neer" data-i="' + i + '" aria-label="' + esc(t('rt.down') + ': ' + s.titel) + '"' + (i === stops.length - 1 ? ' disabled' : '') + '>↓</button>' +
          '<button type="button" data-actie="weg" data-i="' + i + '" aria-label="' + esc(t('rt.remove') + ': ' + s.titel) + '">×</button>' +
        '</span></li>';
    }).join('') + '</ol>';
    html += '<p class="yg-meta yg-rt-som">' + esc(t('rt.sum', { n: stops.length, km: Math.round(totaalKm()) })) + '</p>';
    if (stops.length > 2) html += '<button type="button" class="yg-btn yg-btn--ghost" data-actie="kortste">' + esc(t('rt.order')) + '</button>';
    if (gebied) html += '<p class="yg-routepaneel__let">' + esc(t('rt.approx')) + '</p>';

    // Openen in een kaart-app; lange routes in delen.
    var g = delen(PER_LINK.google), a = delen(PER_LINK.apple);
    var metMelding = stops.filter(function (s) { return actief.geweest.indexOf(s.id) < 0 && stopInfo(s).let; }).length;
    if (metMelding) html += '<p class="yg-routepaneel__let">' + esc(t('rt.skipped', { n: metMelding })) + '</p>';
    if (!g.length) html += '<p class="yg-meta">' + esc(t('rt.allDone')) + '</p>';
    else {
      html += knoppenPerDeel(g, 'rt.google', function (dl, k) { return googleLink(dl, k === 0); }, 'yg-btn--primary');
      html += knoppenPerDeel(a, 'rt.apple', appleLink, 'yg-btn--outline');
      if (g.length > 1 || a.length > 1) html += '<p class="yg-meta">' + esc(t('rt.parts')) + '</p>';
      var wz = teBezoeken();
      html += '<div class="yg-routepaneel__waze"><span class="yg-label">' + esc(t(wz.length > 1 ? 'rt.wazeEach' : 'rt.waze')) + '</span><div class="yg-routepaneel__apps">' +
        wz.map(function (s) {
          var nr = stops.indexOf(s) + 1;
          return '<a class="yg-btn yg-btn--outline" href="' + esc(wazeLink(s)) + '" target="_blank" rel="noopener" aria-label="' + esc(t('rt.wazeTo', { t: s.titel })) + '">' +
            (wz.length > 1 ? '<span class="yg-stop yg-stop--' + s.soort + '" aria-hidden="true">' + nr + '</span>' : esc(t('rt.waze'))) + '</a>';
        }).join('') + '</div></div>';
    }
    html += '<button type="button" class="yg-btn yg-btn--outline yg-btn--block" data-actie="deel">' + esc(t('rt.share')) + '</button>';
    html += '<input type="text" id="yg-rt-link" class="yg-rt-link" readonly hidden aria-label="' + esc(t('rt.share')) + '">';
    html += '<button type="button" class="yg-btn yg-btn--ghost" data-actie="leeg">' + esc(t('rt.clear')) + '</button>';
    paneel.innerHTML = html;
  }

  function knoppenPerDeel(rij, sleutel, maakLink, klasse) {
    if (rij.length === 1) return '<a class="yg-btn ' + klasse + ' yg-btn--block" href="' + esc(maakLink(rij[0], 0)) + '" target="_blank" rel="noopener">' + esc(t(sleutel)) + '</a>';
    return '<div class="yg-rt-delen"><span class="yg-label">' + esc(t(sleutel)) + '</span><div class="yg-routepaneel__apps">' + rij.map(function (dl, k) {
      return '<a class="yg-btn ' + klasse + '" href="' + esc(maakLink(dl, k)) + '" target="_blank" rel="noopener">' + esc(t('rt.part', { i: k + 1, a: dl.van, b: dl.tot })) + '</a>';
    }).join('') + '</div></div>';
  }

  // ── Kaart: genummerde stops en een stippellijn in de volgorde ────────
  // De lijn is de volgorde, niet de weg: daarom gestippeld en zonder afstand.
  function opKaart(map) {
    if (!window.L || !map) return;
    kaartLaag = L.layerGroup().addTo(map);
    tekenKaart();
  }
  function tekenKaart() {
    if (!kaartLaag) return;
    kaartLaag.clearLayers();
    var p = punten();
    if (p.length > 1) L.polyline(p.map(function (s) { return [s.lat, s.lng]; }), { color: '#1E2922', weight: 3, opacity: .55, dashArray: '2 8', lineCap: 'round', interactive: false }).addTo(kaartLaag);
    stops.forEach(function (s, i) {
      L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: 'yg-rt-pin', html: '<span class="yg-stop yg-stop--' + s.soort + '">' + (i + 1) + '</span>', iconSize: [30, 30], iconAnchor: [15, 15] }),
        keyboard: false, zIndexOffset: 1000, title: (i + 1) + '. ' + s.titel
      }).on('click', function () { open(true); }).addTo(kaartLaag);
    });
    if (actief.start) {
      L.marker([actief.start.lat, actief.start.lng], {
        icon: L.divIcon({ className: 'yg-rt-pin', html: '<span class="yg-stop yg-stop--start">⌂</span>', iconSize: [30, 30], iconAnchor: [15, 15] }),
        keyboard: false, interactive: false
      }).addTo(kaartLaag);
    }
  }

  function meld(tekst) { var p = document.getElementById('yg-route-live'); if (p) p.textContent = tekst; }

  window.YGRoute = { knop: knop, heeft: heeft, open: function () { open(true); }, opKaart: opKaart, openOp: openOp };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bouw); else bouw();
})();
