// YardiGo nieuwe startpagina (/nieuw), ronde 3.2: kaart als voordeur met
// lagen, locatie delen, garagesales voorop met foto of affiche, lijst van
// het weekend als kaartjes met beeld. Data en kaart: /site/kaart.js.
(function () {
  'use strict';

  var K, kaart, popup, alles = [];
  var state = { plek: null, wanneer: 'weekend', lagen: { oprit: true, route: true, markt: true } };
  var STRAAL_KM = 50;
  var GARAGE_DAGEN = 90;
  var $ = function (id) { return document.getElementById(id); };

  function slug(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function breed() { return window.matchMedia('(min-width: 960px)').matches; }

  function kaartLink() {
    var q = new URLSearchParams();
    if (state.plek) { q.set('lat', state.plek.lat.toFixed(4)); q.set('lng', state.plek.lng.toFixed(4)); q.set('p', state.plek.naam); }
    if (state.wanneer !== 'weekend') q.set('w', state.wanneer);
    var s = q.toString();
    return '/nieuw/kaart' + (s ? '?' + s : '');
  }

  // Dichtbij eerst als we de plek weten; anders garagesales eerst, dan op dag en tijd.
  function sorteer(lijst) {
    if (state.plek) {
      return lijst.map(function (v) { return Object.assign(v, { km: K.afstand(state.plek, v) }); })
        .filter(function (v) { return v.km <= STRAAL_KM; })
        .sort(function (a, b) { return a.km - b.km; });
    }
    return lijst.sort(function (a, b) {
      return (K.VOLGORDE[a.soort] - K.VOLGORDE[b.soort]) || (a.dagen[0] + (a.begin || '')).localeCompare(b.dagen[0] + (b.begin || ''));
    });
  }

  // Zonder plek tonen de lijsten Nederland en België; Duitse verkopen alleen in het Duits.
  // De kaart zelf toont alles.
  function inGebied(v) { return !!state.plek || YG.taal === 'de' || !K.inDuitsland(v); }

  function weekend() { return K.voegSamen(K.inPeriode(alles, K.periode(state.wanneer))); }

  // Komende garagesales en rommelroutes, ook na dit weekend: ze zijn zeldzaam.
  // Elke verkoop telt met zijn eerste dag; twee listings van dezelfde verkoop op
  // opeenvolgende dagen (za en zo) worden er één, losse data blijven los.
  var garageCache = { sleutel: null, lijst: [] };
  function garages() {
    var sleutel = state.plek ? state.plek.lat + ',' + state.plek.lng : '-';
    if (garageCache.sleutel === sleutel) return garageCache.lijst;
    var v = K.vandaagISO(), tot = new Date(Date.now() + GARAGE_DAGEN * 864e5).toISOString().slice(0, 10);
    var lijst = [];
    alles.forEach(function (x) {
      if (x.soort === 'markt' || x.tot < v || x.van > tot || !inGebied(x)) return;
      var eerste = x.van < v ? v : x.van;
      var dagen = x.tot > eerste ? [eerste, K.plus(eerste, 1)] : [eerste];
      var dub = lijst.find(function (u) {
        return u.titel.toLowerCase() === x.titel.toLowerCase() && Math.abs(u.lat - x.lat) < 0.003 && Math.abs(u.lng - x.lng) < 0.003 &&
          (u.dagen[u.dagen.length - 1] === K.plus(eerste, -1) || K.plus(u.dagen[0], -1) === eerste);
      });
      if (dub) { if (dub.dagen.indexOf(eerste) < 0) dub.dagen.push(eerste); dub.dagen.sort(); }
      else lijst.push(Object.assign({}, x, { dagen: dagen }));
    });
    if (state.plek) lijst = sorteer(lijst);
    // Met foto of affiche eerst: daar is dit blok voor.
    else lijst.sort(function (a, b) { return (!a.foto - !b.foto) || (a.dagen[0] + (a.begin || '')).localeCompare(b.dagen[0] + (b.begin || '')); });
    garageCache = { sleutel: sleutel, lijst: lijst };
    return lijst;
  }

  function kaartje(v) {
    var li = K.kaartje(v);
    var a = li.firstChild;
    a.addEventListener('mouseenter', function () { kaart.licht(v.id, true); });
    a.addEventListener('mouseleave', function () { kaart.licht(v.id, false); });
    return li;
  }

  function kop() {
    var k = state.wanneer === 'vandaag' ? 'home.listToday' : state.wanneer === 'volgend' ? 'home.listNext' : (state.plek ? 'home.listNear' : 'home.listAll');
    if (state.wanneer !== 'weekend' && state.plek) return YG.t(k) + ', ' + state.plek.naam;
    return YG.t(k, { p: state.plek ? state.plek.naam : '' });
  }

  function lagen(wk) {
    var per = { oprit: 0, route: 0, markt: 0 };
    wk.forEach(function (v) { per[v.soort]++; });
    document.querySelectorAll('#lagen button').forEach(function (b) {
      var s = b.getAttribute('data-s');
      b.setAttribute('aria-pressed', String(state.lagen[s]));
      b.querySelector('.yg-count').textContent = per[s];
    });
  }

  function toon() {
    var wk = weekend();
    var lijst = sorteer(wk.filter(function (v) { return state.lagen[v.soort]; }));
    var n = lijst.length;
    sluitPopup();
    lagen(wk);

    $('cta').textContent = state.plek ? YG.t('home.ctaNear', { n: n, p: state.plek.naam }) : YG.t('home.ctaAll', { n: n });
    $('alle').textContent = YG.t('home.allN', { n: n });
    $('alle').href = $('open').href = $('cta').href = kaartLink();
    $('lijst-kop').textContent = kop();
    $('lijst-sort').textContent = state.plek ? YG.t('home.nearest') : YG.t('home.byType');

    var gar = garages().slice(0, 6);
    var alGetoond = {};
    gar.forEach(function (v) { alGetoond[v.id] = 1; });

    // Wat al bij de garagesales staat, komt hier niet nog een keer.
    var ul = $('lijst');
    ul.innerHTML = '';
    var rest = lijst.filter(function (v) { return !alGetoond[v.id] && inGebied(v); });
    rest.slice(0, 8).forEach(function (v) { ul.appendChild(kaartje(v)); });
    $('leeg').hidden = rest.length > 0;

    var gu = $('garages');
    gu.innerHTML = '';
    gar.forEach(function (v) { gu.appendChild(kaartje(v)); });
    gu.hidden = !gar.length;
    $('gar-leeg').hidden = gar.length > 0;
    $('gar-kop').textContent = state.plek ? YG.t('home.garNear', { p: state.plek.naam }) : YG.t('home.garTitle');

    // Eerst de uitsnede, dan de pins (Leaflet kent zonder uitsnede geen grenzen).
    if (state.plek) kaart.map.setView([state.plek.lat, state.plek.lng], 10, { animate: false });
    else kaart.map.setView([K.NL_MIDDEN.lat, K.NL_MIDDEN.lng], breed() ? 8 : 7, { animate: false });
    // Op desktop ligt de zoekkaart links over de kaart: schuif het midden naar rechts.
    if (breed()) kaart.map.panBy([-240, 0], { animate: false });
    kaart.zet(lijst, state.plek);
  }

  function sluitPopup() { if (popup) { kaart.map.closePopup(popup); popup = null; } }

  function openPopup(v) {
    sluitPopup();
    var html = '<div class="yg-pop">' + K.beeldHtml(v, true) + '<div>' +
      '<span class="yg-badge yg-badge--' + v.soort + '">' + K.esc(K.soortTekst(v)) + '</span>' +
      '<h3>' + K.esc(v.titel) + '</h3>' +
      '<p>' + K.esc([K.dagTekst(v), v.plaats].filter(Boolean).join(', ')) + '</p>' +
      '<div class="yg-btns"><a class="yg-btn yg-btn--primary" href="' + K.link(v) + '">' + K.esc(YG.t('map.view')) + '</a></div>' +
      '</div></div>';
    popup = L.popup({ className: 'yg-popup', offset: [0, -30], maxWidth: 320, autoPanPadding: [20, 20] })
      .setLatLng([v.lat, v.lng]).setContent(html).openOn(kaart.map);
  }

  function telling() {
    var wk = K.voegSamen(K.inPeriode(alles, K.periode('weekend')));
    $('live').textContent = YG.t('home.live', { n: wk.length });

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
    $('plaats').value = p.naam === YG.t('loc.mine') ? '' : p.naam;
    toon();
  }

  function locatie() {
    var knop = $('locatie');
    if (!navigator.geolocation) { fout(YG.t('home.locFail')); return; }
    knop.setAttribute('aria-busy', 'true');
    $('locatie-txt').textContent = YG.t('home.locBusy');
    var klaar = function () { knop.removeAttribute('aria-busy'); $('locatie-txt').textContent = YG.t('home.locBtn'); };
    navigator.geolocation.getCurrentPosition(function (pos) {
      klaar();
      kiesPlek({ naam: YG.t('loc.mine'), lat: pos.coords.latitude, lng: pos.coords.longitude });
    }, function () { klaar(); fout(YG.t('home.locFail')); }, { timeout: 8000, maximumAge: 600000 });
  }

  function start() {
    K = window.YGKaart;
    var q = new URLSearchParams(location.search);
    if (['vandaag', 'volgend'].indexOf(q.get('w')) > -1) state.wanneer = q.get('w');
    var b = K.bewaardePlek();
    if (b && typeof b.lat === 'number') { state.plek = b; $('plaats').value = b.naam === YG.t('loc.mine') ? '' : b.naam; }

    kaart = K.maakKaart($('heromap'), {
      stil: true, maxKaartjes: 24, voorrang: true,
      opKlik: openPopup,
      opWijs: function (id, aan) { document.querySelectorAll('.yg-item[data-id="' + id + '"]').forEach(function (a) { a.classList.toggle('is-hot', aan); }); }
    });

    document.querySelectorAll('#wanneer button').forEach(function (btn) {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-w') === state.wanneer));
      btn.addEventListener('click', function () {
        state.wanneer = btn.getAttribute('data-w');
        document.querySelectorAll('#wanneer button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === btn)); });
        toon();
      });
    });

    document.querySelectorAll('#lagen button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var s = btn.getAttribute('data-s');
        state.lagen[s] = !state.lagen[s];
        toon();
      });
    });

    $('locatie').addEventListener('click', locatie);

    // Zoeken: plaats opzoeken en de startpagina daarop zetten; de knop eronder gaat naar de kaart.
    $('zoek').addEventListener('submit', function (e) {
      e.preventDefault();
      var tekst = $('plaats').value.trim();
      if (!tekst) { $('plaats').focus(); return; }
      K.zoekPlaats(tekst, alles).then(function (p) {
        if (!p) { fout(YG.t('home.placeFail')); return; }
        kiesPlek(p);
      });
    });

    K.laad().then(function (lijst) { alles = lijst; telling(); toon(); })
      .catch(function (e) { console.error(e); fout(YG.t('home.none')); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
