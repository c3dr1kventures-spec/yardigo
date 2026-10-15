import SwiftUI
import MapKit

enum KaartLaag: String, CaseIterable, Identifiable {
    case rustig, standaard, satelliet, hybride
    var id: String { rawValue }
    var label: String {
        switch self {
        case .rustig: return "Rustig"
        case .standaard: return "Kleur"
        case .satelliet: return "Satelliet"
        case .hybride: return "Satelliet + wegen"
        }
    }
    var symbol: String {
        switch self {
        case .rustig: return "map"
        case .standaard: return "map.fill"
        case .satelliet: return "globe.europe.africa.fill"
        case .hybride: return "square.3.layers.3d"
        }
    }
    var configuratie: MKMapConfiguration {
        switch self {
        case .rustig:
            let c = MKStandardMapConfiguration(elevationStyle: .flat, emphasisStyle: .muted)
            c.pointOfInterestFilter = .excludingAll
            return c
        case .standaard:
            let c = MKStandardMapConfiguration(elevationStyle: .realistic, emphasisStyle: .default)
            c.pointOfInterestFilter = .excludingAll
            return c
        case .satelliet: return MKImageryMapConfiguration(elevationStyle: .flat)
        case .hybride:
            let c = MKHybridMapConfiguration(elevationStyle: .flat)
            c.pointOfInterestFilter = .excludingAll
            return c
        }
    }
}

struct KaartView: View {
    @Environment(ListingStore.self) private var store
    @AppStorage("kaartlaag") private var laag: KaartLaag = .rustig

    var body: some View {
        ClusterKaart(store: store, laag: laag)
            .ignoresSafeArea()
            .overlay(alignment: .bottomLeading) { Legenda().padding(12).allowsHitTesting(false) }
            .overlay(alignment: .top) {
                if let melding = store.melding {
                    Text(melding)
                        .font(.system(size: 12, weight: .medium))
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(.regularMaterial, in: Capsule())
                        .padding(.top, 12)
                        .transition(.move(edge: .top).combined(with: .opacity))
                        .allowsHitTesting(false)
                }
            }
            .animation(.smooth, value: store.melding)
    }
}

// Werkbalk: kaartlaag kiezen. (Knoppen bovenop de MKMapView geven klikken door
// aan de pinnen eronder, daarom staan ze in de werkbalk.)
struct LaagKnop: View {
    @AppStorage("kaartlaag") private var laag: KaartLaag = .rustig
    @State private var open = false

    var body: some View {
        Button { open.toggle() } label: {
            Label("Kaartlaag", systemImage: "square.3.layers.3d.top.filled")
        }
        .help("Kaartlaag (⌘1–4)")
        .popover(isPresented: $open, arrowEdge: .bottom) {
            LagenKiezer(laag: $laag) { open = false }
        }
    }
}

// Werkbalk: bij mij in de buurt.
struct LocatieKnop: View {
    @Environment(ListingStore.self) private var store
    @State private var locatie = Locatie()
    @State private var bezig = false

    var body: some View {
        Button(action: zoek) {
            Label("Bij mij in de buurt", systemImage: store.mijnLocatie != nil ? "location.fill" : "location")
        }
        .disabled(bezig)
        .help("Bij mij in de buurt: kaart naar je locatie en sorteren op afstand")
    }

    private func zoek() {
        bezig = true
        locatie.vraag { loc in
            bezig = false
            guard let loc else {
                store.toon("Locatie niet beschikbaar. Zet hem aan bij Systeeminstellingen › Privacy en beveiliging › Locatievoorzieningen.")
                return
            }
            store.mijnLocatie = loc
            store.sortering = .afstand
            let p = MKMapPoint(loc.coordinate)
            let breedte = 40_000 * MKMapPointsPerMeterAtLatitude(loc.coordinate.latitude)
            store.vliegNaar = MKMapRect(x: p.x - breedte / 2, y: p.y - breedte / 2, width: breedte, height: breedte)
        }
    }
}

