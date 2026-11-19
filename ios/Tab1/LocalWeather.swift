import CoreLocation
import Foundation
import JavaScriptCore

@MainActor final class LocalWeather: NSObject, @preconcurrency CLLocationManagerDelegate {
  static let shared = LocalWeather()
  private let manager = CLLocationManager()
  private var requested = false
  override init() {
    super.init()
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyKilometer
  }
  var enabled: Bool { UserDefaults.standard.object(forKey: "weatherLatitude") != nil }
  func request() {
    requested = true
    if manager.authorizationStatus == .notDetermined {
      manager.requestWhenInUseAuthorization()
    } else if manager.authorizationStatus == .denied || manager.authorizationStatus == .restricted {
      LibraryStore.shared.lastError =
        "Allow location access in iPhone Settings to use local weather."
    } else {
      manager.requestLocation()
    }
  }
  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    if requested && [.authorizedAlways, .authorizedWhenInUse].contains(manager.authorizationStatus)
    {
      manager.requestLocation()
    }
  }
  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    requested = false
    LibraryStore.shared.lastError = "Location: " + error.localizedDescription
  }
  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    requested = false
    guard let location = locations.last else { return }
    UserDefaults.standard.set(
      (location.coordinate.latitude * 100).rounded() / 100, forKey: "weatherLatitude")
    UserDefaults.standard.set(
      (location.coordinate.longitude * 100).rounded() / 100, forKey: "weatherLongitude")
    Task { await refresh() }
  }
  func reset() {
    UserDefaults.standard.removeObject(forKey: "weatherLatitude")
    UserDefaults.standard.removeObject(forKey: "weatherLongitude")
    Task { await LibraryStore.shared.refresh(download: false) }
  }
  func refresh() async {
    guard enabled else { return }
    do {
      let forecast = try await Self.fetchForecast()
      try Task.checkCancellation()
      LibraryStore.shared.library.weather = forecast
      LibraryStore.shared.persist()
    } catch is CancellationError { return } catch {
      LibraryStore.shared.lastError = "Weather update unavailable; keeping the saved forecast."
    }
  }

  private nonisolated static func fetchForecast() async throws -> JSONValue {
    guard let file = Bundle.main.url(forResource: "forecast", withExtension: "js"),
      let context = JSContext()
    else { throw CocoaError(.fileReadNoSuchFile) }
    let code = try String(contentsOf: file, encoding: .utf8).replacingOccurrences(
      of: "import { escapeHtml } from './cards.js';", with: ""
    ).replacingOccurrences(of: "export ", with: "")
    context.evaluateScript(
      "class URLSearchParams { constructor(o){this.o=o;} toString(){return Object.entries(this.o).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');} }"
    )
    context.evaluateScript(code)
    let coordinates = [
      "latitude": UserDefaults.standard.double(forKey: "weatherLatitude"),
      "longitude": UserDefaults.standard.double(forKey: "weatherLongitude"),
    ]
    guard
      let address = context.objectForKeyedSubscript("forecastUrl")?.call(withArguments: [
        coordinates
      ])?.toString(), let url = URL(string: address)
    else { throw URLError(.badURL) }
    var request = URLRequest(url: url)
    request.timeoutInterval = 20
    let (data, response) = try await URLSession.shared.data(for: request)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
      throw URLError(.badServerResponse)
    }
    let raw = try JSONSerialization.jsonObject(with: data)
    guard
      let weather = context.objectForKeyedSubscript("parseWeather")?.call(withArguments: [
        raw, "Your location",
      ])?.toDictionary()
    else { throw URLError(.cannotParseResponse) }
    return try JSONDecoder().decode(
      JSONValue.self, from: JSONSerialization.data(withJSONObject: weather))
  }
}
