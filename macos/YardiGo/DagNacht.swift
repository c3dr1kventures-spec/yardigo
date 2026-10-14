import SwiftUI

enum DagNacht {
    // Wisselt tussen dag en nacht. Staat hij op "zoals de Mac", dan naar het
    // tegenovergestelde van wat je nu ziet.
    static func wissel(_ w: inout Weergave) {
        switch w {
        case .dag: w = .nacht
        case .nacht: w = .dag
        case .systeem:
            let nuDonker = NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            w = nuDonker ? .dag : .nacht
        }
    }
}

// Zon/maan-knop in de werkbalk: klik wisselt, de pijl geeft alle drie de keuzes.
struct DagNachtKnop: View {
    @AppStorage("weergave") private var weergave: Weergave = .systeem
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Menu {
            Picker("Weergave", selection: $weergave) {
                ForEach(Weergave.allCases) { w in
                    Label(w.label, systemImage: w.symbol).tag(w)
                }
            }
            .pickerStyle(.inline)
        } label: {
            Label("Dag/nacht", systemImage: scheme == .dark ? "moon.stars.fill" : "sun.max.fill")
                .contentTransition(.symbolEffect(.replace))
        } primaryAction: {
            DagNacht.wissel(&weergave)
        }
        .help("Wissel dag/nacht (⇧⌘D)")
    }
}