// Vier lagen als tegels, zoals in Apple Kaarten.
struct LagenKiezer: View {
    @Binding var laag: KaartLaag
    let klaar: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Kaartlaag").font(.system(size: 12, weight: .semibold))
            HStack(spacing: 10) {
                ForEach(KaartLaag.allCases) { l in
                    Button {
                        withAnimation(.snappy) { laag = l }
                        klaar()
                    } label: {
                        VStack(spacing: 6) {
                            Image(systemName: l.symbol)
                                .font(.system(size: 20))
                                .frame(width: 64, height: 46)
                                .background(l == laag ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.1),
                                            in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .stroke(l == laag ? Color.accentColor : .clear, lineWidth: 2))
                            Text(l.label)
                                .font(.system(size: 10.5, weight: l == laag ? .semibold : .regular))
                                .lineLimit(1)
                        }
                        .frame(width: 72)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(14)
    }
}

// MKMapView met native clustering: pinnen dicht bij elkaar worden één bolletje
// met het aantal, en vallen vloeiend uit elkaar bij inzoomen.
struct ClusterKaart: NSViewRepresentable {
    let store: ListingStore
    let laag: KaartLaag

    static let nederland = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 51.95, longitude: 5.25),
        span: MKCoordinateSpan(latitudeDelta: 3.6, longitudeDelta: 4.2))

    func makeCoordinator() -> Coordinator { Coordinator(store: store) }

    func makeNSView(context: Context) -> MKMapView {
        let map = MiddenKaart()
        map.delegate = context.coordinator
        map.setRegion(Self.nederland, animated: false)
        map.preferredConfiguration = laag.configuratie
        map.showsZoomControls = true
        map.showsCompass = true
        map.register(PinAnnotationView.self, forAnnotationViewWithReuseIdentifier: PinAnnotationView.id)
        map.register(ClusterAnnotationView.self, forAnnotationViewWithReuseIdentifier: ClusterAnnotationView.id)
        context.coordinator.laag = laag
        let klik = NSClickGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.kaartGeklikt(_:)))
        klik.delaysPrimaryMouseButtonEvents = false
        klik.delegate = context.coordinator
        map.addGestureRecognizer(klik)
        return map
    }

    func updateNSView(_ map: MKMapView, context: Context) {
        let c = context.coordinator
        if c.laag != laag {
            c.laag = laag
            map.preferredConfiguration = laag.configuratie
        }
        map.showsUserLocation = store.mijnLocatie != nil

        // Alleen toevoegen/verwijderen wat veranderd is, zodat filteren niet flitst.
        let nieuw = Dictionary(uniqueKeysWithValues: store.filtered.map { ($0.id, $0) })
        let weg = c.annotations.filter { nieuw[$0.key] == nil }
        map.removeAnnotations(weg.map(\.value))
        weg.keys.forEach { c.annotations.removeValue(forKey: $0) }
        let erbij = nieuw.filter { c.annotations[$0.key] == nil }.map { ListingAnnotation(listing: $0.value) }
        erbij.forEach { c.annotations[$0.listing.id] = $0 }
        map.addAnnotations(erbij)

        // Vliegopdracht (plaats gezocht, mijn locatie).
        if let rect = store.vliegNaar {
            DispatchQueue.main.async { store.vliegNaar = nil }
            map.setVisibleMapRect(rect, edgePadding: NSEdgeInsets(top: 60, left: 60, bottom: 60, right: 60), animated: true)
        }

        // Selectie uit de lijst → pin selecteren en ernaartoe vliegen.
        c.markeer(store.selection, op: map)
        if c.laatsteSelectie != store.selection {
            c.laatsteSelectie = store.selection
            map.selectedAnnotations.forEach { map.deselectAnnotation($0, animated: false) }
            if let id = store.selection, let a = c.annotations[id], let kaart = map as? MiddenKaart {
                let span = min(map.region.span.latitudeDelta, 0.1)
                kaart.vlieg(naar: MKCoordinateRegion(center: a.coordinate, span: MKCoordinateSpan(latitudeDelta: span, longitudeDelta: span)))
            }
        }
    }

    final class Coordinator: NSObject, MKMapViewDelegate, NSGestureRecognizerDelegate {
        let store: ListingStore
        var annotations: [UUID: ListingAnnotation] = [:]
        var laatsteSelectie: UUID?
        var laag: KaartLaag = .rustig

        init(store: ListingStore) { self.store = store }

        // Laat alleen de gekozen verkoop gloeien.
        private var gemarkeerd: UUID?
        func markeer(_ id: UUID?, op map: MKMapView) {
            guard gemarkeerd != id || (id != nil && annotations[id!]?.uitgelicht == false) else { return }
            for vorige in [gemarkeerd].compactMap({ $0 }) {
                if let a = annotations[vorige] { a.uitgelicht = false; (map.view(for: a) as? PinAnnotationView)?.ververs() }
            }
            gemarkeerd = id
            if let id, let a = annotations[id] { a.uitgelicht = true; (map.view(for: a) as? PinAnnotationView)?.ververs() }
            // Valt de gekozen verkoop in een groepje, dan gloeit het groepje.
            func groepjes(in v: NSView) -> [ClusterAnnotationView] {
                v.subviews.flatMap { ($0 as? ClusterAnnotationView).map { [$0] } ?? groepjes(in: $0) }
            }
            groepjes(in: map).forEach { $0.prepareForDisplay() }
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            if annotation is MKClusterAnnotation {
                return mapView.dequeueReusableAnnotationView(withIdentifier: ClusterAnnotationView.id, for: annotation)
            }
            guard annotation is ListingAnnotation else { return nil }
            return mapView.dequeueReusableAnnotationView(withIdentifier: PinAnnotationView.id, for: annotation)
        }

        func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
            let rect = mapView.visibleMapRect
            Task { @MainActor in self.store.zichtbaarGebied = rect }
        }

        // Klik op pin of groepje (via MapKit). De gloed tekenen we zelf: MapKit-
        // selectie verbergt op de Mac de pin, dus die laten we meteen weer los.
        private var laatsteTreffer = Date.distantPast
        func mapView(_ mapView: MKMapView, didSelect view: MKAnnotationView) {
            laatsteTreffer = .now
            guard let annotation = view.annotation else { return }
            mapView.deselectAnnotation(annotation, animated: false)
            if let cluster = annotation as? MKClusterAnnotation {
                // Na het afhandelen van de klik, anders negeert MapKit de zoom.
                DispatchQueue.main.async { self.zoom(mapView, naar: cluster) }
            } else if let a = annotation as? ListingAnnotation {
                laatsteSelectie = a.listing.id
                Task { @MainActor in self.store.selection = a.listing.id }
            }
        }

        // Klik op een leeg stuk kaart (geen pin geraakt): selectie loslaten.
        @objc func kaartGeklikt(_ g: NSClickGestureRecognizer) {
            let klik = Date.now
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                guard self.laatsteTreffer < klik.addingTimeInterval(-0.3), self.store.selection != nil else { return }
                self.laatsteSelectie = nil
                self.store.selection = nil
            }
        }

        func gestureRecognizer(_ g: NSGestureRecognizer, shouldRecognizeSimultaneouslyWith other: NSGestureRecognizer) -> Bool { true }

        // Klik op een groepje → inzoomen tot de pinnen uit elkaar vallen.
        func zoom(_ mapView: MKMapView, naar cluster: MKClusterAnnotation) {
            var rect = MKMapRect.null
            for m in cluster.memberAnnotations { rect = rect.union(MKMapRect(origin: MKMapPoint(m.coordinate), size: MKMapSize(width: 1, height: 1))) }
            mapView.setVisibleMapRect(rect, edgePadding: NSEdgeInsets(top: 80, left: 80, bottom: 80, right: 80), animated: true)
        }
    }
}

