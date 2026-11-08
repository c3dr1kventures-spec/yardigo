// Maakt site/route-app.css: de stijlen van de dagplanner (site/route.js) uit
// site/site.css, voor de app (app.html). Zo blijft site.css de enige bron.
// Draaien: node scripts/route-app-css.js (gebeurt ook in npm run _copy-web).
'use strict';
const fs = require('fs');
const path = require('path');

const bron = fs.readFileSync(path.join(__dirname, '..', 'site', 'site.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// Basisklassen plus hun varianten (ook de winkelpin en -badge voor de kaart van de app) (--primary, __greep); niet yg-btns of yg-stops.
const KLASSEN = /\.yg-(btns?|field|label|seg|error|meta|sr|stop|routepaneel|routelijst|routeknop|rt|mijnroutes|sleept|shop|pin|badge)([_-][a-z0-9_-]*)?(?![a-z0-9])/;
const NIET = /\.yg-(mappage|header|band|popup|pop|det|item|met-sponsors|hero|keuze)|\.yg-route-actief|\.yg-route-open|\.yg-routebalk/;

// Platte lijst van blokken: { kop, inhoud } of { kop, blokken } voor @media.
function blokken(tekst) {
  const uit = [];
  let i = 0;
  while (i < tekst.length) {
    const open = tekst.indexOf('{', i);
    if (open < 0) break;
    const kop = tekst.slice(i, open).trim();
    let diepte = 1, j = open + 1;
    while (diepte && j < tekst.length) { if (tekst[j] === '{') diepte++; else if (tekst[j] === '}') diepte--; j++; }
    const binnen = tekst.slice(open + 1, j - 1);
    uit.push(kop.startsWith('@media') || kop.startsWith('@supports') ? { kop, blokken: blokken(binnen) } : { kop, inhoud: binnen.trim() });
    i = j;
  }
  return uit;
}

function houd(b) {
  if (b.blokken) return b.blokken.some(houd);
  if (b.kop === ':root') return true;
  const kiezers = b.kop.split(',').map((x) => x.trim());
  return kiezers.some((k) => KLASSEN.test(k) && !NIET.test(k));
}
function schrijf(b, inspring) {
  if (b.blokken) return inspring + b.kop + ' {\n' + b.blokken.filter(houd).map((x) => schrijf(x, inspring + '  ')).join('\n') + '\n' + inspring + '}';
  const kiezers = b.kop === ':root' ? [b.kop] : b.kop.split(',').map((x) => x.trim()).filter((k) => KLASSEN.test(k) && !NIET.test(k));
  return inspring + kiezers.join(', ') + ' { ' + b.inhoud.replace(/\s+/g, ' ') + ' }';
}

const regels = blokken(bron).filter(houd).map((b) => schrijf(b, '')).join('\n');
const kop = '/* Gemaakt door scripts/route-app-css.js uit site/site.css: niet met de hand aanpassen. */\n';
fs.writeFileSync(path.join(__dirname, '..', 'site', 'route-app.css'), kop + regels + '\n');
console.log('site/route-app.css: ' + regels.split('\n').length + ' regels');
