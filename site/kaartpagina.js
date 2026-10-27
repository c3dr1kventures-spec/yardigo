// YardiGo nieuwe kaartpagina (/kaart): lijst links, kaart rechts
// (op de telefoon kaart boven, lijst eronder). De lijst toont wat er op de
// kaart te zien is en volgt de kaart als je schuift of zoomt; wijs je een
// rij aan, dan licht het kaartje op en andersom. Data en kaart: /site/kaart.js.
(function () {
  'use strict';

  var K, kaart, alles = [], popup;
  var state = { plek: null, wanneer: 'alles', soorten: { markt: true, route: true, oprit: true }, gekozen: null };
  var MAX_RIJEN = 60;
  var $ = function (id) { return document.getElementById(id); };

  function huidig() {
    var lijst = K.voegSamen(K.inPeriode(alles, K.periode(state.wanneer)));
    return lijst.filter(function (v) { return state.soorten[v.soort]; });
  }

  // Bij een periode van meer dan één weekend krijgen kaartjes een datum.
  function metDatum() { return state.wanneer === 'alles' || state.wanneer === 'volgend'; }
  function zet() { kaart.zet(huidig(), state.plek, { metDatum: metDatum() }); }

  function bewaarInLink() {
    var q = new URLSearchParams(location.search);
    ['lat', 'lng', 'p', 'w'].forEach(function (k) { q.delete(k); });
    if (state.plek) { q.set('lat', state.plek.lat.toFixed(4)); q.set('lng', state.plek.lng.toFixed(4)); q.set('p', state.plek.naam); }
    if (state.wanneer !== 'alles') q.set('w', state.wanneer);
    var s = q.toString();
    history.replaceState(null, '', location.pathname + (s ? '?' + s : ''));
  }

  function dagknoppen() {
    var opties = [['alles', YG.t('when.all')], ['weekend', YG.t('when.weekend')]];
    var w = K.periode('weekend');
    if (w[0] !== w[1]) { opties.push(['za', K.dagKort(w[0]) + ' ' + Number(w[0].slice(8))]); opties.push(['zo', K.dagKort(w[1]) + ' ' + Number(w[1].slice(8))]); }
    opties.push(['vandaag', YG.t('when.today')], ['volgend', YG.t('home.next')]);
    $('dagen').innerHTML = opties.map(function (o) {
      var n = K.voegSamen(K.inPeriode(alles, K.periode(o[0]))).filter(function (v) { return state.soorten[v.soort]; }).length;
      return '<button class="yg-chip yg-chip--day" type="button" data-w="' + o[0] + '" aria-pressed="' + (o[0] === state.wanneer) + '">' +
        K.esc(o[1]) + ' <span class="yg-count yg-num">' + n + '</span></button>';
    }).join('');
    $('dagen').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () { state.wanneer = b.getAttribute('data-w'); sluitPopup(); dagknoppen(); zet(); bewaarInLink(); });
    });
  }

  // Lijst = wat er nu op de kaart te zien is.
  function lijst(zichtbaar) {
    var grens = kaart.map.getBounds();
    var midden = state.plek || { lat: kaart.map.getCenter().lat, lng: kaart.map.getCenter().lng };
    var rijen = zichtbaar.filter(function (v) { return grens.contains([v.lat, v.lng]); })
      .map(function (v) { return Object.assign(v, { km: K.afstand(midden, v) }); })
      .sort(function (a, b) { return a.km - b.km; });

    $('res').textContent = YG.t('map.inView', { n: rijen.length });
    $('sort').textContent = YG.t('map.sortNear');
    $('leeg').hidden = rijen.length > 0;
    $('meer').hidden = rijen.length <= MAX_RIJEN;
    $('meer').textContent = YG.t('map.more', { n: rijen.length - MAX_RIJEN });

    var ol = $('lijst');
    ol.innerHTML = '';
    rijen.slice(0, MAX_RIJEN).forEach(function (v) {
      var li = document.createElement('li');
      var cls = 'yg-tag yg-tag--inline' + (v.soort === 'route' ? ' yg-tag--route' : v.soort === 'oprit' ? ' yg-tag--oprit' : '');
      li.innerHTML = '<a class="yg-row' + (state.gekozen === v.id ? ' is-hot' : '') + '" href="' + K.link(v) + '" data-id="' + K.esc(v.id) + '">' +
        '<span class="' + cls + '">' + K.esc(metDatum() ? K.label(v, true) : v.dagen.map(K.dagKort).join(' + ')) + '</span>' +
        '<span style="min-width:0"><strong>' + K.esc(v.titel) + '</strong><span class="yg-meta">' + K.esc([v.plaats, K.tijden(v)].filter(Boolean).join(', ')) + '</span></span>' +
        '<span class="yg-km yg-num">' + Math.round(v.km) + ' ' + YG.t('unit.km') + '</span></a>';
      var a = li.firstChild;
      a.addEventListener('mouseenter', function () { kaart.licht(v.id, true); });
      a.addEventListener('mouseleave', function () { kaart.licht(v.id, false); });
      a.addEventListener('focus', function () { kaart.licht(v.id, true); });
      a.addEventListener('blur', function () { kaart.licht(v.id, false); });
      // Eerste klik toont de verkoop op de kaart; de link zelf opent de pagina.
      a.addEventListener('click', function (e) {
        if (state.gekozen === v.id) return;
        e.preventDefault();
        open(v, true);
      });
      ol.appendChild(li);
    });
  }

  function sluitPopup() { if (popup) { kaart.map.closePopup(popup); popup = null; } state.gekozen = null; }

  function open(v, centreer) {
    state.gekozen = v.id;
    kaart.kies(v.id);
    var dagen = v.dagen.map(K.dagLang).join(' ' + YG.t('time.and') + ' ');
    var route = 'https://www.google.com/maps/dir/?api=1&destination=' + v.lat.toFixed(5) + ',' + v.lng.toFixed(5);
    var html = '<h3>' + K.esc(v.titel) + '</h3><p>' + K.esc(dagen) + (v.begin ? ', ' + K.esc(K.tijden(v)) : '') + '<br>' + K.esc(v.plaats) +
      (v.benadering ? '<br>' + K.esc(YG.t('map.approx')) : '') + '</p>' +
      '<div class="yg-btns"><a class="yg-btn yg-btn--primary" href="' + K.link(v) + '">' + K.esc(YG.t('map.view')) + '</a>' + K.routeKnop(K.stopVan(v)) +
      '</div>';
    popup = L.popup({ className: 'yg-popup', offset: [0, -30], autoPanPaddingTopLeft: [20, 70], autoPanPaddingBottomRight: [20, 20], maxWidth: 300 }).setLatLng([v.lat, v.lng]).setContent(html).openOn(kaart.map);
    if (centreer) kaart.map.panTo([v.lat, v.lng]);
    document.querySelectorAll('.yg-row.is-hot').forEach(function (x) { x.classList.remove('is-hot'); });
    var rij = document.querySelector('.yg-row[data-id="' + v.id + '"]');
    if (rij) { rij.classList.add('is-hot'); rij.scrollIntoView({ block: 'nearest' }); }
  }

  function zetPlek(p, zoom) {
    state.plek = p;
    if (p) { K.bewaarPlek(p); $('plaats').value = p.naam === YG.t('loc.mine') ? '' : p.naam; kaart.map.setView([p.lat, p.lng], zoom || 10); }
    zet();
    bewaarInLink();
  }

  function fout(t) { $('fout').textContent = t || ''; $('fout').hidden = !t; }

  function start() {
    K = window.YGKaart;
    var q = new URLSearchParams(location.search);
    if (['weekend', 'vandaag', 'volgend', 'za', 'zo'].indexOf(q.get('w')) > -1) state.wanneer = q.get('w');
    var lat = parseFloat(q.get('lat')), lng = parseFloat(q.get('lng'));
    var plek = isFinite(lat) && isFinite(lng) ? { naam: q.get('p') || '', lat: lat, lng: lng } : K.bewaardePlek();

    kaart = K.maakKaart($('kaart'), {
      maxKaartjes: 50,
      opKlik: function (v) { open(v, false); },
      opWijs: function (id, aan) { var a = document.querySelector('.yg-row[data-id="' + id + '"]'); if (a) a.classList.toggle('is-hot', aan || state.gekozen === id); },
      naTekenen: lijst,
      opWinkel: function (w) {
        sluitPopup();
        popup = L.popup({ className: 'yg-popup', offset: [0, -8], autoPanPaddingTopLeft: [20, 70], autoPanPaddingBottomRight: [20, 20], maxWidth: 300 })
          .setLatLng([w.lat, w.lng]).setContent(K.winkelPopupHtml(w)).openOn(kaart.map);
      }
    });

    // Kringloopwinkels: standaard uit, laden pas bij aanzetten.
    $('winkels').addEventListener('click', function () {
      var b = $('winkels'), aan = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(aan));
      if (!aan) { kaart.winkels([]); $('winkels-n').textContent = ''; return; }
      b.setAttribute('aria-busy', 'true');
      K.winkels().then(function (l) {
        b.removeAttribute('aria-busy');
        if (b.getAttribute('aria-pressed') !== 'true') return;
        $('winkels-n').textContent = l.length;
        kaart.winkels(l);
      }).catch(function (e) { console.error(e); b.removeAttribute('aria-busy'); b.setAttribute('aria-pressed', 'false'); });
    });
    kaart.map.on('popupclose', function () { state.gekozen = null; kaart.kies(null); });

    if (plek && typeof plek.lat === 'number') { state.plek = plek; $('plaats').value = plek.naam === YG.t('loc.mine') ? '' : plek.naam; kaart.map.setView([plek.lat, plek.lng], 10); }
    else kaart.map.setView([K.NL_MIDDEN.lat, K.NL_MIDDEN.lng], 8);

    $('in').addEventListener('click', function () { kaart.map.zoomIn(); });
    $('uit').addEventListener('click', function () { kaart.map.zoomOut(); });
    $('hier').addEventListener('click', function () {
      if (!navigator.geolocation) { fout(YG.t('home.locFail')); return; }
      navigator.geolocation.getCurrentPosition(function (pos) {
        fout(''); zetPlek({ naam: YG.t('loc.mine'), lat: pos.coords.latitude, lng: pos.coords.longitude }, 11);
      }, function () { fout(YG.t('home.locFail')); }, { timeout: 8000, maximumAge: 600000 });
    });

    document.querySelectorAll('[data-soort]').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = b.getAttribute('data-soort');
        state.soorten[s] = !state.soorten[s];
        b.setAttribute('aria-pressed', String(state.soorten[s]));
        sluitPopup(); dagknoppen(); zet();
      });
    });

    $('zoek').addEventListener('submit', function (e) {
      e.preventDefault();
      K.zoekPlaats($('plaats').value, alles).then(function (p) {
        if (!p) { fout(YG.t('home.placeFail')); return; }
        fout(''); sluitPopup(); zetPlek(p, 10);
      });
    });

    K.laad().then(function (l) { alles = l; dagknoppen(); zet(); })
      .catch(function (e) { console.error(e); fout(YG.t('home.none')); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