// Houdt het midden van de kaart vast als het venster groter of kleiner wordt.
// Tijdens een vlucht naar een verkoop blijft juist dát doel in beeld, ook als
// het detailpaneel ondertussen openschuift.
final class MiddenKaart: MKMapView {
    var doel: MKCoordinateRegion?

    override func setFrameSize(_ newSize: NSSize) {
        let midden = centerCoordinate
        let hadMaat = frame.width > 10
        let anders = newSize != frame.size
        super.setFrameSize(newSize)
        // Alleen bij een echte maatwijziging; anders breekt dit lopende zooms af.
        guard hadMaat, anders else { return }
        if let doel { setRegion(doel, animated: false) } else { setCenter(midden, animated: false) }
    }

    func vlieg(naar regio: MKCoordinateRegion) {
        doel = regio
        setRegion(regio, animated: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            if self?.doel?.center.latitude == regio.center.latitude { self?.doel = nil }
        }
    }
}

final class ListingAnnotation: NSObject, MKAnnotation {
    let listing: Listing
    var uitgelicht = false   // gekozen in de app (lijst of kaart): pin gloeit
    let coordinate: CLLocationCoordinate2D
    var title: String? { listing.title }
    init(listing: Listing) {
        self.listing = listing
        self.coordinate = listing.coordinate!
    }
}

