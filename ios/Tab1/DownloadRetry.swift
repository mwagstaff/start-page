import Foundation

struct BackgroundRefreshSchedule {
  static let interval: TimeInterval = 15 * 60
  let refreshDate: Date
  let processingDate: Date?

  init?(automatic: Bool, retry: Bool, online: Bool, now: Date = .now) {
    guard automatic || retry else { return nil }
    refreshDate = now.addingTimeInterval(retry ? 60 : Self.interval)
    processingDate = retry && !online ? nil : refreshDate
  }

  // A pending request with no date is already eligible.
  static func shouldAdvance(pending: Date?, to proposed: Date?) -> Bool {
    guard let pending else { return false }
    return proposed.map { $0 < pending } ?? true
  }
}

struct DownloadDescriptor: Codable {
  var story: String
  var kind: String
  var remote: String?
  // Optional for tasks persisted by older app versions.
  var retryAttempt: Int?
  var scope: String?
  var key: String { "\(story)|\(kind)|\(remote ?? "")" }
  var failureKey: String { kind == "image" ? "image:\(remote ?? "")" : kind }
}

struct DownloadServerError: Decodable {
  var error: String?
  var retryable: Bool?
}

enum DownloadRetry {
  static let delays: [TimeInterval] = [5, 30, 60, 15 * 60, 3600, 6 * 3600, 24 * 3600]
  static let temporaryHTTPStatuses = [408, 429, 500, 502, 503, 504]

  // Older libraries recorded only the display message and a per-file cooldown.
  static func legacyRetryDate(message: String?, after: Date?) -> Date? {
    guard let after, after > .now,
          temporaryHTTPStatuses.contains(where: { message == "Download failed (HTTP \($0))." })
    else { return nil }
    return after
  }

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
      temporary = retryable == true || temporaryHTTPStatuses.contains(status)
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
  var isArticle: Bool
  var retrying: Bool
}
