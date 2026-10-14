import SwiftUI
import MapKit

struct ContentView: View {
    @Environment(ListingStore.self) private var store

    var body: some View {
        @Bindable var store = store
        NavigationSplitView {
            Sidebar()
                .navigationSplitViewColumnWidth(min: 200, ideal: 220, max: 260)
        } content: {
            ListingList()
                .navigationSplitViewColumnWidth(min: 300, ideal: 340, max: 420)
        } detail: {
            KaartView()
                .inspector(isPresented: Binding(get: { store.selection != nil }, set: { if !$0 { store.selection = nil } })) {
                    if let l = store.selected {
                        ListingDetail(listing: l)
                            .inspectorColumnWidth(min: 300, ideal: 340, max: 420)
                    }
                }
        }
        .searchable(text: $store.search, placement: .sidebar, prompt: "Zoek op plaats of titel")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                DagNachtKnop()
            }
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await store.load() } } label: {
                    Label("Vernieuwen", systemImage: "arrow.clockwise")
                }
                .disabled(store.isLoading)
                .help("Vernieuwen (⌘R)")
            }
        }
        .navigationTitle("YardiGo")
        .navigationSubtitle(store.isLoading ? "Laden…" : "\(store.filtered.count) verkopen")
    }
}

// MARK: - Zijbalk: soort, datum, favorieten

struct Sidebar: View {
    @Environment(ListingStore.self) private var store

    var body: some View {
        @Bindable var store = store
        List {
            Section("Soort") {
                ForEach(Kind.allCases) { kind in
                    Toggle(isOn: Binding(
                        get: { store.kinds.contains(kind) },
                        set: { aan in if aan { store.kinds.insert(kind) } else { store.kinds.remove(kind) } }
                    )) {
                        HStack(spacing: 8) {
                            Image(systemName: kind.symbol)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(.white)
                                .frame(width: 20, height: 20)
                                .background(kind.color, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                            Text(kind.label)
                            Spacer()
                            Text("\(store.count(kind))")
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                    }
                    .toggleStyle(.checkbox)
                }
            }
            Section("Wanneer") {
                Picker("Wanneer", selection: $store.dateFilter) {
                    ForEach(DateFilter.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.radioGroup)
                .labelsHidden()
            }
            Section("Bewaard") {
                Toggle(isOn: $store.onlyFavorites) {
                    Label("Alleen favorieten (\(store.favorites.count))", systemImage: "star.fill")
                }
                .toggleStyle(.checkbox)
            }
        }
        .listStyle(.sidebar)
    }
}

// MARK: - Lijst

struct ListingList: View {
    @Environment(ListingStore.self) private var store

    var body: some View {
        @Bindable var store = store
        Group {
            if let fout = store.errorMessage, store.listings.isEmpty {
                ContentUnavailableView("Niet geladen", systemImage: "wifi.exclamationmark", description: Text(fout))
            } else if store.filtered.isEmpty && !store.isLoading {
                ContentUnavailableView("Geen verkopen", systemImage: "magnifyingglass",
                                       description: Text("Niets gevonden met deze filters. Zet een soort aan of kies een ruimere periode."))
            } else {
                List(selection: $store.selection) {
                    ForEach(gegroepeerd, id: \.0) { dag, items in
                        Section(dag) {
                            ForEach(items) { ListingRow(listing: $0).tag($0.id) }
                        }
                    }
                }
                .listStyle(.inset)
            }
        }
        .overlay { if store.isLoading && store.listings.isEmpty { ProgressView() } }
    }

    private var gegroepeerd: [(String, [Listing])] {
        var volgorde: [String] = []
        var groepen: [String: [Listing]] = [:]
        for l in store.filtered {
            let k = DagLabel.tekst(l.date)
            if groepen[k] == nil { volgorde.append(k) }
            groepen[k, default: []].append(l)
        }
        return volgorde.map { ($0, groepen[$0]!) }
    }
}

struct ListingRow: View {
    let listing: Listing
    @Environment(ListingStore.self) private var store

    var body: some View {
        HStack(spacing: 12) {
            Thumb(listing: listing, size: 44)
            VStack(alignment: .leading, spacing: 3) {
                Text(listing.title)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(2)
                Text([listing.subLabel, listing.city].compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 4) {
                if let t = listing.timeStart {
                    Text(String(t.prefix(5)))
                        .font(.system(size: 11, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                if store.favorites.contains(listing.id) {
                    Image(systemName: "star.fill").font(.system(size: 10)).foregroundStyle(.yellow)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

// Vierkant met de eerste foto, of het soort-icoon op de soortkleur.
struct Thumb: View {
    let listing: Listing
    let size: CGFloat

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.22, style: .continuous).fill(listing.kind.color.gradient)
            Image(systemName: listing.symbol)
                .font(.system(size: size * 0.4, weight: .semibold))
                .foregroundStyle(.white)
            if let s = listing.images?.first, let url = URL(string: s) {
                AsyncImage(url: url) { img in img.resizable().scaledToFill() } placeholder: { Color.clear }
                    .frame(width: size, height: size)
                    .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
            }
        }
        .frame(width: size, height: size)
    }
}

enum DagLabel {
    static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "nl_NL")
        f.timeZone = TimeZone(identifier: "Europe/Amsterdam")
        f.dateFormat = "EEEE d MMMM"
        return f
    }()

    static func tekst(_ d: Date?) -> String {
        guard let d else { return "Datum onbekend" }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Amsterdam")!
        if cal.isDateInToday(d) { return "Vandaag" }
        if cal.isDateInTomorrow(d) { return "Morgen" }
        let s = formatter.string(from: d)
        return s.prefix(1).uppercased() + s.dropFirst()
    }
}