func isDonker(_ v: NSView) -> Bool {
    v.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
}

// MARK: - Pin

@MainActor
enum PinBeelden {
    private static var cache: [String: NSImage] = [:]

    // Vaste ruimte rond de pin in elk beeld, zodat rand, schaduw en gloed er
    // helemaal op passen en de punt altijd even hoog staat.
    static let marge: CGFloat = 11
    // Grootste pin (vergroot + gloed): zo groot is het kader van elke pin.
    static let kader = CGSize(width: 30 * groot + 2 * marge, height: 38 * groot + 2 * marge)
    static let groot: CGFloat = 1.25

    static func beeld(_ l: Listing, groot: Bool, gloed: Bool, dark: Bool) -> NSImage {
        let key = "\(l.kind.rawValue)-\(l.symbol)-\(groot)-\(gloed)-\(dark)"
        if let b = cache[key] { return b }
        // Elk beeld even groot (punt onderaan in het midden): MapKit op de Mac
        // schaalt een beeld dat van formaat wisselt terug naar het eerste formaat.
        let r = ImageRenderer(content: Pin(kind: l.kind, symbol: l.symbol, dark: dark, schaal: groot ? Self.groot : 1, gloed: gloed)
            .padding(.bottom, marge)
            .frame(width: kader.width, height: kader.height, alignment: .bottom))
        r.scale = 2
        let b = r.nsImage ?? NSImage()
        cache[key] = b
        return b
    }
}

final class PinAnnotationView: MKAnnotationView {
    static let id = "pin"
    private var hover = false
    private var kaartje: NSHostingView<HoverKaartje>?

    override init(annotation: MKAnnotation?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        clusteringIdentifier = "yardigo"
        collisionMode = .rectangle
        wantsLayer = true
        layer?.masksToBounds = false
    }
    required init?(coder: NSCoder) { fatalError() }

    override func prepareForReuse() {
        super.prepareForReuse()
        hover = false
        verbergKaartje()
    }

    override func prepareForDisplay() {
        super.prepareForDisplay()
        clusteringIdentifier = "yardigo"
        toon()
    }

    override func setSelected(_ selected: Bool, animated: Bool) {
        super.setSelected(selected, animated: animated)
        if selected { verbergKaartje() }
        toon()
    }

    // MapKit op de Mac zet soms alleen deze property, zonder setSelected.
    override var isSelected: Bool {
        didSet { if isSelected != oldValue { if isSelected { verbergKaartje() }; toon() } }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        toon()
    }

