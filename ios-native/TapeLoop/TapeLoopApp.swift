import SwiftUI

@main
struct TapeLoopApp: App {
    @StateObject private var recorder = AudioRecorderManager()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(recorder)
                .preferredColorScheme(.dark)
        }
    }
}
