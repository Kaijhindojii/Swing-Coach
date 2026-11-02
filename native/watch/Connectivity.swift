import Foundation
import WatchConnectivity

/// Watch side of the phone link: sends heart-rate readings, receives stop / haptic commands.
final class Connectivity: NSObject, WCSessionDelegate {
    static let shared = Connectivity()

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func send(_ message: [String: Any]) {
        let s = WCSession.default
        guard s.activationState == .activated, s.isReachable else { return }
        s.sendMessage(message, replyHandler: nil, errorHandler: nil)
    }

    func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {}

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        switch message["cmd"] as? String {
        case "stop":
            DispatchQueue.main.async { WorkoutManager.shared.stop() }
        case "haptic":
            let pattern = message["pattern"] as? String ?? "nudge"
            DispatchQueue.main.async { WorkoutManager.shared.playHaptic(pattern) }
        default:
            break
        }
    }
}
