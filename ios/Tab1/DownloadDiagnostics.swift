import UIKit

/// A bounded, local flight recorder. Keep each hour separately so morning activity
/// cannot displace the preceding night's evidence. All callers supply metadata only.
@MainActor final class DownloadDiagnostics {
  static let shared = DownloadDiagnostics()
  private let defaults = UserDefaults.standard
  private let prefix = "tab1.downloadDiagnostics.v1."
  private var hour = -1
  private var lines: [String] = []
  private var omitted = 0
  private var totals: [String: Int] = [:]
  private var pending: Task<Void, Never>?

  private func selectHour() {
    let current = Int(Date.now.timeIntervalSince1970 / 3600)
    guard current != hour else { return }
    if hour >= 0 { flush() }
    hour = current
    let key = prefix + String(hour)
    let saved = defaults.dictionary(forKey: key)
    omitted = saved?["omitted"] as? Int ?? 0
    lines = saved?["events"] as? [String] ?? []
    totals = saved?["transfers"] as? [String: Int] ?? [:]
    for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(prefix) {
      if let stored = Int(key.dropFirst(prefix.count)), stored < hour - 47 {
        defaults.removeObject(forKey: key)
      }
    }
  }

  private var state: String {
    switch UIApplication.shared.applicationState {
    case .active: return "active"
    case .background: return "background"
    default: return "inactive"
    }
  }

  func event(_ message: String) {
    selectHour()
    if lines.count >= 100 {
      lines.remove(at: 20)
      omitted += 1
    }
    lines.append("\(Date.now.ISO8601Format()) [\(state)] \(message)")
    flush()
  }

  private var lastActivation: Date?

  func activated() {
    lastActivation = .now
    conditions("Entered foreground")
  }

  func networkTiming(kind: String, attempt: Int, start: Date?, end: Date?, callback: Date) {
    let timing: String
    if let start, let end, let activation = lastActivation, activation <= callback, state == "active" {
      if end < activation { timing = "finished before activation" }
      else if start < activation { timing = "spanned activation" }
      else { timing = "started after activation" }
    } else {
      timing = end == nil ? "response end unavailable" : "recorded"
    }
    let outcome = "attempt \(attempt) network timing: \(timing)"
    selectHour()
    if totals["\(state) · \(kind) · \(outcome)"] == nil {
      event("\(kind) attempt \(attempt) timing sample: request=\(start?.ISO8601Format() ?? "unknown"), last byte=\(end?.ISO8601Format() ?? "unknown"), metrics callback=\(callback.ISO8601Format())")
    }
    transfer(kind, outcome)
  }

  func conditions(_ message: String) {
    let availability: String
    switch UIApplication.shared.backgroundRefreshStatus {
    case .available: availability = "available"
    case .denied: availability = "denied"
    default: availability = "restricted or unknown"
    }
    event("\(message). Background App Refresh=\(availability), low power=\(ProcessInfo.processInfo.isLowPowerModeEnabled)")
  }

  func transfer(_ kind: String, _ outcome: String) {
    selectHour()
    let key = "\(state) · \(kind) · \(outcome)"
    totals[key, default: 0] += 1
    if totals[key] == 1 { flush() }
    else if pending == nil {
      pending = Task {
        do { try await Task.sleep(for: .seconds(15)) } catch { return }
        flush()
      }
    }
  }

  func flush() {
    pending?.cancel()
    pending = nil
    guard hour >= 0 else { return }
    defaults.set(["events": lines, "transfers": totals, "omitted": omitted], forKey: prefix + String(hour))
  }

  func report() -> String {
    selectHour()
    flush()
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
    var result = ["tab1 \(version) (\(build)) · iOS \(UIDevice.current.systemVersion)",
                  "Background downloads · UTC · last 48 hourly periods"]
    for bucket in (hour - 47)...hour {
      guard let data = defaults.dictionary(forKey: prefix + String(bucket)) else { continue }
      result.append("\n" + Date(timeIntervalSince1970: Double(bucket) * 3600).ISO8601Format())
      var events = data["events"] as? [String] ?? []
      if let omitted = data["omitted"] as? Int, omitted > 0, events.count >= 20 {
        events.insert("… \(omitted) intermediate events omitted …", at: 20)
      }
      result += events
      let counts = data["transfers"] as? [String: Int] ?? [:]
      result += counts.keys.sorted().map { "\($0): \(counts[$0] ?? 0)" }
    }
    return result.joined(separator: "\n")
  }
}
