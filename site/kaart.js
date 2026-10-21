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
  var CACHE = 'yg-site-listings';
  var NL_MIDDEN = { lat: 52.2, lng: 5.3 };

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
      bevestigd: item.placed_by === 'user' || !!item.claimed_by_user_id
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

  // Verkopen in een periode; dagen = welke dagen van de periode hij open is.
  function inPeriode(lijst, p) {
    return lijst.map(function (v) {
      var dagen = [];
      for (var d = p[0]; d <= p[1]; d = plus(d, 1)) if (v.van <= d && v.tot >= d) dagen.push(d);
      return dagen.length ? Object.assign({}, v, { dagen: dagen }) : null;
    }).filter(Boolean);
  }

  // Zelfde markt op za én zo als twee listings (komt voor): samenvoegen.
  function voegSamen(lijst) {
    var uit = [];
    lijst.forEach(function (v) {
      var dub = uit.find(function (u) {
        return u.titel.toLowerCase() === v.titel.toLowerCase() && Math.abs(u.lat - v.lat) < 0.003 && Math.abs(u.lng - v.lng) < 0.003;
      });
      if (dub) { v.dagen.forEach(function (d) { if (dub.dagen.indexOf(d) < 0) dub.dagen.push(d); }); dub.dagen.sort(); }
      else uit.push(v);
    });
    return uit;
  }

  function afstand(a, b) {
    var r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 12742 * Math.asin(Math.sqrt(h));
  }

  // Kaartje: "za 9:00", "za en zo 9:00", "zo 10:00".
  function label(v) {
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
      if (m) return { naam: (d.woonplaatsnaam || d.weergavenaam.split(',')[0]).replace(/^Gemeente /, ''), lat: parseFloat(m[2]), lng: parseFloat(m[1]) };
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
    var state = { lijst: [], midden: null, gekozen: null };

    function prioriteit(a, b) {
      if (state.gekozen === a.id) return -1;
      if (state.gekozen === b.id) return 1;
      if (state.midden) return afstand(state.midden, a) - afstand(state.midden, b);
      return (a.dagen[0] + (a.begin || '')).localeCompare(b.dagen[0] + (b.begin || ''));
    }

    function teken() {
      laag.clearLayers(); markers = {};
      var grens = map.getBounds().pad(0.15);
      var bezet = [];
      var zichtbaar = state.lijst.filter(function (v) { return grens.contains([v.lat, v.lng]); }).sort(prioriteit);
      var maxKaartjes = opties.maxKaartjes || 40;
      zichtbaar.forEach(function (v, i) {
        var p = map.latLngToContainerPoint([v.lat, v.lng]);
        var tekst = label(v);
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
      if (state.midden && opties.toonMidden !== false) {
        L.marker([state.midden.lat, state.midden.lng], {
          icon: L.divIcon({ className: 'yg-pin', html: '<span class="yg-me" aria-hidden="true"></span>', iconSize: [0, 0] }),
          interactive: false, zIndexOffset: 2000
        }).addTo(laag);
      }
      if (opties.naTekenen) opties.naTekenen(zichtbaar);
    }

    map.on('moveend', function () { if (state.lijst.length) teken(); });

    return {
      map: map,
      zet: function (lijst, midden) { state.lijst = lijst; state.midden = midden || null; if (map._loaded) teken(); },
      kies: function (id) { state.gekozen = id; teken(); },
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
    zoekPlaats: zoekPlaats, bewaarPlek: bewaarPlek, bewaardePlek: bewaardePlek, maakKaart: maakKaart, esc: esc,
    NL_MIDDEN: NL_MIDDEN
  };
})();
