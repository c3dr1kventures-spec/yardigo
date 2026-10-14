import SwiftUI

@main
struct YardiGoApp: App {
    @State private var store = ListingStore()
    @AppStorage("weergave") private var weergave: Weergave = .systeem
    @AppStorage("kaartlaag") private var laag: KaartLaag = .rustig

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(store)
                .frame(minWidth: 980, minHeight: 620)
                .task { await store.load() }
                .onAppear { NSApp.appearance = weergave.appearance }
                .onChange(of: weergave) { _, w in
                    withAnimation(.easeInOut(duration: 0.25)) { NSApp.appearance = w.appearance }
                }
        }
        .defaultSize(width: 1440, height: 900)
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(after: .toolbar) {
                Button("Vernieuwen") { Task { await store.load() } }
                    .keyboardShortcut("r")
                Divider()
                Picker("Weergave", selection: $weergave) {
                    ForEach(Weergave.allCases) { Text($0.label).tag($0) }
                }
                Button("Wissel dag/nacht") { DagNacht.wissel(&weergave) }
                    .keyboardShortcut("d", modifiers: [.command, .shift])
                Divider()
                ForEach(Array(KaartLaag.allCases.enumerated()), id: \.element) { i, l in
                    Button("Kaart: \(l.label)") { laag = l }
                        .keyboardShortcut(KeyEquivalent(Character("\(i + 1)")), modifiers: .command)
                }
            }
        }
    }
}
