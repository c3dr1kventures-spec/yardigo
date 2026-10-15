import Foundation
import Observation
import MapKit

// Zoekfilter als "token" in het zoekveld: een plaats of een categorie.
enum ZoekToken: Identifiable, Hashable {
    case plaats(String)
    case categorie(String)   // subKey, of "oprit"/"route" voor die soorten

    var id: String {
        switch self {
        case .plaats(let p): return "p:" + p
        case .categorie(let c): return "c:" + c
        }
    }
}

enum Sortering: String, CaseIterable, Identifiable {
    case datum, afstand
    var id: String { rawValue }
    var label: String { self == .datum ? "Op datum" : "Op afstand" }
}

// Haalt de kaart op via get_listings_map (slanke versie, zelfde privacyregels
// als yardigo.nl) en houdt filters, zoeken, favorieten en details bij.
@MainActor
@Observable
final class ListingStore {
    nonisolated static let supabaseURL = URL(string: "https://fwehqudhwzcnkcuypuqw.supabase.co")!
    // Publieke anon-sleutel, dezelfde als in index.html.
    nonisolated static let anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3ZWhxdWRod3pjbmtjdXlwdXF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzOTQwNzgsImV4cCI6MjA4OTk3MDA3OH0.A5mPApoGySr97niz6QLZGFSDhsfCqOwi-k8v58mHjMI"

    // Ingelogd (zelfde account als yardigo.nl): dan ook adressen en details.
    private(set) var sessie: Sessie? = Sleutelhanger.lees()
    var ingelogd: Bool { sessie != nil }

    var listings: [Listing] = []
    var details: [UUID: Listing] = [:]
    var isLoading = false
    var errorMessage: String?

    var kinds: Set<Kind> = Set(Kind.allCases)
    var categorieen: Set<String> = []          // leeg = alle markt-categorieën
    var dateFilter: DateFilter = .alles
    var search = ""
    var tokens: [ZoekToken] = []
    var onlyFavorites = false
    var alleenKaartgebied = false
    var sortering: Sortering = .datum
    var selection: Listing.ID?

    // Kaart: zichtbaar gebied (voor "alleen dit kaartgebied") en vliegopdrachten.
    var zichtbaarGebied: MKMapRect?
    var vliegNaar: MKMapRect?
    var mijnLocatie: CLLocation?
    var melding: String?

    func toon(_ tekst: String) {
        melding = tekst
        Task { try? await Task.sleep(for: .seconds(4)); if melding == tekst { melding = nil } }
    }

    var favorites: Set<UUID> = [] {
        didSet { UserDefaults.standard.set(favorites.map(\.uuidString), forKey: "favorites") }
    }

