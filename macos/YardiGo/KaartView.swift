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
        if c.laatsteSelectie != store.selection {
            c.laatsteSelectie = store.selection
            map.selectedAnnotations.forEach { map.deselectAnnotation($0, animated: false) }
            if let id = store.selection, let a = c.annotations[id] {
                let span = min(map.region.span.latitudeDelta, 0.25)
                map.setRegion(MKCoordinateRegion(center: a.coordinate, span: MKCoordinateSpan(latitudeDelta: span, longitudeDelta: span)), animated: true)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { map.selectAnnotation(a, animated: true) }
            }
        }
    }

    final class Coordinator: NSObject, MKMapViewDelegate {
        let store: ListingStore
        var annotations: [UUID: ListingAnnotation] = [:]
        var laatsteSelectie: UUID?
        var laag: KaartLaag = .rustig

        init(store: ListingStore) { self.store = store }

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

        func mapView(_ mapView: MKMapView, didSelect view: MKAnnotationView) {
            guard let annotation = view.annotation else { return }
            if let cluster = annotation as? MKClusterAnnotation {
                // Klik op een groepje → inzoomen tot de pinnen uit elkaar vallen.
                mapView.deselectAnnotation(cluster, animated: false)
                var rect = MKMapRect.null
                for m in cluster.memberAnnotations { rect = rect.union(MKMapRect(origin: MKMapPoint(m.coordinate), size: MKMapSize(width: 1, height: 1))) }
                mapView.setVisibleMapRect(rect, edgePadding: NSEdgeInsets(top: 80, left: 80, bottom: 80, right: 80), animated: true)
                return
            }
            guard let a = annotation as? ListingAnnotation else { return }
            laatsteSelectie = a.listing.id
            Task { @MainActor in if self.store.selection != a.listing.id { self.store.selection = a.listing.id } }
        }

        func mapView(_ mapView: MKMapView, didDeselect view: MKAnnotationView) {
            guard let a = view.annotation as? ListingAnnotation else { return }
            DispatchQueue.main.async {
                // Alleen leegmaken als er niet meteen een andere pin is gekozen.
                if mapView.selectedAnnotations.isEmpty && self.store.selection == a.listing.id {
                    self.laatsteSelectie = nil
                    self.store.selection = nil
                }
            }
        }
    }
}

// Houdt het midden van de kaart vast als het venster groter of kleiner wordt.
final class MiddenKaart: MKMapView {
    override func setFrameSize(_ newSize: NSSize) {
        let midden = centerCoordinate
        let hadMaat = frame.width > 10
        super.setFrameSize(newSize)
        if hadMaat { setCenter(midden, animated: false) }
    }
}

final class ListingAnnotation: NSObject, MKAnnotation {
    let listing: Listing
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

    static func beeld(_ l: Listing, groot: Bool, dark: Bool) -> NSImage {
        let key = "\(l.kind.rawValue)-\(l.symbol)-\(groot)-\(dark)"
        if let b = cache[key] { return b }
        let r = ImageRenderer(content: Pin(kind: l.kind, symbol: l.symbol, dark: dark).scaleEffect(groot ? 1.3 : 1, anchor: .bottom).padding(groot ? 6 : 2))
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
        guard !isSelected, kaartje == nil, let l = (annotation as? ListingAnnotation)?.listing else { return }
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

    // Het kaartje steekt buiten de pin uit; klikken daar gaan door naar de kaart.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let p = convert(point, from: superview)
        return bounds.contains(p) ? self : nil
    }

    private func toon() {
        guard let l = (annotation as? ListingAnnotation)?.listing else { return }
        image = PinBeelden.beeld(l, groot: isSelected || hover, dark: isDonker(self))
        centerOffset = CGPoint(x: 0, y: -(image?.size.height ?? 0) / 2)
        displayPriority = isSelected ? .required : .defaultHigh
        zPriority = isSelected || hover ? .max : .defaultUnselected
        kaartje.map { k in k.frame.origin = kaartjeOorsprong(k.frame.size) }
    }

    private func kaartjeOorsprong(_ maat: NSSize) -> CGPoint {
        CGPoint(x: (bounds.width - maat.width) / 2, y: isFlipped ? -maat.height + 2 : bounds.height - 2)
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

    var body: some View {
        ZStack(alignment: .top) {
            PinShape()
                .fill(kind.pinColor(dark: dark))
                .overlay(PinShape().stroke(.white, lineWidth: 2))
                .frame(width: 30, height: 38)
                .shadow(color: .black.opacity(0.28), radius: 2, y: 1.5)
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(.white)
                .padding(.top, 7)
        }
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

    override func prepareForDisplay() {
        super.prepareForDisplay()
        guard let c = annotation as? MKClusterAnnotation else { return }
        let leden = c.memberAnnotations.compactMap { ($0 as? ListingAnnotation)?.listing }
        // Kleur van de soort die het meest voorkomt in het groepje.
        let telling = Dictionary(grouping: leden, by: \.kind).mapValues(\.count)
        let kind = telling.max { $0.value < $1.value }?.key ?? .markt
        let r = ImageRenderer(content: Bolletje(aantal: leden.count, kleur: kind.pinColor(dark: isDonker(self))).padding(2))
        r.scale = 2
        image = r.nsImage
        centerOffset = .zero
        toolTip = "\(leden.count) verkopen. Klik om in te zoomen."
    }
}

struct Bolletje: View {
    let aantal: Int
    let kleur: Color

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
            .padding(6)
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