    // Muis boven de pin: kort kaartje met de belangrijkste info.
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) {
        hover = true
        toon()
        guard !isSelected, kaartje == nil, let a = annotation as? ListingAnnotation, !a.uitgelicht else { return }
        let l = a.listing
        let v = NSHostingView(rootView: HoverKaartje(listing: l))
        let maat = v.fittingSize
        v.frame = NSRect(origin: kaartjeOorsprong(maat), size: maat)
        v.alphaValue = 0
        addSubview(v)
        kaartje = v
        NSAnimationContext.runAnimationGroup { $0.duration = 0.12; v.animator().alphaValue = 1 }
    }

    override func mouseExited(with event: NSEvent) {
        hover = false
        verbergKaartje()
        toon()
    }

    private func verbergKaartje() {
        kaartje?.removeFromSuperview()
        kaartje = nil
    }

    // Groeperen gebeurt op de pin zelf, niet op de lege ruimte voor de gloed.
    override var alignmentRectInsets: NSEdgeInsets {
        let k = PinBeelden.kader, m = PinBeelden.marge
        let zij = (k.width - 30) / 2
        return NSEdgeInsets(top: k.height - m - 38, left: zij, bottom: m, right: zij)
    }

    // Het kaartje steekt buiten de pin uit; klikken daar gaan door naar de kaart.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let p = convert(point, from: superview)
        return bounds.insetBy(dx: PinBeelden.marge, dy: PinBeelden.marge).contains(p) ? self : nil
    }

    func ververs() { toon() }

    private func toon() {
        guard let a = annotation as? ListingAnnotation else { return }
        let gekozen = isSelected || a.uitgelicht
        if gekozen { verbergKaartje() }
        image = PinBeelden.beeld(a.listing, groot: gekozen || hover, gloed: gekozen, dark: isDonker(self))
        // De punt (onderkant minus marge) staat precies op de locatie.
        centerOffset = CGPoint(x: 0, y: -(PinBeelden.kader.height / 2 - PinBeelden.marge))
        displayPriority = gekozen ? .required : .defaultHigh
        zPriority = gekozen || hover ? .max : .defaultUnselected
        kaartje.map { k in k.frame.origin = kaartjeOorsprong(k.frame.size) }
    }

    private func kaartjeOorsprong(_ maat: NSSize) -> CGPoint {
        CGPoint(x: (bounds.width - maat.width) / 2, y: isFlipped ? -maat.height + PinBeelden.marge : bounds.height - PinBeelden.marge)
    }
}

struct HoverKaartje: View {
    let listing: Listing

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(listing.title)
                .font(.system(size: 12, weight: .semibold))
                .lineLimit(2)
            Text([listing.subLabel, DagLabel.kort(listing.date), listing.timeRange, listing.city].compactMap { $0 }.joined(separator: " · "))
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .frame(width: 220, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(.separator, lineWidth: 0.5))
        .shadow(color: .black.opacity(0.18), radius: 6, y: 2)
        .padding(6)
    }
}

// Druppelpin zoals op de website: soortkleur, witte rand, icoon.
struct Pin: View {
    let kind: Kind
    let symbol: String
    var dark = false
    var schaal: CGFloat = 1
    var gloed = false     // geselecteerd: zachte gloed langs de rand

    var body: some View {
        let kleur = kind.pinColor(dark: dark)
        ZStack(alignment: .top) {
            if gloed {
                // Zachte lichtrand: wit halo + soortkleur die naar buiten uitloopt.
                PinShape()
                    .stroke(kleur.opacity(0.85), lineWidth: 9)
                    .blur(radius: 6)
                PinShape()
                    .stroke(.white, lineWidth: 5)
                    .blur(radius: 2.5)
                    .shadow(color: .white.opacity(0.8), radius: 4)
            }
            PinShape()
                .fill(kleur)
                .overlay(PinShape().stroke(.white, lineWidth: 2))
                .shadow(color: .black.opacity(gloed ? 0.15 : 0.28), radius: 2, y: 1.5)
            Image(systemName: symbol)
                .font(.system(size: 12 * schaal, weight: .bold))
                .foregroundStyle(.white)
                .padding(.top, 7 * schaal)
        }
        .frame(width: 30 * schaal, height: 38 * schaal)
    }
}

