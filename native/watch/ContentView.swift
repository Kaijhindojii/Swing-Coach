import SwiftUI

struct ContentView: View {
    @EnvironmentObject var workout: WorkoutManager

    var body: some View {
        VStack(spacing: 8) {
            if workout.running {
                Text(workout.bpm > 0 ? "\(Int(workout.bpm.rounded()))" : "--")
                    .font(.system(size: 54, weight: .bold, design: .rounded))
                Text("bpm").font(.footnote).foregroundStyle(.secondary)
                Text(workout.still ? "Standing still" : "Moving")
                    .font(.caption).foregroundStyle(workout.still ? .green : .orange)
                Button("End round", role: .destructive) { workout.stop() }
            } else {
                Text("SwingCoach").font(.headline)
                Text("Tap Connect in the Nerves tab on your iPhone, or start here.")
                    .font(.footnote).multilineTextAlignment(.center)
                Button("Start") { workout.start() }
            }
        }
        .padding()
    }
}
