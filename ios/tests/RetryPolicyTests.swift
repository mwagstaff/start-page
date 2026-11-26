import Foundation

@main struct RetryPolicyTests {
  static func main() throws {
    let now = Date(timeIntervalSince1970: 1000)
    let routine = BackgroundRefreshSchedule(automatic: true, retry: false, online: true, now: now)!
    let recovery = BackgroundRefreshSchedule(automatic: false, retry: true, online: false, now: now)!
    precondition(routine.refreshDate == now.addingTimeInterval(900) && routine.processingDate == routine.refreshDate)
    precondition(recovery.refreshDate == now.addingTimeInterval(60) && recovery.processingDate == nil)
    precondition(BackgroundRefreshSchedule(automatic: false, retry: false, online: true) == nil)
    let later = now.addingTimeInterval(1200)
    precondition(!BackgroundRefreshSchedule.shouldAdvance(pending: routine.refreshDate, to: later))
    precondition(!BackgroundRefreshSchedule.shouldAdvance(pending: routine.refreshDate, to: routine.refreshDate))
    precondition(BackgroundRefreshSchedule.shouldAdvance(pending: routine.refreshDate, to: recovery.refreshDate))
    precondition(BackgroundRefreshSchedule.shouldAdvance(pending: routine.processingDate, to: recovery.processingDate))
    precondition(!BackgroundRefreshSchedule.shouldAdvance(pending: nil, to: recovery.refreshDate))
    precondition(DownloadRetry.delays.prefix(3) == [5, 30, 60])
    precondition(DownloadRetry.delay(attempt: 3, status: 502) == 900)
    let cooldown = Date.now.addingTimeInterval(3600)
    precondition(DownloadRetry.legacyRetryDate(message: "Download failed (HTTP 502).", after: cooldown) == cooldown)
    precondition(DownloadRetry.legacyRetryDate(message: "Download failed (HTTP 404).", after: cooldown) == nil)
    for status in [408, 429, 500, 502, 503, 504] {
      for (attempt, expected) in DownloadRetry.delays.enumerated() {
        precondition(DownloadRetry.delay(attempt: attempt, status: status) == expected)
      }
      precondition(DownloadRetry.delay(attempt: DownloadRetry.delays.count, status: status) == nil)
      precondition(DownloadRetry.delay(attempt: 0, status: status, retryable: false) == nil)
    }
    for status in [200, 400, 401, 403, 404, 410, 422, 507] {
      precondition(DownloadRetry.delay(attempt: 0, status: status) == nil)
    }
    precondition(
      DownloadRetry.delay(attempt: 0, error: URLError(.networkConnectionLost) as NSError) == 5)
    precondition(DownloadRetry.delay(attempt: 0, error: URLError(.cancelled) as NSError) == nil)
    precondition(
      DownloadRetry.delay(attempt: 0, error: URLError(.serverCertificateUntrusted) as NSError)
        == nil)
    precondition(DownloadRetry.delay(attempt: 0, status: 429, retryAfter: "240") == 240)
    precondition(
      DownloadRetry.delay(
        attempt: 0, status: 503, retryAfter: "Thu, 01 Jan 1970 00:02:00 GMT",
        now: Date(timeIntervalSince1970: 0)) == 120)
    precondition(DownloadRetry.delay(attempt: 0, status: 503, retryAfter: "nonsense") == 5)
    let legacy = try JSONDecoder().decode(
      DownloadDescriptor.self, from: Data(#"{"story":"a","kind":"article"}"#.utf8))
    precondition(legacy.retryAttempt == nil)
    var next = legacy
    next.retryAttempt = 3
    let restored = try JSONDecoder().decode(
      DownloadDescriptor.self, from: JSONEncoder().encode(next))
    precondition(restored.retryAttempt == 3 && restored.key == legacy.key)
    precondition(DownloadRetry.delay(attempt: restored.retryAttempt!, status: 502) == 900)
    let a = DownloadDescriptor(story: "a", kind: "image", remote: "https://example.org/a.jpg")
    let b = DownloadDescriptor(story: "a", kind: "image", remote: "https://example.org/b.jpg")
    precondition(a.key != b.key && a.failureKey != b.failureKey)
    print("Retry policy checks passed")
  }
}
