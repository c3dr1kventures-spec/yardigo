import re, sys, unicodedata, os
os.chdir(sys.argv[1])
LAT = re.compile(r"^[A-Za-zÀ-ɏ0-9\s'’`.\-()/]+$")
def norm(x): return re.sub(r'[^a-z]', '', unicodedata.normalize('NFD', x.lower()).encode('ascii','ignore').decode())
rijen = {}
def verwerk(f, landen=None):
    for regel in open(f, encoding='utf-8'):
        k = regel.rstrip('\n').split('\t')
        if len(k) < 15: continue
        naam, ascii_, alt, lat, lng, kl, code, cc = k[1], k[2], k[3], k[4], k[5], k[6], k[7], k[8]
        if landen and cc not in landen: continue
        if not (kl == 'P' or (kl == 'A' and code in ('ADM2','ADM3','ADM4'))): continue
        inw = int(k[14] or 0)
        kand = [naam, ascii_] + (alt.split(',') if inw >= 1000 or kl == 'A' else [])
        namen = {norm(n) for n in kand if n and len(n) <= 50 and LAT.match(n)}
        for nn in namen:
            if len(nn) >= 2:
                rijen[(nn, round(float(lat),4), round(float(lng),4))] = (nn, naam.replace('|',' '), round(float(lat),4), round(float(lng),4), cc.lower(), code, inw)
for c in ('NL','BE','LU'): verwerk(c + '.txt')
verwerk('cities500.txt', {'DE'})
with open('../plaatsen.psv','w') as f:
    for r in rijen.values(): f.write('|'.join(map(str, r)) + '\n')
print(len(rijen), os.path.getsize('../plaatsen.psv'))
