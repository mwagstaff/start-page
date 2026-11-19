import Foundation

struct DownloadDescriptor: Codable {
  var story: String
  var kind: String
  var remote: String?
  // Optional for tasks persisted by older app versions.
  var retryAttempt: Int?
  var key: String { "\(story)|\(kind)|\(remote ?? "")" }
  var failureKey: String { kind == "image" ? "image:\(remote ?? "")" : kind }
}

struct DownloadServerError: Decodable {
  var error: String?
  var retryable: Bool?
}

enum DownloadRetry {
  static let delays: [TimeInterval] = [5, 30, 60]
  static func isTemporaryConnectionError(_ error: NSError) -> Bool {
    error.domain == NSURLErrorDomain && [
      URLError.timedOut, .networkConnectionLost, .notConnectedToInternet,
      .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed,
    ].contains { $0.rawValue == error.code }
  }
  static func delay(
    attempt: Int, status: Int? = nil, error: NSError? = nil,
    retryable: Bool? = nil, retryAfter: String? = nil, now: Date = .now
  ) -> TimeInterval? {
    guard attempt >= 0, attempt < delays.count, retryable != false else { return nil }
    let temporary: Bool
    if let status {
      temporary = [408, 429, 500, 502, 503, 504].contains(status)
    } else if let error {
      temporary = isTemporaryConnectionError(error)
    } else {
      temporary = false
    }
    guard temporary else { return nil }
    var delay = delays[attempt]
    if let retryAfter {
      if let seconds = TimeInterval(retryAfter), seconds.isFinite {
        delay = max(delay, seconds)
      } else {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss z"
        if let date = formatter.date(from: retryAfter) {
          delay = max(delay, date.timeIntervalSince(now))
        }
      }
    }
    return delay
  }
}

struct DownloadActivity {
  var story: String
  var retrying: Bool
}
