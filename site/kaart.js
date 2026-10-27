// ═══════════════════════════════════════════════════════════════════════
// YardiGo website: verkopen ophalen en tonen op de kaart.
//
// Data: dezelfde RPC als de app (get_listings_map), met dezelfde
// privacyregels; geen eigen query's op tabellen. Type-indeling gelijk aan
// mapSupabaseToSale in index.html: markt (evenement), route (buurt),
// oprit (particulier).
// Kaart: Leaflet met de CARTO-tegels van de app. Verkopen staan er als
// prijskaartje met dag en tijd; raken twee kaartjes elkaar, dan wordt de
// minst belangrijke een stip (zoals Airbnb). Belangrijk = dichtbij het
// gekozen punt, daarna het vroegst.
// Vereist: site.js (window.YG) en Leaflet (window.L).
// ═══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var SUPABASE_URL = 'https://fwehqudhwzcnkcuypuqw.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3ZWhxdWRod3pjbmtjdXlwdXF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzOTQwNzgsImV4cCI6MjA4OTk3MDA3OH0.A5mPApoGySr97niz6QLZGFSDhsfCqOwi-k8v58mHjMI';
  var CARTO_KEY = 'cb1_2pvc_1_3258ad842f08e23ffc14ee4e';
  var CACHE = 'yg-site-listings-2';
  var NL_MIDDEN = { lat: 52.2, lng: 5.3 };
  var GROEP_TOT_ZOOM = 10;

  function opslag(fn) { try { return fn(); } catch (e) { return null; } }

  // ── Datums (altijd Nederlandse tijd) ─────────────────────────────────
  function vandaagISO() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
  function plus(iso, n) { var d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function weekdag(iso) { return new Date(iso + 'T12:00:00Z').getUTCDay(); } // 0 = zondag
  function nuMinuten() {
    var s = new Date().toLocaleTimeString('sv-SE', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });
    return parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
  }
  // Periode als [van, tot] (inclusief). Dit weekend = komende za en zo; op zondag alleen vandaag.
  function periode(wanneer) {
    var v = vandaagISO(), wd = weekdag(v);
    if (wanneer === 'vandaag') return [v, v];
    if (wanneer === 'alles') return [v, plus(v, 365)];
    var za = wd === 6 ? v : wd === 0 ? plus(v, -1) : plus(v, 6 - wd);
    if (wanneer === 'volgend') return [plus(za, 7), plus(za, 8)];
    if (wanneer === 'za') return [za, za];
    if (wanneer === 'zo') return [plus(za, 1), plus(za, 1)];
    return [wd === 0 ? v : za, plus(za, 1)];
  }

  function taal() { return (window.YG && YG.taal) || 'nl'; }
  function dagKort(iso) {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString(taal() === 'nl' ? 'nl-NL' : taal(), { weekday: 'short', timeZone: 'UTC' }).replace('.', '');
  }
  function dagLang(iso) {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString(taal() === 'nl' ? 'nl-NL' : taal(), { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace('.', '');
  }
  function uur(t) { if (!t) return ''; var h = parseInt(t.slice(0, 2), 10), m = t.slice(3, 5); return h + ':' + m; }

  // ── Data ─────────────────────────────────────────────────────────────
  function soort(item) {
    var map = { garagesale: 'oprit', garageverkoop: 'oprit', rommelmarkt: 'markt', vlooienmarkt: 'markt', kofferbakverkoop: 'markt', buurtverkoop: 'route', overig: 'oprit' };
    var s = map[item.category] || 'oprit';
    var sub = String(item.event_subtype || '').toLowerCase();
    if (sub === 'rommelroute' || (sub === 'buurtverkoop' && item.placed_by === 'yardigo')) s = 'route';
    else if (['opritverkoop', 'garagesale', 'garageverkoop', 'tuinverkoop'].indexOf(sub) > -1) s = 'oprit';
    return s;
  }

  function naarVerkoop(item) {
    if (typeof item.latitude !== 'number' || typeof item.longitude !== 'number') return null;
    return {
      id: item.id, soort: soort(item), titel: item.title || '', plaats: item.city || '',
      lat: item.latitude, lng: item.longitude, van: item.date_start, tot: item.date_end || item.date_start,
      begin: item.time_start, eind: item.time_end, benadering: !!item.location_approx,
      bevestigd: item.placed_by === 'user' || !!item.claimed_by_user_id,
      foto: (item.images && item.images[0]) || null, fotos: item.photo_count || 0
    };
  }

  function laad() {
    var c = opslag(function () { return JSON.parse(sessionStorage.getItem(CACHE)); });
    if (c && c.t > Date.now() - 10 * 60 * 1000 && Array.isArray(c.d)) return Promise.resolve(c.d);
    return fetch(SUPABASE_URL + '/rest/v1/rpc/get_listings_map', {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: '{}'
    }).then(function (r) { if (!r.ok) throw new Error('listings ' + r.status); return r.json(); })
      .then(function (rows) {
        var lijst = rows.filter(function (r) { return r.status === 'active' || !r.status; }).map(naarVerkoop).filter(Boolean);
        opslag(function () { sessionStorage.setItem(CACHE, JSON.stringify({ t: Date.now(), d: lijst })); });
        return lijst;
      });
  }

  // Kringloop- en tweedehandswinkels (OpenStreetMap) via get_winkels_publiek, in porties van 1000.
  var WINKEL_CACHE = 'yg-site-winkels-1';
  function winkels() {
    var c = opslag(function () { return JSON.parse(sessionStorage.getItem(WINKEL_CACHE)); });
    if (c && c.t > Date.now() - 60 * 60 * 1000 && Array.isArray(c.d)) return Promise.resolve(c.d);
    var alle = [];
    function deel(offset) {
      return fetch(SUPABASE_URL + '/rest/v1/rpc/get_winkels_publiek?order=id&limit=1000&offset=' + offset, {
        method: 'POST',
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: '{}'
      }).then(function (r) { if (!r.ok) throw new Error('winkels ' + r.status); return r.json(); })
        .then(function (rij) { alle = alle.concat(rij); return rij.length < 1000 ? alle : deel(offset + 1000); });
    }
    return deel(0).then(function (rij) {
      var lijst = rij.map(function (w) {
        return { id: 'w' + w.id, naam: w.naam || '', soort: w.soort, lat: w.latitude, lng: w.longitude, plaats: w.plaats || '',
          adres: [w.straat, w.huisnummer].filter(Boolean).join(' '), tijden: w.openingstijden || '', website: w.website || '' };
      });
      opslag(function () { sessionStorage.setItem(WINKEL_CACHE, JSON.stringify({ t: Date.now(), d: lijst })); });
      return lijst;
    });
  }

  // OSM-openingstijden leesbaar: "Mo-Fr 09:00-17:00; Sa 10:00-16:00" → "ma-vr 09:00-17:00, za 10:00-16:00".
  function openingstijden(t) {
    if (!t) return '';
    var dagen = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    return String(t).replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su)\b/g, function (d) {
      return new Date(Date.UTC(2024, 0, 7 + dagen.indexOf(d))).toLocaleDateString(taal() === 'nl' ? 'nl-NL' : taal(), { weekday: 'short', timeZone: 'UTC' }).replace('.', '');
    }).replace(/\bPH\b/g, YG.t('shop.holidays')).replace(/\boff\b/g, YG.t('state.closed').toLowerCase()).replace(/\s*;\s*/g, ', ');
  }

  // Eén verkoop met alle foto's en de beschrijving; zelfde privacyregels als de lijst.
  function detail(id) {
    return fetch(SUPABASE_URL + '/rest/v1/rpc/get_listing_detail', {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_id: id })
    }).then(function (r) { if (!r.ok) throw new Error('detail ' + r.status); return r.json(); })
      .then(function (item) {
        var v = item && naarVerkoop(item);
        if (!v) return null;
        return Object.assign(v, {
          fotosAlle: (item.images || []).filter(Boolean), fotos: (item.images || []).length,
          beschrijving: item.description || '', tags: item.tags || [], adres: item.address || '',
          adresVanaf: item.address_visible_at || null, bron: item.source_label || ''
        });
      });
  }

  // Verkopen in een periode; dagen = welke dagen van de periode hij open is
  // (hooguit een maand, voor langlopende listings).
  function inPeriode(lijst, p) {
    return lijst.map(function (v) {
      var van = v.van > p[0] ? v.van : p[0], tot = v.tot < p[1] ? v.tot : p[1];
      if (van > tot) return null;
      var dagen = [];
      for (var d = van; d <= tot && dagen.length < 31; d = plus(d, 1)) dagen.push(d);
      return Object.assign({}, v, { dagen: dagen });
    }).filter(Boolean);
  }

  // Zelfde markt op za én zo als twee listings (komt voor): samenvoegen.
  // Alleen bij aansluitende dagen; dezelfde markt een maand later blijft apart.
  function voegSamen(lijst) {
    var uit = [];
    lijst.forEach(function (v) {
      var dub = uit.find(function (u) {
        return u.titel.toLowerCase() === v.titel.toLowerCase() && Math.abs(u.lat - v.lat) < 0.003 && Math.abs(u.lng - v.lng) < 0.003 &&
          plus(u.dagen[u.dagen.length - 1], 1) >= v.dagen[0] && plus(v.dagen[v.dagen.length - 1], 1) >= u.dagen[0];
      });
      if (dub) { v.dagen.forEach(function (d) { if (dub.dagen.indexOf(d) < 0) dub.dagen.push(d); }); dub.dagen.sort(); }
      else uit.push(v);
    });
    return uit;
  }

  // Volgorde van belang: garagesales eerst, dan rommelroutes, dan markten.
  var VOLGORDE = { oprit: 0, route: 1, markt: 2 };

  // Beeld bij een verkoop: de eigen foto of het affiche, anders een sfeerbeeld van
  // de soort (3 per soort; vast per verkoop, zodat buren afwisselen). Zelfde keuze
  // als sfeerbeeld() in build/prerender.mjs.
  function sfeer(v) {
    var n = 0, id = String(v.id);
    for (var i = 0; i < id.length; i++) n = (n + id.charCodeAt(i)) % 997;
    return '/site/img/sfeer/' + v.soort + '-' + (n % 3 + 1) + '.jpg';
  }
  function beeld(v) { return v.foto || sfeer(v); }

  // ── Kaartjes met beeld (startpagina, verkooppagina) ────────────────
  var SOORT_TEKST = { oprit: 'type.driveway', route: 'type.route', markt: 'type.market' };
  function soortTekst(v) { return YG.t(SOORT_TEKST[v.soort]); }
  function link(v) { return '/v/' + encodeURIComponent(v.id); }

  function dagTekst(v) {
    var d = v.dagen.length > 1 ? label(Object.assign({}, v, { begin: null })) : dagLang(v.dagen[0]);
    return d + (v.begin ? ', ' + tijden(v) : '');
  }

  function beeldHtml(v, klein) {
    var alt = v.foto ? YG.t('home.poster', { t: v.titel }) : '';
    var html = '<img src="' + esc(beeld(v)) + '" alt="' + esc(alt) + '" width="320" height="240" loading="lazy" decoding="async">';
    if (klein) return html;
    html += '<span class="yg-badge yg-badge--' + v.soort + '">' + esc(soortTekst(v)) + '</span>';
    if (!v.foto) html += '<span class="yg-sfeer">' + esc(YG.t('img.stock')) + '</span>';
    if (v.fotos > 1) html += '<span class="yg-item__n yg-num">' + esc(YG.t('home.photos', { n: v.fotos })) + '</span>';
    return html;
  }

  function kaartje(v) {
    var li = document.createElement('li');
    li.innerHTML = '<a class="yg-item" href="' + link(v) + '" data-id="' + esc(v.id) + '">' +
      '<span class="yg-item__img">' + beeldHtml(v) + '</span>' +
      '<span class="yg-item__txt">' +
        '<span class="yg-item__day yg-item__day--' + v.soort + '">' + esc(dagTekst(v)) + '</span>' +
        '<strong>' + esc(v.titel) + '</strong>' +
        '<span class="yg-meta">' + esc([v.plaats, v.km != null ? Math.round(v.km) + ' ' + YG.t('unit.km') : ''].filter(Boolean).join(', ')) + '</span>' +
      '</span></a>';
    return li;
  }

  // Ligt een punt duidelijk in Duitsland? Per breedtegraad het oostelijkste
  // stuk Nederland of België (Vaals, Kerkrade, Venlo, Dinxperlo, Losser, Ter
  // Apel). Twijfel telt als Nederland: liever een Duitse verkoop te veel in de
  // lijst dan een Nederlandse kwijt. Keulen, Düsseldorf en Münster vallen eruit.
  var GRENS = [[50.3, 6.42], [50.75, 6.05], [50.9, 6.1], [51.0, 6.02], [51.2, 6.17], [51.35, 6.23], [51.5, 6.24], [51.7, 6.1],
    [51.8, 6.3], [51.86, 6.52], [51.97, 6.84], [52.2, 7.08], [52.45, 7.08], [52.7, 7.1], [53.0, 7.22], [53.6, 7.25]];
  function inDuitsland(v) {
    if (v.lat < GRENS[0][0] || v.lat > 53.8) return false;
    for (var i = 1; i < GRENS.length; i++) {
      var a = GRENS[i - 1], b = GRENS[i];
      if (v.lat <= b[0]) return v.lng > Math.max(a[1], b[1]) + 0.03;
    }
    return v.lng > GRENS[GRENS.length - 1][1] + 0.03;
  }

  // ── Route (site/route.js) en kringloopwinkels ─────────────────────────
  var WINKEL_TEKST = { kringloop: 'shop.thrift', tweedehands: 'shop.secondhand', antiek: 'shop.antique', goede_doel: 'shop.charity' };
  function winkelSoort(w) { return YG.t(WINKEL_TEKST[w.soort] || 'shop.secondhand'); }
  function stopVan(v) {
    return { id: v.id, titel: v.titel, soort: v.soort, lat: v.lat, lng: v.lng, plaats: v.plaats, sub: dagTekst(v), benadering: !!v.benadering,
      van: v.van, tot: v.tot, begin: v.begin || null, eind: v.eind || null };
  }
  function stopWinkel(w) {
    return { id: w.id, titel: w.naam || winkelSoort(w), soort: 'winkel', lat: w.lat, lng: w.lng, plaats: w.plaats, sub: winkelSoort(w), benadering: false,
      tijden: w.tijden || null };
  }
  function routeKnop(stop) { return window.YGRoute ? window.YGRoute.knop(stop) : ''; }
  function winkelPopupHtml(w) {
    var tijden = openingstijden(w.tijden);
    var route = 'https://www.google.com/maps/dir/?api=1&destination=' + w.lat.toFixed(5) + ',' + w.lng.toFixed(5);
    return '<span class="yg-badge yg-badge--shop">' + esc(winkelSoort(w)) + '</span>' +
      '<h3>' + esc(w.naam || winkelSoort(w)) + '</h3>' +
      '<p>' + esc([w.adres, w.plaats].filter(Boolean).join(', ')) + (tijden ? '<br>' + esc(YG.t('shop.hours')) + ': ' + esc(tijden) : '') +
      (w.website && /^https?:\/\//.test(w.website) ? '<br><a href="' + esc(w.website) + '" target="_blank" rel="noopener nofollow">' + esc(YG.t('shop.site')) + '</a>' : '') + '</p>' +
      '<div class="yg-btns">' + routeKnop(stopWinkel(w)) +
      '<a class="yg-btn yg-btn--outline" href="' + route + '" target="_blank" rel="noopener">' + esc(YG.t('act.route')) + '</a></div>' +
      '<p class="yg-meta" style="margin:8px 0 0;font-size:12px">' + esc(YG.t('shop.osm')) + '</p>';
  }

  function afstand(a, b) {
    var r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 12742 * Math.asin(Math.sqrt(h));
  }

  // Kaartje: "za 9:00", "za en zo 9:00", "zo 10:00". Met datum (periode "alles"): "za 31 okt".
  function label(v, metDatum) {
    if (metDatum) return new Date(v.dagen[0] + 'T12:00:00Z').toLocaleDateString(taal() === 'nl' ? 'nl-NL' : taal(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(/\./g, '');
    var d = v.dagen.length === 2 && plus(v.dagen[0], 1) === v.dagen[1]
      ? dagKort(v.dagen[0]) + ' ' + YG.t('time.and') + ' ' + dagKort(v.dagen[1])
      : v.dagen.length > 2 ? dagKort(v.dagen[0]) + '–' + dagKort(v.dagen[v.dagen.length - 1]) : dagKort(v.dagen[0]);
    return v.begin ? d + ' ' + uur(v.begin) : d;
  }
  function tijden(v) { return v.begin ? uur(v.begin) + (v.eind ? ' ' + YG.t('time.until') + ' ' + uur(v.eind) : '') : ''; }

  // ── Plaats zoeken: PDOK voor NL (zoals de app), Nominatim voor BE ─────
  // Volgorde: eerst plaatsen uit de verkopen zelf (direct, geen netwerk), dan PDOK,
  // dan Nominatim. PDOK weigerde op 21 okt 2026 verzoeken mét Origin-header (502).
  function zoekPlaats(tekst, verkopen) {
    var q = String(tekst || '').trim();
    if (!q) return Promise.resolve(null);
    var norm = function (x) { return String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, ''); };
    var raak = (verkopen || []).filter(function (v) { return norm(v.plaats) === norm(q); });
    if (raak.length) {
      var lat = 0, lng = 0;
      raak.forEach(function (v) { lat += v.lat; lng += v.lng; });
      return Promise.resolve({ naam: raak[0].plaats, lat: lat / raak.length, lng: lng / raak.length });
    }
    var pdok = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?q=' + encodeURIComponent(q) + '&fq=type:(woonplaats%20OR%20postcode%20OR%20gemeente)&bq=type:woonplaats%5E2&rows=1&fl=weergavenaam,centroide_ll,woonplaatsnaam,type';
    var nominatim = function () {
      return fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=nl,be,de&q=' + encodeURIComponent(q))
        .then(function (r) { if (!r.ok) throw new Error('nominatim ' + r.status); return r.json(); })
        .then(function (a) { return a && a[0] ? { naam: a[0].display_name.split(',')[0], lat: parseFloat(a[0].lat), lng: parseFloat(a[0].lon) } : null; });
    };
    return fetch(pdok).then(function (r) { if (!r.ok) throw new Error('pdok ' + r.status); return r.json(); }).then(function (j) {
      var d = j && j.response && j.response.docs && j.response.docs[0];
      var m = d && /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(d.centroide_ll);
      // PDOK kent alleen Nederland en geeft altijd iets terug ('Gent' wordt 'Sas van Gent'):
      // alleen aannemen als de naam met de zoekterm begint of als het een postcode is.
      var naam = d && (d.woonplaatsnaam || d.weergavenaam.split(',')[0]).replace(/^Gemeente /, '');
      if (m && (d.type === 'postcode' || norm(naam).indexOf(norm(q)) === 0)) return { naam: naam, lat: parseFloat(m[2]), lng: parseFloat(m[1]) };
      return nominatim();
    }).catch(function () { return nominatim().catch(function () { return null; }); });
  }

  function bewaarPlek(p) { opslag(function () { localStorage.setItem('yg-plek', JSON.stringify(p)); }); }
  function bewaardePlek() { return opslag(function () { return JSON.parse(localStorage.getItem('yg-plek')); }); }

  // ── Kaart ────────────────────────────────────────────────────────────
  function maakKaart(el, opties) {
    opties = opties || {};
    var stil = !!opties.stil;
    var map = L.map(el, {
      zoomControl: false, attributionControl: true,
      dragging: !stil, scrollWheelZoom: !stil, touchZoom: !stil, doubleClickZoom: !stil, boxZoom: !stil, keyboard: !stil
    });
    L.tileLayer('https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=' + CARTO_KEY, {
      maxZoom: 19, detectRetina: true,
      attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>'
    }).addTo(map);
    map.attributionControl.setPrefix(false);

    var laag = L.layerGroup().addTo(map);
    var markers = {};
    var state = { lijst: [], winkels: [], midden: null, gekozen: null, metDatum: false };
    var groepen = null, groepenVan = null, versie = 0;

    // Ver uitgezoomd (zoals de app): verkopen dicht bij elkaar worden één
    // bolletje met het aantal; een losse verkoop is een stip. Elke soort heeft
    // eigen bolletjes in eigen kleur, zodat garagesales niet in het groen van de
    // markten verdwijnen. Klik op een bolletje zoomt in; vanaf GROEP_TOT_ZOOM
    // staan de prijskaartjes.
    function groepIcoon(soort) {
      return function (cluster) {
        // Winkels kleiner: verkopen blijven het opvallendst.
        var n = cluster.getChildCount(), d = soort === 'winkel' ? (n < 10 ? 24 : n < 50 ? 28 : 32) : n < 10 ? 34 : n < 50 ? 40 : 48;
        return L.divIcon({ className: 'yg-pin', iconSize: [0, 0],
          html: '<span class="yg-groep yg-groep--' + soort + '" style="width:' + d + 'px;height:' + d + 'px;margin:-' + d / 2 + 'px 0 0 -' + d / 2 + 'px">' + n + '</span>' });
      };
    }
    function nieuweGroep(soort) {
      return L.markerClusterGroup({
        disableClusteringAtZoom: GROEP_TOT_ZOOM, maxClusterRadius: soort === 'markt' ? 55 : 45, chunkedLoading: true,
        showCoverageOnHover: false, spiderfyOnMaxZoom: false, zoomToBoundsOnClick: true, removeOutsideVisibleBounds: true,
        iconCreateFunction: groepIcoon(soort)
      });
    }
    function tekenGroepen() {
      if (groepen && groepenVan === versie) return;
      weg();
      groepen = { winkel: nieuweGroep('winkel'), markt: nieuweGroep('markt'), route: nieuweGroep('route'), oprit: nieuweGroep('oprit') };
      state.lijst.forEach(function (v) {
        var m = L.marker([v.lat, v.lng], {
          icon: L.divIcon({ className: 'yg-pin', html: '<span class="yg-dot yg-dot--' + v.soort + '"></span>', iconSize: [0, 0] }),
          title: v.titel, keyboard: true
        });
        m.on('click', function () { if (opties.opKlik) opties.opKlik(v); });
        groepen[v.soort].addLayer(m);
      });
      state.winkels.forEach(function (w) { groepen.winkel.addLayer(winkelPin(w)); });
      // Volgorde = welke bovenop ligt: garagesales boven, winkels onder.
      ['winkel', 'markt', 'route', 'oprit'].forEach(function (k) { map.addLayer(groepen[k]); });
      groepenVan = versie;
    }
    function weg() { if (groepen) { Object.keys(groepen).forEach(function (k) { map.removeLayer(groepen[k]); }); groepen = null; groepenVan = null; } }

    // Kringloopwinkel: vierkante bruine pin.
    function winkelPin(w) {
      var m = L.marker([w.lat, w.lng], {
        icon: L.divIcon({ className: 'yg-pin', html: '<span class="yg-shop"></span>', iconSize: [0, 0] }),
        title: w.naam || '', keyboard: true, zIndexOffset: -100
      });
      m.on('click', function () { if (opties.opWinkel) opties.opWinkel(w); });
      return m;
    }

    function prioriteit(a, b) {
      if (state.gekozen === a.id) return -1;
      if (state.gekozen === b.id) return 1;
      if (opties.voorrang && a.soort !== b.soort) return VOLGORDE[a.soort] - VOLGORDE[b.soort];
      if (state.midden) return afstand(state.midden, a) - afstand(state.midden, b);
      return (a.dagen[0] + (a.begin || '')).localeCompare(b.dagen[0] + (b.begin || ''));
    }

    function teken() {
      laag.clearLayers(); markers = {};
      var groeperen = window.L.markerClusterGroup && !opties.stil && map.getZoom() < GROEP_TOT_ZOOM;
      if (groeperen) tekenGroepen(); else weg();
      var grens = map.getBounds().pad(0.15);
      var bezet = [];
      var zichtbaar = groeperen ? [] : state.lijst.filter(function (v) { return grens.contains([v.lat, v.lng]); }).sort(prioriteit);
      if (!groeperen) state.winkels.forEach(function (w) { if (grens.contains([w.lat, w.lng])) winkelPin(w).addTo(laag); });
      var maxKaartjes = opties.maxKaartjes || 40;
      zichtbaar.forEach(function (v, i) {
        var p = map.latLngToContainerPoint([v.lat, v.lng]);
        var tekst = label(v, state.metDatum);
        var w = tekst.length * 7.4 + 30;
        var box = { x1: p.x - w / 2 - 4, x2: p.x + w / 2 + 4, y1: p.y - 38, y2: p.y + 2 };
        var vrij = i < maxKaartjes && !bezet.some(function (b) { return box.x1 < b.x2 && box.x2 > b.x1 && box.y1 < b.y2 && box.y2 > b.y1; });
        var m;
        if (vrij) {
          bezet.push(box);
          var cls = 'yg-tag' + (v.soort === 'route' ? ' yg-tag--route' : v.soort === 'oprit' ? ' yg-tag--oprit' : '') + (state.gekozen === v.id ? ' is-selected' : '');
          var huis = v.soort === 'oprit' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M3 11 L12 4 L21 11 V20 H3 Z"/></svg>' : '';
          m = L.marker([v.lat, v.lng], {
            icon: L.divIcon({ className: 'yg-pin', html: '<span class="' + cls + '">' + huis + esc(tekst) + '</span>', iconSize: [0, 0] }),
            keyboard: true, title: v.titel, riseOnHover: true, zIndexOffset: state.gekozen === v.id ? 1000 : 500 - i
          });
        } else {
          m = L.circleMarker([v.lat, v.lng], {
            radius: 6, weight: 2, color: '#FFFFFF', fillOpacity: 1,
            fillColor: v.soort === 'route' ? '#E07B39' : v.soort === 'oprit' ? '#F2A830' : '#3A6B4A'
          });
        }
        m.on('click', function () { if (opties.opKlik) opties.opKlik(v); });
        m.on('mouseover', function () { if (opties.opWijs) opties.opWijs(v.id, true); });
        m.on('mouseout', function () { if (opties.opWijs) opties.opWijs(v.id, false); });
        m.addTo(laag);
        markers[v.id] = m;
      });
      tekenMidden();
      if (opties.naTekenen) {
        var b = map.getBounds();
        opties.naTekenen(groeperen ? state.lijst.filter(function (v) { return b.contains([v.lat, v.lng]); }) : zichtbaar);
      }
    }

    function tekenMidden() {
      if (!state.midden || opties.toonMidden === false) return;
      L.marker([state.midden.lat, state.midden.lng], {
        icon: L.divIcon({ className: 'yg-pin', html: '<span class="yg-me" aria-hidden="true"></span>', iconSize: [0, 0] }),
        interactive: false, zIndexOffset: 2000
      }).addTo(laag);
    }

    map.on('moveend', function () { if (state.lijst.length || state.winkels.length) teken(); });

    return {
      map: map,
      zet: function (lijst, midden, extra) {
        state.lijst = lijst; state.midden = midden || null; state.metDatum = !!(extra && extra.metDatum); versie++;
        if (map._loaded) teken();
      },
      kies: function (id) { state.gekozen = id; teken(); },
      winkels: function (lijst) { state.winkels = lijst || []; versie++; if (map._loaded) teken(); },
      licht: function (id, aan) {
        var m = markers[id]; if (!m) return;
        if (m.getElement) { var e = m.getElement(); if (e && e.firstChild) e.firstChild.classList.toggle('is-selected', aan || state.gekozen === id); }
        else m.setStyle({ radius: aan ? 9 : 6 });
      },
      teken: teken
    };
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  window.YGKaart = {
    laad: laad, periode: periode, inPeriode: inPeriode, voegSamen: voegSamen, afstand: afstand,
    label: label, tijden: tijden, dagKort: dagKort, dagLang: dagLang, vandaagISO: vandaagISO, nuMinuten: nuMinuten,
    detail: detail, winkels: winkels, stopVan: stopVan, stopWinkel: stopWinkel, routeKnop: routeKnop, winkelPopupHtml: winkelPopupHtml, openingstijden: openingstijden, inDuitsland: inDuitsland, kaartje: kaartje, beeldHtml: beeldHtml, dagTekst: dagTekst, soortTekst: soortTekst, link: link, plus: plus, beeld: beeld, VOLGORDE: VOLGORDE, zoekPlaats: zoekPlaats, bewaarPlek: bewaarPlek, bewaardePlek: bewaardePlek, maakKaart: maakKaart, esc: esc,
    NL_MIDDEN: NL_MIDDEN, SUPABASE_URL: SUPABASE_URL, SUPABASE_ANON_KEY: SUPABASE_ANON_KEY
  };
})();
