import SwiftUI

// Werkbalk: inloggen, of je account-menu als je al ingelogd bent.
struct AccountKnop: View {
    @Environment(ListingStore.self) private var store
    @Environment(\.openURL) private var openURL
    @State private var inloggen = false

    var body: some View {
        if let s = store.sessie {
            Menu {
                Text(s.email)
                Divider()
                Button("Mijn verkopen op yardigo.nl") { openURL(URL(string: "https://www.yardigo.nl")!) }
                Button("Uitloggen") { Task { await store.uitloggen() } }
            } label: {
                Label(s.email, systemImage: "person.crop.circle.fill")
            }
            .help("Ingelogd als \(s.email)")
        } else {
            Button { inloggen = true } label: {
                Label("Inloggen", systemImage: "person.crop.circle")
            }
            .help("Inloggen met je YardiGo-account: dan zie je ook adressen")
            .sheet(isPresented: $inloggen) { InlogScherm() }
        }
    }
}

struct InlogScherm: View {
    @Environment(ListingStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var email = ""
    @State private var wachtwoord = ""
    @State private var bezig = false
    @State private var fout: String?
    @FocusState private var veld: Veld?
    private enum Veld { case email, wachtwoord }

    var body: some View {
        VStack(spacing: 18) {
            VStack(spacing: 6) {
                Image(nsImage: NSApp.applicationIconImage)
                    .resizable()
                    .frame(width: 64, height: 64)
                Text("Inloggen bij YardiGo")
                    .font(.system(size: 17, weight: .semibold))
                Text("Met je account van yardigo.nl. Ingelogd zie je adressen van verkopen.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(spacing: 10) {
                TextField("E-mailadres", text: $email)
                    .textContentType(.username)
                    .focused($veld, equals: .email)
                    .onSubmit { veld = .wachtwoord }
                SecureField("Wachtwoord", text: $wachtwoord)
                    .textContentType(.password)
                    .focused($veld, equals: .wachtwoord)
                    .onSubmit(inloggen)
            }
            .textFieldStyle(.roundedBorder)
            .controlSize(.large)
            .disabled(bezig)

            if let fout {
                Label(fout, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(.opacity)
            }

            HStack {
                Button("Annuleren", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                if bezig { ProgressView().controlSize(.small) }
                Button("Inloggen", action: inloggen)
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(email.isEmpty || wachtwoord.isEmpty || bezig)
            }

            Divider()
            HStack {
                Button("Wachtwoord vergeten?") { openURL(URL(string: "https://www.yardigo.nl")!) }
                Spacer()
                Button("Account maken") { openURL(URL(string: "https://www.yardigo.nl")!) }
            }
            .buttonStyle(.link)
            .font(.system(size: 12))
        }
        .padding(24)
        .frame(width: 360)
        .animation(.snappy, value: fout)
        .onAppear { veld = .email }
    }

    private func inloggen() {
        guard !email.isEmpty, !wachtwoord.isEmpty, !bezig else { return }
        bezig = true
        fout = nil
        Task {
            do {
                try await store.inloggen(email: email, wachtwoord: wachtwoord)
                dismiss()
            } catch {
                fout = error.localizedDescription
                wachtwoord = ""
                veld = .wachtwoord
            }
            bezig = false
        }
    }
}