struct PinShape: Shape {
    // Pad uit makeMarkerIcon() (viewBox 36×46), geschaald naar het frame.
    func path(in r: CGRect) -> Path {
        let sx = r.width / 28, sy = r.height / 42
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: r.minX + (x - 4) * sx, y: r.minY + (y - 2) * sy) }
        var path = Path()
        path.move(to: p(18, 2))
        path.addCurve(to: p(4, 16), control1: p(10.268, 2), control2: p(4, 8.268))
        path.addCurve(to: p(18, 44), control1: p(4, 26), control2: p(18, 44))
        path.addCurve(to: p(32, 16), control1: p(18, 44), control2: p(32, 26))
        path.addCurve(to: p(18, 2), control1: p(32, 8.268), control2: p(25.732, 2))
        path.closeSubpath()
        return path
    }
}

// MARK: - Groepje

final class ClusterAnnotationView: MKAnnotationView {
    static let id = "cluster"

    override init(annotation: MKAnnotation?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        collisionMode = .circle
        displayPriority = .defaultHigh
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        prepareForDisplay()
    }

    // Groeperen op het bolletje zelf, niet op de ruimte voor de gloed.
    override var alignmentRectInsets: NSEdgeInsets { NSEdgeInsets(top: 8, left: 8, bottom: 8, right: 8) }

    override func prepareForDisplay() {
        super.prepareForDisplay()
        guard let c = annotation as? MKClusterAnnotation else { return }
        let leden = c.memberAnnotations.compactMap { ($0 as? ListingAnnotation)?.listing }
        // Kleur van de soort die het meest voorkomt in het groepje.
        let telling = Dictionary(grouping: leden, by: \.kind).mapValues(\.count)
        let kind = telling.max { $0.value < $1.value }?.key ?? .markt
        let gloed = c.memberAnnotations.contains { ($0 as? ListingAnnotation)?.uitgelicht == true }
        let r = ImageRenderer(content: Bolletje(aantal: leden.count, kleur: kind.pinColor(dark: isDonker(self)), gloed: gloed).padding(2))
        r.scale = 2
        image = r.nsImage
        centerOffset = .zero
        toolTip = "\(leden.count) verkopen. Klik om in te zoomen."
    }
}

struct Bolletje: View {
    let aantal: Int
    let kleur: Color
    var gloed = false

    var body: some View {
        let d: CGFloat = aantal < 10 ? 32 : aantal < 50 ? 38 : 46
        Text("\(aantal)")
            .font(.system(size: aantal < 100 ? 13 : 12, weight: .bold, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(.white)
            .frame(width: d, height: d)
            .background(kleur, in: Circle())
            .overlay(Circle().stroke(.white, lineWidth: 2.5))
            .background(Circle().fill(kleur.opacity(0.25)).padding(-5))
            .shadow(color: .black.opacity(0.25), radius: 2, y: 1)
            .background {
                if gloed {
                    Circle().stroke(kleur.opacity(0.85), lineWidth: 9).blur(radius: 6).padding(-4)
                    Circle().stroke(.white, lineWidth: 5).blur(radius: 2.5).padding(-2)
                }
            }
            .padding(12)   // altijd even groot: MapKit schaalt wisselende maten terug
    }
}

struct Legenda: View {
    var body: some View {
        HStack(spacing: 12) {
            ForEach(Kind.allCases) { k in
                HStack(spacing: 5) {
                    Circle().fill(k.color).frame(width: 9, height: 9)
                    Text(k.label).font(.system(size: 11, weight: .medium))
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(.regularMaterial, in: Capsule())
    }
}





