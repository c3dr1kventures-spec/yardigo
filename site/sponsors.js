// YardiGo sponsorvakken op de homepage: 3 links (plek 1-3), 3 rechts (4-6),
// alleen op schermen waar naast de inhoud ruimte is. Elk domein heeft eigen
// sponsors: yardigo.nl Nederlandse, yardigo.be Belgische, yardigo.de Duitse.
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
    if (/(^|\.)yardigo\.de$/.test(h)) return 'de';
    if (!/(^|\.)yardigo\.nl$/.test(h) && (q === 'be' || q === 'de')) return q;
    return 'nl';
  })();
  var geteld = false;
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

  function vak(s) {
    var logo = s.logo_url
      ? '<img class="yg-sv__logo" src="' + K.esc(s.logo_url) + '" alt="" loading="lazy" width="44" height="44">'
      : '<span class="yg-sv__logo" style="background:' + K.esc(s.kleur) + '" aria-hidden="true">' + K.esc(s.naam.charAt(0).toUpperCase()) + '</span>';
    var host = s.url.replace(/^https:\/\/(www\.)?/, '').replace(/\/.*$/, '');
    return '<a class="yg-sv" href="' + K.esc(s.url) + '" target="_blank" rel="sponsored noopener" data-id="' + s.id + '">' +
      '<span class="yg-sv__lbl">' + K.esc(t('sp.label')) + '</span>' +
      '<span class="yg-sv__rij">' + logo + '<span><span class="yg-sv__naam">' + K.esc(s.naam) + '</span>' +
      '<span class="yg-sv__url">' + K.esc(host) + '</span></span></span>' +
      (s.tekst ? '<span class="yg-sv__tekst">' + K.esc(s.tekst) + '</span>' : '') + '</a>';
  }

  function leeg() {
    return '<a class="yg-sv yg-sv--leeg" href="' + MAIL + '">' +
      '<span class="yg-sv__naam">' + K.esc(t('sp.free')) + '</span>' +
      '<span class="yg-sv__tekst">' + K.esc(t('sp.freeTxt')) + '</span>' +
      '<span class="yg-sv__knop">' + K.esc(t('sp.cta')) + '</span></a>';
  }

  // Per kant de verkochte plekken op volgorde, plus één vrij vak zolang er nog plek is.
  function kolom(lijst, van) {
    var html = '';
    for (var p = van; p < van + 3; p++) {
      var s = lijst.filter(function (x) { return x.plek === p; })[0];
      if (s) html += vak(s);
    }
    if (lijst.filter(function (x) { return x.plek >= van && x.plek < van + 3; }).length < 3) html += leeg();
    return html;
  }

  function teken(lijst) {
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
    main.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('.yg-sv[data-id]');
      if (a) tel([Number(a.getAttribute('data-id'))], true);
    });
    function weergave() {
      if (geteld || !BREED.matches) return;
      geteld = true;
      tel(lijst.map(function (s) { return s.id; }), false);
    }
    weergave();
    if (BREED.addEventListener) BREED.addEventListener('change', weergave);
  }

  // Op smallere schermen niets laden; pas als het venster breed genoeg wordt.
  function start() {
    if (!K) return;
    if (!BREED.matches) {
      if (BREED.addEventListener) BREED.addEventListener('change', function wacht() { BREED.removeEventListener('change', wacht); start(); });
      return;
    }
    api('sponsors?select=id,plek,naam,tekst,url,logo_url,kleur&land=eq.' + LAND + '&order=plek')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (lijst) { teken(Array.isArray(lijst) ? lijst : []); })
      .catch(function () { teken([]); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
