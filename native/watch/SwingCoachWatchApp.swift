import SwiftUI
import HealthKit
import WatchKit

@main
struct SwingCoachWatchApp: App {
    @WKApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var workout = WorkoutManager.shared

    var body: some Scene {
        WindowGroup { ContentView().environmentObject(workout) }
    }
}

/// The iPhone launches us with a workout configuration (HKHealthStore.startWatchApp).
final class AppDelegate: NSObject, WKApplicationDelegate {
    func applicationDidFinishLaunching() {
        Connectivity.shared.activate()
    }

    func handle(_ workoutConfiguration: HKWorkoutConfiguration) {
        WorkoutManager.shared.start(workoutConfiguration)
    }
}
