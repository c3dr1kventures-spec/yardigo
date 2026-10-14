import Foundation
import CoreLocation
import SwiftUI

// Eén advertentie zoals get_listings_for_user() hem teruggeeft. Het adres is
// voor gasten al server-side weggelaten; particuliere pinnen zijn verschoven.
struct Listing: Identifiable, Decodable, Hashable {
    let id: UUID
    let title: String
    let description: String?
    let category: String?
    let address: String?
    let city: String?
    let latitude: Double?
    let longitude: Double?
    let dateStart: String?
    let dateEnd: String?
    let timeStart: String?
    let timeEnd: String?
    let images: [String]?
    let photoCount: Int?
    let status: String?
    let addressRevealMode: String?
    let eventSubtype: String?
    let placedBy: String?
    let sourceUrl: String?
    let tags: [String]?
    let sourceLabel: String?
    let locationApprox: Bool?
    let shortCode: String?

    var coordinate: CLLocationCoordinate2D? {
        guard let latitude, let longitude else { return nil }
        return CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    var date: Date? { dateStart.flatMap { Self.isoDay.date(from: $0) } }

    var kind: Kind {
        let sub = (eventSubtype ?? "").lowercased()
        if sub == "rommelroute" || (sub == "buurtverkoop" && placedBy == "yardigo") || category == "buurtverkoop" { return .route }
        if ["opritverkoop", "garagesale", "garageverkoop", "tuinverkoop"].contains(sub) { return .oprit }
        if ["garagesale", "garageverkoop", "overig"].contains(category ?? "") && sub.isEmpty { return .oprit }
        return .markt
    }

    // Zelfde indeling als saleSubKey() in index.html.
    var subKey: String {
        let v = (eventSubtype ?? "").lowercased().trimmingCharacters(in: .whitespaces)
        let regels: [(String, String)] = [
            ("kofferbak", "kofferbak"), ("kerst", "kerstmarkt"), ("boek", "boekenmarkt"),
            ("antiek", "antiekmarkt"), ("curiosa", "antiekmarkt"), ("braderie", "braderie"),
            ("kinder", "kinderbeurs"), ("speelgoed", "kinderbeurs"), ("kleding", "kledingmarkt"),
            ("snuffel", "snuffelmarkt"), ("vlooien", "vlooienmarkt"), ("jaarmarkt", "jaarmarkt"),
            ("rommelmarkt", "rommelmarkt"),
        ]
        return regels.first { v.contains($0.0) }?.1 ?? v
    }

    // Categorie voor filters en zoeken: de marktsoort, of "oprit"/"route".
    var categorieKey: String {
        switch kind {
        case .oprit: return "oprit"
        case .route: return "route"
        case .markt: return subKey.isEmpty || subKey == "overig" ? "markt" : subKey
        }
    }

    var subLabel: String {
        switch kind {
        case .oprit: return "Opritverkoop"
        case .route: return "Rommelroute"
        case .markt:
            if let l = Self.subLabels[subKey] { return l }
            return subKey.isEmpty || subKey == "overig" ? "Markt" : subKey.prefix(1).uppercased() + subKey.dropFirst()
        }
    }

    var symbol: String {
        switch kind {
        case .oprit: return "house.fill"
        case .route: return "signpost.right.fill"
        case .markt: return Self.subSymbols[subKey] ?? "storefront.fill"
        }
    }

    var timeRange: String? {
        let van = timeStart.map { String($0.prefix(5)) }
        let tot = timeEnd.map { String($0.prefix(5)) }
        switch (van, tot) {
        case let (v?, t?): return "\(v) – \(t)"
        case let (v?, nil): return "vanaf \(v)"
        default: return nil
        }
    }

    var webURL: URL {
        if let shortCode { return URL(string: "https://yardigo.nl/s/\(shortCode)")! }
        return URL(string: "https://www.yardigo.nl/v/\(id.uuidString.lowercased())")!
    }

    static let isoDay: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Europe/Amsterdam")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static let subLabels: [String: String] = [
        "rommelmarkt": "Rommelmarkt", "vlooienmarkt": "Vlooienmarkt", "snuffelmarkt": "Snuffelmarkt",
        "jaarmarkt": "Jaarmarkt", "kofferbak": "Kofferbakverkoop", "boekenmarkt": "Boekenmarkt",
        "antiekmarkt": "Antiekmarkt", "kerstmarkt": "Kerstmarkt", "braderie": "Braderie",
        "kinderbeurs": "Kinderbeurs", "kledingmarkt": "Kledingmarkt",
    ]
    static let subSymbols: [String: String] = [
        "kofferbak": "car.fill", "boekenmarkt": "book.fill", "antiekmarkt": "lamp.table.fill",
        "kerstmarkt": "tree.fill", "braderie": "flag.fill", "kinderbeurs": "teddybear.fill",
        "kledingmarkt": "tshirt.fill",
    ]
}

