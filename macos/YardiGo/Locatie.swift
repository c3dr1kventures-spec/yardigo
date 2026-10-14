import CoreLocation

// Vraagt eenmalig je locatie op voor "bij mij in de buurt" en sorteren op afstand.
@MainActor
final class Locatie: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var klaar: ((CLLocation?) -> Void)?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    func vraag(_ klaar: @escaping (CLLocation?) -> Void) {
        self.klaar = klaar
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .denied, .restricted: klaar(nil); self.klaar = nil
        default: manager.requestLocation()
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        Task { @MainActor in
            guard self.klaar != nil else { return }
            switch m.authorizationStatus {
            case .authorized, .authorizedAlways: m.requestLocation()
            case .denied, .restricted: self.klaar?(nil); self.klaar = nil
            default: break
            }
        }
    }

    nonisolated func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in self.klaar?(locations.last); self.klaar = nil }
    }

    nonisolated func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.klaar?(nil); self.klaar = nil }
    }
}
