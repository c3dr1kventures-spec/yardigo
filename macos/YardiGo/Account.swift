import Foundation
import Security

// Ingelogde sessie bij Supabase Auth (zelfde account als op yardigo.nl).
struct Sessie: Codable, Equatable {
    var accessToken: String
    var refreshToken: String
    var verlooptOp: Date
    var email: String
    var userId: UUID
}

enum InlogFout: LocalizedError {
    case onjuist, nietBevestigd, geenVerbinding, server(String)

    var errorDescription: String? {
        switch self {
        case .onjuist: return "E-mailadres of wachtwoord klopt niet."
        case .nietBevestigd: return "Bevestig eerst je e-mailadres via de link in je mail."
        case .geenVerbinding: return "Geen verbinding. Controleer je internet en probeer het opnieuw."
        case .server(let t): return t
        }
    }
}

// De sessie staat in de Sleutelhanger, niet in gewone voorkeuren.
enum Sleutelhanger {
    private static let dienst = "nl.yardigo.mac.sessie"

    static func lees() -> Sessie? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: dienst,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var uit: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &uit) == errSecSuccess, let data = uit as? Data else { return nil }
        return try? JSONDecoder().decode(Sessie.self, from: data)
    }

    static func bewaar(_ s: Sessie) {
        guard let data = try? JSONEncoder().encode(s) else { return }
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: dienst]
        if SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary) == errSecItemNotFound {
            var nieuw = q
            nieuw[kSecValueData as String] = data
            nieuw[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(nieuw as CFDictionary, nil)
        }
    }

    static func wis() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: dienst] as CFDictionary)
    }
}

// Supabase Auth (GoTrue): inloggen met wachtwoord en tokens verversen.
enum Auth {
    private struct Antwoord: Decodable {
        let accessToken: String
        let refreshToken: String
        let expiresIn: Double
        let user: Gebruiker
        struct Gebruiker: Decodable { let id: UUID; let email: String? }
    }

    static func inloggen(email: String, wachtwoord: String) async throws -> Sessie {
        try await token("password", ["email": email, "password": wachtwoord])
    }

    static func ververs(_ s: Sessie) async throws -> Sessie {
        try await token("refresh_token", ["refresh_token": s.refreshToken])
    }

    static func uitloggen(_ s: Sessie) async {
        var req = URLRequest(url: ListingStore.supabaseURL.appending(path: "auth/v1/logout"))
        req.httpMethod = "POST"
        req.setValue(ListingStore.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(s.accessToken)", forHTTPHeaderField: "Authorization")
        _ = try? await URLSession.shared.data(for: req)
    }

    private static func token(_ soort: String, _ body: [String: String]) async throws -> Sessie {
        var c = URLComponents(url: ListingStore.supabaseURL.appending(path: "auth/v1/token"), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "grant_type", value: soort)]
        var req = URLRequest(url: c.url!)
        req.httpMethod = "POST"
        req.setValue(ListingStore.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        let data: Data, resp: URLResponse
        do { (data, resp) = try await URLSession.shared.data(for: req) } catch { throw InlogFout.geenVerbinding }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            let tekst = String(decoding: data, as: UTF8.self).lowercased()
            if tekst.contains("not confirmed") { throw InlogFout.nietBevestigd }
            if status == 400 || status == 401 { throw InlogFout.onjuist }
            throw InlogFout.server("Inloggen lukt nu niet (fout \(status)). Probeer het zo opnieuw.")
        }
        let dec = JSONDecoder()
        dec.keyDecodingStrategy = .convertFromSnakeCase
        let a = try dec.decode(Antwoord.self, from: data)
        return Sessie(accessToken: a.accessToken, refreshToken: a.refreshToken,
                      verlooptOp: .now.addingTimeInterval(a.expiresIn),
                      email: a.user.email ?? body["email"] ?? "", userId: a.user.id)
    }
}
