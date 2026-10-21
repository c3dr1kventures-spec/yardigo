// YardiGo nieuwe startpagina (/nieuw): kaart als voordeur, zoeken op plaats,
// lijst van het weekend en de stadspagina's. Data en kaart: /site/kaart.js.
(function () {
  'use strict';

  var K, kaart, alles = [];
  var state = { plek: null, wanneer: 'weekend' };
  var STRAAL_KM = 50;
  var $ = function (id) { return document.getElementById(id); };

  function slug(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function getal(n) { return new Intl.NumberFormat(YG.taal === 'nl' ? 'nl-NL' : YG.taal).format(n); }
  function breed() { return window.matchMedia('(min-width: 960px)').matches; }

  function kaartLink() {
    var q = new URLSearchParams();
    if (state.plek) { q.set('lat', state.plek.lat.toFixed(4)); q.set('lng', state.plek.lng.toFixed(4)); q.set('p', state.plek.naam); }
    if (state.wanneer !== 'weekend') q.set('w', state.wanneer);
    var s = q.toString();
    return '/nieuw/kaart' + (s ? '?' + s : '');
  }

  function selectie() {
    var lijst = K.voegSamen(K.inPeriode(alles, K.periode(state.wanneer)));
    if (state.plek) {
      lijst = lijst.map(function (v) { return Object.assign(v, { km: K.afstand(state.plek, v) }); })
        .filter(function (v) { return v.km <= STRAAL_KM; })
        .sort(function (a, b) { return a.km - b.km; });
    } else {
      lijst.sort(function (a, b) { return (a.dagen[0] + (a.begin || '')).localeCompare(b.dagen[0] + (b.begin || '')); });
    }
    return lijst;
  }

  function kop() {
    var k = state.wanneer === 'vandaag' ? 'home.listToday' : state.wanneer === 'volgend' ? 'home.listNext' : (state.plek ? 'home.listNear' : 'home.listAll');
    if (state.wanneer !== 'weekend' && state.plek) return YG.t(k) + ', ' + state.plek.naam;
    return YG.t(k, { p: state.plek ? state.plek.naam : '' });
  }

  function toon() {
    var lijst = selectie();
    var n = lijst.length;

    $('cta').textContent = state.plek ? YG.t('home.ctaNear', { n: n, p: state.plek.naam }) : YG.t('home.ctaAll', { n: n });
    $('alle').textContent = YG.t('home.allN', { n: n });
    $('alle').href = $('open').href = kaartLink();
    $('lijst-kop').textContent = kop();
    $('lijst-sort').textContent = state.plek ? YG.t('home.nearest') : YG.t('home.byTime');

    var ol = $('lijst');
    ol.innerHTML = '';
    lijst.slice(0, 8).forEach(function (v) {
      var li = document.createElement('li');
      var cls = 'yg-tag yg-tag--inline' + (v.soort === 'route' ? ' yg-tag--route' : v.soort === 'oprit' ? ' yg-tag--oprit' : '');
      var dag = v.dagen.map(K.dagKort).join(' + ');
      li.innerHTML = '<a class="yg-row" href="/v/' + K.esc(v.id) + '" data-id="' + K.esc(v.id) + '">' +
        '<span class="' + cls + '">' + K.esc(dag) + '</span>' +
        '<span style="min-width:0"><strong>' + K.esc(v.titel) + '</strong><span class="yg-meta">' + K.esc([v.plaats, K.tijden(v)].filter(Boolean).join(', ')) + '</span></span>' +
        '<span class="yg-km yg-num">' + (v.km != null ? Math.round(v.km) + ' ' + YG.t('unit.km') : '') + '</span></a>';
      var a = li.firstChild;
      a.addEventListener('mouseenter', function () { kaart.licht(v.id, true); });
      a.addEventListener('mouseleave', function () { kaart.licht(v.id, false); });
      ol.appendChild(li);
    });
    $('leeg').hidden = n > 0;

    // Eerst de uitsnede, dan de pins (Leaflet kent zonder uitsnede geen grenzen).
    if (state.plek) {
      kaart.map.setView([state.plek.lat, state.plek.lng], 9, { animate: false });
    } else {
      kaart.map.setView([K.NL_MIDDEN.lat, K.NL_MIDDEN.lng], breed() ? 8 : 7, { animate: false });
    }
    // Op desktop ligt de zoekkaart links over de kaart: schuif het midden naar rechts.
    if (breed()) kaart.map.panBy([-240, 0], { animate: false });
    kaart.zet(lijst, state.plek);
  }

  function telling() {
    var wk = K.voegSamen(K.inPeriode(alles, K.periode('weekend')));
    $('live').textContent = YG.t('home.live', { n: wk.length });
    var per = { markt: 0, route: 0, oprit: 0 }, plaatsen = {};
    alles.forEach(function (v) { per[v.soort]++; if (v.plaats) plaatsen[v.plaats.toLowerCase()] = 1; });
    $('n-markt').textContent = getal(per.markt);
    $('n-route').textContent = getal(per.route);
    $('n-oprit').textContent = getal(per.oprit);
    $('wat-tel').textContent = YG.t('home.whatCount', { n: getal(alles.length), p: getal(Object.keys(plaatsen).length) });
    document.querySelectorAll('.yg-tile .yg-big').forEach(function (el) { if (el.textContent === '1.911') el.textContent = getal(1911); });

    // Stadspagina's bestaan voor plaatsen met komende rommelmarkten (build/prerender.mjs).
    var steden = {};
    alles.forEach(function (v) { if (v.soort === 'markt' && v.plaats) { var s = slug(v.plaats); steden[s] = steden[s] || { naam: v.plaats, n: 0 }; steden[s].n++; } });
    var top = Object.keys(steden).sort(function (a, b) { return steden[b].n - steden[a].n; }).slice(0, 18);
    $('steden').innerHTML = top.map(function (s) {
      return '<a href="/rommelmarkt/' + s + '">' + K.esc(steden[s].naam) + ' <span class="yg-count yg-num">' + steden[s].n + '</span></a>';
    }).join('');
  }

  function fout(tekst) { var p = $('fout'); p.textContent = tekst || ''; p.hidden = !tekst; }

  function kiesPlek(p) {
    state.plek = p; K.bewaarPlek(p); fout('');
    $('plaats').value = p.naam;
    toon();
  }

  function start() {
    K = window.YGKaart;
    var q = new URLSearchParams(location.search);
    if (['vandaag', 'volgend'].indexOf(q.get('w')) > -1) state.wanneer = q.get('w');
    var b = K.bewaardePlek();
    if (b && typeof b.lat === 'number') { state.plek = b; $('plaats').value = b.naam === YG.t('loc.mine') ? '' : b.naam; }

    kaart = K.maakKaart($('heromap'), {
      stil: true, maxKaartjes: 24,
      opKlik: function (v) { location.href = '/v/' + encodeURIComponent(v.id); },
      opWijs: function (id, aan) { var a = document.querySelector('.yg-row[data-id="' + id + '"]'); if (a) a.classList.toggle('is-hot', aan); }
    });

    document.querySelectorAll('#wanneer button').forEach(function (btn) {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-w') === state.wanneer));
      btn.addEventListener('click', function () {
        state.wanneer = btn.getAttribute('data-w');
        document.querySelectorAll('#wanneer button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === btn)); });
        toon();
      });
    });

    $('locatie').addEventListener('click', function () {
      if (!navigator.geolocation) { fout(YG.t('home.locFail')); return; }
      navigator.geolocation.getCurrentPosition(function (pos) {
        kiesPlek({ naam: YG.t('loc.mine'), lat: pos.coords.latitude, lng: pos.coords.longitude });
        $('plaats').value = '';
      }, function () { fout(YG.t('home.locFail')); }, { timeout: 8000, maximumAge: 600000 });
    });

    // Zoeken: eerst de plaats opzoeken; staat de plaats al vast, dan door naar de kaart.
    $('zoek').addEventListener('submit', function (e) {
      e.preventDefault();
      var tekst = $('plaats').value.trim();
      if (!tekst || (state.plek && tekst.toLowerCase() === state.plek.naam.toLowerCase())) { location.href = kaartLink(); return; }
      K.zoekPlaats(tekst, alles).then(function (p) {
        if (!p) { fout(YG.t('home.placeFail')); return; }
        kiesPlek(p);
        location.href = kaartLink();
      });
    });

    K.laad().then(function (lijst) { alles = lijst; telling(); toon(); })
      .catch(function (e) { console.error(e); fout(YG.t('home.none')); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
