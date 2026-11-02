import UIKit
import Capacitor

/// Registers the local WatchHeart plugin. Set this as the custom class of the view controller in
/// Main.storyboard (Module: App).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(WatchHeartPlugin())
    }
}
