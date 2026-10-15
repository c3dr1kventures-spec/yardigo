import SwiftUI
import MapKit

struct ListingDetail: View {
    let listing: Listing
    @Environment(ListingStore.self) private var store
    @Environment(\.openURL) private var openURL
    @State private var fotoIndex = 0
    @State private var fotoGroot = false

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
                    Label(plaats + (store.afstandTekst(listing).map { " · \($0)" } ?? ""), systemImage: "mappin.and.ellipse")
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

    // Foto's: bladeren met de pijltjes (of ← →) als er meer dan één is.
    private var kop: some View {
        let fotos = (listing.images ?? []).compactMap(URL.init(string:))
        let i = fotos.isEmpty ? 0 : min(fotoIndex, fotos.count - 1)
        return ZStack {
            RoundedRectangle(cornerRadius: 14, style: .continuous).fill(listing.kind.color.gradient)
            Image(systemName: listing.symbol)
                .font(.system(size: 54, weight: .semibold))
                .foregroundStyle(.white.opacity(0.9))
            if !fotos.isEmpty {
                AsyncImage(url: fotos[i]) { img in img.resizable().scaledToFill() } placeholder: { Color.clear }
                    .id(fotos[i])
                    .transition(.opacity)
            }
            if fotos.count > 1 {
                HStack {
                    fotoKnop("chevron.left") { fotoIndex = (i - 1 + fotos.count) % fotos.count }
                        .keyboardShortcut(.leftArrow, modifiers: [])
                    Spacer()
                    fotoKnop("chevron.right") { fotoIndex = (i + 1) % fotos.count }
                        .keyboardShortcut(.rightArrow, modifiers: [])
                }
                .padding(8)
                Text("\(i + 1) / \(fotos.count)")
                    .font(.system(size: 10, weight: .semibold))
                    .monospacedDigit()
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(.black.opacity(0.45), in: Capsule())
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .padding(8)
            }
        }
        .frame(height: 200)
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture { if !fotos.isEmpty { fotoGroot = true } }
        .onHover { binnen in if !fotos.isEmpty { (binnen ? NSCursor.pointingHand : NSCursor.arrow).set() } }
        .help(fotos.isEmpty ? "" : "Klik om te vergroten")
        .sheet(isPresented: $fotoGroot) {
            FotoBekijker(fotos: fotos, index: $fotoIndex)
        }
        .animation(.easeInOut(duration: 0.2), value: fotoIndex)
        .onChange(of: listing.id) { fotoIndex = 0 }
    }

    private func fotoKnop(_ symbool: String, _ actie: @escaping () -> Void) -> some View {
        Button(action: actie) {
            Image(systemName: symbool)
                .font(.system(size: 12, weight: .bold))
                .frame(width: 28, height: 28)
                .background(.regularMaterial, in: Circle())
        }
        .buttonStyle(.plain)
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
        let dagVooraf = listing.kind == .oprit || listing.addressRevealMode == "day_before"
        if store.ingelogd {
            return dagVooraf ? "Het huisadres verschijnt 24 uur vooraf. De pin staat bij benadering." : nil
        }
        return dagVooraf
            ? "Het huisadres verschijnt 24 uur vooraf voor ingelogde bezoekers. De pin staat bij benadering."
            : "Log in (rechtsboven) om het exacte adres te zien."
    }

    private func routeInKaarten() {
        guard let c = listing.coordinate else { return }
        let item = MKMapItem(placemark: MKPlacemark(coordinate: c))
        item.name = listing.title
        item.openInMaps(launchOptions: [MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeDriving])
    }
}

// Grote weergave van de foto's: klik op de foto in het detailpaneel.
// Bladeren met ← → of de pijlen, sluiten met Esc of de knop.
struct FotoBekijker: View {
    let fotos: [URL]
    @Binding var index: Int
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let i = min(index, fotos.count - 1)
        ZStack {
            Color.black
            AsyncImage(url: fotos[i]) { fase in
                switch fase {
                case .success(let img): img.resizable().scaledToFit()
                case .failure: Label("Foto kon niet laden", systemImage: "photo").foregroundStyle(.white.opacity(0.7))
                default: ProgressView().tint(.white)
                }
            }
            .id(fotos[i])
            .transition(.opacity)
            .padding(fotos.count > 1 ? 56 : 16)

            if fotos.count > 1 {
                HStack {
                    pijl("chevron.left") { index = (i - 1 + fotos.count) % fotos.count }
                        .keyboardShortcut(.leftArrow, modifiers: [])
                    Spacer()
                    pijl("chevron.right") { index = (i + 1) % fotos.count }
                        .keyboardShortcut(.rightArrow, modifiers: [])
                }
                .padding(14)
                Text("\(i + 1) / \(fotos.count)")
                    .font(.system(size: 12, weight: .semibold)).monospacedDigit()
                    .padding(.horizontal, 9).padding(.vertical, 4)
                    .background(.white.opacity(0.15), in: Capsule())
                    .foregroundStyle(.white)
                    .frame(maxHeight: .infinity, alignment: .bottom)
                    .padding(.bottom, 14)
            }
            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .bold))
                    .frame(width: 30, height: 30)
                    .background(.white.opacity(0.15), in: Circle())
                    .foregroundStyle(.white)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
            .help("Sluiten (Esc)")
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
            .padding(14)
        }
        .frame(minWidth: 720, idealWidth: 1000, minHeight: 540, idealHeight: 760)
        .animation(.easeInOut(duration: 0.2), value: index)
        .onTapGesture(count: 2) { dismiss() }
    }

    private func pijl(_ symbool: String, _ actie: @escaping () -> Void) -> some View {
        Button(action: actie) {
            Image(systemName: symbool)
                .font(.system(size: 16, weight: .bold))
                .frame(width: 40, height: 40)
                .background(.white.opacity(0.15), in: Circle())
                .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
    }
}
