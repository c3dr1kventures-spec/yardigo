// ═══════════════════════════════════════════════════════════════════════
// YardiGo website: teksten in vier talen en het menu op de telefoon.
//
// Pagina's staan in het Nederlands in de HTML (goed voor Google); dit
// script vertaalt elementen met data-i18n="sleutel" naar de taal van de
// bezoeker. Volgorde: ?lang= in de link, eerder gekozen taal, domein
// (yardigo.de = Duits), taal van de browser, anders Nederlands.
// Vertalen: data-i18n (tekst), data-i18n-aria (aria-label),
// data-i18n-placeholder (placeholder). Zelfde sleutelstijl als index.html.
// Geen em-dashes in teksten voor bezoekers.
// ═══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var TALEN = ['nl', 'en', 'fr', 'de'];

  var T = {
    nl: {
      'nav.map': 'Kaart', 'nav.agenda': 'Agenda', 'nav.routes': 'Rommelroutes', 'nav.driveway': 'Opritverkoop', 'nav.shops': 'Winkels',
      'nav.organisers': 'Voor organisatoren', 'nav.post': 'Verkoop aanmelden', 'nav.menu': 'Menu', 'nav.home': 'YardiGo, naar de startpagina',
      'type.market': 'Markt', 'type.markets': 'Markten', 'type.route': 'Rommelroute', 'type.driveway': 'Opritverkoop', 'type.shop': 'Winkel', 'type.shops': 'Winkels',
      'shop.thrift': 'Kringloop', 'shop.secondhand': 'Tweedehands', 'shop.antique': 'Antiek en brocante', 'shop.charity': 'Goed doel', 'shop.vintage': 'Vintage',
      'when.weekend': 'Dit weekend', 'when.today': 'Vandaag', 'when.date': 'Datum', 'when.now': 'Nu',
      'state.openUntil': 'Open tot {t}', 'state.opensAt': 'Gaat om {t} open', 'state.closed': 'Gesloten', 'state.closesSoon': 'Sluit over {d}',
      'trust.organiser': 'Bevestigd door organisator', 'trust.checked': 'Gecontroleerd op {d}',
      'act.addRound': '+ Rondje', 'act.inRound': 'In rondje', 'act.route': 'Route', 'act.openMap': 'Open de kaart', 'act.alert': 'Melding aanzetten',
      'act.startRoute': 'Rommelroute starten', 'act.more': 'Meer',
      'foot.discover': 'Ontdekken', 'foot.organise': 'Organiseren', 'foot.about': 'YardiGo', 'foot.privacy': 'Privacy', 'foot.terms': 'Voorwaarden',
      'foot.app': 'De app', 'foot.nocookies': 'Geen cookiemuur: YardiGo volgt je niet.', 'foot.osm': 'Kaartgegevens en winkels: © OpenStreetMap-bijdragers',
      'foot.domains': 'yardigo.nl, yardigo.be en yardigo.de', 'foot.lang': 'Taal'
    },
    en: {
      'nav.map': 'Map', 'nav.agenda': 'Calendar', 'nav.routes': 'Yard sale routes', 'nav.driveway': 'Driveway sales', 'nav.shops': 'Shops',
      'nav.organisers': 'For organisers', 'nav.post': 'List a sale', 'nav.menu': 'Menu', 'nav.home': 'YardiGo, go to the home page',
      'type.market': 'Market', 'type.markets': 'Markets', 'type.route': 'Yard sale route', 'type.driveway': 'Driveway sale', 'type.shop': 'Shop', 'type.shops': 'Shops',
      'shop.thrift': 'Thrift store', 'shop.secondhand': 'Second-hand', 'shop.antique': 'Antiques and brocante', 'shop.charity': 'Charity shop', 'shop.vintage': 'Vintage',
      'when.weekend': 'This weekend', 'when.today': 'Today', 'when.date': 'Date', 'when.now': 'Now',
      'state.openUntil': 'Open until {t}', 'state.opensAt': 'Opens at {t}', 'state.closed': 'Closed', 'state.closesSoon': 'Closes in {d}',
      'trust.organiser': 'Confirmed by the organiser', 'trust.checked': 'Checked on {d}',
      'act.addRound': '+ Trip', 'act.inRound': 'In trip', 'act.route': 'Directions', 'act.openMap': 'Open the map', 'act.alert': 'Turn on alerts',
      'act.startRoute': 'Start a yard sale route', 'act.more': 'More',
      'foot.discover': 'Discover', 'foot.organise': 'Organise', 'foot.about': 'YardiGo', 'foot.privacy': 'Privacy', 'foot.terms': 'Terms',
      'foot.app': 'The app', 'foot.nocookies': 'No cookie wall: YardiGo does not track you.', 'foot.osm': 'Map data and shops: © OpenStreetMap contributors',
      'foot.domains': 'yardigo.nl, yardigo.be and yardigo.de', 'foot.lang': 'Language'
    },
    fr: {
      'nav.map': 'Carte', 'nav.agenda': 'Agenda', 'nav.routes': 'Circuits brocante', 'nav.driveway': 'Ventes sur allée', 'nav.shops': 'Boutiques',
      'nav.organisers': 'Pour les organisateurs', 'nav.post': 'Annoncer une vente', 'nav.menu': 'Menu', 'nav.home': 'YardiGo, vers la page d’accueil',
      'type.market': 'Marché', 'type.markets': 'Marchés', 'type.route': 'Circuit brocante', 'type.driveway': 'Vente sur allée', 'type.shop': 'Boutique', 'type.shops': 'Boutiques',
      'shop.thrift': 'Ressourcerie', 'shop.secondhand': 'Seconde main', 'shop.antique': 'Antiquités et brocante', 'shop.charity': 'Boutique solidaire', 'shop.vintage': 'Vintage',
      'when.weekend': 'Ce week-end', 'when.today': 'Aujourd’hui', 'when.date': 'Date', 'when.now': 'Maintenant',
      'state.openUntil': 'Ouvert jusqu’à {t}', 'state.opensAt': 'Ouvre à {t}', 'state.closed': 'Fermé', 'state.closesSoon': 'Ferme dans {d}',
      'trust.organiser': 'Confirmé par l’organisateur', 'trust.checked': 'Vérifié le {d}',
      'act.addRound': '+ Tournée', 'act.inRound': 'Dans la tournée', 'act.route': 'Itinéraire', 'act.openMap': 'Ouvrir la carte', 'act.alert': 'Activer les alertes',
      'act.startRoute': 'Lancer un circuit brocante', 'act.more': 'Plus',
      'foot.discover': 'Découvrir', 'foot.organise': 'Organiser', 'foot.about': 'YardiGo', 'foot.privacy': 'Confidentialité', 'foot.terms': 'Conditions',
      'foot.app': 'L’appli', 'foot.nocookies': 'Pas de mur de cookies : YardiGo ne vous suit pas.', 'foot.osm': 'Données cartographiques et boutiques : © contributeurs OpenStreetMap',
      'foot.domains': 'yardigo.nl, yardigo.be et yardigo.de', 'foot.lang': 'Langue'
    },
    de: {
      'nav.map': 'Karte', 'nav.agenda': 'Kalender', 'nav.routes': 'Hofflohmärkte', 'nav.driveway': 'Garagenverkäufe', 'nav.shops': 'Läden',
      'nav.organisers': 'Für Veranstalter', 'nav.post': 'Verkauf eintragen', 'nav.menu': 'Menü', 'nav.home': 'YardiGo, zur Startseite',
      'type.market': 'Markt', 'type.markets': 'Märkte', 'type.route': 'Hofflohmarkt', 'type.driveway': 'Garagenverkauf', 'type.shop': 'Laden', 'type.shops': 'Läden',
      'shop.thrift': 'Gebrauchtwarenhaus', 'shop.secondhand': 'Second Hand', 'shop.antique': 'Antiquitäten und Trödel', 'shop.charity': 'Sozialkaufhaus', 'shop.vintage': 'Vintage',
      'when.weekend': 'Dieses Wochenende', 'when.today': 'Heute', 'when.date': 'Datum', 'when.now': 'Jetzt',
      'state.openUntil': 'Geöffnet bis {t}', 'state.opensAt': 'Öffnet um {t}', 'state.closed': 'Geschlossen', 'state.closesSoon': 'Schließt in {d}',
      'trust.organiser': 'Vom Veranstalter bestätigt', 'trust.checked': 'Geprüft am {d}',
      'act.addRound': '+ Tour', 'act.inRound': 'In der Tour', 'act.route': 'Route', 'act.openMap': 'Karte öffnen', 'act.alert': 'Benachrichtigung an',
      'act.startRoute': 'Hofflohmarkt starten', 'act.more': 'Mehr',
      'foot.discover': 'Entdecken', 'foot.organise': 'Veranstalten', 'foot.about': 'YardiGo', 'foot.privacy': 'Datenschutz', 'foot.terms': 'AGB',
      'foot.app': 'Die App', 'foot.nocookies': 'Keine Cookie-Wand: YardiGo verfolgt dich nicht.', 'foot.osm': 'Kartendaten und Läden: © OpenStreetMap-Mitwirkende',
      'foot.domains': 'yardigo.nl, yardigo.be und yardigo.de', 'foot.lang': 'Sprache'
    }
  };

  // Teksten van de startpagina en de kaartpagina.
  Object.assign(T.nl, {
    'map.radius': 'Afstand', 'map.allTypes': 'Alle soorten', 'map.search': 'Zoek', 'map.here': 'Rond het midden van de kaart', 'map.sortNear': 'Dichtstbij eerst', 'map.sortTime': 'Vroegst eerst', 'map.locate': 'Mijn locatie', 'map.more': 'Zoom in voor de rest ({n})',
    'loc.mine': 'jouw locatie',
    'home.title': 'Rommelmarkten, rommelroutes en opritverkopen bij jou in de buurt',
    'home.live': 'Dit weekend {n} verkopen op de kaart', 'home.where': 'Waar ben je?', 'home.wherePh': 'Plaats of postcode',
    'home.locate': 'Gebruik mijn locatie', 'home.when': 'Wanneer?', 'home.next': 'Volgend weekend',
    'home.ctaNear': 'Toon {n} verkopen rond {p}', 'home.ctaAll': 'Toon {n} verkopen op de kaart',
    'home.listNear': 'Dit weekend rond {p}', 'home.listAll': 'Dit weekend', 'home.listToday': 'Vandaag', 'home.listNext': 'Volgend weekend',
    'home.nearest': 'Dichtstbij eerst', 'home.byTime': 'Op dag en tijd', 'home.allN': 'Alle {n} op de kaart', 'home.none': 'Geen verkopen gevonden. Kijk verder weg of kies een andere dag.',
    'home.whatTitle': 'Wat je op YardiGo vindt', 'home.whatCount': '{n} komende verkopen in {p} plaatsen',
    'home.tMarket': 'Rommelmarkten', 'home.tMarketTxt': 'Ook vlooien-, boeken- en kofferbakmarkten.',
    'home.tRoute': 'Rommelroutes', 'home.tRouteTxt': 'Een hele buurt verkoopt op dezelfde dag vanaf de oprit.',
    'home.tDriveway': 'Opritverkoop', 'home.tDrivewayTxt': 'Eén huishouden verkoopt vanuit de garage of de tuin.',
    'home.tShops': 'Winkels', 'home.tShopsTxt': 'Kringloop, antiek en brocante, met openingstijden. Binnenkort op de kaart.',
    'home.orgTitle': 'Organiseer je iets? Zet het op de kaart.', 'home.orgTxt': 'Gratis, en meestal dezelfde dag online. Een foto van je affiche is genoeg.',
    'home.cities': 'Rommelmarkten per plaats', 'home.locFail': 'Je locatie is niet beschikbaar. Typ een plaats.', 'home.placeFail': 'Die plaats kennen we niet. Probeer een andere naam of een postcode.',
    'map.inView': '{n} verkopen in dit gebied', 'map.noneInView': 'Hier is in deze periode niets. Zoom uit of kies een andere dag.',
    'map.view': 'Bekijk', 'map.zoomIn': 'Inzoomen', 'map.zoomOut': 'Uitzoomen', 'map.legend': 'Kleiner of verder weg',
    'map.alsoDays': '{d}', 'map.approx': 'Locatie bij benadering', 'map.backHome': 'Terug naar de startpagina',
    'map.filters': 'Filters', 'map.list': 'Lijst', 'map.map': 'Kaart', 'time.until': 'tot', 'time.and': 'en', 'unit.km': 'km'
  });
  Object.assign(T.en, {
    'map.radius': 'Distance', 'map.allTypes': 'All types', 'map.search': 'Search', 'map.here': 'Around the centre of the map', 'map.sortNear': 'Nearest first', 'map.sortTime': 'Earliest first', 'map.locate': 'My location', 'map.more': 'Zoom in for the rest ({n})',
    'loc.mine': 'your location',
    'home.title': 'Flea markets, yard sale routes and driveway sales near you',
    'home.live': 'This weekend {n} sales on the map', 'home.where': 'Where are you?', 'home.wherePh': 'Town or postcode',
    'home.locate': 'Use my location', 'home.when': 'When?', 'home.next': 'Next weekend',
    'home.ctaNear': 'Show {n} sales around {p}', 'home.ctaAll': 'Show {n} sales on the map',
    'home.listNear': 'This weekend around {p}', 'home.listAll': 'This weekend', 'home.listToday': 'Today', 'home.listNext': 'Next weekend',
    'home.nearest': 'Nearest first', 'home.byTime': 'By day and time', 'home.allN': 'All {n} on the map', 'home.none': 'No sales found. Look further away or pick another day.',
    'home.whatTitle': 'What you find on YardiGo', 'home.whatCount': '{n} upcoming sales in {p} places',
    'home.tMarket': 'Flea markets', 'home.tMarketTxt': 'Also book markets and car boot sales.',
    'home.tRoute': 'Yard sale routes', 'home.tRouteTxt': 'A whole neighbourhood sells from their driveways on the same day.',
    'home.tDriveway': 'Driveway sales', 'home.tDrivewayTxt': 'One household sells from the garage or the garden.',
    'home.tShops': 'Shops', 'home.tShopsTxt': 'Thrift, antiques and brocante, with opening hours. Coming soon to the map.',
    'home.orgTitle': 'Organising something? Put it on the map.', 'home.orgTxt': 'Free, and usually online the same day. A photo of your poster is enough.',
    'home.cities': 'Flea markets by town', 'home.locFail': 'Your location is not available. Type a town.', 'home.placeFail': 'We do not know that place. Try another name or a postcode.',
    'map.inView': '{n} sales in this area', 'map.noneInView': 'Nothing here in this period. Zoom out or pick another day.',
    'map.view': 'View', 'map.zoomIn': 'Zoom in', 'map.zoomOut': 'Zoom out', 'map.legend': 'Smaller or further away',
    'map.alsoDays': '{d}', 'map.approx': 'Approximate location', 'map.backHome': 'Back to the home page',
    'map.filters': 'Filters', 'map.list': 'List', 'map.map': 'Map', 'time.until': 'to', 'time.and': 'and', 'unit.km': 'km'
  });
  Object.assign(T.fr, {
    'map.radius': 'Distance', 'map.allTypes': 'Tous les types', 'map.search': 'Chercher', 'map.here': 'Autour du centre de la carte', 'map.sortNear': 'Les plus proches d’abord', 'map.sortTime': 'Les plus tôt d’abord', 'map.locate': 'Ma position', 'map.more': 'Zoomez pour voir le reste ({n})',
    'loc.mine': 'votre position',
    'home.title': 'Brocantes, circuits brocante et ventes sur allée près de chez vous',
    'home.live': 'Ce week-end, {n} ventes sur la carte', 'home.where': 'Où êtes-vous ?', 'home.wherePh': 'Ville ou code postal',
    'home.locate': 'Utiliser ma position', 'home.when': 'Quand ?', 'home.next': 'Week-end prochain',
    'home.ctaNear': 'Voir {n} ventes autour de {p}', 'home.ctaAll': 'Voir {n} ventes sur la carte',
    'home.listNear': 'Ce week-end autour de {p}', 'home.listAll': 'Ce week-end', 'home.listToday': 'Aujourd’hui', 'home.listNext': 'Week-end prochain',
    'home.nearest': 'Les plus proches d’abord', 'home.byTime': 'Par jour et heure', 'home.allN': 'Les {n} sur la carte', 'home.none': 'Aucune vente trouvée. Cherchez plus loin ou choisissez un autre jour.',
    'home.whatTitle': 'Ce que vous trouvez sur YardiGo', 'home.whatCount': '{n} ventes à venir dans {p} localités',
    'home.tMarket': 'Brocantes', 'home.tMarketTxt': 'Aussi marchés aux puces, aux livres et vide-coffres.',
    'home.tRoute': 'Circuits brocante', 'home.tRouteTxt': 'Tout un quartier vend devant chez soi le même jour.',
    'home.tDriveway': 'Ventes sur allée', 'home.tDrivewayTxt': 'Un ménage vend depuis le garage ou le jardin.',
    'home.tShops': 'Boutiques', 'home.tShopsTxt': 'Ressourceries, antiquités et brocante, avec horaires. Bientôt sur la carte.',
    'home.orgTitle': 'Vous organisez quelque chose ? Mettez-le sur la carte.', 'home.orgTxt': 'Gratuit, et en ligne le jour même le plus souvent. Une photo de votre affiche suffit.',
    'home.cities': 'Brocantes par ville', 'home.locFail': 'Votre position n’est pas disponible. Tapez une ville.', 'home.placeFail': 'Nous ne connaissons pas ce lieu. Essayez un autre nom ou un code postal.',
    'map.inView': '{n} ventes dans cette zone', 'map.noneInView': 'Rien ici pour cette période. Dézoomez ou choisissez un autre jour.',
    'map.view': 'Voir', 'map.zoomIn': 'Zoomer', 'map.zoomOut': 'Dézoomer', 'map.legend': 'Plus petit ou plus loin',
    'map.alsoDays': '{d}', 'map.approx': 'Position approximative', 'map.backHome': 'Retour à l’accueil',
    'map.filters': 'Filtres', 'map.list': 'Liste', 'map.map': 'Carte', 'time.until': 'à', 'time.and': 'et', 'unit.km': 'km'
  });
  Object.assign(T.de, {
    'map.radius': 'Entfernung', 'map.allTypes': 'Alle Arten', 'map.search': 'Suchen', 'map.here': 'Um die Kartenmitte', 'map.sortNear': 'Nächste zuerst', 'map.sortTime': 'Früheste zuerst', 'map.locate': 'Mein Standort', 'map.more': 'Zoom hinein für den Rest ({n})',
    'loc.mine': 'deinen Standort',
    'home.title': 'Flohmärkte, Hofflohmärkte und Garagenverkäufe in deiner Nähe',
    'home.live': 'Dieses Wochenende {n} Verkäufe auf der Karte', 'home.where': 'Wo bist du?', 'home.wherePh': 'Ort oder Postleitzahl',
    'home.locate': 'Meinen Standort verwenden', 'home.when': 'Wann?', 'home.next': 'Nächstes Wochenende',
    'home.ctaNear': '{n} Verkäufe um {p} zeigen', 'home.ctaAll': '{n} Verkäufe auf der Karte zeigen',
    'home.listNear': 'Dieses Wochenende um {p}', 'home.listAll': 'Dieses Wochenende', 'home.listToday': 'Heute', 'home.listNext': 'Nächstes Wochenende',
    'home.nearest': 'Nächste zuerst', 'home.byTime': 'Nach Tag und Uhrzeit', 'home.allN': 'Alle {n} auf der Karte', 'home.none': 'Keine Verkäufe gefunden. Such weiter weg oder wähl einen anderen Tag.',
    'home.whatTitle': 'Was du auf YardiGo findest', 'home.whatCount': '{n} kommende Verkäufe an {p} Orten',
    'home.tMarket': 'Flohmärkte', 'home.tMarketTxt': 'Auch Bücher- und Kofferraummärkte.',
    'home.tRoute': 'Hofflohmärkte', 'home.tRouteTxt': 'Ein ganzes Viertel verkauft am selben Tag vor der Haustür.',
    'home.tDriveway': 'Garagenverkäufe', 'home.tDrivewayTxt': 'Ein Haushalt verkauft aus der Garage oder dem Garten.',
    'home.tShops': 'Läden', 'home.tShopsTxt': 'Gebrauchtwaren, Antiquitäten und Trödel, mit Öffnungszeiten. Bald auf der Karte.',
    'home.orgTitle': 'Du veranstaltest etwas? Bring es auf die Karte.', 'home.orgTxt': 'Kostenlos und meist am selben Tag online. Ein Foto deines Plakats genügt.',
    'home.cities': 'Flohmärkte nach Ort', 'home.locFail': 'Dein Standort ist nicht verfügbar. Gib einen Ort ein.', 'home.placeFail': 'Diesen Ort kennen wir nicht. Versuch einen anderen Namen oder eine Postleitzahl.',
    'map.inView': '{n} Verkäufe in diesem Gebiet', 'map.noneInView': 'Hier ist in diesem Zeitraum nichts. Zoom heraus oder wähl einen anderen Tag.',
    'map.view': 'Ansehen', 'map.zoomIn': 'Vergrößern', 'map.zoomOut': 'Verkleinern', 'map.legend': 'Kleiner oder weiter weg',
    'map.alsoDays': '{d}', 'map.approx': 'Ungefährer Standort', 'map.backHome': 'Zurück zur Startseite',
    'map.filters': 'Filter', 'map.list': 'Liste', 'map.map': 'Karte', 'time.until': 'bis', 'time.and': 'und', 'unit.km': 'km'
  });

  // Ronde 3.2: garagesales voorop, foto's en affiches, uitleg met Cedrik.
  Object.assign(T.nl, {
    'nav.driveway': 'Garagesales', 'nav.markets': 'Rommelmarkten', 'type.driveway': 'Garagesale',
    'home.title': 'Garagesales, rommelroutes en rommelmarkten bij jou in de buurt',
    'home.locBtn': 'Toon wat er bij mij in de buurt is', 'home.locBusy': 'Even kijken waar je bent', 'home.orType': 'of typ een plaats', 'home.layers': 'Lagen op de kaart',
    'home.howTitle': 'Zo werkt YardiGo',
    'home.how1': 'Kijk op de kaart', 'home.how1Txt': 'Elke pin is een verkoop met dag en tijd. Geel is een garagesale, oranje een rommelroute, groen een markt.',
    'home.how2': 'Bekijk wat er te koop is', 'home.how2Txt': 'Garagesales laten foto\'s van hun spullen zien. Bij markten en routes zie je het affiche.',
    'home.how3': 'Maak er een dag van', 'home.how3Txt': 'Combineer een paar garagesales met een markt in de buurt en vraag de route op. Kijken is gratis.',
    'home.garTitle': 'Garagesales: kijk vooraf wat er te koop is', 'home.garNear': 'Garagesales rond {p}',
    'home.garTxt': 'Bij een garagesale verkoopt één huishouden vanaf de oprit, of een hele buurt tegelijk op een rommelroute.',
    'home.garNone': 'Nog geen garagesales in de buurt. Ken je er een, of houd je er zelf een?',
    'home.garPost': 'Garagesale aanmelden', 'home.garPostTxt': 'Gratis. Zet er foto\'s van je spullen bij, dan weten kopers wat ze kunnen verwachten.',
    'home.allGar': 'Alle garagesales', 'home.marketPost': 'Markt aanmelden',
    'home.photos': '{n} foto\'s', 'home.poster': 'Affiche van {t}', 'home.byType': 'Garagesales eerst'
  });
  Object.assign(T.en, {
    'nav.driveway': 'Garage sales', 'nav.markets': 'Flea markets', 'type.driveway': 'Garage sale',
    'home.title': 'Garage sales, yard sale routes and flea markets near you',
    'home.locBtn': 'Show what is near me', 'home.locBusy': 'Finding your location', 'home.orType': 'or type a town', 'home.layers': 'Map layers',
    'home.howTitle': 'How YardiGo works',
    'home.how1': 'Look at the map', 'home.how1Txt': 'Every pin is a sale with its day and time. Yellow is a garage sale, orange a yard sale route, green a market.',
    'home.how2': 'See what is for sale', 'home.how2Txt': 'Garage sales show photos of their items. For markets and routes you see the poster.',
    'home.how3': 'Make a day of it', 'home.how3Txt': 'Combine a few garage sales with a market nearby and get directions. Browsing is free.',
    'home.garTitle': 'Garage sales: see what is for sale before you go', 'home.garNear': 'Garage sales around {p}',
    'home.garTxt': 'At a garage sale one household sells from the driveway, or a whole neighbourhood at once on a yard sale route.',
    'home.garNone': 'No garage sales nearby yet. Know of one, or holding one yourself?',
    'home.garPost': 'List a garage sale', 'home.garPostTxt': 'Free. Add photos of your items so buyers know what to expect.',
    'home.allGar': 'All garage sales', 'home.marketPost': 'List a market',
    'home.photos': '{n} photos', 'home.poster': 'Poster for {t}', 'home.byType': 'Garage sales first'
  });
  Object.assign(T.fr, {
    'nav.driveway': 'Ventes de garage', 'nav.markets': 'Brocantes', 'type.driveway': 'Vente de garage',
    'home.title': 'Ventes de garage, circuits brocante et brocantes près de chez vous',
    'home.locBtn': 'Voir ce qui est près de moi', 'home.locBusy': 'Recherche de votre position', 'home.orType': 'ou tapez une ville', 'home.layers': 'Couches de la carte',
    'home.howTitle': 'Comment fonctionne YardiGo',
    'home.how1': 'Regardez la carte', 'home.how1Txt': 'Chaque repère est une vente avec son jour et son heure. Jaune pour une vente de garage, orange pour un circuit brocante, vert pour un marché.',
    'home.how2': 'Voyez ce qui est à vendre', 'home.how2Txt': 'Les ventes de garage montrent des photos de leurs objets. Pour les marchés et les circuits, vous voyez l’affiche.',
    'home.how3': 'Faites-en une journée', 'home.how3Txt': 'Combinez quelques ventes de garage avec un marché proche et obtenez l’itinéraire. Regarder est gratuit.',
    'home.garTitle': 'Ventes de garage : voyez ce qui est à vendre avant d’y aller', 'home.garNear': 'Ventes de garage autour de {p}',
    'home.garTxt': 'Lors d’une vente de garage, un ménage vend devant chez lui, ou tout un quartier en même temps lors d’un circuit brocante.',
    'home.garNone': 'Pas encore de vente de garage près d’ici. Vous en connaissez une, ou vous en organisez une ?',
    'home.garPost': 'Annoncer une vente de garage', 'home.garPostTxt': 'Gratuit. Ajoutez des photos de vos objets pour que les acheteurs sachent à quoi s’attendre.',
    'home.allGar': 'Toutes les ventes de garage', 'home.marketPost': 'Annoncer un marché',
    'home.photos': '{n} photos', 'home.poster': 'Affiche de {t}', 'home.byType': 'Ventes de garage d’abord'
  });
  Object.assign(T.de, {
    'nav.driveway': 'Garagenverkäufe', 'nav.markets': 'Flohmärkte', 'type.driveway': 'Garagenverkauf',
    'home.title': 'Garagenverkäufe, Hofflohmärkte und Flohmärkte in deiner Nähe',
    'home.locBtn': 'Zeig, was in meiner Nähe ist', 'home.locBusy': 'Standort wird gesucht', 'home.orType': 'oder gib einen Ort ein', 'home.layers': 'Kartenebenen',
    'home.howTitle': 'So funktioniert YardiGo',
    'home.how1': 'Schau auf die Karte', 'home.how1Txt': 'Jede Markierung ist ein Verkauf mit Tag und Uhrzeit. Gelb ist ein Garagenverkauf, orange ein Hofflohmarkt, grün ein Markt.',
    'home.how2': 'Sieh, was verkauft wird', 'home.how2Txt': 'Garagenverkäufe zeigen Fotos ihrer Sachen. Bei Märkten und Hofflohmärkten siehst du das Plakat.',
    'home.how3': 'Mach einen Tag daraus', 'home.how3Txt': 'Kombiniere ein paar Garagenverkäufe mit einem Markt in der Nähe und lass dir die Route zeigen. Schauen ist kostenlos.',
    'home.garTitle': 'Garagenverkäufe: sieh vorher, was es gibt', 'home.garNear': 'Garagenverkäufe um {p}',
    'home.garTxt': 'Beim Garagenverkauf verkauft ein Haushalt vor der Tür, beim Hofflohmarkt ein ganzes Viertel zugleich.',
    'home.garNone': 'Noch keine Garagenverkäufe in der Nähe. Kennst du einen oder machst du selbst einen?',
    'home.garPost': 'Garagenverkauf eintragen', 'home.garPostTxt': 'Kostenlos. Füg Fotos deiner Sachen hinzu, damit Käufer wissen, was sie erwartet.',
    'home.allGar': 'Alle Garagenverkäufe', 'home.marketPost': 'Markt eintragen',
    'home.photos': '{n} Fotos', 'home.poster': 'Plakat für {t}', 'home.byType': 'Garagenverkäufe zuerst'
  });

  function opslag(fn) { try { return fn(); } catch (e) { return null; } }

  function kiesTaal() {
    var uitLink = opslag(function () { return new URLSearchParams(location.search).get('lang'); });
    if (TALEN.indexOf(uitLink) > -1) { opslag(function () { localStorage.setItem('yg-lang', uitLink); }); return uitLink; }
    var bewaard = opslag(function () { return localStorage.getItem('yg-lang'); });
    if (TALEN.indexOf(bewaard) > -1) return bewaard;
    if (/\.de$/.test(location.hostname)) return 'de';
    var browser = (navigator.language || 'nl').slice(0, 2).toLowerCase();
    if (/\.be$/.test(location.hostname)) return browser === 'fr' ? 'fr' : 'nl';
    return TALEN.indexOf(browser) > -1 ? browser : 'nl';
  }

  function t(sleutel, waarden, taal) {
    var tekst = (T[taal] && T[taal][sleutel]) || T.nl[sleutel] || sleutel;
    if (waarden) Object.keys(waarden).forEach(function (k) { tekst = tekst.replace('{' + k + '}', waarden[k]); });
    return tekst;
  }

  function vertaal(taal, wortel) {
    var root = wortel || document;
    document.documentElement.lang = taal;
    root.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n'), null, taal); });
    root.querySelectorAll('[data-i18n-aria]').forEach(function (el) { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'), null, taal)); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'), null, taal)); });
    root.querySelectorAll('[data-lang]').forEach(function (a) {
      var l = a.getAttribute('data-lang');
      a.setAttribute('aria-current', l === taal ? 'true' : 'false');
      a.setAttribute('hreflang', l);
      a.href = '?lang=' + l;
    });
  }

  function menu() {
    var knop = document.querySelector('.yg-menu-btn');
    var paneel = document.getElementById('yg-menu');
    if (!knop || !paneel) return;
    knop.addEventListener('click', function () {
      var open = !paneel.classList.contains('is-open');
      paneel.classList.toggle('is-open', open);
      knop.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && paneel.classList.contains('is-open')) {
        paneel.classList.remove('is-open');
        knop.setAttribute('aria-expanded', 'false');
        knop.focus();
      }
    });
  }

  var taal = kiesTaal();
  window.YG = { taal: taal, t: function (k, w) { return t(k, w, taal); }, vertaal: function (wortel) { vertaal(taal, wortel); } };

  function start() { vertaal(taal); menu(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
