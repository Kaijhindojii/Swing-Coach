import Foundation
import Capacitor
import HealthKit
import WatchConnectivity

/// Bridges the Apple Watch to the web app.
///   JS -> start()        asks for Health access, launches the golf workout on the watch
///   JS -> stop()         ends the workout
///   JS -> getBaseline()  resting heart rate (14-day average) from Apple Health
///   JS -> haptic()       taps the wrist: breatheIn | breatheOut | nudge
///   events: "heartRate" {t, bpm, still}   "status" {workoutActive, reachable}
@objc(WatchHeartPlugin)
public class WatchHeartPlugin: CAPPlugin, CAPBridgedPlugin, WCSessionDelegate {
    public let identifier = "WatchHeartPlugin"
    public let jsName = "WatchHeart"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getBaseline", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "haptic", returnType: CAPPluginReturnPromise),
    ]

    private let store = HKHealthStore()
    private var session: WCSession?
    private var workoutActive = false

    public override func load() {
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        s.delegate = self
        s.activate()
        session = s
    }

    // MARK: JS API

    @objc func start(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.reject("Health data is not available on this device.")
            return
        }
        guard let session = session, session.isPaired, session.isWatchAppInstalled else {
            call.reject("No paired Apple Watch with the SwingCoach watch app installed.")
            return
        }
        let hr = HKQuantityType.quantityType(forIdentifier: .heartRate)!
        let resting = HKQuantityType.quantityType(forIdentifier: .restingHeartRate)!
        let toShare: Set<HKSampleType> = [HKObjectType.workoutType()]
        let toRead: Set<HKObjectType> = [hr, resting]
        store.requestAuthorization(toShare: toShare, read: toRead) { [weak self] ok, error in
            guard let self = self else { return }
            if let error = error { call.reject("Health access failed: \(error.localizedDescription)"); return }
            guard ok else { call.reject("Health access was not granted."); return }
            let config = HKWorkoutConfiguration()
            config.activityType = .golf
            config.locationType = .outdoor
            // Wakes the watch app and hands it the workout configuration.
            self.store.startWatchApp(with: config) { launched, err in
                if let err = err { call.reject("Could not start the watch app: \(err.localizedDescription)"); return }
                self.notifyStatus()
                call.resolve(["launched": launched])
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        send(["cmd": "stop"])
        workoutActive = false
        notifyStatus()
        call.resolve()
    }

    @objc func getBaseline(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable(),
              let type = HKQuantityType.quantityType(forIdentifier: .restingHeartRate) else {
            call.resolve(["restingHR": NSNull()])
            return
        }
        let from = Calendar.current.date(byAdding: .day, value: -14, to: Date())
        let predicate = HKQuery.predicateForSamples(withStart: from, end: Date(), options: [])
        let query = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: predicate, options: .discreteAverage) { _, stats, _ in
            let unit = HKUnit.count().unitDivided(by: .minute())
            if let v = stats?.averageQuantity()?.doubleValue(for: unit) {
                call.resolve(["restingHR": v])
            } else {
                call.resolve(["restingHR": NSNull()])
            }
        }
        store.execute(query)
    }

    @objc func haptic(_ call: CAPPluginCall) {
        send(["cmd": "haptic", "pattern": call.getString("pattern") ?? "nudge"])
        call.resolve()
    }

    // MARK: helpers

    private func send(_ message: [String: Any]) {
        guard let s = session, s.activationState == .activated, s.isReachable else { return }
        s.sendMessage(message, replyHandler: nil, errorHandler: nil)
    }

    private func notifyStatus() {
        notifyListeners("status", data: [
            "workoutActive": workoutActive,
            "reachable": session?.isReachable ?? false,
        ])
    }

    // MARK: WCSessionDelegate

    public func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        notifyStatus()
    }

    public func sessionDidBecomeInactive(_ session: WCSession) {}

    public func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    public func sessionReachabilityDidChange(_ session: WCSession) {
        notifyStatus()
    }

    public func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        switch message["type"] as? String {
        case "hr":
            guard let bpm = message["bpm"] as? Double else { return }
            notifyListeners("heartRate", data: [
                "t": message["t"] as? Double ?? Date().timeIntervalSince1970,
                "bpm": bpm,
                "still": message["still"] as? Bool ?? true,
            ])
        case "status":
            workoutActive = message["workoutActive"] as? Bool ?? false
            notifyStatus()
        default:
            break
        }
    }
}
