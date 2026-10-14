import SwiftUI
import MapKit

struct ContentView: View {
    @Environment(ListingStore.self) private var store

    var body: some View {
        @Bindable var store = store
        NavigationSplitView {
            Sidebar()
                .navigationSplitViewColumnWidth(min: 210, ideal: 230, max: 280)
        } content: {
            ListingList()
                .navigationSplitViewColumnWidth(min: 300, ideal: 350, max: 440)
        } detail: {
            KaartView()
                .inspector(isPresented: Binding(get: { store.selection != nil }, set: { if !$0 { store.selection = nil } })) {
                    if let l = store.selected {
                        ListingDetail(listing: l)
                            .inspectorColumnWidth(min: 300, ideal: 340, max: 420)
                            .task(id: l.id) { await store.laadDetail(l.id) }
                    }
                }
        }
        .searchable(text: $store.search, placement: .sidebar, prompt: "Zoek plaats, soort of titel")
        .onSubmit(of: .search) {
            // Enter: neem de eerste suggestie over.
            if let t = store.voorgesteldeTokens.first { store.tokens.append(t); store.search = "" }
        }
        .onChange(of: store.tokens) { store.tokensVeranderd() }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                LocatieKnop()
                LaagKnop()
            }
            ToolbarItem(placement: .primaryAction) { DagNachtKnop() }
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await store.load() } } label: {
                    Label("Vernieuwen", systemImage: "arrow.clockwise")
                }
                .disabled(store.isLoading)
                .help("Vernieuwen (⌘R)")
            }
        }
        .navigationTitle("YardiGo")
        .navigationSubtitle(store.isLoading && store.listings.isEmpty ? "Laden…" : "\(store.filtered.count) verkopen")
    }
}

// MARK: - Zijbalk: soort, categorie, datum, favorieten

struct Sidebar: View {
    @Environment(ListingStore.self) private var store

