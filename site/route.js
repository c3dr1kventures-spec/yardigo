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
// Opslag: localStorage; wie in /app is ingelogd, krijgt de routes ook in zijn
// account (tabel opgeslagen_routes, opgeslagen-routes.sql). Deellinks
// (/kaart?r=<code> met account, anders /kaart?stops=…) bevatten nooit start of eind.
// Knoppen elders: YGRoute.knop(stop) geeft HTML; klikken gaat via één
// luisteraar op het document. Kaart: YGRoute.opKaart(map) tekent de stops.
// Vereist: site.js (window.YG); kaart.js (window.YGKaart) voor plaatsen zoeken
// en controle van verkopen.
// In de app (app.html): window.YG_ROUTE_HOUDER = element waarin het paneel vast
// staat (geen zwevende knop, geen sluitknop); window.YG_ROUTE_BASIS = adres voor
// deellinks (https://yardigo.nl); window.YG_ROUTE_TOON() = naar het paneel gaan;
// window.YG_ROUTE_POORT() = false als toevoegen nu niet mag (de app: eerst inloggen).
// Op de website: zonder account tot GRATIS stops; daarna eerst inloggen via /app.
// Routeplanner (/route, route.html): window.YG_ROUTE_PAGINA = element voor de
// stoplijst, YG_ROUTE_BALK = de balk onderaan (overzicht, delen, navigatie),
// YG_ROUTE_DAG = de regel met datum, vertrek, start, einde en vervoer. Klik op
// een stop of pin: event 'yg-route-toon' (detail: { stop, nr }) voor de detailkolom
// (site/routepagina.js). Deellinks: /route/<code> (account) of /route?stops=….
// Stops met exact: true (de app kent soms het echte adres) gaan nooit precies
// mee in een deellink: dan alleen het gebied.
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
  var terug = null;   // { stops, geweest, tekst }: om weghalen of leegmaken ongedaan te maken
  var controle = {};   // id → 'weg' | 'gewijzigd' (na controle bij openen)
  var kaartLaag = null;
  var BASIS = window.YG_ROUTE_BASIS || location.origin;
  function ingebed() { return !!window.YG_ROUTE_HOUDER; }
  function pagina() { return !!window.YG_ROUTE_PAGINA; }
  var balk = null, dagEl = null, gekozen = null, opties = false, deelNu = null, geslimd = false;
  var beelden = {};   // verkoop-id → { foto, sfeer } (uit de kaartlijst)
  // Op de routeplanner staan velden ook buiten het paneel (balk, dagregel).
  function vind(sel) { return (pagina() ? document : paneel).querySelector(sel); }

  function opslaan() { schrijf(SLEUTEL, routes); synchroniseerLater(); }
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
  geslimd = !!actief.slim;   // de volgorde is door de routedienst bepaald (blijft na herladen)

  function bewaar() {
    actief.stops = stops;
    if (geslimd) actief.slim = true; else delete actief.slim;
    actief.bijgewerkt = Date.now();
    opslaan();
    schrijf(ACTIEF, actief.id);
    werkKnoppenBij(); tekenPaneel(); tekenKaart();
    meldWijziging();
    // Routeplanner: foto's ophalen voor stops die er net bij kwamen.
    if (pagina() && stops.some(function (s) { return s.soort !== 'winkel' && !beelden[s.id]; })) controleer();
  }
  function meldWijziging() { try { document.dispatchEvent(new CustomEvent('yg-route-wijzig')); } catch (e) { /* oude browser */ } }
  function kies(r) { actief = r; stops = r.stops; geslimd = !!r.slim; controle = {}; bewaar(); controleer(); }

  function plek(id) { for (var i = 0; i < stops.length; i++) if (stops[i].id === id) return i; return -1; }
  function heeft(id) { return plek(id) > -1; }

  // Mag er iets bij? Weghalen mag altijd. Wie ooit in /app inlogde (ook met een
  // verlopen sessie) heeft een account en plant onbeperkt.
  var GRATIS = 3, grens = false;
  function magToevoegen() {
    if (typeof window.YG_ROUTE_POORT === 'function') return window.YG_ROUTE_POORT() !== false;
    if (stops.length < GRATIS || heeftAccount()) return true;
    grens = true; weergave = 'route';
    open(true); meld(t('rt.limit'));
    return false;
  }
  function heeftAccount() { var s = lees(SESSIE); return !!(s && s.user && s.user.id); }
  function wissel(stop) {
    var i = plek(stop.id);
    if (i < 0 && !magToevoegen()) return;
    terug = null; geslimd = false;
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
      var anders = false, nieuwBeeld = false;
      verkopen.forEach(function (s) {
        var v = per[s.id];
        if (!beelden[s.id]) { beelden[s.id] = v ? { foto: v.foto || null, sfeer: v.sfeer || null } : {}; nieuwBeeld = nieuwBeeld || !!v; }
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
      else if (nieuwBeeld && pagina()) tekenPaneel();
    }).catch(function () { /* geen verbinding: dan zonder controle */ });
  }
  // Beeld bij een stop: eigen foto, anders de illustratie van de soort.
  function beeldVan(s) {
    if (s.soort === 'winkel') return '/site/img/winkel.svg';
    var b = beelden[s.id];
    return (b && b.foto) || '/site/img/sfeer/' + ((b && b.sfeer) || s.soort) + '.svg';
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

  // ── Reistijden over de weg (Edge Function route-plan → OpenRouteService) ──
  // Alleen opnieuw rekenen als de punten of het vervoer veranderen; datum,
  // vertrektijd en bezoekduur rekenen we hier zelf door. Lukt het niet, dan
  // blijft de vogelvlucht-schatting staan, zonder aankomsttijden.
  var BEZOEK = { oprit: 20, route: 90, markt: 60, winkel: 30 };
  var BEZOEK_KEUZE = [10, 15, 20, 30, 45, 60, 90, 120, 180];
  var reis = null, reisTimer = null, reisBezig = false;
  var omweg = {}, omwegSleutel = '';
  function bezoekVan(s) { return s.bezoek || BEZOEK[s.soort] || 30; }
  function routedienst(body) {
    var K = window.YGKaart;
    if (!K) return Promise.reject(new Error('geen kaart.js'));
    return fetch(K.SUPABASE_URL + '/functions/v1/route-plan', {
      method: 'POST',
      headers: { apikey: K.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + K.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok || j.fout) throw new Error(j.fout || r.status); return j; }); });
  }
  function lngLat(p) { return [+p.lng.toFixed(4), +p.lat.toFixed(4)]; }
  // De punten waar de reis langs gaat: start, de stops die nog komen, einde.
  function reisPunten() {
    var p = teBezoeken().slice();
    if (actief.start) p.unshift(actief.start);
    var e = eindPunt();
    if (e && p.length) p.push(e);
    return p;
  }
  function reisSleutel() { return actief.vervoer + '|' + reisPunten().map(function (p) { return lngLat(p).join(','); }).join(';'); }
  function planReis() {
    var sleutel = reisSleutel(), p = reisPunten();
    if (p.length < 2) { reis = null; return; }
    if (reis && reis.sleutel === sleutel) return;
    clearTimeout(reisTimer);
    reisTimer = setTimeout(function () {
      reisBezig = true;
      routedienst({ actie: 'lijn', vervoer: actief.vervoer, punten: p.map(lngLat) }).then(function (j) {
        reis = { sleutel: sleutel, afstand: j.afstand, duur: j.duur, delen: j.delen || [], lijn: j.lijn || [] };
      }).catch(function () {
        reis = { sleutel: sleutel, fout: true };
      }).then(function () { reisBezig = false; if (reisSleutel() === sleutel) { tekenPaneel(); tekenKaart(); } });
    }, 700);
  }
  function minNaarTijd(m) { m = Math.round(m); return Math.floor(m / 60 % 24) + ':' + ('0' + m % 60).slice(-2); }
  function tijdNaarMin(s) { var m = /^(\d{1,2}):(\d{2})/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; }
  // Openingsvensters (minuten) van een stop op de dag van de route; null = onbekend.
  function vensters(s) {
    if (s.soort === 'winkel') return openOp(s.tijden, routeDatum());
    var b = tijdNaarMin(s.begin), e = tijdNaarMin(s.eind);
    return b != null ? [[b, e != null && e > b ? e : 24 * 60]] : null;
  }
  // Aankomst, wachttijd en melding per stop, uit de reistijden en de bezoekduur.
  function planning() {
    if (!reis || reis.fout || reis.sleutel !== reisSleutel()) return null;
    var rij = teBezoeken(), uit = {}, t = tijdNaarMin(actief.vertrek) || 540, deel = 0;
    rij.forEach(function (s, i) {
      if (actief.start || i > 0) t += (reis.delen[deel++] || { duur: 0 }).duur / 60;
      var aankomst = t, v = vensters(s), wacht = 0, laat = false;
      if (v && v.length) {
        var blok = v.filter(function (x) { return x[1] > aankomst; })[0];
        if (!blok) laat = true;
        else if (blok[0] > aankomst) wacht = blok[0] - aankomst;
      }
      uit[s.id] = { aankomst: aankomst, wacht: wacht, laat: laat };
      t = aankomst + wacht + bezoekVan(s);
    });
    if (eindPunt() && rij.length) t += (reis.delen[deel] || { duur: 0 }).duur / 60;
    return { stops: uit, klaar: t, km: reis.afstand / 1000, reistijd: reis.duur / 60 };
  }
  function duurTekst(min) { min = Math.round(min); return min < 60 ? t('rt.min', { n: min }) : min % 60 ? t('rt.hmin', { u: Math.floor(min / 60), m: ('0' + min % 60).slice(-2) }) : t('rt.h', { u: min / 60 }); }

  // Slimme volgorde via de routedienst: past in de openingstijden, met bezoekduur.
  function slimOverDeWeg() {
    var rij = teBezoeken(), rest = stops.filter(function (s) { return rij.indexOf(s) < 0; });
    if (rij.length < 2) { slimmeVolgorde(); return; }
    var start = actief.start || lees('yg-plek');
    if (!start || typeof start.lat !== 'number') start = rij[0];
    var knop = paneel && vind('[data-actie="kortste"]');
    if (knop) { knop.disabled = true; knop.textContent = t('rt.ordering'); }
    routedienst({
      actie: 'optimaliseer', vervoer: actief.vervoer, start: lngLat(start), eind: eindPunt() ? lngLat(eindPunt()) : null,
      vertrek: (tijdNaarMin(actief.vertrek) || 540) * 60,
      stops: rij.map(function (s) {
        var v = vensters(s) || [];
        return { id: s.id, plek: lngLat(s), bezoek: bezoekVan(s) * 60, vensters: v.map(function (x) { return [x[0] * 60, x[1] * 60]; }) };
      })
    }).then(function (j) {
      var per = {};
      rij.forEach(function (s) { per[s.id] = s; });
      var nieuw = j.volgorde.map(function (id) { return per[id]; }).filter(Boolean);
      var past = j.niet.map(function (id) { return per[id]; }).filter(Boolean);
      stops.splice.apply(stops, [0, stops.length].concat(nieuw, past, rest));
      geslimd = true;
      bewaar();
      meld(past.length ? t('rt.orderedNot', { n: past.length }) : t('rt.orderedRoad'));
      if (past.length) { var p = paneel && paneel.querySelector('.yg-rt-som'); if (p) p.insertAdjacentHTML('afterend', '<p class="yg-routepaneel__let" role="status">' + esc(t('rt.orderedNot', { n: past.length })) + '</p>'); }
    }).catch(function () { slimmeVolgorde(); });
  }

  // Omrijtijd voor de suggesties: één afstandstabel voor route + kandidaten.
  function planOmweg(lijst) {
    var p = punten();
    if (!lijst.length || p.length < 2 || p.length + lijst.length > 27) return;
    var sleutel = actief.vervoer + '|' + p.map(function (x) { return lngLat(x).join(','); }).join(';') + '|' + lijst.map(function (x) { return x.stop.id; }).sort().join(',');
    if (sleutel === omwegSleutel) return;
    omwegSleutel = sleutel;
    var alle = p.concat(lijst.map(function (x) { return x.stop; }));
    routedienst({ actie: 'matrix', vervoer: actief.vervoer, punten: alle.map(lngLat) }).then(function (j) {
      if (omwegSleutel !== sleutel) return;
      omweg = {};
      lijst.forEach(function (x, k) {
        var c = p.length + k, a = Math.max(0, x.na - 1), b = Math.min(p.length - 1, x.na), d = j.duur;
        if (p.length === 1 || a === b) return;
        if (d[a][c] == null || d[c][b] == null || d[a][b] == null) return;
        omweg[x.stop.id] = Math.max(0, (d[a][c] + d[c][b] - d[a][b]) / 60);
      });
      tekenPaneel();
    }).catch(function () { /* dan blijft de afstand in vogelvlucht staan */ });
  }

  // ── Suggesties langs de route ────────────────────────────────────────
  // Verkopen en winkels die op de dag van de route open zijn en dicht bij de
  // lijn tussen je stops liggen. Nooit automatisch toegevoegd. 'bron' laat
  // later ruimte voor gesponsorde stops; nu altijd 'nabij'.
  var kandidaten = null, winkelsGeladen = false;
  var MARGE_KM = { auto: 3, fiets: 1.5, lopen: 0.7 };
  function laadKandidaten() {
    var K = window.YGKaart;
    if (!K || kandidaten) return;
    kandidaten = [];
    K.laad().then(function (lijst) {
      lijst.forEach(function (v) { kandidaten.push(K.stopVan(Object.assign({ dagen: [v.van] }, v))); });
      tekenPaneel(); if (pagina()) tekenKaart();
    }).catch(function () {});
  }
  function laadWinkels() {
    var K = window.YGKaart;
    if (!K || winkelsGeladen || !kandidaten) return;
    winkelsGeladen = true;
    K.winkels().then(function (lijst) {
      lijst.forEach(function (w) { kandidaten.push(K.stopWinkel(w)); });
      tekenPaneel(); if (pagina()) tekenKaart();
    }).catch(function () { winkelsGeladen = false; });
  }
  // Afstand (km) van punt p tot het lijnstuk a-b, in een platte projectie rond a.
  function totLijn(p, a, b) {
    var c = Math.cos(a.lat * Math.PI / 180), k = 111.32;
    var bx = (b.lng - a.lng) * c * k, by = (b.lat - a.lat) * k, px = (p.lng - a.lng) * c * k, py = (p.lat - a.lat) * k;
    var l = bx * bx + by * by, f = l ? Math.max(0, Math.min(1, (px * bx + py * by) / l)) : 0;
    var dx = px - f * bx, dy = py - f * by;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function suggesties() {
    if (!kandidaten || stops.length < 1) return [];
    var d = routeDatum(), p = punten(), marge = MARGE_KM[actief.vervoer] || 3;
    var gekozen = {};
    stops.forEach(function (s) { gekozen[s.id] = true; });
    var uit = [];
    kandidaten.forEach(function (c) {
      if (gekozen[c.id]) return;
      if (c.soort === 'winkel') { var o = openOp(c.tijden, d); if (!o || !o.length) return; }
      else if (!c.van || d < c.van || d > c.tot) return;
      var best = Infinity, na = 0;
      if (p.length === 1) best = km(c, p[0]);
      for (var i = 1; i < p.length; i++) { var x = totLijn(c, p[i - 1], p[i]); if (x < best) { best = x; na = i; } }
      if (best <= marge) uit.push({ stop: c, km: best, na: na, bron: 'nabij' });
    });
    var volg = { oprit: 0, route: 1, markt: 2, winkel: 3 };
    // Eerst de beste vijf op vogelvlucht kiezen; zodra de omrijtijd bekend is, die volgorde.
    var top = uit.sort(function (a, b) { return (volg[a.stop.soort] - volg[b.stop.soort]) || a.km - b.km; }).slice(0, 5);
    var bekend = function (x) { return omweg[x.stop.id] != null; };
    if (top.every(bekend)) top.sort(function (a, b) { return (volg[a.stop.soort] - volg[b.stop.soort]) || omweg[a.stop.id] - omweg[b.stop.id]; });
    return top;
  }
  // Toevoegen op de plek waar hij het minst omrijdt: na de stop waar hij het dichtst bij ligt.
  function voegSuggestieToe(id) {
    var s = suggesties().filter(function (x) { return x.stop.id === id; })[0];
    if (!s || !magToevoegen()) return;
    var plekInStops = Math.max(0, s.na - (actief.start ? 1 : 0));
    stops.splice(Math.min(plekInStops, stops.length), 0, s.stop);
    bewaar();
    meld(t('rt.added', { t: s.stop.titel }));
  }
  function suggestieHtml() {
    laadKandidaten();
    var lijst = suggesties();
    planOmweg(lijst);
    var html = '<section class="yg-rt-sugg" aria-labelledby="yg-rt-sugg-kop"><h3 id="yg-rt-sugg-kop">' + esc(t('rt.suggTitle')) + '</h3>';
    if (lijst.length) {
      var winkels = lijst.filter(function (x) { return x.stop.soort === 'winkel'; }).length;
      html += '<p class="yg-meta">' + esc(t((winkels === lijst.length ? 'rt.suggShops' : 'rt.suggN') + (lijst.length === 1 ? '1' : ''), { n: lijst.length })) + '</p><ul>';
      html += lijst.map(function (x) {
        var s = x.stop, info = s.soort === 'winkel' ? stopInfo(s).tijd : [s.begin ? hhmm(s.begin) + (s.eind ? '-' + hhmm(s.eind) : '') : ''].join('');
        return '<li><span class="yg-stop yg-stop--' + s.soort + '" aria-hidden="true"></span><span class="yg-routelijst__txt"><strong>' + esc(s.titel) + '</strong>' +
          '<span class="yg-meta">' + esc([s.soort === 'winkel' ? s.sub : '', s.plaats, info, (omweg[s.id] != null ? t('rt.detour', { n: Math.max(1, Math.round(omweg[s.id])) }) : t('rt.suggKm', { km: x.km < 1 ? x.km.toFixed(1).replace('.', ',') : Math.round(x.km) }))].filter(Boolean).join(' · ')) + '</span></span>' +
          '<button type="button" class="yg-btn yg-btn--outline" data-actie="sugg" data-sid="' + esc(s.id) + '" aria-label="' + esc(t('rt.add') + ': ' + s.titel) + '">' + esc(t('rt.add')) + '</button></li>';
      }).join('') + '</ul>';
    } else html += '<p class="yg-meta">' + esc(t(kandidaten && kandidaten.length ? 'rt.suggNone' : 'rt.suggLoading')) + '</p>';
    if (!winkelsGeladen) html += '<button type="button" class="yg-btn yg-btn--ghost" data-actie="suggWinkels">' + esc(t('rt.suggShopsOn')) + '</button>';
    return html + '</section>';
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
    // Vanaf nov 2026 een object met naam, datum en vervoer; per stop ook de dagen,
    // tijden en (winkel) openingstijden. Oude links (alleen de rij) blijven werken.
    var rij = stops.map(function (s) {
      var n = geheim(s) ? 2 : 5;
      var x = [s.id, s.titel, s.soort, +s.lat.toFixed(n), +s.lng.toFixed(n), s.plaats || '', s.sub || '', s.benadering || geheim(s) ? 1 : 0,
        s.van || 0, s.tot || 0, s.begin ? String(s.begin).slice(0, 5) : 0, s.eind ? String(s.eind).slice(0, 5) : 0, s.tijden || 0];
      while (x.length > 8 && !x[x.length - 1]) x.pop();
      return x;
    });
    var pak = { s: rij };
    if (actief.naam) pak.n = actief.naam.slice(0, 80);
    if (actief.datum) pak.d = actief.datum;
    if (actief.vertrek && actief.vertrek !== '09:00') pak.t = actief.vertrek;
    if (actief.vervoer && actief.vervoer !== 'auto') pak.v = actief.vervoer;
    var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(pak)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return BASIS + '/route?stops=' + b64;
  }
  // Een echt adres van een garagesale of rommelroute (alleen in de app bekend).
  function geheim(s) { return !!s.exact && (s.soort === 'oprit' || s.soort === 'route'); }
  function heeftGeheim(r) { return r.stops.some(geheim); }
  function laadGedeeld(rij, naam, extra) {
    var r = stops.length ? legeRoute(naam || t('rt.sharedName')) : actief;
    if (r !== actief) routes.unshift(r); else if (naam) r.naam = naam;
    r.stops = rij;
    if (extra) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(extra.datum || '')) r.datum = extra.datum;
      if (/^\d{2}:\d{2}$/.test(extra.vertrek || '')) r.vertrek = extra.vertrek;
      if (['auto', 'fiets', 'lopen'].indexOf(extra.vervoer) > -1) r.vervoer = extra.vervoer;
    }
    kies(r);
    meld(t('rt.loaded', { n: rij.length }));
    open(true);
  }
  function leesDeelLink() {
    // /route/<code> (routeplanner) of ?r=<code> (oude links via /kaart).
    var pad = /^\/route\/([A-Za-z0-9]{8,16})\/?$/.exec(location.pathname);
    var code = pad ? pad[1] : new URLSearchParams(location.search).get('r');
    if (code && /^[A-Za-z0-9]{8,16}$/.test(code)) {
      try { var u0 = new URL(location.href); u0.searchParams.delete('r'); history.replaceState(history.state, '', (pad ? '/route' : u0.pathname) + u0.search + u0.hash); } catch (e) { /* link blijft staan */ }
      api('rpc/get_gedeelde_route', { method: 'POST', body: JSON.stringify({ p_code: code }) }, false).then(function (rij) {
        var x = rij && rij[0];
        if (!x || !Array.isArray(x.stops)) { meld(t('rt.shareGone')); return; }
        laadGedeeld(x.stops.filter(function (s) { return s && SOORTEN.indexOf(s.soort) > -1 && isFinite(s.lat) && isFinite(s.lng); }).slice(0, 50), x.naam, { datum: x.datum, vervoer: x.vervoer });
      }).catch(function () { meld(t('rt.shareGone')); });
      return;
    }
    var ruw = new URLSearchParams(location.search).get('stops');
    if (!ruw) return;
    var pak;
    try { pak = JSON.parse(decodeURIComponent(escape(atob(ruw.replace(/-/g, '+').replace(/_/g, '/'))))); } catch (e) { return; }
    var rij = Array.isArray(pak) ? pak : pak && Array.isArray(pak.s) ? pak.s : null;
    if (!rij) return;
    var tekst = function (x, n) { return typeof x === 'string' ? x.slice(0, n || 120) : ''; };
    var dag = function (x) { return /^\d{4}-\d{2}-\d{2}$/.test(x || '') ? x : null; };
    var uur = function (x) { return /^\d{2}:\d{2}$/.test(x || '') ? x : null; };
    var nieuw = rij.slice(0, 25).filter(function (x) {
      return Array.isArray(x) && typeof x[0] === 'string' && SOORTEN.indexOf(x[2]) > -1 && isFinite(x[3]) && isFinite(x[4]) && Math.abs(x[3]) <= 90 && Math.abs(x[4]) <= 180;
    }).map(function (x) {
      var s = { id: tekst(x[0]), titel: tekst(x[1]), soort: x[2], lat: +x[3], lng: +x[4], plaats: tekst(x[5]), sub: tekst(x[6]), benadering: !!x[7] };
      if (s.soort === 'winkel') s.tijden = tekst(x[12], 300) || null;
      else { s.van = dag(x[8]); s.tot = dag(x[9]) || s.van; s.begin = uur(x[10]); s.eind = uur(x[11]); }
      return s;
    });
    try { var u = new URL(location.href); u.searchParams.delete('stops'); history.replaceState(history.state, '', u.pathname + u.search + u.hash); } catch (e) { /* oude browser: link blijft staan */ }
    // Een gedeelde route wordt een eigen route in Mijn routes; je huidige blijft bewaard.
    if (nieuw.length) laadGedeeld(nieuw, pak.n ? tekst(pak.n, 80) : '', Array.isArray(pak) ? null : { datum: pak.d, vertrek: pak.t, vervoer: pak.v });
  }
  function deel(b) {
    // Met een echt adres erin: nooit via de server delen (die link toont de stops zoals bewaard).
    if (sessie() && !heeftGeheim(actief)) {
      if (!actief.deelCode) { actief.deelCode = maakCode(); opslaan(); }
      upsert(actief).then(function () { deelUrl(b, BASIS + '/route/' + actief.deelCode); })
        .catch(function () { deelUrl(b, deelLink()); });
      return;
    }
    deelUrl(b, deelLink());
  }
  function maakCode() {
    var tekens = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789', a = new Uint8Array(10), uit = '';
    crypto.getRandomValues(a);
    for (var i = 0; i < a.length; i++) uit += tekens[a[i] % tekens.length];
    return uit;
  }
  function deelUrl(b, url) {
    // Routeplanner: eigen deelvenster met WhatsApp, Facebook, e-mail en kopiëren.
    if (pagina()) { deelNu = url; opties = false; tekenBalk(); var k = vind('#yg-rp-deel'); if (k) k.focus(); return; }
    if (navigator.share) { navigator.share({ title: actief.naam || t('rt.shareTitle'), url: url }).catch(function () {}); return; }
    var klaar = function () { b.textContent = t('rt.copied'); meld(t('rt.copied')); setTimeout(function () { b.textContent = t('rt.share'); }, 2500); };
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(klaar, function () { toonLink(url); });
    else toonLink(url);
  }
  // Zonder klembord: de link in een veld om zelf te kopiëren (geen browserdialoog).
  function toonLink(url) {
    var vak = vind('#yg-rt-link');
    if (vak) { vak.hidden = false; vak.value = url; vak.select(); }
  }

  // ── Start- en eindpunt ───────────────────────────────────────────────
  function zetPunt(welk, keuze, invoer) {
    var fout = vind('#yg-rt-' + welk + '-fout');
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
    var fout = vind('#yg-rt-' + welk + '-fout');
    if (fout) { fout.textContent = t(sleutel); fout.hidden = false; }
  }

  // ── Slepen (muis en touch); de pijltjesknoppen blijven voor wie niet sleept ──
  // Luistert op het document: een element verplaatsen in de lijst laat de pointer-capture los.
  function sleepStart(e, greep) {
    var li = greep.closest('li'), lijst = li && li.parentNode;
    if (!li || e.button > 0) return;
    e.preventDefault();
    li.classList.add('is-sleep');
    document.body.classList.add('yg-sleept');
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
      document.body.classList.remove('yg-sleept');
      var volgorde = Array.prototype.map.call(lijst.children, function (x) { return +x.getAttribute('data-i'); });
      var nieuw = volgorde.map(function (i) { return stops[i]; });
      if (volgorde.some(function (v, i) { return v !== i; })) { geslimd = false; stops.splice.apply(stops, [0, stops.length].concat(nieuw)); bewaar(); meld(t('rt.moved')); }
    };
    document.addEventListener('pointermove', beweeg);
    document.addEventListener('pointerup', los);
    document.addEventListener('pointercancel', los);
  }

  // ── Paneel ───────────────────────────────────────────────────────────
  function bouw() {
    if (pagina()) {
      var q = function (x) { return typeof x === 'string' ? document.querySelector(x) : x; };
      paneel = q(window.YG_ROUTE_PAGINA);
      paneel.classList.add('yg-rp-lijst');
      balk = q(window.YG_ROUTE_BALK) || null;
      dagEl = q(window.YG_ROUTE_DAG) || null;
    }
    else if (ingebed()) {
      paneel = document.createElement('section');
      paneel.id = 'yg-route';
      paneel.className = 'yg-routepaneel yg-routepaneel--ingebed';
      paneel.setAttribute('aria-labelledby', 'yg-route-kop');
      var houder = typeof window.YG_ROUTE_HOUDER === 'string' ? document.querySelector(window.YG_ROUTE_HOUDER) : window.YG_ROUTE_HOUDER;
      (houder || document.body).appendChild(paneel);
    }
    else bouwZwevend();
    var live = document.createElement('p');
    live.id = 'yg-route-live';
    live.className = 'yg-sr';
    live.setAttribute('aria-live', 'polite');
    document.body.appendChild(live);
    bouwLuisteraars();
    tekenPaneel();
  }
  function bouwZwevend() {
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
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !paneel.hidden) open(false); });
  }
  function bouwLuisteraars() {
    [balk, dagEl].forEach(function (el) {
      if (!el) return;
      el.addEventListener('click', klik);
      el.addEventListener('change', wijzig);
      el.addEventListener('submit', function (e) { e.preventDefault(); var f = e.target; if (f.getAttribute('data-punt')) zetPunt(f.getAttribute('data-punt'), 'plaats', f.querySelector('input').value); });
    });
    if (pagina()) document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && (deelNu || opties)) { deelNu = null; opties = false; tekenBalk(); }
    });
    paneel.addEventListener('click', klik);
    paneel.addEventListener('change', wijzig);
    paneel.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      if (f.getAttribute('data-punt')) zetPunt(f.getAttribute('data-punt'), 'plaats', f.querySelector('input').value);
      else if (f.id === 'yg-rt-naam-form') {
        var r = routes.filter(function (x) { return x.id === hernoem; })[0];
        if (r) { r.naam = f.querySelector('input').value.trim().slice(0, 80); r.bijgewerkt = Date.now(); }
        hernoem = null; opslaan(); tekenPaneel(); meld(t('rt.renamed'));
      }
    });
    paneel.addEventListener('pointerdown', function (e) {
      var g = e.target.closest('.yg-routelijst__greep');
      if (g) sleepStart(e, g);
    });
    werkKnoppenBij();
    leesDeelLink();
    controleer();
    haalAccount();
  }

  function onthoud(tekst) { terug = { stops: stops.slice(), geweest: actief.geweest.slice(), tekst: tekst }; }

  function klik(e) {
    var b = e.target.closest('button');
    if (!b) {
      // Routeplanner: klik op een stopkaart toont hem in de detailkolom.
      var kaart = pagina() && e.target.closest('[data-toon]');
      if (kaart && !e.target.closest('a, select, label, .yg-routelijst__greep')) toon(+kaart.getAttribute('data-toon'));
      return;
    }
    if (b.getAttribute('data-actie') !== 'ongedaan') terug = terug && b.getAttribute('data-actie') !== 'weg' && b.getAttribute('data-actie') !== 'leeg' ? null : terug;
    var i = Number(b.getAttribute('data-i'));
    var actie = b.getAttribute('data-actie');
    var rid = b.getAttribute('data-rid');
    if (actie === 'op' || actie === 'neer') geslimd = false;
    var r = rid && routes.filter(function (x) { return x.id === rid; })[0];
    if (actie === 'sluit') open(false);
    else if (actie === 'grensNee') { grens = false; tekenPaneel(); focusKop(); }
    else if (actie === 'grootte') { paneel.classList.toggle('is-vol'); tekenPaneel(); var gr = paneel.querySelector('[data-actie="grootte"]'); if (gr) gr.focus(); }
    else if (actie === 'op' && i > 0) { stops.splice(i - 1, 0, stops.splice(i, 1)[0]); bewaar(); focusOp('op', i - 1); }
    else if (actie === 'neer' && i < stops.length - 1) { stops.splice(i + 1, 0, stops.splice(i, 1)[0]); bewaar(); focusOp('neer', i + 1); }
    else if (actie === 'weg') { onthoud(t('rt.removed', { t: stops[i].titel })); stops.splice(i, 1); bewaar(); focusKop(); }
    else if (actie === 'leeg') { onthoud(t('rt.cleared')); stops.splice(0, stops.length); actief.geweest = []; bewaar(); focusKop(); }
    else if (actie === 'ongedaan' && terug) {
      stops.splice.apply(stops, [0, stops.length].concat(terug.stops)); actief.geweest = terug.geweest; terug = null;
      bewaar(); meld(t('rt.undone')); focusKop();
    }
    else if (actie === 'kortste') slimOverDeWeg();
    else if (actie === 'sugg') voegSuggestieToe(b.getAttribute('data-sid'));
    else if (actie === 'suggWinkels') { laadWinkels(); b.disabled = true; }
    else if (actie === 'deel') deel(b);
    else if (actie === 'toon') toon(i);
    else if (actie === 'opties') { opties = !opties; deelNu = null; tekenBalk(); var ob = vind('[data-actie="opties"]'); if (ob) ob.focus(); }
    else if (actie === 'deelDicht') { deelNu = null; tekenBalk(); var db = vind('[data-actie="deel"]'); if (db) db.focus(); }
    else if (actie === 'kopieer' && deelNu) {
      var gekopieerd = function () { b.textContent = t('rt.copied'); meld(t('rt.copied')); };
      if (navigator.clipboard) navigator.clipboard.writeText(deelNu).then(gekopieerd, function () { var v = vind('#yg-rp-deel-link'); if (v) v.select(); });
      else { var v2 = vind('#yg-rp-deel-link'); if (v2) v2.select(); }
    }
    else if (actie === 'deelMeer' && deelNu && navigator.share) navigator.share({ title: naamVan(actief), text: deelTekst(), url: deelNu }).catch(function () {});
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
      kopie.id = nieuwId(); kopie.naam = t('rt.copyOf', { t: naamVan(r) }); kopie.geweest = []; kopie.deelCode = null; kopie.bijgewerkt = Date.now();
      routes.splice(routes.indexOf(r) + 1, 0, kopie);
      opslaan(); tekenPaneel(); meld(t('rt.duplicated'));
    }
    else if (actie === 'wis' && r) { wisVraag = r.id; hernoem = null; tekenPaneel(); }
    else if (actie === 'wisNee') { wisVraag = null; tekenPaneel(); }
    else if (actie === 'wisJa' && r) {
      routes.splice(routes.indexOf(r), 1);
      if (!routes.length) routes.push(legeRoute());
      wisVraag = null;
      if (r === actief) kies(routes[0]); else { opslaan(); tekenPaneel(); }
      meld(t('rt.deleted'));
    }
    else if (b.hasAttribute('data-vervoer')) { actief.vervoer = b.getAttribute('data-vervoer'); bewaar(); }
  }

  function wijzig(e) {
    var el = e.target;
    if (el.id === 'yg-rt-datum') { actief.datum = el.value || ''; bewaar(); }
    else if (el.id === 'yg-rt-vertrek') { actief.vertrek = el.value || '09:00'; bewaar(); }
    else if (el.getAttribute('data-bezoek') != null) {
      var s = stops[+el.getAttribute('data-bezoek')];
      if (s) { s.bezoek = +el.value; bewaar(); var terugFocus = paneel.querySelector('[data-bezoek="' + el.getAttribute('data-bezoek') + '"]'); if (terugFocus) terugFocus.focus(); }
    }
    else if (el.getAttribute('data-punt-keuze')) {
      var welk = el.getAttribute('data-punt-keuze');
      var form = vind('form[data-punt="' + welk + '"]');
      if (el.value === 'plaats') { if (form) { form.hidden = false; form.querySelector('input').focus(); } }
      else { if (form) form.hidden = true; zetPunt(welk, el.value); }
    }
  }

  function focusOp(actie, i) {
    var b = paneel.querySelector('[data-actie="' + actie + '"][data-i="' + i + '"]') || paneel.querySelector('[data-i="' + i + '"] button');
    if (b) b.focus();
  }
  function focusKop() { var h = paneel.querySelector('#yg-route-kop'); if (h) h.focus(); }

  function open(aan) {
    if (pagina()) { if (aan) { weergave = 'route'; tekenPaneel(); } return; }
    if (ingebed()) {
      weergave = 'route'; tekenPaneel();
      if (aan && typeof window.YG_ROUTE_TOON === 'function') window.YG_ROUTE_TOON();
      return;
    }
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
    html += sessie() ? '<p class="yg-meta">' + esc(t('rt.inAccount')) + '</p>'
      : '<p class="yg-meta">' + esc(t('rt.localOnly')) + ' <a href="/app">' + esc(t('rt.login')) + '</a></p>';
    paneel.innerHTML = html; paneel._yg = null;
  }

  function tekenPaneel() {
    if (!paneel || paneel.hidden) return;
    if (weergave === 'lijst') { tekenLijst(); if (pagina()) { tekenBalk(); tekenDag(); } return; }
    if (pagina()) { tekenPagina(); tekenBalk(); tekenDag(); return; }
    var gebied = stops.some(function (s) { return s.benadering; });
    var html = greepHtml() + '<div class="yg-routepaneel__kop"><h2 id="yg-route-kop" tabindex="-1">' + esc(naamVan(actief)) + '</h2>' +
      '<button type="button" class="yg-btn yg-btn--ghost yg-routepaneel__mijn" data-actie="mijn">' + esc(t('rt.myRoutes')) + (routes.length > 1 ? ' (' + routes.length + ')' : '') + '</button>' +
      '<button type="button" class="yg-routepaneel__dicht" data-actie="sluit" aria-label="' + esc(t('rt.close')) + '">×</button></div>';
    if (grens && stops.length < GRATIS) grens = false;
    if (grens) html += '<div class="yg-rt-grens" role="status"><p>' + esc(t('rt.limit')) + '</p><div class="yg-rt-grens__btns">' +
      '<a class="yg-btn yg-btn--primary" href="/app#route">' + esc(t('rt.limitBtn')) + '</a>' +
      '<button type="button" class="yg-btn yg-btn--ghost" data-actie="grensNee">' + esc(t('rt.limitLater')) + '</button></div></div>';
    if (terug) html += '<p class="yg-rt-terug" role="status">' + esc(terug.tekst) + ' <button type="button" class="yg-btn yg-btn--outline" data-actie="ongedaan">' + esc(t('rt.undo')) + '</button></p>';
    if (!ingebed() && stops.length) html += '<a class="yg-btn yg-btn--outline" href="/route">' + esc(t('rp.bigView')) + ' →</a>';
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

    planReis();
    var plan = planning();
    html += '<ol class="yg-routelijst">' + stops.map(function (s, i) {
      var info = stopInfo(s), gehad = actief.geweest.indexOf(s.id) > -1, pl = plan && plan.stops[s.id];
      var regel = [s.soort === 'winkel' ? s.sub : '', s.plaats, info.tijd].filter(Boolean).join(' · ');
      if (pl && pl.laat && !info.let) info.let = t('rt.late', { t: minNaarTijd(pl.aankomst) });
      var tijdregel = gehad || info.let ? '' : '<span class="yg-rt-tijd">' +
        (pl ? '<span>' + esc(t('rt.arrive', { t: minNaarTijd(pl.aankomst) })) + (pl.wacht >= 5 ? ' · ' + esc(t('rt.wait', { n: Math.round(pl.wacht) })) : '') + '</span>' : '') +
        '<label><span class="yg-sr">' + esc(t('rt.visit') + ': ' + s.titel) + '</span><select data-bezoek="' + i + '">' +
        BEZOEK_KEUZE.concat(BEZOEK_KEUZE.indexOf(bezoekVan(s)) < 0 ? [bezoekVan(s)] : []).sort(function (a, b) { return a - b; }).map(function (m) {
          return '<option value="' + m + '"' + (m === bezoekVan(s) ? ' selected' : '') + '>' + esc(t('rt.stay', { d: duurTekst(m) })) + '</option>';
        }).join('') + '</select></label></span>';
      return '<li data-i="' + i + '"' + (gehad ? ' class="is-geweest"' : '') + '>' +
        '<span class="yg-routelijst__greep" aria-hidden="true" title="' + esc(t('rt.drag')) + '">⋮⋮</span>' +
        '<span class="yg-stop yg-stop--' + s.soort + '" aria-hidden="true">' + (i + 1) + '</span>' +
        '<span class="yg-routelijst__txt"><strong>' + esc(s.titel) + '</strong><span class="yg-meta">' + esc(regel) + '</span>' + tijdregel +
        (info.let ? '<span class="yg-routelijst__let">' + esc(info.let) + '</span>' : '') + '</span>' +
        '<span class="yg-routelijst__btns">' +
          '<button type="button" data-actie="geweest" data-i="' + i + '" aria-pressed="' + gehad + '" aria-label="' + esc(t('rt.done') + ': ' + s.titel) + '" title="' + esc(t('rt.done')) + '">✓</button>' +
          '<button type="button" data-actie="op" data-i="' + i + '" aria-label="' + esc(t('rt.up') + ': ' + s.titel) + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button type="button" data-actie="neer" data-i="' + i + '" aria-label="' + esc(t('rt.down') + ': ' + s.titel) + '"' + (i === stops.length - 1 ? ' disabled' : '') + '>↓</button>' +
          '<button type="button" data-actie="weg" data-i="' + i + '" aria-label="' + esc(t('rt.remove') + ': ' + s.titel) + '">×</button>' +
        '</span></li>';
    }).join('') + '</ol>';
    if (plan) html += '<p class="yg-rt-som yg-rt-som--echt"><strong>' + esc(t('rt.sumRoad', { km: Math.round(plan.km), reis: duurTekst(plan.reistijd), klaar: minNaarTijd(plan.klaar) })) + '</strong>' +
      (gebied ? '<span class="yg-meta">' + esc(t('rt.sumApprox')) + '</span>' : '') + '</p>';
    else html += '<p class="yg-meta yg-rt-som">' + esc(t('rt.sum', { n: stops.length, km: Math.round(totaalKm()) })) +
      (reisBezig ? ' ' + esc(t('rt.roadLoading')) : reis && reis.fout ? ' ' + esc(t('rt.roadFail')) : '') + '</p>';
    if (stops.length > 2) html += '<button type="button" class="yg-btn yg-btn--ghost" data-actie="kortste">' + esc(t('rt.order')) + '</button>';
    if (gebied) html += '<p class="yg-routepaneel__let">' + esc(t(ingebed() ? 'rt.approxApp' : 'rt.approx')) + '</p>';
    html += suggestieHtml();

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

  // ── Kaart: genummerde stops en de route ──────────────────────────────
  // Met reistijden: de route over de weg (doorgetrokken). Zonder: alleen de
  // volgorde als stippellijn, want dat is niet de weg.
  function opKaart(map) {
    if (!window.L || !map) return;
    kaartLaag = L.layerGroup().addTo(map);
    tekenKaart();
  }
  function tekenKaart() {
    if (!kaartLaag) return;
    kaartLaag.clearLayers();
    var p = punten();
    planReis();
    if (reis && !reis.fout && reis.sleutel === reisSleutel() && reis.lijn.length > 1) {
      L.polyline(reis.lijn, { color: '#FFFFFF', weight: 8, opacity: .9, interactive: false }).addTo(kaartLaag);
      L.polyline(reis.lijn, { color: '#2A5038', weight: 4, opacity: .9, interactive: false }).addTo(kaartLaag);
      if (pagina()) tekenStukken();
    } else if (p.length > 1) L.polyline(p.map(function (s) { return [s.lat, s.lng]; }), { color: '#1E2922', weight: 3, opacity: .55, dashArray: '2 8', lineCap: 'round', interactive: false }).addTo(kaartLaag);
    // Routeplanner: wat er ook langs de route open is, als kleine pin met een plusje.
    if (pagina()) suggesties().forEach(function (x) {
      var c = x.stop;
      L.marker([c.lat, c.lng], {
        icon: L.divIcon({ className: 'yg-rt-pin', html: '<span class="yg-rp-plus yg-rp-plus--' + c.soort + '">+</span>', iconSize: [24, 24], iconAnchor: [12, 12] }),
        keyboard: false, zIndexOffset: 500, title: t('rp.alsoOpen') + ': ' + c.titel
      }).on('click', function () { bekend[c.id] = c; toonStop(c, null); }).addTo(kaartLaag);
    });
    stops.forEach(function (s, i) {
      L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: 'yg-rt-pin', html: '<span class="yg-stop yg-stop--' + s.soort + (gekozen === s.id ? ' is-gekozen' : '') + '">' + (i + 1) + '</span>', iconSize: [30, 30], iconAnchor: [15, 15] }),
        keyboard: false, zIndexOffset: 1000, title: (i + 1) + '. ' + s.titel
      }).on('click', function () { if (pagina()) toon(i); else open(true); }).addTo(kaartLaag);
    });
    if (actief.start) {
      L.marker([actief.start.lat, actief.start.lng], {
        icon: L.divIcon({ className: 'yg-rt-pin', html: '<span class="yg-stop yg-stop--start">⌂</span>', iconSize: [30, 30], iconAnchor: [15, 15] }),
        keyboard: false, interactive: false
      }).addTo(kaartLaag);
    }
  }

  // Per stuk van de route een label met reistijd en afstand, halverwege op de lijn.
  function tekenStukken() {
    var rp = reisPunten();
    reis.delen.forEach(function (d, k) {
      var a = rp[k], b = rp[k + 1];
      if (!a || !b || !d) return;
      var mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 }, best = null, bestKm = Infinity;
      reis.lijn.forEach(function (q) { var x = km(mid, { lat: q[0], lng: q[1] }); if (x < bestKm) { bestKm = x; best = q; } });
      if (!best) return;
      L.marker(best, {
        icon: L.divIcon({ className: 'yg-rp-stuk', html: '<span><strong>' + esc(duurTekst(d.duur / 60)) + '</strong>' + esc(kmTekst(d.afstand / 1000)) + '</span>', iconSize: null }),
        keyboard: false, interactive: false
      }).addTo(kaartLaag);
    });
  }
  function kmTekst(n) { return (n < 10 ? n.toFixed(1).replace('.', ',') : Math.round(n)) + ' km'; }

  // ── Routeplanner (/route): stopkaarten, dagregel, balk met overzicht ──
  function zetHtml(el, html) { if (el && el._yg !== html) { el._yg = html; el.innerHTML = html; } }
  function toon(i) { var s = stops[i]; if (s) toonStop(s, i + 1); }
  function toonStop(s, nr) {
    gekozen = s.id;
    try { document.dispatchEvent(new CustomEvent('yg-route-toon', { detail: { stop: s, nr: nr } })); } catch (e) { /* oude browser */ }
    if (pagina()) { tekenPaneel(); tekenKaart(); }
  }
  // Reistijd en afstand naar elke stop (vanaf de vorige), als de routedienst ze kent.
  function stukPerStop() {
    var uit = {};
    if (!reis || reis.fout || reis.sleutel !== reisSleutel()) return uit;
    var deel = 0;
    teBezoeken().forEach(function (s, i) {
      if (actief.start || i > 0) { var d = reis.delen[deel++]; if (d) uit[s.id] = d; }
    });
    return uit;
  }
  var ICOON = {
    klok: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    auto: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 17h14v-5l-2-5H7l-2 5z"/><circle cx="8" cy="17" r="1.6"/><circle cx="16" cy="17" r="1.6"/></svg>',
    fiets: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/><path d="M6 16l4-8h5l3 8M10 8l3 8"/></svg>',
    lopen: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="13" cy="4.5" r="1.8"/><path d="M10 21l2-6 3 3v3M9 12l3-4 3 3 3 1M12 8l-3 1-2 3"/></svg>',
    slim: '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8zM19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z"/></svg>',
    deel: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/></svg>',
    opties: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>',
    nav: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M21 3L3 10.5l7.5 3 3 7.5z"/></svg>',
    plek: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>'
  };

  function tekenPagina() {
    var n = stops.length;
    var html = '<div class="yg-rp-kop"><div class="yg-rp-kop__titel"><h1 id="yg-route-kop" tabindex="-1">' + esc(naamVan(actief)) + '</h1>' +
      (n ? '<span class="yg-rp-badge">' + esc(t('rt.stopsN', { n: n })) + '</span>' : '') + '</div>' +
      '<button type="button" class="yg-btn yg-btn--ghost yg-rp-mijn" data-actie="mijn">' + esc(t('rt.myRoutes')) + (routes.length > 1 ? ' (' + routes.length + ')' : '') + '</button></div>';
    if (n > 2) html += '<div class="yg-rp-kop__rij"><p class="yg-meta">' + esc(t('rp.dragHint')) + '</p>' +
      '<button type="button" class="yg-btn yg-rp-slim" data-actie="kortste">' + ICOON.slim + esc(t('rp.optimize')) + '</button></div>';
    else if (n > 1) html += '<p class="yg-meta yg-rp-kop__rij">' + esc(t('rp.dragHint')) + '</p>';
    if (grens && n < GRATIS) grens = false;
    if (grens) html += '<div class="yg-rt-grens" role="status"><p>' + esc(t('rt.limit')) + '</p><div class="yg-rt-grens__btns">' +
      '<a class="yg-btn yg-btn--primary" href="/app#route">' + esc(t('rt.limitBtn')) + '</a>' +
      '<button type="button" class="yg-btn yg-btn--ghost" data-actie="grensNee">' + esc(t('rt.limitLater')) + '</button></div></div>';
    if (terug) html += '<p class="yg-rt-terug" role="status">' + esc(terug.tekst) + ' <button type="button" class="yg-btn yg-btn--outline" data-actie="ongedaan">' + esc(t('rt.undo')) + '</button></p>';
    if (!n) {
      zetHtml(paneel, html + '<div class="yg-rp-leeg"><img src="/site/img/cedrik-kaart.png" alt="" width="150" height="150">' +
        '<h2>' + esc(t('rp.emptyTitle')) + '</h2><p>' + esc(t('rp.emptyTxt')) + '</p>' +
        '<a class="yg-btn yg-btn--primary" href="/kaart">' + esc(t('rp.toMap')) + '</a></div>');
      return;
    }
    planReis();
    var plan = planning(), stuk = stukPerStop(), eerste = teBezoeken()[0];
    var vervoer = ICOON[actief.vervoer] || ICOON.auto;
    html += '<ol class="yg-rp-stops">' + stops.map(function (s, i) {
      var info = stopInfo(s), gehad = actief.geweest.indexOf(s.id) > -1, pl = plan && plan.stops[s.id], d = stuk[s.id];
      if (pl && pl.laat && !info.let) info.let = t('rt.late', { t: minNaarTijd(pl.aankomst) });
      var regel = [s.soort === 'winkel' ? s.sub : '', s.plaats].filter(Boolean).join(' · ');
      var reisRegel = gehad || info.let ? '' : s === eerste && !actief.start ? t('rp.first') :
        d ? duurTekst(d.duur / 60) + ' · ' + kmTekst(d.afstand / 1000) : '';
      var tijdregel = gehad || info.let ? '' : '<span class="yg-rt-tijd">' +
        (pl ? '<span>' + esc(t('rt.arrive', { t: minNaarTijd(pl.aankomst) })) + (pl.wacht >= 5 ? ' · ' + esc(t('rt.wait', { n: Math.round(pl.wacht) })) : '') + '</span>' : '') +
        '<label><span class="yg-sr">' + esc(t('rt.visit') + ': ' + s.titel) + '</span><select data-bezoek="' + i + '">' +
        BEZOEK_KEUZE.concat(BEZOEK_KEUZE.indexOf(bezoekVan(s)) < 0 ? [bezoekVan(s)] : []).sort(function (a, b) { return a - b; }).map(function (m) {
          return '<option value="' + m + '"' + (m === bezoekVan(s) ? ' selected' : '') + '>' + esc(t('rt.stay', { d: duurTekst(m) })) + '</option>';
        }).join('') + '</select></label></span>';
      return '<li data-i="' + i + '" data-toon="' + i + '" class="yg-rp-stop' + (gehad ? ' is-geweest' : '') + (gekozen === s.id ? ' is-gekozen' : '') + '">' +
        '<span class="yg-rp-stop__links"><span class="yg-stop yg-stop--' + s.soort + '" aria-hidden="true">' + (i + 1) + '</span>' +
        '<span class="yg-routelijst__greep" aria-hidden="true" title="' + esc(t('rt.drag')) + '">⋮⋮</span></span>' +
        '<img class="yg-rp-stop__img" src="' + esc(beeldVan(s)) + '" alt="" loading="lazy" width="84" height="84">' +
        '<span class="yg-rp-stop__txt"><button type="button" class="yg-rp-stop__titel" data-actie="toon" data-i="' + i + '">' + esc(s.titel) + '</button>' +
        (regel ? '<span class="yg-meta">' + esc(regel) + '</span>' : '') +
        (info.tijd ? '<span class="yg-rp-stop__r">' + ICOON.klok + esc(info.tijd) + '</span>' : '') +
        (reisRegel ? '<span class="yg-rp-stop__r">' + vervoer + esc(reisRegel) + '</span>' : '') +
        tijdregel + (info.let ? '<span class="yg-routelijst__let">' + esc(info.let) + '</span>' : '') + '</span>' +
        '<span class="yg-routelijst__btns">' +
          '<button type="button" data-actie="geweest" data-i="' + i + '" aria-pressed="' + gehad + '" aria-label="' + esc(t('rt.done') + ': ' + s.titel) + '" title="' + esc(t('rt.done')) + '">✓</button>' +
          '<button type="button" data-actie="weg" data-i="' + i + '" aria-label="' + esc(t('rt.remove') + ': ' + s.titel) + '" title="' + esc(t('rt.remove')) + '">×</button>' +
          '<button type="button" data-actie="op" data-i="' + i + '" aria-label="' + esc(t('rt.up') + ': ' + s.titel) + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button type="button" data-actie="neer" data-i="' + i + '" aria-label="' + esc(t('rt.down') + ': ' + s.titel) + '"' + (i === n - 1 ? ' disabled' : '') + '>↓</button>' +
        '</span></li>';
    }).join('') + '</ol>';
    if (stops.some(function (s) { return s.benadering; })) html += '<p class="yg-routepaneel__let">' + esc(t('rt.approx')) + '</p>';
    html += suggestieHtml();
    html += '<button type="button" class="yg-btn yg-btn--ghost" data-actie="leeg">' + esc(t('rt.clear')) + '</button>';
    zetHtml(paneel, html);
  }

  // Datum, vertrek, start, einde en vervoer als één regel boven de planner.
  function tekenDag() {
    if (!dagEl) return;
    if (!stops.length) { zetHtml(dagEl, ''); dagEl.hidden = true; return; }
    dagEl.hidden = false;
    var d = routeDatum();
    zetHtml(dagEl, '<div class="yg-rp-veld"><label for="yg-rt-datum">' + esc(t('rt.date')) + '</label><input type="date" id="yg-rt-datum" value="' + esc(d) + '" min="' + esc(vandaag()) + '"></div>' +
      '<div class="yg-rp-veld"><label for="yg-rt-vertrek">' + esc(t('rt.depart')) + '</label><input type="time" id="yg-rt-vertrek" value="' + esc(actief.vertrek || '09:00') + '" step="900"></div>' +
      puntKeuze('start').replace('yg-rt-punt', 'yg-rt-punt yg-rp-veld') + puntKeuze('eind').replace('yg-rt-punt', 'yg-rt-punt yg-rp-veld') +
      '<div class="yg-rp-veld"><span class="yg-label" id="yg-rt-hoe">' + esc(t('rt.how')) + '</span><div class="yg-seg" role="group" aria-labelledby="yg-rt-hoe">' +
      [['auto', 'rt.car'], ['fiets', 'rt.bike'], ['lopen', 'rt.walk']].map(function (o) {
        return '<button type="button" data-vervoer="' + o[0] + '" aria-pressed="' + (actief.vervoer === o[0]) + '" aria-label="' + esc(t(o[1])) + '" title="' + esc(t(o[1])) + '">' + ICOON[o[0]] + '</button>';
      }).join('') + '</div></div>');
  }

  function deelTekst() { return t('rp.shareText', { n: stops.length, d: dagNaam(routeDatum(), true) }); }

  function tekenBalk() {
    if (!balk) return;
    if (!stops.length || weergave === 'lijst') { zetHtml(balk, ''); balk.hidden = true; document.body.classList.remove('yg-rp-heeft-balk'); return; }
    balk.hidden = false;
    document.body.classList.add('yg-rp-heeft-balk');
    var plan = planning(), d = routeDatum(), n = stops.length;
    var kmNu = plan ? kmTekst(plan.km) : '± ' + kmTekst(totaalKm());
    var tijd = plan ? duurTekst(plan.reistijd) : reisBezig ? '…' : '–';
    var g = delen(PER_LINK.google), a = delen(PER_LINK.apple);
    var html = '<div class="yg-rp-som"><h2 class="yg-rp-som__kop">' + esc(t('rp.overview')) + '</h2><dl>' +
      '<div>' + (ICOON[actief.vervoer] || ICOON.auto) + '<dt>' + esc(t('rp.total')) + '</dt><dd>' + esc(kmNu) + '</dd></div>' +
      '<div>' + ICOON.klok + '<dt>' + esc(t('rp.travel')) + '</dt><dd>' + esc(tijd) + '</dd></div>' +
      '<div>' + ICOON.plek + '<dt>' + esc(t('rp.stops')) + '</dt><dd>' + esc(String(n)) + ' <small>' + esc(d === vandaag() ? t('when.today') : dagNaam(d, true)) + '</small></dd></div>' +
      '</dl></div>';
    // Cedrik met een tip: wat nu het meeste helpt.
    var tipKop, tipTekst, tipKnop = '';
    if (geslimd) { tipKop = t('rp.tipSmartT'); tipTekst = plan ? t('rp.tipSmartDone', { t: minNaarTijd(plan.klaar) }) : t('rp.tipSmart'); }
    else if (n > 2) { tipKop = t('rp.tipTryT'); tipTekst = t('rp.tipTry'); tipKnop = '<button type="button" class="yg-rp-tip__knop" data-actie="kortste" aria-label="' + esc(t('rp.optimize')) + '">›</button>'; }
    else if (plan) { tipKop = t('rp.tipDoneT'); tipTekst = t('rp.tipDone', { t: minNaarTijd(plan.klaar) }); }
    else { tipKop = t('rp.tipAddT'); tipTekst = t('rp.tipAdd'); }
    html += '<div class="yg-rp-tip"><img src="/site/img/cedrik-zwaai.png" alt="" width="64" height="64"><div class="yg-rp-tip__wolk"><strong>' + esc(tipKop) + '</strong><span>' + esc(tipTekst) + '</span></div>' + tipKnop + '</div>';
    html += '<div class="yg-rp-acties">' +
      '<button type="button" class="yg-btn yg-btn--outline" data-actie="deel" aria-haspopup="dialog" aria-expanded="' + !!deelNu + '">' + ICOON.deel + esc(t('rp.share')) + '</button>' +
      '<button type="button" class="yg-btn yg-btn--outline" data-actie="opties" aria-expanded="' + opties + '" aria-controls="yg-rp-opties">' + ICOON.opties + esc(t('rp.options')) + '</button>';
    if (g.length) html += '<a class="yg-rp-start" href="' + esc(googleLink(g[0], true)) + '" target="_blank" rel="noopener">' + ICOON.nav +
      '<span><strong>' + esc(t(g.length > 1 ? 'rp.startPart' : 'rp.start')) + '</strong><small>' + esc(plan ? kmTekst(plan.km) + ' · ' + duurTekst(plan.reistijd) : t('rp.inGoogle')) + '</small></span></a>';
    else html += '<p class="yg-meta">' + esc(t('rt.allDone')) + '</p>';
    html += '</div>';
    if (opties) {
      var wz = teBezoeken();
      html += '<div class="yg-rp-pop" id="yg-rp-opties" role="region" aria-label="' + esc(t('rp.options')) + '"><div class="yg-rp-pop__kop"><h3>' + esc(t('rp.openIn')) + '</h3>' +
        '<button type="button" class="yg-routepaneel__dicht" data-actie="opties" aria-label="' + esc(t('rt.close')) + '">×</button></div>';
      if (g.length) {
        html += knoppenPerDeel(g, 'rt.google', function (dl, k) { return googleLink(dl, k === 0); }, 'yg-btn--primary');
        html += knoppenPerDeel(a, 'rt.apple', appleLink, 'yg-btn--outline');
        if (g.length > 1 || a.length > 1) html += '<p class="yg-meta">' + esc(t('rt.parts')) + '</p>';
        html += '<div class="yg-routepaneel__waze"><span class="yg-label">' + esc(t(wz.length > 1 ? 'rt.wazeEach' : 'rt.waze')) + '</span><div class="yg-routepaneel__apps">' +
          wz.map(function (s) {
            return '<a class="yg-btn yg-btn--outline" href="' + esc(wazeLink(s)) + '" target="_blank" rel="noopener" aria-label="' + esc(t('rt.wazeTo', { t: s.titel })) + '">' +
              (wz.length > 1 ? '<span class="yg-stop yg-stop--' + s.soort + '" aria-hidden="true">' + (stops.indexOf(s) + 1) + '</span>' : esc(t('rt.waze'))) + '</a>';
          }).join('') + '</div></div>';
      }
      var metMelding = stops.filter(function (s) { return actief.geweest.indexOf(s.id) < 0 && stopInfo(s).let; }).length;
      if (metMelding) html += '<p class="yg-routepaneel__let">' + esc(t('rt.skipped', { n: metMelding })) + '</p>';
      html += '</div>';
    }
    if (deelNu) {
      var tekst = deelTekst(), u = encodeURIComponent(deelNu), tu = encodeURIComponent(tekst + ' ' + deelNu);
      html += '<div class="yg-rp-pop yg-rp-pop--deel" role="dialog" aria-labelledby="yg-rp-deel"><div class="yg-rp-pop__kop"><h3 id="yg-rp-deel" tabindex="-1">' + esc(t('rp.shareTitle')) + '</h3>' +
        '<button type="button" class="yg-routepaneel__dicht" data-actie="deelDicht" aria-label="' + esc(t('rt.close')) + '">×</button></div>' +
        '<p class="yg-meta">' + esc(t('rp.shareIntro')) + '</p><div class="yg-rp-deelapps">' +
        '<a class="yg-rp-app yg-rp-app--wa" href="https://wa.me/?text=' + tu + '" target="_blank" rel="noopener"><span aria-hidden="true">W</span>WhatsApp</a>' +
        '<a class="yg-rp-app yg-rp-app--fb" href="https://www.facebook.com/sharer/sharer.php?u=' + u + '" target="_blank" rel="noopener"><span aria-hidden="true">f</span>Facebook</a>' +
        '<a class="yg-rp-app yg-rp-app--tg" href="https://t.me/share/url?url=' + u + '&amp;text=' + encodeURIComponent(tekst) + '" target="_blank" rel="noopener"><span aria-hidden="true">➤</span>Telegram</a>' +
        '<a class="yg-rp-app yg-rp-app--mail" href="mailto:?subject=' + encodeURIComponent(naamVan(actief)) + '&amp;body=' + encodeURIComponent(tekst + '\n\n' + deelNu) + '"><span aria-hidden="true">@</span>' + esc(t('rp.mail')) + '</a>' +
        (navigator.share ? '<button type="button" class="yg-rp-app" data-actie="deelMeer"><span aria-hidden="true">…</span>' + esc(t('rp.more')) + '</button>' : '') +
        '</div><div class="yg-rp-deellink"><label class="yg-sr" for="yg-rp-deel-link">' + esc(t('rp.link')) + '</label><input id="yg-rp-deel-link" type="text" readonly value="' + esc(deelNu) + '">' +
        '<button type="button" class="yg-btn yg-btn--primary" data-actie="kopieer">' + esc(t('rp.copy')) + '</button></div>' +
        '<p class="yg-meta">' + esc(t('rp.sharePrivacy')) + '</p></div>';
    }
    zetHtml(balk, html);
  }

  // ── Account: dezelfde sessie als /app (Supabase Auth in localStorage) ──
  // Verlopen sessie: we verversen hier niet (dat doet /app); dan bewaren we
  // alleen lokaal en wijzen de weg naar inloggen.
  var SESSIE = 'sb-fwehqudhwzcnkcuypuqw-auth-token';
  var gesynct = {};   // route-id → JSON zoals laatst in het account bewaard
  var syncTimer = null, accountBekend = false;
  function sessie() {
    var s = lees(SESSIE);
    if (!s || !s.access_token || !s.user || !s.user.id) return null;
    if (s.expires_at && s.expires_at * 1000 < Date.now() + 60000) return null;
    return s;
  }
  function api(pad, opties, metSessie) {
    var K = window.YGKaart, s = metSessie === false ? null : sessie();
    if (!K) return Promise.reject(new Error('geen kaart.js'));
    opties = opties || {};
    opties.headers = Object.assign({ apikey: K.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + (s ? s.access_token : K.SUPABASE_ANON_KEY), 'Content-Type': 'application/json' }, opties.headers || {});
    return fetch(K.SUPABASE_URL + '/rest/v1/' + pad, opties).then(function (r) {
      if (!r.ok) throw new Error(pad + ' ' + r.status);
      return r.status === 204 ? null : r.text().then(function (x) { return x ? JSON.parse(x) : null; });
    });
  }
  function naarRij(r) {
    return { client_id: r.id, naam: (r.naam || '').slice(0, 80), datum: r.datum || null, vertrek: r.vertrek || null, vervoer: r.vervoer || 'auto',
      start: r.start || null, eind: r.eind || null, stops: r.stops.slice(0, 50), deel_code: heeftGeheim(r) ? null : r.deelCode || null };
  }
  function upsert(r) {
    var rij = naarRij(r);
    return api('opgeslagen_routes?on_conflict=user_id,client_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rij) })
      .then(function () { gesynct[r.id] = JSON.stringify(rij); });
  }
  function synchroniseerLater() {
    if (!accountBekend || !sessie()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(synchroniseer, 1500);
  }
  function synchroniseer() {
    if (!sessie()) return;
    var nu = {};
    routes.forEach(function (r) {
      nu[r.id] = true;
      if (!r.stops.length && !r.naam) return;   // lege route niet bewaren
      if (gesynct[r.id] !== JSON.stringify(naarRij(r))) upsert(r).catch(function () { /* volgende keer opnieuw */ });
    });
    Object.keys(gesynct).forEach(function (id) {
      if (nu[id]) return;
      api('opgeslagen_routes?client_id=eq.' + encodeURIComponent(id), { method: 'DELETE' }).then(function () { delete gesynct[id]; }).catch(function () {});
    });
  }
  // Bij openen: routes uit het account erbij halen; de nieuwste versie wint.
  function haalAccount() {
    if (!sessie()) return;
    api('opgeslagen_routes?select=client_id,naam,datum,vertrek,vervoer,start,eind,stops,deel_code,updated_at&order=updated_at.desc').then(function (rijen) {
      accountBekend = true;
      (rijen || []).forEach(function (x) {
        var r = routes.filter(function (y) { return y.id === x.client_id; })[0];
        var server = Date.parse(x.updated_at) || 0;
        if (r && (r.bijgewerkt || 0) > server) return;
        if (!r) { r = legeRoute(); r.id = x.client_id; routes.push(r); }
        r.naam = x.naam || ''; r.datum = x.datum || ''; r.vertrek = (x.vertrek || '09:00').slice(0, 5); r.vervoer = x.vervoer || 'auto';
        r.start = x.start || null; r.eind = x.eind || null; r.stops = Array.isArray(x.stops) ? x.stops : []; r.deelCode = x.deel_code || null;
        r.bijgewerkt = server;
        gesynct[r.id] = JSON.stringify(naarRij(r));
      });
      // De lege beginroute weg als het account al routes heeft.
      routes = routes.filter(function (r) { return r.stops.length || r.naam || r === actief && routes.length === 1; });
      if (!routes.length) routes.push(legeRoute());
      if (routes.indexOf(actief) < 0) actief = routes[0];
      stops = actief.stops;
      schrijf(SLEUTEL, routes);
      werkKnoppenBij(); tekenPaneel(); tekenKaart();
      synchroniseer();
    }).catch(function () { /* geen verbinding of verlopen: alleen lokaal */ });
  }

  function meld(tekst) { var p = document.getElementById('yg-route-live'); if (p) p.textContent = tekst; }

  window.YGRoute = { knop: knop, heeft: heeft, open: function () { open(true); }, opKaart: opKaart, openOp: openOp,
    // Voor de app: stop aan/uit, een nieuwe route met deze stops, slimme volgorde, account opnieuw ophalen.
    wissel: function (stop) { wissel(stop); return heeft(stop.id); },
    nieuw: function (lijst, naam) { var r = legeRoute(naam); routes.unshift(r); r.stops = lijst.slice(0, 50); weergave = 'route'; kies(r); },
    slim: function () { slimOverDeWeg(); },
    // Voor de app: een stop bijwerken met verse gegevens (bijv. het echte adres zodra het zichtbaar is).
    werkBij: function (stop) {
      var i = plek(stop.id), oud = stops[i];
      if (i < 0 || (oud.lat === stop.lat && oud.lng === stop.lng && !!oud.benadering === !!stop.benadering && !!oud.exact === !!stop.exact)) return;
      stops[i] = Object.assign({}, oud, { lat: stop.lat, lng: stop.lng, benadering: stop.benadering, exact: stop.exact });
      bewaar();
    },
    stops: function () { return stops.slice(); }, account: function () { haalAccount(); },
    // Routeplanner: stop tonen, suggesties voor de kaart, de dag van de route.
    toon: function (id) { var i = plek(id); if (i > -1) toon(i); }, gekozen: function () { return gekozen; },
    suggesties: function () { return suggesties().map(function (x) { return x.stop; }); },
    datum: function () { return routeDatum(); }, beeld: beeldVan, onthoud: function (stop) { bekend[stop.id] = stop; },
    aantal: function () { return stops.length; } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bouw); else bouw();
})();
