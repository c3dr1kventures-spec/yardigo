import os, sys
# Provincie per plaats (NL: GeoNames admin1, BE: admin2, want admin1 is daar
# het gewest). Uitvoer: plaatsen-provincie.psv met lat|lng|cc|provincie-slug,
# dezelfde afronding als plaatsen.psv zodat het daarop te koppelen is.
# Gebruik: python3 bouw_provincies.py <map met NL.txt en BE.txt>
os.chdir(sys.argv[1])
NL = {'01': 'drenthe', '02': 'friesland', '03': 'gelderland', '04': 'groningen', '05': 'limburg',
      '06': 'noord-brabant', '07': 'noord-holland', '09': 'utrecht', '10': 'zeeland',
      '11': 'zuid-holland', '15': 'overijssel', '16': 'flevoland'}
BE = {'VWV': 'west-vlaanderen', 'VOV': 'oost-vlaanderen', 'VAN': 'antwerpen', 'VLI': 'belgisch-limburg',
      'VBR': 'vlaams-brabant', 'WBR': 'waals-brabant', 'WHT': 'henegouwen', 'WLG': 'luik',
      'WNA': 'namen', 'WLX': 'belgisch-luxemburg', 'BRU': 'brussel'}
rijen = {}
for f, cc in (('NL.txt', 'nl'), ('BE.txt', 'be')):
    for regel in open(f, encoding='utf-8'):
        k = regel.rstrip('\n').split('\t')
        if len(k) < 15: continue
        kl, code = k[6], k[7]
        if not (kl == 'P' or (kl == 'A' and code in ('ADM2', 'ADM3', 'ADM4'))): continue
        prov = NL.get(k[10]) if cc == 'nl' else BE.get(k[11])
        if not prov: continue
        rijen[(round(float(k[4]), 4), round(float(k[5]), 4), cc)] = prov
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'plaatsen-provincie.psv'), 'w') as out:
    for (lat, lng, cc), prov in rijen.items():
        out.write(f'{lat}|{lng}|{cc}|{prov}\n')
print(len(rijen))