    var body: some View {
        @Bindable var store = store
        List {
            // Suggesties terwijl je typt: klik = filter op die plaats of soort.
            if !store.voorgesteldeTokens.isEmpty {
                Section("Suggesties") {
                    ForEach(store.voorgesteldeTokens) { t in
                        let (tekst, symbool) = store.tokenLabel(t)
                        Button {
                            withAnimation(.snappy) {
                                store.tokens.append(t)
                                store.search = ""
                            }
                        } label: {
                            Label(tekst, systemImage: symbool).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            if !store.tokens.isEmpty {
                Section("Actieve zoekfilters") {
                    ForEach(store.tokens) { t in
                        let (tekst, symbool) = store.tokenLabel(t)
                        HStack {
                            Label(tekst, systemImage: symbool)
                            Spacer()
                            Button { withAnimation(.snappy) { store.tokens.removeAll { $0 == t } } } label: {
                                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                            }
                            .buttonStyle(.plain)
                            .help("Filter weghalen")
                        }
                    }
                }
            }
            Section("Soort") {
                ForEach(Kind.allCases) { kind in
                    FilterRij(aan: store.kinds.contains(kind), symbool: kind.symbol, kleur: kind.color,
                              tekst: kind.label, aantal: store.count(kind)) {
                        if store.kinds.contains(kind) { store.kinds.remove(kind) } else { store.kinds.insert(kind) }
                    }
                }
            }
            if store.kinds.contains(.markt) {
                Section {
                    ForEach(store.categorieTelling, id: \.key) { c in
                        FilterRij(aan: store.categorieen.isEmpty || store.categorieen.contains(c.key), symbool: c.symbol,
                                  kleur: Kind.markt.color, tekst: c.label, aantal: c.aantal, klein: true) {
                            kiesCategorie(c.key)
                        }
                    }
                } header: {
                    HStack {
                        Text("Soort markt")
                        Spacer()
                        if !store.categorieen.isEmpty {
                            Button("Alle") { withAnimation(.snappy) { store.categorieen = [] } }
                                .buttonStyle(.plain)
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(.tint)
                        }
                    }
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
        .animation(.snappy, value: store.kinds)
    }

    // Eerste klik: alleen deze categorie. Daarna erbij of eraf.
    private func kiesCategorie(_ key: String) {
        withAnimation(.snappy) {
            if store.categorieen.isEmpty { store.categorieen = [key] }
            else if store.categorieen.contains(key) { store.categorieen.remove(key) }
            else { store.categorieen.insert(key) }
        }
    }
}

struct FilterRij: View {
    let aan: Bool
    let symbool: String
    let kleur: Color
    let tekst: String
    let aantal: Int
    var klein = false
    let actie: () -> Void

    var body: some View {
        Button(action: actie) {
            HStack(spacing: 8) {
                Image(systemName: symbool)
                    .font(.system(size: klein ? 10 : 11, weight: .semibold))
                    .foregroundStyle(aan ? .white : .secondary)
                    .frame(width: klein ? 18 : 20, height: klein ? 18 : 20)
                    .background(aan ? kleur : Color.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                Text(tekst)
                    .foregroundStyle(aan ? .primary : .secondary)
                Spacer()
                Text("\(aantal)")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Lijst

struct ListingList: View {
    @Environment(ListingStore.self) private var store

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Toggle(isOn: $store.alleenKaartgebied.animation(.snappy)) {
                    Text("Alleen kaartgebied")
                }
                .toggleStyle(.switch)
                .controlSize(.mini)
                .help("Toon in de lijst alleen verkopen die op het zichtbare deel van de kaart staan")
                Spacer()
                Picker("Sorteren", selection: $store.sortering) {
                    ForEach(Sortering.allCases) { s in
                        Text(s.label).tag(s).disabled(s == .afstand && store.mijnLocatie == nil)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .fixedSize()
                .help(store.mijnLocatie == nil ? "Sorteren op afstand: druk eerst op het locatie-icoon op de kaart" : "Sorteren")
            }
            .font(.system(size: 11))
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            Divider()
            inhoud
        }
    }

    @ViewBuilder private var inhoud: some View {
        @Bindable var store = store
        if let fout = store.errorMessage, store.listings.isEmpty {
            ContentUnavailableView("Niet geladen", systemImage: "wifi.exclamationmark", description: Text(fout))
        } else if store.lijst.isEmpty && !store.isLoading {
            ContentUnavailableView("Geen verkopen", systemImage: "magnifyingglass",
                                   description: Text(store.alleenKaartgebied
                                        ? "Niets in dit deel van de kaart. Zoom uit of zet ‘Alleen kaartgebied’ uit."
                                        : "Niets gevonden. Haal een filter weg of kies een ruimere periode."))
        } else {
            List(selection: $store.selection) {
                if store.sortering == .afstand && store.mijnLocatie != nil {
                    ForEach(store.lijst) { ListingRow(listing: $0).tag($0.id) }
                } else {
                    ForEach(gegroepeerd, id: \.0) { dag, items in
                        Section(dag) {
                            ForEach(items) { ListingRow(listing: $0).tag($0.id) }
                        }
                    }
                }
            }
            .listStyle(.inset)
            .overlay { if store.isLoading && store.listings.isEmpty { ProgressView() } }
        }
    }

    private var gegroepeerd: [(String, [Listing])] {
        var volgorde: [String] = []
        var groepen: [String: [Listing]] = [:]
        for l in store.lijst {
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
                if let a = store.afstandTekst(listing) {
                    Text(a)
                        .font(.system(size: 11, weight: .semibold))
                        .monospacedDigit()
                } else if let t = listing.timeStart {
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
    static let kortFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "nl_NL")
        f.timeZone = TimeZone(identifier: "Europe/Amsterdam")
        f.dateFormat = "EEE d MMM"
        return f
    }()

    private static var cal: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Europe/Amsterdam")!
        return c
    }

    static func tekst(_ d: Date?) -> String {
        guard let d else { return "Datum onbekend" }
        if cal.isDateInToday(d) { return "Vandaag" }
        if cal.isDateInTomorrow(d) { return "Morgen" }
        let s = formatter.string(from: d)
        return s.prefix(1).uppercased() + s.dropFirst()
    }

    static func kort(_ d: Date?) -> String? {
        guard let d else { return nil }
        if cal.isDateInToday(d) { return "vandaag" }
        if cal.isDateInTomorrow(d) { return "morgen" }
        return kortFormatter.string(from: d)
    }
}
