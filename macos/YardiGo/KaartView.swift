import SwiftUI
import MapKit

struct KaartView: View {
    @Environment(ListingStore.self) private var store

    var body: some View {
        ClusterKaart(listings: store.filtered, selection: Binding(get: { store.selection }, set: { store.selection = $0 }))
            .ignoresSafeArea()
            .overlay(alignment: .bottomLeading) {
                Legenda().padding(12)
            }
    }
}

// MKMapView met native clustering: pinnen dicht bij elkaar worden één bolletje
// met het aantal, en vallen vloeiend uit elkaar bij inzoomen.
struct ClusterKaart: NSViewRepresentable {
    let listings: [Listing]
    @Binding var selection: Listing.ID?

    static let nederland = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 51.95, longitude: 5.25),
        span: MKCoordinateSpan(latitudeDelta: 3.6, longitudeDelta: 4.2))

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> MKMapView {
        let map = MKMapView()
        map.delegate = context.coordinator
        map.setRegion(Self.nederland, animated: false)
        // Gedempte kaart (zoals CARTO op de website): pinnen springen er dag en nacht uit.
        let config = MKStandardMapConfiguration(elevationStyle: .flat, emphasisStyle: .muted)
        config.pointOfInterestFilter = .excludingAll
        map.preferredConfiguration = config
        map.showsZoomControls = true
        map.showsCompass = true
        map.showsScale = true
        map.register(PinAnnotationView.self, forAnnotationViewWithReuseIdentifier: PinAnnotationView.id)
        map.register(ClusterAnnotationView.self, forAnnotationViewWithReuseIdentifier: ClusterAnnotationView.id)
        return map
    }

    func updateNSView(_ map: MKMapView, context: Context) {
        context.coordinator.parent = self
        let c = context.coordinator

        // Alleen toevoegen/verwijderen wat veranderd is, zodat filteren niet flitst.
        let nieuw = Dictionary(uniqueKeysWithValues: listings.filter { $0.coordinate != nil }.map { ($0.id, $0) })
        let weg = c.annotations.filter { nieuw[$0.key] == nil }
        map.removeAnnotations(weg.map(\.value))
        weg.keys.forEach { c.annotations.removeValue(forKey: $0) }
        let erbij = nieuw.filter { c.annotations[$0.key] == nil }.map { ListingAnnotation(listing: $0.value) }
        erbij.forEach { c.annotations[$0.listing.id] = $0 }
        map.addAnnotations(erbij)

        // Selectie uit de lijst → pin selecteren en ernaartoe vliegen.
        if c.laatsteSelectie != selection {
            c.laatsteSelectie = selection
            map.selectedAnnotations.forEach { map.deselectAnnotation($0, animated: false) }
            if let id = selection, let a = c.annotations[id] {
                let regio = MKCoordinateRegion(center: a.coordinate, latitudinalMeters: 22_000, longitudinalMeters: 22_000)
                NSAnimationContext.runAnimationGroup { ctx in
                    ctx.duration = 0.6
                    ctx.allowsImplicitAnimation = true
                    map.setRegion(regio, animated: true)
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.65) { map.selectAnnotation(a, animated: true) }
            }
        }
    }

    final class Coordinator: NSObject, MKMapViewDelegate {
        var parent: ClusterKaart
        var annotations: [UUID: ListingAnnotation] = [:]
        var laatsteSelectie: UUID?

        init(_ parent: ClusterKaart) { self.parent = parent }

        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            if annotation is MKClusterAnnotation {
                return mapView.dequeueReusableAnnotationView(withIdentifier: ClusterAnnotationView.id, for: annotation)
            }
            guard annotation is ListingAnnotation else { return nil }
            return mapView.dequeueReusableAnnotationView(withIdentifier: PinAnnotationView.id, for: annotation)
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
            if parent.selection != a.listing.id { parent.selection = a.listing.id }
        }

        func mapView(_ mapView: MKMapView, didDeselect view: MKAnnotationView) {
            guard let annotation = view.annotation else { return }
            guard let a = annotation as? ListingAnnotation, parent.selection == a.listing.id else { return }
            DispatchQueue.main.async {
                // Alleen leegmaken als er niet meteen een andere pin is gekozen.
                if mapView.selectedAnnotations.isEmpty && self.parent.selection == a.listing.id {
                    self.laatsteSelectie = nil
                    self.parent.selection = nil
                }
            }
        }
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

// MARK: - Pin

@MainActor
enum PinBeelden {
    private static var cache: [String: NSImage] = [:]

    static func beeld(_ l: Listing, selected: Bool, dark: Bool) -> NSImage {
        let key = "\(l.kind.rawValue)-\(l.symbol)-\(selected)-\(dark)"
        if let b = cache[key] { return b }
        let r = ImageRenderer(content: Pin(kind: l.kind, symbol: l.symbol, dark: dark).scaleEffect(selected ? 1.3 : 1, anchor: .bottom).padding(selected ? 6 : 2))
        r.scale = 2
        let b = r.nsImage ?? NSImage()
        cache[key] = b
        return b
    }
}

final class PinAnnotationView: MKAnnotationView {
    static let id = "pin"

    override init(annotation: MKAnnotation?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        clusteringIdentifier = "yardigo"
        collisionMode = .rectangle
    }
    required init?(coder: NSCoder) { fatalError() }

    override func prepareForDisplay() {
        super.prepareForDisplay()
        clusteringIdentifier = "yardigo"
        toon(selected: isSelected)
    }

    override func setSelected(_ selected: Bool, animated: Bool) {
        super.setSelected(selected, animated: animated)
        toon(selected: selected)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        toon(selected: isSelected)
    }

    private func toon(selected: Bool) {
        guard let l = (annotation as? ListingAnnotation)?.listing else { return }
        image = PinBeelden.beeld(l, selected: selected, dark: isDonker(self))
        centerOffset = CGPoint(x: 0, y: -(image?.size.height ?? 0) / 2)
        displayPriority = selected ? .required : .defaultHigh
        zPriority = selected ? .max : .defaultUnselected
    }
}

// Druppelpin zoals op de website: soortkleur, witte rand, icoon.
func isDonker(_ v: NSView) -> Bool {
    v.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
}

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
