import SwiftUI

@main
struct YardiGoApp: App {
    @State private var store = ListingStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(store)
                .frame(minWidth: 980, minHeight: 620)
                .task { await store.load() }
        }
        .defaultSize(width: 1440, height: 900)
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(after: .toolbar) {
                Button("Vernieuwen") { Task { await store.load() } }
                    .keyboardShortcut("r")
            }
        }
    }
}
