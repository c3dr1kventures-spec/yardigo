// YardiGo sponsors op de homepage. Elk domein heeft eigen sponsors:
// yardigo.nl Nederlandse, yardigo.be Belgische, yardigo.de Duitse.
//   - Brede schermen (vanaf 1600 px): vakken naast de inhoud, 3 links
//     (plek 1-3) en 3 rechts (4-6), met onderaan altijd een vak dat om
//     sponsors vraagt.
//   - Smallere schermen (telefoon, laptop): één sponsor als vierde kaartje in
//     de lijst "Binnenkort", elke keer een andere. home.js roept inLijst() aan
//     na het vullen van die lijst.
// Beheer via de Telegram-bot (/sponsor). Weergaven en kliks tellen we per dag
// in sponsor_stats, zonder cookies of iets over de bezoeker.
(function () {
  'use strict';

  var K = window.YGKaart;
  var BREED = window.matchMedia('(min-width: 1600px)');
  var MAIL = 'mailto:info@yardigo.nl?subject=Sponsorplek%20YardiGo';
  // Preview-deploys en localhost: ?land=be of ?land=de om een domein na te doen.
  var LAND = (function () {
    var h = location.hostname, q = new URLSearchParams(location.search).get('land');
    if (/(^|\.)yardigo\.be$/.test(h)) return 'be';
    // yardigo.app gebruiken we voor Duitse verkopen zolang yardigo.de er niet is.
    if (/(^|\.)yardigo\.(de|app)$/.test(h)) return 'de';
    if (!/(^|\.)yardigo\.nl$/.test(h) && (q === 'be' || q === 'de')) return q;
    return 'nl';
  })();
  var sponsors = null;      // null = nog aan het laden
  var inDeLijst = null;     // de sponsor voor het kaartje in de lijst, vast per bezoek
  var wachtendeLijst = null;
  var zijGeteld = false, lijstGeteld = false;
  var t = function (k) { return window.YG ? window.YG.t(k) : k; };

  function api(pad, opties) {
    return fetch(K.SUPABASE_URL + '/rest/v1/' + pad, Object.assign({
      headers: { apikey: K.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + K.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }
    }, opties || {}));
  }

  function tel(ids, klik) {
    if (!ids.length) return;
    api('rpc/sponsor_tel', { method: 'POST', keepalive: true, body: JSON.stringify({ p_ids: ids, p_klik: !!klik }) }).catch(function () {});
  }

  function logo(s) {
    return s.logo_url
      ? '<img class="yg-sv__logo" src="' + K.esc(s.logo_url) + '" alt="" loading="lazy" width="44" height="44">'
      : '<span class="yg-sv__logo" style="background:' + K.esc(s.kleur) + '" aria-hidden="true">' + K.esc(s.naam.charAt(0).toUpperCase()) + '</span>';
  }
  function host(s) { return s.url.replace(/^https:\/\/(www\.)?/, '').replace(/\/.*$/, ''); }

  function vak(s) {
    return '<a class="yg-sv" href="' + K.esc(s.url) + '" target="_blank" rel="sponsored noopener" data-sponsor="' + s.id + '">' +
      '<span class="yg-sv__lbl">' + K.esc(t('sp.label')) + '</span>' +
      '<span class="yg-sv__rij">' + logo(s) + '<span><span class="yg-sv__naam">' + K.esc(s.naam) + '</span>' +
      '<span class="yg-sv__url">' + K.esc(host(s)) + '</span></span></span>' +
      (s.tekst ? '<span class="yg-sv__tekst">' + K.esc(s.tekst) + '</span>' : '') + '</a>';
  }

  function leeg() {
    return '<a class="yg-sv yg-sv--leeg" href="' + MAIL + '">' +
      '<span class="yg-sv__naam">' + K.esc(t('sp.free')) + '</span>' +
      '<span class="yg-sv__tekst">' + K.esc(t('sp.freeTxt')) + '</span>' +
      '<span class="yg-sv__knop">' + K.esc(t('sp.cta')) + '</span></a>';
  }

  // Per kant de sponsors onder elkaar (hooguit 3, op volgorde van plek) en
  // daaronder altijd het vak dat om sponsors vraagt.
  function kolom(lijst, van) {
    var html = '';
    for (var p = van; p < van + 3; p++) {
      var s = lijst.filter(function (x) { return x.plek === p; })[0];
      if (s) html += vak(s);
    }
    return html + leeg();
  }

  // Kaartje in dezelfde vorm als een verkoop, met het label Sponsor.
  function lijstKaartje(s) {
    var li = document.createElement('li');
    li.className = 'yg-sponsor-item';
    li.innerHTML = '<a class="yg-item" href="' + K.esc(s.url) + '" target="_blank" rel="sponsored noopener" data-sponsor="' + s.id + '">' +
      '<span class="yg-item__img yg-sponsor-item__img">' + logo(s) + '</span>' +
      '<span class="yg-item__txt">' +
        '<span class="yg-item__day yg-sponsor-item__lbl">' + K.esc(t('sp.label')) + '</span>' +
        '<strong>' + K.esc(s.naam) + '</strong>' +
        '<span class="yg-meta">' + K.esc(s.tekst || host(s)) + '</span>' +
      '</span></a>';
    return li;
  }

  // Na elke nieuwe vulling van "Binnenkort": de sponsor als vierde kaartje.
  // Geteld wordt hij pas als hij echt in beeld komt.
  function inLijst(ul) {
    if (!ul) return;
    if (sponsors === null) { wachtendeLijst = ul; return; }
    if (!inDeLijst) return;
    var li = lijstKaartje(inDeLijst);
    ul.insertBefore(li, ul.children[3] || null);
    if (lijstGeteld || !('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (items) {
      if (!items.some(function (x) { return x.isIntersecting; }) || lijstGeteld || BREED.matches) return;
      lijstGeteld = true;
      io.disconnect();
      tel([inDeLijst.id], false);
    }, { threshold: 0.6 });
    io.observe(li);
  }

  function zijkanten(lijst) {
    var main = document.getElementById('inhoud-start');
    if (!main) return;
    ['l', 'r'].forEach(function (kant) {
      var el = document.createElement('aside');
      el.className = 'yg-sponsors yg-sponsors--' + kant;
      el.setAttribute('aria-label', t('sp.aria'));
      el.innerHTML = kolom(lijst, kant === 'l' ? 1 : 4);
      main.appendChild(el);
    });
    document.body.classList.add('yg-met-sponsors');
    function weergave() {
      if (zijGeteld || !BREED.matches) return;
      zijGeteld = true;
      tel(lijst.map(function (s) { return s.id; }), false);
    }
    weergave();
    if (BREED.addEventListener) BREED.addEventListener('change', weergave);
  }

  function klaar(lijst) {
    sponsors = lijst;
    inDeLijst = lijst.length ? lijst[Math.floor(Math.random() * lijst.length)] : null;
    zijkanten(lijst);
    if (wachtendeLijst) { inLijst(wachtendeLijst); wachtendeLijst = null; }
  }

  function start() {
    if (!K) return;
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('[data-sponsor]');
      if (a) tel([Number(a.getAttribute('data-sponsor'))], true);
    });
    api('sponsors?select=id,plek,naam,tekst,url,logo_url,kleur&land=eq.' + LAND + '&order=plek')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (lijst) { klaar(Array.isArray(lijst) ? lijst : []); })
      .catch(function () { klaar([]); });
  }

  window.YGSponsors = { inLijst: inLijst };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
