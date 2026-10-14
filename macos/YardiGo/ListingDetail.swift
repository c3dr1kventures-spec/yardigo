import SwiftUI
import MapKit

struct ListingDetail: View {
    let listing: Listing
    @Environment(ListingStore.self) private var store
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                kop
                VStack(alignment: .leading, spacing: 8) {
                    Text(listing.subLabel.uppercased())
                        .font(.system(size: 11, weight: .bold))
                        .tracking(0.6)
                        .foregroundStyle(listing.kind.color)
                    Text(listing.title)
                        .font(.system(size: 20, weight: .bold))
                        .fixedSize(horizontal: false, vertical: true)
                }
                VStack(alignment: .leading, spacing: 10) {
                    Label(DagLabel.tekst(listing.date), systemImage: "calendar")
                    if let t = listing.timeRange { Label(t, systemImage: "clock") }
                    Label(plaats, systemImage: "mappin.and.ellipse")
                    if let uitleg = adresUitleg {
                        Text(uitleg).font(.caption).foregroundStyle(.secondary).padding(.leading, 28)
                    }
                }
                .font(.system(size: 13))

                if let d = listing.description, !d.isEmpty {
                    Divider()
                    Text(d).font(.system(size: 13)).foregroundStyle(.secondary).textSelection(.enabled)
                }

                if let label = listing.sourceLabel ?? listing.sourceUrl.flatMap({ URL(string: $0)?.host() }),
                   let s = listing.sourceUrl, let url = URL(string: s) {
                    Divider()
                    Link(destination: url) {
                        Label("Organisator: \(label)", systemImage: "arrow.up.right.square")
                    }
                    .font(.system(size: 13))
                }

                Divider()
                knoppen
            }
            .padding(20)
        }
    }

    private var kop: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14, style: .continuous).fill(listing.kind.color.gradient)
            Image(systemName: listing.symbol)
                .font(.system(size: 54, weight: .semibold))
                .foregroundStyle(.white.opacity(0.9))
            if let s = listing.images?.first, let url = URL(string: s) {
                AsyncImage(url: url) { img in img.resizable().scaledToFill() } placeholder: { Color.clear }
            }
        }
        .frame(height: 190)
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var knoppen: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Button { routeInKaarten() } label: {
                    Label("Route", systemImage: "car.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(listing.kind.color)

                Button { store.toggleFavorite(listing.id) } label: {
                    Label(isFavoriet ? "Bewaard" : "Bewaar", systemImage: isFavoriet ? "star.fill" : "star")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            HStack(spacing: 8) {
                ShareLink(item: listing.webURL) {
                    Label("Delen", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                Button { openURL(listing.webURL) } label: {
                    Label("Op yardigo.nl", systemImage: "safari").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        }
        .controlSize(.large)
    }

    private var isFavoriet: Bool { store.favorites.contains(listing.id) }

    private var plaats: String {
        if let a = listing.address, !a.isEmpty { return a }
        return listing.city ?? "Onbekende plaats"
    }

    private var adresUitleg: String? {
        guard listing.address?.isEmpty ?? true else { return nil }
        if listing.kind == .oprit || listing.addressRevealMode == "day_before" {
            return "Het huisadres verschijnt 24 uur vooraf voor ingelogde bezoekers op yardigo.nl. De pin staat bij benadering."
        }
        return "Het exacte adres zie je na inloggen op yardigo.nl."
    }

    private func routeInKaarten() {
        guard let c = listing.coordinate else { return }
        let item = MKMapItem(placemark: MKPlacemark(coordinate: c))
        item.name = listing.title
        item.openInMaps(launchOptions: [MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeDriving])
    }
}
