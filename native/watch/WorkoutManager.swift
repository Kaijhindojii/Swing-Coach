import Foundation
import HealthKit
import CoreMotion
import WatchKit

/// Runs a golf workout so the watch samples heart rate every few seconds and keeps the app alive,
/// then forwards each reading to the iPhone together with a "still / moving" flag from the motion sensors.
final class WorkoutManager: NSObject, ObservableObject {
    static let shared = WorkoutManager()

    @Published var running = false
    @Published var bpm: Double = 0
    @Published var still = true

    private let store = HKHealthStore()
    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    private let motion = CMMotionManager()
    private var recentMotion: [(t: TimeInterval, mag: Double)] = []

    func start(_ configuration: HKWorkoutConfiguration? = nil) {
        guard !running else { return }
        let config: HKWorkoutConfiguration
        if let configuration = configuration { config = configuration } else {
            config = HKWorkoutConfiguration()
            config.activityType = .golf
            config.locationType = .outdoor
        }
        let hr = HKQuantityType.quantityType(forIdentifier: .heartRate)!
        store.requestAuthorization(toShare: [HKObjectType.workoutType()], read: [hr]) { [weak self] ok, _ in
            guard ok else { return }
            DispatchQueue.main.async { self?.begin(config) }
        }
    }

    private func begin(_ config: HKWorkoutConfiguration) {
        do {
            let s = try HKWorkoutSession(healthStore: store, configuration: config)
            let b = s.associatedWorkoutBuilder()
            b.dataSource = HKLiveWorkoutDataSource(healthStore: store, workoutConfiguration: config)
            s.delegate = self
            b.delegate = self
            session = s
            builder = b
            let now = Date()
            s.startActivity(with: now)
            b.beginCollection(withStart: now) { _, _ in }
            startMotion()
            running = true
            Connectivity.shared.send(["type": "status", "workoutActive": true])
        } catch {
            running = false
        }
    }

    func stop() {
        session?.end()
    }

    private func finish() {
        motion.stopDeviceMotionUpdates()
        let end = Date()
        builder?.endCollection(withEnd: end) { [weak self] _, _ in
            self?.builder?.finishWorkout { _, _ in }
        }
        DispatchQueue.main.async {
            self.running = false
            self.bpm = 0
        }
        Connectivity.shared.send(["type": "status", "workoutActive": false])
    }

    // MARK: motion -> still / moving

    private func startMotion() {
        guard motion.isDeviceMotionAvailable else { return }
        recentMotion.removeAll()
        motion.deviceMotionUpdateInterval = 0.1
        motion.startDeviceMotionUpdates(to: .main) { [weak self] data, _ in
            guard let self = self, let a = data?.userAcceleration else { return }
            let now = Date().timeIntervalSince1970
            self.recentMotion.append((now, sqrt(a.x * a.x + a.y * a.y + a.z * a.z)))
            self.recentMotion.removeAll { now - $0.t > 4 }
        }
    }

    /// Walking shakes the wrist (mean user acceleration well above 0.1 g); standing at the ball does not.
    private func isStill() -> Bool {
        guard recentMotion.count >= 10 else { return true }
        let mean = recentMotion.reduce(0) { $0 + $1.mag } / Double(recentMotion.count)
        return mean < 0.06
    }

    // MARK: haptics from the phone

    func playHaptic(_ pattern: String) {
        let d = WKInterfaceDevice.current()
        switch pattern {
        case "breatheIn": d.play(.directionUp)
        case "breatheOut": d.play(.directionDown)
        default: d.play(.notification)
        }
    }
}

extension WorkoutManager: HKWorkoutSessionDelegate {
    func workoutSession(_ workoutSession: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState,
                        from fromState: HKWorkoutSessionState, date: Date) {
        if toState == .ended { finish() }
    }
    func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        finish()
    }
}

extension WorkoutManager: HKLiveWorkoutBuilderDelegate {
    func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}

    func workoutBuilder(_ workoutBuilder: HKLiveWorkoutBuilder, didCollectDataOf collectedTypes: Set<HKSampleType>) {
        guard let type = HKQuantityType.quantityType(forIdentifier: .heartRate), collectedTypes.contains(type),
              let stats = workoutBuilder.statistics(for: type),
              let q = stats.mostRecentQuantity() else { return }
        let value = q.doubleValue(for: HKUnit.count().unitDivided(by: .minute()))
        let still = isStill()
        DispatchQueue.main.async { self.bpm = value; self.still = still }
        Connectivity.shared.send([
            "type": "hr", "bpm": value, "t": Date().timeIntervalSince1970, "still": still,
        ])
    }
}
