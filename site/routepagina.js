// ═══════════════════════════════════════════════════════════════════════
// YardiGo routeplanner (/route): kaart in het midden en de detailkolom
// rechts. De stoplijst, de dagregel en de balk onderaan tekent site/route.js
// (window.YG_ROUTE_PAGINA, zie route.html). Klik op een stop of pin geeft het
// event 'yg-route-toon' ({ stop, nr }); nr = null voor een stop die nog niet in
// de route staat (een plusje op de kaart: ook open langs je route).
// Op de telefoon en op smallere schermen is de detailkolom een kaartje dat
// over de kaart schuift.
// ═══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var K, R, map, el, huidig = null, fotoI = 0, sleutel = null;
  var $ = function (id) { return document.getElementById(id); };
  function t(k, w) { return YG.t(k, w); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var IC = {
    pin: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
    klok: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
  };

  // Kaart passend maken op de route (alleen als de stops veranderen, of op verzoek).
  function pas(altijd) {
    var stops = R.stops(), nu = stops.map(function (s) { return s.id; }).join(',');
    if (!altijd && nu === sleutel) return;
    sleutel = nu;
    if (stops.length) {
      map.fitBounds(L.latLngBounds(stops.map(function (s) { return [s.lat, s.lng]; })), { padding: [56, 56], maxZoom: 14 });
      return;
    }
    var plek = K.bewaardePlek && K.bewaardePlek();
    if (plek && typeof plek.lat === 'number') map.setView([plek.lat, plek.lng], 11);
    else map.setView([K.NL_MIDDEN.lat, K.NL_MIDDEN.lng], 8);
  }

  function nuOpen(s) {
    var vandaag = K.vandaagISO(), nu = K.nuMinuten();
    var min = function (x) { var m = /^(\d{1,2}):(\d{2})/.exec(x || ''); return m ? +m[1] * 60 + +m[2] : null; };
    if (s.soort === 'winkel') {
      var o = R.openOp && R.openOp(s.tijden, vandaag);
      return !!(o && o.some(function (b) { return nu >= b[0] && nu < b[1]; }));
    }
    if (!s.van || vandaag < s.van || vandaag > (s.tot || s.van)) return false;
    var b = min(s.begin), e = min(s.eind);
    return b != null && nu >= b && (e == null || nu < e);
  }

  function wanneer(s) {
    if (s.soort === 'winkel') {
      var o = R.openOp && R.openOp(s.tijden, R.datum());
      if (o && o.length) return t('rt.openAt', { t: o.map(function (b) { var f = function (m) { return Math.floor(m / 60) + ':' + ('0' + m % 60).slice(-2); }; return f(b[0]) + '-' + f(b[1]); }).join(', ') });
      return s.tijden ? K.openingstijden(s.tijden) : '';
    }
    // s.sub (uit kaart.js: dagTekst) heeft de dag en meestal de tijden al.
    return s.sub || K.tijden(s);
  }

  function teken() {
    if (!huidig) {
      var leeg = !R.stops().length;
      el.innerHTML = leeg ? '' : '<div class="yg-rp-det__leeg"><img src="/site/img/cedrik-kaart.png" alt="" width="120" height="120"><p>' + esc(t('rp.pick')) + '</p></div>';
      el.classList.toggle('is-leeg', leeg);
      return;
    }
    el.classList.remove('is-leeg');
    var s = huidig.stop, d = huidig.det;
    var echt = d && d.fotosAlle && d.fotosAlle.length ? d.fotosAlle : null;
    var fotos = echt || [R.beeld(s)];
    var i = ((fotoI % fotos.length) + fotos.length) % fotos.length;
    var adres = s.soort === 'winkel' ? [s.sub, s.plaats].filter(Boolean).join(', ') :
      d && d.adres ? d.adres : s.plaats + (s.benadering ? ' (' + t('rp.addrApprox') + ')' : '');
    var html = '<div class="yg-rp-det__foto">' +
      '<img src="' + esc(fotos[i]) + '" alt="' + esc(echt ? t('det.photoOf', { i: i + 1, n: fotos.length }) : '') + '">' +
      '<span class="yg-rp-det__badge">' + esc(huidig.nr ? t('rp.stopN', { n: huidig.nr }) : t('rp.along')) + '</span>' +
      '<button type="button" class="yg-rp-det__dicht" data-dicht aria-label="' + esc(t('rt.close')) + '">×</button>';
    if (fotos.length > 1) html += '<button type="button" class="yg-rp-det__pijl yg-rp-det__pijl--l" data-stap="-1" aria-label="' + esc(t('det.prev')) + '">‹</button>' +
      '<button type="button" class="yg-rp-det__pijl yg-rp-det__pijl--r" data-stap="1" aria-label="' + esc(t('det.next')) + '">›</button>' +
      '<span class="yg-rp-det__n">' + (i + 1) + ' / ' + fotos.length + '</span>';
    html += '</div><div class="yg-rp-det__body">' +
      '<h2>' + esc(s.titel) + '</h2>' +
      (adres ? '<p class="yg-rp-det__r">' + IC.pin + '<span>' + esc(adres) + '</span></p>' : '') +
      (wanneer(s) ? '<p class="yg-rp-det__r">' + IC.klok + '<span>' + esc(wanneer(s)) + '</span>' + (nuOpen(s) ? '<span class="yg-rp-open">' + esc(t('rp.nowOpen')) + '</span>' : '') + '</p>' : '');
    if (d && d.tags && d.tags.length) html += '<ul class="yg-rp-tags">' + d.tags.slice(0, 6).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    if (d && d.beschrijving) html += '<p class="yg-rp-det__tekst">' + esc(d.beschrijving) + '</p>';
    else if (s.soort !== 'winkel' && !d) html += '<p class="yg-meta">' + esc(t('rp.loading')) + '</p>';
    if (echt && echt.length > 1) {
      html += '<div class="yg-rp-duim">' + echt.slice(0, 4).map(function (f, k) {
        var meer = k === 3 && echt.length > 4 ? '<span>+' + (echt.length - 4) + '</span>' : '';
        return '<button type="button" data-foto="' + k + '" aria-label="' + esc(t('det.photoOf', { i: k + 1, n: echt.length })) + '"' + (k === i ? ' aria-current="true"' : '') + '><img src="' + esc(f) + '" alt="" loading="lazy">' + meer + '</button>';
      }).join('') + '</div>';
    }
    html += '<div class="yg-rp-det__knoppen">' + R.knop(s, 'yg-btn--primary yg-btn--block') +
      (s.soort !== 'winkel' ? '<a class="yg-btn yg-btn--outline yg-btn--block" href="' + esc(K.link(s)) + '">' + esc(t('rp.viewSale')) + '</a>' : '') + '</div></div>';
    el.innerHTML = html;
  }

  function toon(stop, nr, stil) {
    var zelfde = huidig && huidig.stop.id === stop.id;
    huidig = { stop: stop, nr: nr, det: zelfde ? huidig.det : null };
    if (!zelfde) fotoI = 0;
    teken();
    if (!stil) {
      el.classList.add('is-open');
      if (!map.getBounds().pad(-0.1).contains([stop.lat, stop.lng])) map.panTo([stop.lat, stop.lng]);
    }
    if (stop.soort !== 'winkel' && !huidig.det) {
      K.detail(stop.id).then(function (d) {
        if (!huidig || huidig.stop.id !== stop.id) return;
        huidig.det = d || { fotosAlle: [], tags: [] };
        teken();
      }).catch(function () { if (huidig && huidig.stop.id === stop.id) { huidig.det = { fotosAlle: [], tags: [] }; teken(); } });
    }
  }

  function kiesEerste() {
    var s = R.stops()[0];
    if (s) { stilKiezen = true; R.toon(s.id); stilKiezen = false; }
    else { huidig = null; teken(); }
  }
  var stilKiezen = false;

  function start() {
    K = window.YGKaart; R = window.YGRoute; el = $('yg-rp-detail');
    if (!K || !R || !window.L) return;
    map = K.maakKaart($('yg-rp-kaart')).map;
    R.opKaart(map);
    pas(true);
    // Na de eerste opmaak heeft de kaart pas zijn echte maat (telefoon: 40% van het scherm).
    setTimeout(function () { map.invalidateSize(); pas(true); }, 150);

    document.addEventListener('yg-route-toon', function (e) { toon(e.detail.stop, e.detail.nr, stilKiezen); });
    document.addEventListener('yg-route-wijzig', function () {
      pas(false);
      if (!huidig) { kiesEerste(); return; }
      var lijst = R.stops(), i = -1;
      lijst.forEach(function (s, k) { if (s.id === huidig.stop.id) i = k; });
      if (i > -1) { huidig.stop = lijst[i]; if (huidig.nr !== i + 1) { huidig.nr = i + 1; teken(); } }
      else if (huidig.nr) { el.classList.remove('is-open'); kiesEerste(); }
    });

    el.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-dicht')) { el.classList.remove('is-open'); return; }
      if (b.hasAttribute('data-stap')) { fotoI += +b.getAttribute('data-stap'); teken(); return; }
      if (b.hasAttribute('data-foto')) { fotoI = +b.getAttribute('data-foto'); teken(); }
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && el.classList.contains('is-open')) el.classList.remove('is-open'); });

    $('rp-in').addEventListener('click', function () { map.zoomIn(); });
    $('rp-uit').addEventListener('click', function () { map.zoomOut(); });
    $('rp-alles').addEventListener('click', function () { pas(true); });
    $('rp-hier').addEventListener('click', function () {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(function (p) { map.setView([p.coords.latitude, p.coords.longitude], 13); }, function () {}, { timeout: 10000, maximumAge: 300000 });
    });
    // De kolommen wisselen van maat met het scherm: Leaflet opnieuw laten meten.
    window.addEventListener('resize', function () { map.invalidateSize(); });

    kiesEerste();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
