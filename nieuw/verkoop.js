// YardiGo nieuwe verkooppagina (/nieuw/verkoop?id=…): galerij met foto's of
// het affiche, wat er te koop is, wanneer en waar, en wat er die dag nog meer
// in de buurt is. Adres en precieze plek volgen de privacyregels van de RPC:
// zonder account geen adres, en bij garagesales alleen het gebied.
// Data en kaart: /site/kaart.js.
(function () {
  'use strict';

  var K, v, fotos = [], nu = 0;
  var DAG_KM = 15;
  var $ = function (id) { return document.getElementById(id); };

  function fout(tekst) { $('laden').textContent = tekst; $('laden').hidden = false; $('inhoud').hidden = true; }

  // Dagen waarop hij nog open is (vanaf vandaag, hooguit een week).
  function dagen(x) {
    var uit = [], d = x.van < K.vandaagISO() ? K.vandaagISO() : x.van;
    for (; d <= x.tot && uit.length < 7; d = K.plus(d, 1)) uit.push(d);
    return uit.length ? uit : [x.van];
  }

  // ── Galerij ──────────────────────────────────────────────────────────
  function toonFoto(i) {
    nu = (i + fotos.length) % fotos.length;
    var img = $('groot');
    img.src = fotos[nu];
    img.alt = v.fotosAlle.length ? YG.t('det.photoOf', { i: nu + 1, n: fotos.length }) + ', ' + v.titel : '';
    $('teller').textContent = (nu + 1) + ' / ' + fotos.length;
    $('duimen').querySelectorAll('button').forEach(function (b, j) { b.setAttribute('aria-current', String(j === nu)); });
  }

  function galerij() {
    fotos = v.fotosAlle.length ? v.fotosAlle : [K.beeld(v)];
    var meer = fotos.length > 1;
    $('galerij').classList.toggle('yg-gal--tekening', !v.fotosAlle.length);
    ['vorige', 'volgende', 'teller', 'duimen'].forEach(function (id) { $(id).hidden = !meer; });
    $('duimen').innerHTML = meer ? fotos.map(function (src, i) {
      return '<button type="button" aria-label="' + K.esc(YG.t('det.photoOf', { i: i + 1, n: fotos.length })) + '"><img src="' + K.esc(src) + '" alt="" loading="lazy"></button>';
    }).join('') : '';
    $('duimen').querySelectorAll('button').forEach(function (b, i) { b.addEventListener('click', function () { toonFoto(i); }); });
    $('vorige').addEventListener('click', function () { toonFoto(nu - 1); });
    $('volgende').addEventListener('click', function () { toonFoto(nu + 1); });
    $('galerij').addEventListener('keydown', function (e) {
      if (!meer) return;
      if (e.key === 'ArrowLeft') toonFoto(nu - 1);
      if (e.key === 'ArrowRight') toonFoto(nu + 1);
    });
    toonFoto(0);
  }

  // ── Knoppen ──────────────────────────────────────────────────────────
  function agenda() {
    var d = v.dagen[0].replace(/-/g, ''), e = v.dagen[v.dagen.length - 1].replace(/-/g, '');
    var t = function (x) { return x ? x.slice(0, 5).replace(':', '') + '00' : ''; };
    var regels = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//YardiGo//NL', 'BEGIN:VEVENT',
      'UID:' + v.id + '@yardigo.nl', 'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'];
    if (v.begin) regels.push('DTSTART:' + d + 'T' + t(v.begin), 'DTEND:' + (v.dagen.length > 1 ? e : d) + 'T' + t(v.eind || v.begin));
    else regels.push('DTSTART;VALUE=DATE:' + d, 'DTEND;VALUE=DATE:' + K.plus(v.dagen[v.dagen.length - 1], 1).replace(/-/g, ''));
    regels.push('SUMMARY:' + v.titel.replace(/[,;\n]/g, ' '), 'LOCATION:' + (v.adres || v.plaats).replace(/[,;\n]/g, ' '),
      'URL:' + location.href, 'END:VEVENT', 'END:VCALENDAR');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([regels.join('\r\n')], { type: 'text/calendar' }));
    a.download = 'yardigo-' + v.id.slice(0, 8) + '.ics';
    document.body.appendChild(a); a.click(); a.remove();
  }

  function delen() {
    var url = location.href;
    if (navigator.share) { navigator.share({ title: v.titel, url: url }).catch(function () {}); return; }
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () {
      $('delen-txt').textContent = YG.t('det.copied');
      setTimeout(function () { $('delen-txt').textContent = YG.t('det.share'); }, 2500);
    });
  }

  // ── Invullen ─────────────────────────────────────────────────────────
  function vulIn() {
    document.title = v.titel + ' | YardiGo';
    v.dagen = dagen(v);
    $('soort').textContent = K.soortTekst(v);
    $('soort').className = 'yg-badge yg-badge--' + v.soort;
    $('titel').textContent = v.titel;
    $('datum-dag').textContent = K.dagKort(v.dagen[0]);
    $('datum-nr').textContent = Number(v.dagen[0].slice(8));
    $('wanneer').textContent = K.dagTekst(v);
    $('waar').textContent = v.adres ? v.adres + ', ' + v.plaats : v.plaats;

    var prive = v.soort !== 'markt';
    var info = '';
    if (!v.adres && prive) {
      var vanaf = v.adresVanaf && new Date(v.adresVanaf) > new Date() ? new Date(v.adresVanaf) : null;
      info = (vanaf ? YG.t('det.addrFrom', { d: vanaf.toLocaleDateString(YG.taal === 'nl' ? 'nl-NL' : YG.taal, { weekday: 'long', day: 'numeric', month: 'long' }) }) + ' ' : '') + YG.t('det.addrLogin');
    }
    $('adres-info').textContent = info;
    $('adres-info').hidden = !info;

    // Route alleen naar een echte plek; bij een gebied zou dat naar het verkeerde huis leiden.
    $('route').hidden = v.benadering;
    $('route').href = 'https://www.google.com/maps/dir/?api=1&destination=' + v.lat.toFixed(5) + ',' + v.lng.toFixed(5);
    $('app').href = $('eigenaar-link').href = '/v/' + encodeURIComponent(v.id);
    $('benadering').hidden = !v.benadering;

    var tags = v.tags.filter(Boolean);
    $('te-koop').hidden = !tags.length;
    $('tags').innerHTML = tags.map(function (t) { return '<span class="yg-chip yg-chip--static">' + K.esc(t) + '</span>'; }).join('');
    $('over').hidden = !v.beschrijving;
    $('tekst').textContent = v.beschrijving;
    $('bron').hidden = !v.bron;
    $('bron').textContent = v.bron ? YG.t('det.source', { s: v.bron }) : '';
    $('eigenaar').hidden = !(prive && v.fotosAlle.length <= 1);

    galerij();
    $('laden').hidden = true;
    $('inhoud').hidden = false;

    var kaart = K.maakKaart($('minikaart'), { stil: true, toonMidden: false });
    kaart.map.setView([v.lat, v.lng], v.benadering ? 14 : 15, { animate: false });
    if (v.benadering) L.circle([v.lat, v.lng], { radius: 350, color: '#C5612A', weight: 2, fillColor: '#F2A830', fillOpacity: .25 }).addTo(kaart.map);
    else kaart.zet([v], null);
    $('minikaart').setAttribute('aria-label', YG.t('nav.map') + ': ' + v.plaats);
    $('terug').href = $('dag-kaart').href = '/nieuw/kaart?lat=' + v.lat.toFixed(4) + '&lng=' + v.lng.toFixed(4) + '&p=' + encodeURIComponent(v.plaats);
  }

  // Wat er dezelfde dag dichtbij is: garagesales eerst, dan dichtstbij.
  function dag(alles) {
    var d = v.dagen[0];
    var lijst = K.voegSamen(K.inPeriode(alles, [d, d]))
      .filter(function (x) { return x.id !== v.id; })
      .map(function (x) { return Object.assign(x, { km: K.afstand(v, x) }); })
      .filter(function (x) { return x.km <= DAG_KM; })
      .sort(function (a, b) { return (K.VOLGORDE[a.soort] - K.VOLGORDE[b.soort]) || a.km - b.km; })
      .slice(0, 8);
    $('dag').hidden = false;
    $('dag-txt').textContent = lijst.length ? YG.t('det.dayTxt', { k: DAG_KM }) : YG.t('det.dayNone');
    var ul = $('dag-lijst');
    ul.innerHTML = '';
    lijst.forEach(function (x) { ul.appendChild(K.kaartje(x)); });
  }

  function start() {
    K = window.YGKaart;
    var id = new URLSearchParams(location.search).get('id') || '';
    if (!/^[0-9a-f-]{36}$/i.test(id)) { fout(YG.t('det.notFound')); return; }
    $('delen').addEventListener('click', delen);
    $('agenda').addEventListener('click', agenda);
    K.detail(id).then(function (x) {
      if (!x) { fout(YG.t('det.notFound')); return; }
      v = x;
      vulIn();
      return K.laad().then(dag);
    }).catch(function (e) { console.error(e); fout(YG.t('det.notFound')); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
