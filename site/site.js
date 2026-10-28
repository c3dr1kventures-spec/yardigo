// ═══════════════════════════════════════════════════════════════════════
// YardiGo website: teksten in vier talen en het menu op de telefoon.
//
// Pagina's staan in het Nederlands in de HTML (goed voor Google); dit
// script vertaalt elementen met data-i18n="sleutel" naar de taal van de
// bezoeker. Volgorde: ?lang= in de link, eerder gekozen taal, domein
// (yardigo.de = Duits), taal van de browser, anders Nederlands.
// Vertalen: data-i18n (tekst), data-i18n-aria (aria-label),
// data-i18n-placeholder (placeholder), data-i18n-title (title). Zelfde sleutelstijl als index.html.
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
      'when.weekend': 'Dit weekend', 'when.all': 'Alles', 'img.stock': 'Sfeerbeeld', 'home.listSoon': 'Binnenkort', 'home.listSoonNear': 'Binnenkort rond {p}', 'when.today': 'Vandaag', 'when.date': 'Datum', 'when.now': 'Nu',
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
      'when.weekend': 'This weekend', 'when.all': 'All', 'img.stock': 'Stock photo', 'home.listSoon': 'Coming up', 'home.listSoonNear': 'Coming up around {p}', 'when.today': 'Today', 'when.date': 'Date', 'when.now': 'Now',
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
      'when.weekend': 'Ce week-end', 'when.all': 'Tout', 'img.stock': 'Photo d’illustration', 'home.listSoon': 'Bientôt', 'home.listSoonNear': 'Bientôt autour de {p}', 'when.today': 'Aujourd’hui', 'when.date': 'Date', 'when.now': 'Maintenant',
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
      'when.weekend': 'Dieses Wochenende', 'when.all': 'Alle', 'img.stock': 'Symbolbild', 'home.listSoon': 'Demnächst', 'home.listSoonNear': 'Demnächst um {p}', 'when.today': 'Heute', 'when.date': 'Datum', 'when.now': 'Jetzt',
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
    'nav.driveway': 'Garagesales', 'nav.markets': 'Rommelmarkten', 'nav.thrift': 'Kringloopwinkels', 'type.driveway': 'Garagesale',
    'home.title': 'Garagesales, rommelroutes en rommelmarkten bij jou in de buurt',
    'home.locBtn': 'Toon wat er bij mij in de buurt is', 'home.locBusy': 'Even kijken waar je bent…', 'det.loading': 'Verkoop laden…', 'nav.skip': 'Naar de inhoud', 'home.orType': 'of typ een plaats', 'home.layers': 'Lagen op de kaart',
    'home.howTitle': 'Zo werkt YardiGo', 'home.more': 'Lees verder',
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
    'nav.driveway': 'Garage sales', 'nav.markets': 'Flea markets', 'nav.thrift': 'Thrift stores', 'type.driveway': 'Garage sale',
    'home.title': 'Garage sales, yard sale routes and flea markets near you',
    'home.locBtn': 'Show what is near me', 'home.locBusy': 'Finding your location…', 'det.loading': 'Loading sale…', 'nav.skip': 'Skip to content', 'home.orType': 'or type a town', 'home.layers': 'Map layers',
    'home.howTitle': 'How YardiGo works', 'home.more': 'Read more',
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
    'nav.driveway': 'Ventes de garage', 'nav.markets': 'Brocantes', 'nav.thrift': 'Ressourceries', 'type.driveway': 'Vente de garage',
    'home.title': 'Ventes de garage, circuits brocante et brocantes près de chez vous',
    'home.locBtn': 'Voir ce qui est près de moi', 'home.locBusy': 'Recherche de votre position…', 'det.loading': 'Chargement de la vente…', 'nav.skip': 'Aller au contenu', 'home.orType': 'ou tapez une ville', 'home.layers': 'Couches de la carte',
    'home.howTitle': 'Comment fonctionne YardiGo', 'home.more': 'Lire la suite',
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
    'nav.driveway': 'Garagenverkäufe', 'nav.markets': 'Flohmärkte', 'nav.thrift': 'Gebrauchtwarenläden', 'type.driveway': 'Garagenverkauf',
    'home.title': 'Garagenverkäufe, Hofflohmärkte und Flohmärkte in deiner Nähe',
    'home.locBtn': 'Zeig, was in meiner Nähe ist', 'home.locBusy': 'Standort wird gesucht…', 'det.loading': 'Verkauf wird geladen…', 'nav.skip': 'Zum Inhalt', 'home.orType': 'oder gib einen Ort ein', 'home.layers': 'Kartenebenen',
    'home.howTitle': 'So funktioniert YardiGo', 'home.more': 'Weiterlesen',
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

  // Pagina van één verkoop (/v/{id}).
  Object.assign(T.nl, {
    'det.back': 'Terug naar de kaart', 'det.forSale': 'Wat er te koop is', 'det.about': 'Over deze verkoop', 'det.when': 'Wanneer', 'det.where': 'Waar',
    'det.addrLogin': 'Het huisnummer zie je met een gratis account in de app.', 'det.addrFrom': 'Het adres verschijnt op {d}.',
    'det.approx': 'De kaart toont het gebied, niet het precieze huis.', 'det.route': 'Route', 'det.cal': 'In agenda', 'det.share': 'Delen', 'det.copied': 'Link gekopieerd',
    'det.openApp': 'Bekijk in de app', 'det.photoOf': 'Foto {i} van {n}', 'det.prev': 'Vorige foto', 'det.next': 'Volgende foto',
    'det.day': 'Maak er een dag van', 'det.dayTxt': 'Ook die dag, binnen {k} km', 'det.dayNone': 'Nog niets anders in de buurt op die dag.',
    'det.owner': 'Is dit jouw verkoop? Zet er foto\'s van je spullen bij. Kopers komen eerder als ze zien wat er ligt.', 'det.ownerBtn': 'Foto\'s toevoegen in de app',
    'det.notFound': 'Deze verkoop bestaat niet meer of is al geweest.', 'det.source': 'Bron: {s}'
  });
  Object.assign(T.en, {
    'det.back': 'Back to the map', 'det.forSale': 'What is for sale', 'det.about': 'About this sale', 'det.when': 'When', 'det.where': 'Where',
    'det.addrLogin': 'You see the house number with a free account in the app.', 'det.addrFrom': 'The address appears on {d}.',
    'det.approx': 'The map shows the area, not the exact house.', 'det.route': 'Directions', 'det.cal': 'Add to calendar', 'det.share': 'Share', 'det.copied': 'Link copied',
    'det.openApp': 'View in the app', 'det.photoOf': 'Photo {i} of {n}', 'det.prev': 'Previous photo', 'det.next': 'Next photo',
    'det.day': 'Make a day of it', 'det.dayTxt': 'Also that day, within {k} km', 'det.dayNone': 'Nothing else nearby on that day yet.',
    'det.owner': 'Is this your sale? Add photos of your items. Buyers come sooner when they see what is there.', 'det.ownerBtn': 'Add photos in the app',
    'det.notFound': 'This sale no longer exists or has already taken place.', 'det.source': 'Source: {s}'
  });
  Object.assign(T.fr, {
    'det.back': 'Retour à la carte', 'det.forSale': 'Ce qui est à vendre', 'det.about': 'À propos de cette vente', 'det.when': 'Quand', 'det.where': 'Où',
    'det.addrLogin': 'Le numéro de maison est visible avec un compte gratuit dans l’appli.', 'det.addrFrom': 'L’adresse apparaît le {d}.',
    'det.approx': 'La carte montre la zone, pas la maison exacte.', 'det.route': 'Itinéraire', 'det.cal': 'Ajouter à l’agenda', 'det.share': 'Partager', 'det.copied': 'Lien copié',
    'det.openApp': 'Voir dans l’appli', 'det.photoOf': 'Photo {i} sur {n}', 'det.prev': 'Photo précédente', 'det.next': 'Photo suivante',
    'det.day': 'Faites-en une journée', 'det.dayTxt': 'Le même jour, à moins de {k} km', 'det.dayNone': 'Rien d’autre à proximité ce jour-là pour l’instant.',
    'det.owner': 'C’est votre vente ? Ajoutez des photos de vos objets. Les acheteurs viennent plus vite quand ils voient ce qu’il y a.', 'det.ownerBtn': 'Ajouter des photos dans l’appli',
    'det.notFound': 'Cette vente n’existe plus ou a déjà eu lieu.', 'det.source': 'Source : {s}'
  });
  Object.assign(T.de, {
    'det.back': 'Zurück zur Karte', 'det.forSale': 'Was verkauft wird', 'det.about': 'Über diesen Verkauf', 'det.when': 'Wann', 'det.where': 'Wo',
    'det.addrLogin': 'Die Hausnummer siehst du mit einem kostenlosen Konto in der App.', 'det.addrFrom': 'Die Adresse erscheint am {d}.',
    'det.approx': 'Die Karte zeigt das Gebiet, nicht das genaue Haus.', 'det.route': 'Route', 'det.cal': 'In den Kalender', 'det.share': 'Teilen', 'det.copied': 'Link kopiert',
    'det.openApp': 'In der App ansehen', 'det.photoOf': 'Foto {i} von {n}', 'det.prev': 'Vorheriges Foto', 'det.next': 'Nächstes Foto',
    'det.day': 'Mach einen Tag daraus', 'det.dayTxt': 'Am selben Tag, im Umkreis von {k} km', 'det.dayNone': 'Noch nichts anderes in der Nähe an diesem Tag.',
    'det.owner': 'Ist das dein Verkauf? Füg Fotos deiner Sachen hinzu. Käufer kommen eher, wenn sie sehen, was es gibt.', 'det.ownerBtn': 'Fotos in der App hinzufügen',
    'det.notFound': 'Diesen Verkauf gibt es nicht mehr oder er hat schon stattgefunden.', 'det.source': 'Quelle: {s}'
  });

  // Route en kringloopwinkels op de kaart.
  Object.assign(T.nl, {
    'rt.add': '+ Route', 'rt.in': 'In je route ✓', 'rt.open': 'Jouw route ({n})', 'rt.title': 'Jouw route', 'rt.close': 'Sluiten',
    'rt.empty': 'Nog niets in je route. Kies op de kaart een verkoop of winkel en tik op + Route.',
    'rt.up': 'Eerder', 'rt.down': 'Later', 'rt.remove': 'Uit route halen', 'rt.how': 'Hoe ga je?', 'rt.car': 'Auto', 'rt.bike': 'Fiets', 'rt.walk': 'Lopen',
    'rt.order': 'Zet in de kortste volgorde', 'rt.google': 'Open de route in Google Maps', 'rt.apple': 'Open de route in Apple Maps', 'rt.waze': 'Waze',
    'rt.wazeEach': 'Waze neemt één stop per keer. Kies je volgende stop:', 'rt.wazeTo': 'Navigeer met Waze naar {t}', 'rt.max': 'Google Maps neemt de eerste {n} stops mee.',
    'rt.approx': 'Garagesales en rommelroutes staan als gebied in je route. Het huisnummer zie je in de YardiGo-app vanaf de dag ervoor.',
    'rt.share': 'Deel je route', 'rt.shareTitle': 'Mijn snuffelroute op YardiGo', 'rt.copied': 'Link naar je route gekopieerd', 'rt.loaded': 'Gedeelde route geladen: {n} stops',
    'rt.order': 'Zet in een slimme volgorde', 'rt.ordered': 'Volgorde aangepast: wie vroeg sluit eerst, daarna de dichtstbijzijnde', 'rt.gone': 'Niet meer gevonden: verwijderd of afgelast', 'rt.openAt': 'open {t}', 'rt.shut': 'Gesloten op {d}', 'rt.past': 'Al voorbij', 'rt.notOn': 'Niet op {d}', 'rt.changed': 'Datum gewijzigd: nu {d}', 'rt.sharedName': 'Gedeelde route', 'rt.here': 'Mijn locatie', 'rt.locFail': 'Je locatie is niet beschikbaar.', 'rt.placeFail': 'Die plaats vinden we niet. Probeer een andere naam of een postcode.', 'rt.moved': 'Volgorde aangepast', 'rt.renamed': 'Naam bewaard', 'rt.duplicated': 'Kopie gemaakt', 'rt.deleted': 'Route verwijderd', 'rt.copyOf': '{t} (kopie)', 'rt.untitled': 'Mijn route', 'rt.myRoutes': 'Mijn routes', 'rt.back': 'Terug naar je route', 'rt.name': 'Naam van de route', 'rt.save': 'Bewaren', 'rt.stopsN': '{n} stops', 'rt.delAsk': 'Route verwijderen?', 'rt.yes': 'Ja, verwijderen', 'rt.no': 'Nee', 'rt.rename': 'Naam', 'rt.dup': 'Kopie', 'rt.del': 'Verwijderen', 'rt.newRoute': 'Nieuwe route', 'rt.from': 'vanaf {p}', 'rt.day': 'Je dag', 'rt.date': 'Datum', 'rt.depart': 'Vertrek', 'rt.start': 'Start', 'rt.end': 'Einde', 'rt.none': 'Geen', 'rt.place': 'Een plaats…', 'rt.otherPlace': 'Andere plaats…', 'rt.backToStart': 'Terug naar start', 'rt.placePh': 'Plaats of postcode', 'rt.next': 'Volgende stop', 'rt.navigate': 'Navigeer', 'rt.drag': 'Sleep om de volgorde te wijzigen', 'rt.done': 'Geweest', 'rt.sum': '{n} stops, ongeveer {km} km in vogelvlucht. De afstand over de weg is langer.', 'rt.allDone': 'Alle stops gehad. Veel plezier met je vondsten!', 'rt.parts': 'Je route is te lang voor één link. Open hem deel voor deel.', 'rt.part': 'Deel {i}: {a} t/m {b}', 'rt.suggTitle': 'Ook langs je route', 'rt.min': '{n} min', 'rt.h': '{u} u', 'rt.hmin': '{u} u {m}', 'rt.arrive': 'aankomst {t}', 'rt.wait': '{n} min wachten tot het opent', 'rt.late': 'Je komt om {t} aan, dan is het al dicht', 'rt.visit': 'Bezoektijd', 'rt.stay': '{d} blijven', 'rt.sumRoad': '{km} km, {reis} onderweg, klaar om {klaar}', 'rt.sumApprox': 'Garagesales en rommelroutes staan als gebied in je route: daar is de aankomsttijd een schatting.', 'rt.roadLoading': 'Reistijden laden…', 'rt.roadFail': 'Reistijden zijn nu niet beschikbaar.', 'rt.ordering': 'Volgorde berekenen…', 'rt.orderedRoad': 'Volgorde aangepast op reistijd en openingstijden', 'rt.orderedNot': '{n} stop(s) passen niet in je dag door de openingstijden. Die staan nu achteraan.', 'rt.detour': '{n} min omrijden', 'rt.cleared': 'Route leeggemaakt.', 'rt.undo': 'Ongedaan maken', 'rt.undone': 'Teruggezet', 'rt.suggN1': 'Er ligt nog 1 plek dicht bij je route die die dag open is.', 'rt.suggShops1': 'Er ligt nog 1 kringloopwinkel dicht bij je route.', 'rt.suggN': 'Er liggen nog {n} plekken dicht bij je route die die dag open zijn.', 'rt.suggShops': 'Er liggen nog {n} kringloopwinkels dicht bij je route.', 'rt.suggKm': '{km} km van je route (vogelvlucht)', 'rt.suggNone': 'Niets anders open dicht bij je route op die dag.', 'rt.suggLoading': 'Even zoeken…', 'rt.suggShopsOn': '+ Kringloopwinkels meenemen', 'rt.shareGone': 'Deze gedeelde route bestaat niet meer.', 'rt.inAccount': 'Je routes staan in je account en zijn ook op je andere apparaten te zien.', 'rt.localOnly': 'Je routes staan alleen in deze browser.', 'rt.login': 'Log in om ze in je account te bewaren', 'rt.bigger': 'Paneel groter', 'rt.smaller': 'Paneel kleiner', 'rt.skipped': '{n} stop(s) met een melding laten we uit de navigatie. Los de melding op of kies een andere datum.',
    'rt.clear': 'Route leegmaken', 'rt.added': '{t} staat in je route', 'rt.removed': '{t} is uit je route',
    'map.shopsOn': '+ Kringloopwinkels', 'map.shopsHint': 'Zet kringloopwinkels aan om ze in je route te zetten', 'shop.holidays': 'feestdagen',
    'shop.site': 'Website', 'shop.hours': 'Open', 'shop.osm': 'Uit OpenStreetMap'
  });
  Object.assign(T.en, {
    'rt.add': '+ Route', 'rt.in': 'In your route ✓', 'rt.open': 'Your route ({n})', 'rt.title': 'Your route', 'rt.close': 'Close',
    'rt.empty': 'Nothing in your route yet. Pick a sale or shop on the map and tap + Route.',
    'rt.up': 'Earlier', 'rt.down': 'Later', 'rt.remove': 'Remove from route', 'rt.how': 'How are you going?', 'rt.car': 'Car', 'rt.bike': 'Bike', 'rt.walk': 'Walk',
    'rt.order': 'Put in the shortest order', 'rt.google': 'Open the route in Google Maps', 'rt.apple': 'Open the route in Apple Maps', 'rt.waze': 'Waze',
    'rt.wazeEach': 'Waze takes one stop at a time. Pick your next stop:', 'rt.wazeTo': 'Navigate with Waze to {t}', 'rt.max': 'Google Maps takes the first {n} stops.',
    'rt.approx': 'Garage sales and yard sale routes are in your route as an area. You see the house number in the YardiGo app from the day before.',
    'rt.share': 'Share your route', 'rt.shareTitle': 'My bargain-hunting route on YardiGo', 'rt.copied': 'Link to your route copied', 'rt.loaded': 'Shared route loaded: {n} stops',
    'rt.order': 'Put in a smart order', 'rt.ordered': 'Order updated: what closes early first, then the nearest', 'rt.gone': 'No longer found: removed or cancelled', 'rt.openAt': 'open {t}', 'rt.shut': 'Closed on {d}', 'rt.past': 'Already over', 'rt.notOn': 'Not on {d}', 'rt.changed': 'Date changed: now {d}', 'rt.sharedName': 'Shared route', 'rt.here': 'My location', 'rt.locFail': 'Your location is not available.', 'rt.placeFail': 'We cannot find that place. Try another name or a postcode.', 'rt.moved': 'Order updated', 'rt.renamed': 'Name saved', 'rt.duplicated': 'Copy made', 'rt.deleted': 'Route deleted', 'rt.copyOf': '{t} (copy)', 'rt.untitled': 'My route', 'rt.myRoutes': 'My routes', 'rt.back': 'Back to your route', 'rt.name': 'Route name', 'rt.save': 'Save', 'rt.stopsN': '{n} stops', 'rt.delAsk': 'Delete this route?', 'rt.yes': 'Yes, delete', 'rt.no': 'No', 'rt.rename': 'Rename', 'rt.dup': 'Copy', 'rt.del': 'Delete', 'rt.newRoute': 'New route', 'rt.from': 'from {p}', 'rt.day': 'Your day', 'rt.date': 'Date', 'rt.depart': 'Leave at', 'rt.start': 'Start', 'rt.end': 'End', 'rt.none': 'None', 'rt.place': 'A place…', 'rt.otherPlace': 'Another place…', 'rt.backToStart': 'Back to start', 'rt.placePh': 'Town or postcode', 'rt.next': 'Next stop', 'rt.navigate': 'Navigate', 'rt.drag': 'Drag to change the order', 'rt.done': 'Visited', 'rt.sum': '{n} stops, about {km} km as the crow flies. The distance by road is longer.', 'rt.allDone': 'All stops visited. Enjoy your finds!', 'rt.parts': 'Your route is too long for one link. Open it part by part.', 'rt.part': 'Part {i}: {a} to {b}', 'rt.suggTitle': 'Also along your route', 'rt.min': '{n} min', 'rt.h': '{u} h', 'rt.hmin': '{u} h {m}', 'rt.arrive': 'arrive {t}', 'rt.wait': 'wait {n} min until it opens', 'rt.late': 'You arrive at {t}, it is already closed', 'rt.visit': 'Time spent', 'rt.stay': 'stay {d}', 'rt.sumRoad': '{km} km, {reis} travelling, done by {klaar}', 'rt.sumApprox': 'Garage sales and yard sale routes are areas in your route: arrival times there are an estimate.', 'rt.roadLoading': 'Loading travel times…', 'rt.roadFail': 'Travel times are not available right now.', 'rt.ordering': 'Working out the order…', 'rt.orderedRoad': 'Order updated by travel time and opening hours', 'rt.orderedNot': '{n} stop(s) do not fit in your day because of opening hours. They are now at the end.', 'rt.detour': '{n} min detour', 'rt.cleared': 'Route cleared.', 'rt.undo': 'Undo', 'rt.undone': 'Restored', 'rt.suggN1': 'There is 1 more place near your route that is open that day.', 'rt.suggShops1': 'There is 1 more second-hand shop near your route.', 'rt.suggN': 'There are {n} more places near your route that are open that day.', 'rt.suggShops': 'There are {n} more second-hand shops near your route.', 'rt.suggKm': '{km} km from your route (as the crow flies)', 'rt.suggNone': 'Nothing else open near your route that day.', 'rt.suggLoading': 'Searching…', 'rt.suggShopsOn': '+ Include second-hand shops', 'rt.shareGone': 'This shared route no longer exists.', 'rt.inAccount': 'Your routes are saved in your account and available on your other devices.', 'rt.localOnly': 'Your routes are only saved in this browser.', 'rt.login': 'Log in to keep them in your account', 'rt.bigger': 'Larger panel', 'rt.smaller': 'Smaller panel', 'rt.skipped': 'We leave {n} stop(s) with a warning out of the navigation. Solve the warning or pick another date.',
    'rt.clear': 'Clear route', 'rt.added': '{t} is in your route', 'rt.removed': '{t} is out of your route',
    'map.shopsOn': '+ Thrift stores', 'map.shopsHint': 'Turn on thrift stores to add them to your route', 'shop.holidays': 'public holidays',
    'shop.site': 'Website', 'shop.hours': 'Open', 'shop.osm': 'From OpenStreetMap'
  });
  Object.assign(T.fr, {
    'rt.add': '+ Itinéraire', 'rt.in': 'Dans l’itinéraire ✓', 'rt.open': 'Votre itinéraire ({n})', 'rt.title': 'Votre itinéraire', 'rt.close': 'Fermer',
    'rt.empty': 'Rien encore dans votre itinéraire. Choisissez une vente ou une boutique sur la carte et touchez + Itinéraire.',
    'rt.up': 'Plus tôt', 'rt.down': 'Plus tard', 'rt.remove': 'Retirer de l’itinéraire', 'rt.how': 'Comment y allez-vous ?', 'rt.car': 'Voiture', 'rt.bike': 'Vélo', 'rt.walk': 'À pied',
    'rt.order': 'Mettre dans l’ordre le plus court', 'rt.google': 'Ouvrir l’itinéraire dans Google Maps', 'rt.apple': 'Ouvrir l’itinéraire dans Plans', 'rt.waze': 'Waze',
    'rt.wazeEach': 'Waze prend un arrêt à la fois. Choisissez le prochain :', 'rt.wazeTo': 'Naviguer avec Waze vers {t}', 'rt.max': 'Google Maps prend les {n} premiers arrêts.',
    'rt.approx': 'Les ventes de garage et circuits brocante figurent comme zone. Le numéro de maison est visible dans l’appli YardiGo dès la veille.',
    'rt.share': 'Partager votre itinéraire', 'rt.shareTitle': 'Mon itinéraire chine sur YardiGo', 'rt.copied': 'Lien vers votre itinéraire copié', 'rt.loaded': 'Itinéraire partagé chargé : {n} arrêts',
    'rt.order': 'Mettre dans un ordre malin', 'rt.ordered': 'Ordre mis à jour : ce qui ferme tôt d’abord, puis le plus proche', 'rt.gone': 'Introuvable : supprimé ou annulé', 'rt.openAt': 'ouvert {t}', 'rt.shut': 'Fermé le {d}', 'rt.past': 'Déjà passé', 'rt.notOn': 'Pas le {d}', 'rt.changed': 'Date modifiée : maintenant {d}', 'rt.sharedName': 'Itinéraire partagé', 'rt.here': 'Ma position', 'rt.locFail': 'Votre position n’est pas disponible.', 'rt.placeFail': 'Nous ne trouvons pas ce lieu. Essayez un autre nom ou un code postal.', 'rt.moved': 'Ordre mis à jour', 'rt.renamed': 'Nom enregistré', 'rt.duplicated': 'Copie créée', 'rt.deleted': 'Itinéraire supprimé', 'rt.copyOf': '{t} (copie)', 'rt.untitled': 'Mon itinéraire', 'rt.myRoutes': 'Mes itinéraires', 'rt.back': 'Retour à votre itinéraire', 'rt.name': 'Nom de l’itinéraire', 'rt.save': 'Enregistrer', 'rt.stopsN': '{n} arrêts', 'rt.delAsk': 'Supprimer cet itinéraire ?', 'rt.yes': 'Oui, supprimer', 'rt.no': 'Non', 'rt.rename': 'Renommer', 'rt.dup': 'Copier', 'rt.del': 'Supprimer', 'rt.newRoute': 'Nouvel itinéraire', 'rt.from': 'depuis {p}', 'rt.day': 'Votre journée', 'rt.date': 'Date', 'rt.depart': 'Départ', 'rt.start': 'Départ de', 'rt.end': 'Arrivée', 'rt.none': 'Aucun', 'rt.place': 'Un lieu…', 'rt.otherPlace': 'Un autre lieu…', 'rt.backToStart': 'Retour au départ', 'rt.placePh': 'Ville ou code postal', 'rt.next': 'Prochain arrêt', 'rt.navigate': 'Naviguer', 'rt.drag': 'Glissez pour changer l’ordre', 'rt.done': 'Visité', 'rt.sum': '{n} arrêts, environ {km} km à vol d’oiseau. La distance par la route est plus longue.', 'rt.allDone': 'Tous les arrêts sont faits. Bonnes trouvailles !', 'rt.parts': 'Votre itinéraire est trop long pour un seul lien. Ouvrez-le partie par partie.', 'rt.part': 'Partie {i} : {a} à {b}', 'rt.suggTitle': 'Aussi sur votre route', 'rt.min': '{n} min', 'rt.h': '{u} h', 'rt.hmin': '{u} h {m}', 'rt.arrive': 'arrivée {t}', 'rt.wait': 'attendre {n} min l’ouverture', 'rt.late': 'Vous arrivez à {t}, c’est déjà fermé', 'rt.visit': 'Temps sur place', 'rt.stay': 'rester {d}', 'rt.sumRoad': '{km} km, {reis} de trajet, fini à {klaar}', 'rt.sumApprox': 'Les ventes de garage et circuits brocante sont des zones : l’heure d’arrivée y est une estimation.', 'rt.roadLoading': 'Chargement des temps de trajet…', 'rt.roadFail': 'Les temps de trajet ne sont pas disponibles pour le moment.', 'rt.ordering': 'Calcul de l’ordre…', 'rt.orderedRoad': 'Ordre mis à jour selon le trajet et les horaires', 'rt.orderedNot': '{n} arrêt(s) ne rentrent pas dans votre journée à cause des horaires. Ils sont maintenant à la fin.', 'rt.detour': '{n} min de détour', 'rt.cleared': 'Itinéraire vidé.', 'rt.undo': 'Annuler', 'rt.undone': 'Rétabli', 'rt.suggN1': 'Il y a encore 1 lieu près de votre itinéraire, ouvert ce jour-là.', 'rt.suggShops1': 'Il y a encore 1 magasin de seconde main près de votre itinéraire.', 'rt.suggN': 'Il y a encore {n} lieux près de votre itinéraire, ouverts ce jour-là.', 'rt.suggShops': 'Il y a encore {n} magasins de seconde main près de votre itinéraire.', 'rt.suggKm': 'à {km} km de votre itinéraire (à vol d’oiseau)', 'rt.suggNone': 'Rien d’autre d’ouvert près de votre itinéraire ce jour-là.', 'rt.suggLoading': 'Recherche…', 'rt.suggShopsOn': '+ Inclure les magasins de seconde main', 'rt.shareGone': 'Cet itinéraire partagé n’existe plus.', 'rt.inAccount': 'Vos itinéraires sont enregistrés dans votre compte et disponibles sur vos autres appareils.', 'rt.localOnly': 'Vos itinéraires sont enregistrés uniquement dans ce navigateur.', 'rt.login': 'Connectez-vous pour les garder dans votre compte', 'rt.bigger': 'Agrandir le panneau', 'rt.smaller': 'Réduire le panneau', 'rt.skipped': 'Nous laissons {n} arrêt(s) avec un avertissement hors de la navigation. Réglez l’avertissement ou choisissez une autre date.',
    'rt.clear': 'Vider l’itinéraire', 'rt.added': '{t} est dans votre itinéraire', 'rt.removed': '{t} est retiré de votre itinéraire',
    'map.shopsOn': '+ Ressourceries', 'map.shopsHint': 'Affichez les ressourceries pour les ajouter à votre itinéraire', 'shop.holidays': 'jours fériés',
    'shop.site': 'Site web', 'shop.hours': 'Ouvert', 'shop.osm': 'Depuis OpenStreetMap'
  });
  Object.assign(T.de, {
    'rt.add': '+ Route', 'rt.in': 'In deiner Route ✓', 'rt.open': 'Deine Route ({n})', 'rt.title': 'Deine Route', 'rt.close': 'Schließen',
    'rt.empty': 'Noch nichts in deiner Route. Wähl auf der Karte einen Verkauf oder Laden und tipp auf + Route.',
    'rt.up': 'Früher', 'rt.down': 'Später', 'rt.remove': 'Aus der Route nehmen', 'rt.how': 'Wie bist du unterwegs?', 'rt.car': 'Auto', 'rt.bike': 'Rad', 'rt.walk': 'Zu Fuß',
    'rt.order': 'In die kürzeste Reihenfolge bringen', 'rt.google': 'Route in Google Maps öffnen', 'rt.apple': 'Route in Apple Karten öffnen', 'rt.waze': 'Waze',
    'rt.wazeEach': 'Waze nimmt einen Stopp nach dem anderen. Wähl deinen nächsten Stopp:', 'rt.wazeTo': 'Mit Waze zu {t} navigieren', 'rt.max': 'Google Maps nimmt die ersten {n} Stopps mit.',
    'rt.approx': 'Garagenverkäufe und Hofflohmärkte stehen als Gebiet in deiner Route. Die Hausnummer siehst du ab dem Vortag in der YardiGo-App.',
    'rt.share': 'Route teilen', 'rt.shareTitle': 'Meine Stöberroute auf YardiGo', 'rt.copied': 'Link zu deiner Route kopiert', 'rt.loaded': 'Geteilte Route geladen: {n} Stopps',
    'rt.order': 'In eine kluge Reihenfolge bringen', 'rt.ordered': 'Reihenfolge angepasst: was früh schließt zuerst, dann das Nächste', 'rt.gone': 'Nicht mehr gefunden: entfernt oder abgesagt', 'rt.openAt': 'geöffnet {t}', 'rt.shut': 'Geschlossen am {d}', 'rt.past': 'Schon vorbei', 'rt.notOn': 'Nicht am {d}', 'rt.changed': 'Datum geändert: jetzt {d}', 'rt.sharedName': 'Geteilte Route', 'rt.here': 'Mein Standort', 'rt.locFail': 'Dein Standort ist nicht verfügbar.', 'rt.placeFail': 'Diesen Ort finden wir nicht. Versuch einen anderen Namen oder eine Postleitzahl.', 'rt.moved': 'Reihenfolge angepasst', 'rt.renamed': 'Name gespeichert', 'rt.duplicated': 'Kopie erstellt', 'rt.deleted': 'Route gelöscht', 'rt.copyOf': '{t} (Kopie)', 'rt.untitled': 'Meine Route', 'rt.myRoutes': 'Meine Routen', 'rt.back': 'Zurück zu deiner Route', 'rt.name': 'Name der Route', 'rt.save': 'Speichern', 'rt.stopsN': '{n} Stopps', 'rt.delAsk': 'Route löschen?', 'rt.yes': 'Ja, löschen', 'rt.no': 'Nein', 'rt.rename': 'Umbenennen', 'rt.dup': 'Kopieren', 'rt.del': 'Löschen', 'rt.newRoute': 'Neue Route', 'rt.from': 'ab {p}', 'rt.day': 'Dein Tag', 'rt.date': 'Datum', 'rt.depart': 'Abfahrt', 'rt.start': 'Start', 'rt.end': 'Ziel', 'rt.none': 'Keins', 'rt.place': 'Ein Ort…', 'rt.otherPlace': 'Anderer Ort…', 'rt.backToStart': 'Zurück zum Start', 'rt.placePh': 'Ort oder Postleitzahl', 'rt.next': 'Nächster Stopp', 'rt.navigate': 'Navigieren', 'rt.drag': 'Ziehen, um die Reihenfolge zu ändern', 'rt.done': 'Besucht', 'rt.sum': '{n} Stopps, etwa {km} km Luftlinie. Die Strecke über die Straße ist länger.', 'rt.allDone': 'Alle Stopps erledigt. Viel Freude mit deinen Funden!', 'rt.parts': 'Deine Route ist zu lang für einen Link. Öffne sie Teil für Teil.', 'rt.part': 'Teil {i}: {a} bis {b}', 'rt.suggTitle': 'Auch auf deinem Weg', 'rt.min': '{n} Min.', 'rt.h': '{u} Std.', 'rt.hmin': '{u} Std. {m}', 'rt.arrive': 'Ankunft {t}', 'rt.wait': '{n} Min. warten, bis es öffnet', 'rt.late': 'Du kommst um {t} an, dann ist schon geschlossen', 'rt.visit': 'Aufenthalt', 'rt.stay': '{d} bleiben', 'rt.sumRoad': '{km} km, {reis} unterwegs, fertig um {klaar}', 'rt.sumApprox': 'Garagenverkäufe und Hofflohmärkte sind Gebiete in deiner Route: die Ankunftszeit dort ist geschätzt.', 'rt.roadLoading': 'Fahrzeiten laden…', 'rt.roadFail': 'Fahrzeiten sind gerade nicht verfügbar.', 'rt.ordering': 'Reihenfolge wird berechnet…', 'rt.orderedRoad': 'Reihenfolge nach Fahrzeit und Öffnungszeiten angepasst', 'rt.orderedNot': '{n} Stopp(s) passen wegen der Öffnungszeiten nicht in deinen Tag. Sie stehen jetzt am Ende.', 'rt.detour': '{n} Min. Umweg', 'rt.cleared': 'Route geleert.', 'rt.undo': 'Rückgängig', 'rt.undone': 'Wiederhergestellt', 'rt.suggN1': 'Es gibt noch 1 Ort nahe deiner Route, der an dem Tag geöffnet ist.', 'rt.suggShops1': 'Es gibt noch 1 Gebrauchtwarenladen nahe deiner Route.', 'rt.suggN': 'Es gibt noch {n} Orte nahe deiner Route, die an dem Tag geöffnet sind.', 'rt.suggShops': 'Es gibt noch {n} Gebrauchtwarenläden nahe deiner Route.', 'rt.suggKm': '{km} km von deiner Route (Luftlinie)', 'rt.suggNone': 'Sonst nichts geöffnet nahe deiner Route an dem Tag.', 'rt.suggLoading': 'Suche…', 'rt.suggShopsOn': '+ Gebrauchtwarenläden einbeziehen', 'rt.shareGone': 'Diese geteilte Route gibt es nicht mehr.', 'rt.inAccount': 'Deine Routen sind in deinem Konto gespeichert und auf deinen anderen Geräten verfügbar.', 'rt.localOnly': 'Deine Routen sind nur in diesem Browser gespeichert.', 'rt.login': 'Melde dich an, um sie in deinem Konto zu speichern', 'rt.bigger': 'Feld größer', 'rt.smaller': 'Feld kleiner', 'rt.skipped': '{n} Stopp(s) mit einem Hinweis lassen wir aus der Navigation. Behebe den Hinweis oder wähl ein anderes Datum.',
    'rt.clear': 'Route leeren', 'rt.added': '{t} ist in deiner Route', 'rt.removed': '{t} ist aus deiner Route',
    'map.shopsOn': '+ Gebrauchtwarenläden', 'map.shopsHint': 'Blende Gebrauchtwarenläden ein, um sie in deine Route aufzunehmen', 'shop.holidays': 'Feiertage',
    'shop.site': 'Website', 'shop.hours': 'Geöffnet', 'shop.osm': 'Aus OpenStreetMap'
  });

  function opslag(fn) { try { return fn(); } catch (e) { return null; } }

  function kiesTaal() {
    var uitLink = opslag(function () { return new URLSearchParams(location.search).get('lang'); });
    if (TALEN.indexOf(uitLink) > -1) { opslag(function () { localStorage.setItem('yg-lang', uitLink); }); return uitLink; }
    // Vaste taal van de pagina zelf (yardigo.be/fr, gebouwd door build/prerender.mjs).
    var vast = document.documentElement.getAttribute('data-taal');
    if (TALEN.indexOf(vast) > -1) return vast;
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
    root.querySelectorAll('[data-i18n-title]').forEach(function (el) { el.setAttribute('title', t(el.getAttribute('data-i18n-title'), null, taal)); });
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