enum Kind: String, CaseIterable, Identifiable {
    case markt, route, oprit
    var id: String { rawValue }

    var label: String {
        switch self {
        case .markt: return "Markten"
        case .route: return "Rommelroutes"
        case .oprit: return "Opritverkopen"
        }
    }
    var symbol: String {
        switch self {
        case .markt: return "storefront.fill"
        case .route: return "signpost.right.fill"
        case .oprit: return "house.fill"
        }
    }
    // Op de nachtkaart iets lichter, zodat pinnen niet wegvallen (YG_KIND_COLORS.light).
    func pinColor(dark: Bool) -> Color {
        guard dark else { return color }
        switch self {
        case .markt: return Color(red: 0x5E / 255, green: 0x9E / 255, blue: 0x70 / 255)
        case .route: return Color(red: 0xEC / 255, green: 0x9A / 255, blue: 0x5E / 255)
        case .oprit: return Color(red: 0xF6 / 255, green: 0xBF / 255, blue: 0x5A / 255)
        }
    }

    // Zelfde kleuren als YG_KIND_COLORS op de website.
    var color: Color {
        switch self {
        case .markt: return Color(red: 0x3A / 255, green: 0x6B / 255, blue: 0x4A / 255)
        case .route: return Color(red: 0xE0 / 255, green: 0x7B / 255, blue: 0x39 / 255)
        case .oprit: return Color(red: 0xF2 / 255, green: 0xA8 / 255, blue: 0x30 / 255)
        }
    }
}

// Dag/nacht-keuze van de gebruiker; "systeem" volgt de Mac.
enum Weergave: String, CaseIterable, Identifiable {
    case systeem, dag, nacht
    var id: String { rawValue }
    var label: String {
        switch self {
        case .systeem: return "Zoals de Mac"
        case .dag: return "Dag"
        case .nacht: return "Nacht"
        }
    }
    var symbol: String {
        switch self {
        case .systeem: return "circle.lefthalf.filled"
        case .dag: return "sun.max.fill"
        case .nacht: return "moon.stars.fill"
        }
    }
    var appearance: NSAppearance? {
        switch self {
        case .systeem: return nil
        case .dag: return NSAppearance(named: .aqua)
        case .nacht: return NSAppearance(named: .darkAqua)
        }
    }
}

enum DateFilter: String, CaseIterable, Identifiable {
    case alles, vandaag, weekend, week, maand
    var id: String { rawValue }
    var label: String {
        switch self {
        case .alles: return "Alle data"
        case .vandaag: return "Vandaag"
        case .weekend: return "Dit weekend"
        case .week: return "Komende 7 dagen"
        case .maand: return "Komende 30 dagen"
        }
    }

    func contains(_ d: Date, today: Date, calendar: Calendar) -> Bool {
        switch self {
        case .alles: return true
        case .vandaag: return calendar.isDate(d, inSameDayAs: today)
        case .week: return d < calendar.date(byAdding: .day, value: 7, to: today)!
        case .maand: return d < calendar.date(byAdding: .day, value: 30, to: today)!
        case .weekend:
            // Komend weekend: zaterdag en zondag van deze week (of vandaag als het weekend is).
            let wd = calendar.component(.weekday, from: today) // 1 = zondag, 7 = zaterdag
            let totZaterdag = wd == 1 ? -1 : 7 - wd
            let zaterdag = calendar.date(byAdding: .day, value: totZaterdag, to: today)!
            let maandag = calendar.date(byAdding: .day, value: 2, to: zaterdag)!
            return d >= min(zaterdag, today) && d < maandag
        }
    }
}
