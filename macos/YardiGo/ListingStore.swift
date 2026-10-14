import Foundation
import Observation

// Haalt de kaart op via dezelfde RPC als yardigo.nl (als gast: geen adressen,
// verschoven pinnen bij particulieren) en houdt filters en favorieten bij.
@MainActor
@Observable
final class ListingStore {
    static let supabaseURL = URL(string: "https://fwehqudhwzcnkcuypuqw.supabase.co")!
    // Publieke anon-sleutel, dezelfde als in index.html.
    static let anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3ZWhxdWRod3pjbmtjdXlwdXF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzOTQwNzgsImV4cCI6MjA4OTk3MDA3OH0.A5mPApoGySr97niz6QLZGFSDhsfCqOwi-k8v58mHjMI"

    var listings: [Listing] = []
    var isLoading = false
    var errorMessage: String?

    var kinds: Set<Kind> = Set(Kind.allCases)
    var dateFilter: DateFilter = .alles
    var search = ""
    var onlyFavorites = false
    var selection: Listing.ID?

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
        return dir.appending(path: "listings.json")
    }

    init() {
        let opgeslagen = UserDefaults.standard.stringArray(forKey: "favorites") ?? []
        favorites = Set(opgeslagen.compactMap(UUID.init))
        if let data = try? Data(contentsOf: Self.cacheURL), let l = try? Self.decode(data) { listings = l }
    }

    private static func decode(_ data: Data) throws -> [Listing] {
        let dec = JSONDecoder()
        dec.keyDecodingStrategy = .convertFromSnakeCase
        return try dec.decode([Listing].self, from: data)
    }

    var selected: Listing? { listings.first { $0.id == selection } }

    // Toekomstige, actieve advertenties met coördinaten.
    var upcoming: [Listing] {
        let today = calendar.startOfDay(for: .now)
        return listings.filter { l in
            guard l.coordinate != nil, l.status == nil || l.status == "active", let d = l.date else { return false }
            return d >= today
        }
    }

    var filtered: [Listing] {
        let today = calendar.startOfDay(for: .now)
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        return upcoming
            .filter { kinds.contains($0.kind) }
            .filter { dateFilter.contains($0.date!, today: today, calendar: calendar) }
            .filter { !onlyFavorites || favorites.contains($0.id) }
            .filter { q.isEmpty || $0.title.lowercased().contains(q) || ($0.city ?? "").lowercased().contains(q) || $0.subLabel.lowercased().contains(q) }
            .sorted { ($0.dateStart ?? "", $0.timeStart ?? "", $0.title) < ($1.dateStart ?? "", $1.timeStart ?? "", $1.title) }
    }

    func count(_ kind: Kind) -> Int { upcoming.filter { $0.kind == kind }.count }

    func toggleFavorite(_ id: UUID) {
        if favorites.contains(id) { favorites.remove(id) } else { favorites.insert(id) }
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        var req = URLRequest(url: Self.supabaseURL.appending(path: "rest/v1/rpc/get_listings_for_user"))
        req.httpMethod = "POST"
        req.setValue(Self.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(Self.anonKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{}".utf8)
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
                errorMessage = "De server gaf geen geldige reactie. Probeer het zo opnieuw (⌘R)."
                return
            }
            listings = try Self.decode(data)
            errorMessage = nil
            try? data.write(to: Self.cacheURL, options: .atomic)
        } catch {
            errorMessage = "Kon de verkopen niet laden. Controleer je internetverbinding en druk op ⌘R."
        }
    }
}