    private let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Europe/Amsterdam")!
        return c
    }()

    // Kopie van de laatst opgehaalde verkopen: de app start daarmee meteen en
    // ververst op de achtergrond.
    private static var cacheURL: URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return dir.appending(path: "listings-map.json")
    }

    init() {
        let opgeslagen = UserDefaults.standard.stringArray(forKey: "favorites") ?? []
        favorites = Set(opgeslagen.compactMap(UUID.init))
        if let data = try? Data(contentsOf: Self.cacheURL), let l = try? Self.decode([Listing].self, data) { listings = l }
    }

    private static func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        let dec = JSONDecoder()
        dec.keyDecodingStrategy = .convertFromSnakeCase
        return try dec.decode(type, from: data)
    }

    var selected: Listing? {
        guard let id = selection else { return nil }
        return details[id] ?? listings.first { $0.id == id }
    }

    // Toekomstige, actieve advertenties met coördinaten.
    var upcoming: [Listing] {
        let today = calendar.startOfDay(for: .now)
        return listings.filter { l in
            guard l.coordinate != nil, l.status == nil || l.status == "active", let d = l.date else { return false }
            let eind = l.dateEnd.flatMap { Listing.isoDay.date(from: $0) } ?? d
            return eind >= today
        }
    }

    // Alles wat op de kaart staat (filters, zoeken, tokens).
    var filtered: [Listing] {
        let today = calendar.startOfDay(for: .now)
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        let plaatsen = Set(tokens.compactMap { if case .plaats(let p) = $0 { return p.lowercased() } else { return nil } })
        let tokenCats = Set(tokens.compactMap { if case .categorie(let c) = $0 { return c } else { return nil } })
        return upcoming.filter { l in
            guard kinds.contains(l.kind) else { return false }
            if l.kind == .markt, !categorieen.isEmpty, !categorieen.contains(l.categorieKey) { return false }
            if !tokenCats.isEmpty, !tokenCats.contains(l.categorieKey) { return false }
            if !plaatsen.isEmpty, !plaatsen.contains((l.city ?? "").lowercased()) { return false }
            if !dateFilter.contains(l.date!, today: today, calendar: calendar) { return false }
            if onlyFavorites, !favorites.contains(l.id) { return false }
            if !q.isEmpty {
                let hooi = [l.title, l.city ?? "", l.subLabel, (l.tags ?? []).joined(separator: " ")].joined(separator: " ").lowercased()
                if !q.split(separator: " ").allSatisfy({ hooi.contains($0) }) { return false }
            }
            return true
        }
    }

    // De lijst: wat op de kaart staat, eventueel alleen in het zichtbare gebied.
    var lijst: [Listing] {
        var l = filtered
        if alleenKaartgebied, let rect = zichtbaarGebied {
            l = l.filter { rect.contains(MKMapPoint($0.coordinate!)) }
        }
        if sortering == .afstand, let loc = mijnLocatie {
            return l.sorted { afstand($0, loc) < afstand($1, loc) }
        }
        return l.sorted { ($0.dateStart ?? "", $0.timeStart ?? "", $0.title) < ($1.dateStart ?? "", $1.timeStart ?? "", $1.title) }
    }

    func afstand(_ l: Listing, _ loc: CLLocation) -> CLLocationDistance {
        guard let c = l.coordinate else { return .greatestFiniteMagnitude }
        return loc.distance(from: CLLocation(latitude: c.latitude, longitude: c.longitude))
    }

    func afstandTekst(_ l: Listing) -> String? {
        guard let loc = mijnLocatie else { return nil }
        let m = afstand(l, loc)
        return m < 1000 ? "\(Int(m / 100) * 100) m" : m < 10_000 ? String(format: "%.1f km", m / 1000) : "\(Int(m / 1000)) km"
    }

    func count(_ kind: Kind) -> Int { upcoming.filter { $0.kind == kind }.count }

    // Markt-categorieën met aantallen, meest voorkomend eerst.
    var categorieTelling: [(key: String, label: String, symbol: String, aantal: Int)] {
        let markten = upcoming.filter { $0.kind == .markt }
        let groepen = Dictionary(grouping: markten, by: \.categorieKey)
        return groepen.map { k, v in (k, v[0].subLabel, v[0].symbol, v.count) }.sorted { $0.aantal > $1.aantal }
    }

    // Suggesties terwijl je typt: plaatsen en categorieën.
    var voorgesteldeTokens: [ZoekToken] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard q.count >= 2 else { return [] }
        var cats: [ZoekToken] = []
        var gezien = Set<String>()
        for l in upcoming where !gezien.contains(l.categorieKey) {
            gezien.insert(l.categorieKey)
            if l.subLabel.lowercased().contains(q) { cats.append(.categorie(l.categorieKey)) }
        }
        let steden = Dictionary(grouping: upcoming.compactMap(\.city), by: { $0 })
            .filter { $0.key.lowercased().hasPrefix(q) }
            .sorted { $0.value.count > $1.value.count }
            .prefix(6)
            .map { ZoekToken.plaats($0.key) }
        return Array(cats.prefix(4)) + steden
    }

    func tokenLabel(_ t: ZoekToken) -> (String, String) {
        switch t {
        case .plaats(let p):
            let n = upcoming.filter { $0.city == p }.count
            return ("\(p) (\(n))", "mappin.and.ellipse")
        case .categorie(let c):
            let l = upcoming.first { $0.categorieKey == c }
            return (l?.subLabel ?? c.capitalized, l?.symbol ?? "tag.fill")
        }
    }

    // Bij een plaats-token vliegt de kaart naar die plaats.
    func tokensVeranderd() {
        guard case .plaats(let p)? = tokens.last else { return }
        let punten = upcoming.filter { $0.city == p }.compactMap(\.coordinate).map(MKMapPoint.init)
        guard !punten.isEmpty else { return }
        var rect = punten.reduce(MKMapRect.null) { $0.union(MKMapRect(origin: $1, size: MKMapSize(width: 1, height: 1))) }
        let minimaal = 6000 * MKMapPointsPerMeterAtLatitude(52)
        if rect.width < minimaal { rect = rect.insetBy(dx: -(minimaal - rect.width) / 2, dy: -(minimaal - rect.height) / 2) }
        vliegNaar = rect
    }

    func toggleFavorite(_ id: UUID) {
        if favorites.contains(id) { favorites.remove(id) } else { favorites.insert(id) }
    }

    // MARK: - Account

    func inloggen(email: String, wachtwoord: String) async throws {
        let s = try await Auth.inloggen(email: email.trimmingCharacters(in: .whitespaces), wachtwoord: wachtwoord)
        sessie = s
        Sleutelhanger.bewaar(s)
        details = [:]
        await load()
        toon("Ingelogd als \(s.email)")
    }

    func uitloggen() async {
        if let s = sessie { await Auth.uitloggen(s) }
        sessie = nil
        Sleutelhanger.wis()
        details = [:]
        try? FileManager.default.removeItem(at: Self.cacheURL)   // geen adressen achterlaten
        await load()
        toon("Uitgelogd")
    }

    // Geldig toegangstoken: ververst vlak voor het verloopt; anoniem als je
    // niet (meer) ingelogd bent.
    private var verversen: Task<Sessie?, Never>?
    private func toegangstoken() async -> String {
        guard var s = sessie else { return Self.anonKey }
        if s.verlooptOp.timeIntervalSinceNow < 120 {
            if verversen == nil {
                let oud = s
                verversen = Task { try? await Auth.ververs(oud) }
            }
            let nieuw = await verversen?.value
            verversen = nil
            guard sessie != nil else { return Self.anonKey }   // intussen uitgelogd
            if let nieuw {
                s = nieuw
                sessie = nieuw
                Sleutelhanger.bewaar(nieuw)
            } else if s.verlooptOp < .now {
                // Verversen mislukt en token verlopen: netjes als gast verder.
                sessie = nil
                Sleutelhanger.wis()
                toon("Je sessie is verlopen. Log opnieuw in om adressen te zien.")
                return Self.anonKey
            }
        }
        return s.accessToken
    }

    private func rpc(_ naam: String, body: [String: Any] = [:]) async -> URLRequest {
        var req = URLRequest(url: Self.supabaseURL.appending(path: "rest/v1/rpc/\(naam)"))
        req.httpMethod = "POST"
        req.setValue(Self.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(await toegangstoken())", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        return req
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let (data, resp) = try await URLSession.shared.data(for: await rpc("get_listings_map"))
            if (resp as? HTTPURLResponse)?.statusCode == 401, sessie != nil {
                // Token ingetrokken (bijv. elders uitgelogd): als gast verder.
                sessie = nil
                Sleutelhanger.wis()
                toon("Je bent uitgelogd. Log opnieuw in om adressen te zien.")
                return await load()
            }
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
                errorMessage = "De server gaf geen geldige reactie. Probeer het zo opnieuw (⌘R)."
                return
            }
            listings = try Self.decode([Listing].self, data)
            details = [:]
            errorMessage = nil
            try? data.write(to: Self.cacheURL, options: .atomic)
        } catch {
            errorMessage = "Kon de verkopen niet laden. Controleer je internetverbinding en druk op ⌘R."
        }
    }

    // Beschrijving, alle foto's en bron pas ophalen als je een verkoop opent.
    func laadDetail(_ id: UUID) async {
        guard details[id] == nil else { return }
        guard let (data, resp) = try? await URLSession.shared.data(for: await rpc("get_listing_detail", body: ["p_id": id.uuidString.lowercased()])),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let l = try? Self.decode(Listing.self, data) else { return }
        details[id] = l
    }
}
