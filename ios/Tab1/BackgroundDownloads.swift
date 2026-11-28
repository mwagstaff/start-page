import Foundation
import UIKit

final class BackgroundDownloads: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
  static let shared = BackgroundDownloads()
  var completion: (() -> Void)?
  @MainActor private var activeKeys: Set<String> = []
  // URLSession delivers delegate events on its serial delegate queue.
  private var pending: Task<Void, Never>?
  private func handle(_ operation: @escaping @MainActor () async -> Void) {
    let previous = pending
    pending = Task {
      await previous?.value
      await operation()
    }
  }
  private lazy var session: URLSession = {
    let config = URLSessionConfiguration.background(withIdentifier: "tab1.dev.skynolimit.downloads")
    config.sessionSendsLaunchEvents = true
    config.allowsCellularAccess = true
    config.isDiscretionary = false
    config.httpMaximumConnectionsPerHost = 3
    // Keep the system resource timeout so a suspended or offline transfer can resume later.
    return URLSession(configuration: config, delegate: self, delegateQueue: nil)
  }()
  @MainActor func cancelAccountTasks() async {
    for task in await session.allTasks { task.cancel() }
    activeKeys.removeAll()
  }
  func reconnect() { _ = session }
  // Register surviving system tasks before creating new ones, once per process.
  @MainActor private lazy var restoration = Task { @MainActor in
    await restoreSessionTasks()
  }
  @MainActor func restoreActivity() async { await restoration.value }
  @MainActor private func restoreSessionTasks() async {
    for task in await session.allTasks where task.state != .completed && task.state != .canceling {
      guard let descriptor = descriptor(for: task) else { continue }
      guard descriptor.scope == LibraryStore.shared.downloadScope else { task.cancel(); continue }
      activeKeys.insert(descriptor.key)
      LibraryStore.shared.trackDownload(descriptor)
    }
    DownloadDiagnostics.shared.event("Restored \(activeKeys.count) system transfers")
  }
  @MainActor func logQueue(_ occasion: String) async {
    let tasks = await session.allTasks
    var first = 0, retries = 0, deferred = 0, images = 0, comments = 0
    let now = Date.now
    var next: Date?
    var oldestFirst: Date?
    var reasons: [String: Int] = [:]
    for task in tasks where task.state != .completed && task.state != .canceling {
      guard let item = descriptor(for: task), item.scope == LibraryStore.shared.downloadScope else { continue }
      switch item.kind {
      case "article":
        if (item.retryAttempt ?? 0) > 0 {
          retries += 1
          let reason = item.retryHTTPStatus.map { "HTTP \($0)" }
            ?? item.retryTransportCode.map { "transport \($0)" } ?? "unknown"
          reasons[reason, default: 0] += 1
          if let date = task.earliestBeginDate, date > now {
            deferred += 1
            next = min(next ?? date, date)
          }
        } else {
          first += 1
          if let date = item.queuedAt { oldestFirst = min(oldestFirst ?? date, date) }
        }
      case "comments": comments += 1
      case "image": images += 1
      default: break
      }
    }
    let causes = reasons.keys.sorted().map { "\($0)=\(reasons[$0] ?? 0)" }.joined(separator: ", ")
    DownloadDiagnostics.shared.event("System queue (\(occasion)): articles first attempt=\(first) (oldest known submission=\(oldestFirst?.ISO8601Format() ?? "unknown")), retry=\(retries) (future earliest start=\(deferred), next=\(next?.ISO8601Format() ?? "none")), images=\(images), comments=\(comments), article retry causes: \(causes.isEmpty ? "none" : causes)")
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
    guard let item = descriptor(for: task) else { return }
    let start = metrics.transactionMetrics.first?.requestStartDate
    let end = metrics.transactionMetrics.last?.responseEndDate
    let callback = Date.now
    handle {
      guard item.scope == LibraryStore.shared.downloadScope else { return }
      DownloadDiagnostics.shared.networkTiming(kind: item.kind, attempt: (item.retryAttempt ?? 0) + 1,
                                              start: start, end: end, callback: callback)
    }
  }

  private func descriptor(for task: URLSessionTask) -> DownloadDescriptor? {
    guard let text = task.taskDescription, let data = text.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(DownloadDescriptor.self, from: data)
  }
  @MainActor func enqueue(url: URL, token: String?, descriptor: DownloadDescriptor, earliest: Date? = nil) async {
    let scope = LibraryStore.shared.downloadScope
    await restoreActivity()
    guard scope == LibraryStore.shared.downloadScope, !LibraryStore.shared.switchingLibrary else { return }
    var descriptor = descriptor
    descriptor.scope = LibraryStore.shared.downloadScope
    guard activeKeys.insert(descriptor.key).inserted else { return }
    var request = URLRequest(url: url)
    request.timeoutInterval = descriptor.kind == "comments" ? 90 : 45
    if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
    if earliest != nil { descriptor.retryAttempt = 1 }
    await start(request, descriptor: descriptor, delay: earliest.map { max(0, $0.timeIntervalSinceNow) })
  }
  @MainActor private func start(
    _ request: URLRequest, descriptor: DownloadDescriptor, delay: TimeInterval? = nil
  ) async {
    var descriptor = descriptor
    descriptor.queuedAt = .now
    activeKeys.insert(descriptor.key)
    LibraryStore.shared.trackDownload(descriptor)
    await submit(request, descriptor: descriptor, delay: delay)
    DownloadDiagnostics.shared.transfer(descriptor.kind, delay == nil ? "submitted" : "retry submitted")
  }
  private func submit(
    _ request: URLRequest, descriptor: DownloadDescriptor, delay: TimeInterval?
  ) async {
    let task = session.downloadTask(with: request)
    task.priority = descriptor.kind == "article" ? URLSessionTask.highPriority : URLSessionTask.defaultPriority
    task.taskDescription = String(
      data: (try? JSONEncoder().encode(descriptor)) ?? Data(), encoding: .utf8)
    if let delay { task.earliestBeginDate = Date(timeIntervalSinceNow: delay) }
    task.resume()
  }
  @MainActor private func finish(_ descriptor: DownloadDescriptor, failed: Bool) {
    guard descriptor.scope == LibraryStore.shared.downloadScope else { return }
    if descriptor.kind != "backdrop" {
      DownloadDiagnostics.shared.transfer(descriptor.kind, failed ? "failed" : "completed")
    }
    activeKeys.remove(descriptor.key)
    LibraryStore.shared.finishDownload(descriptor, failed: failed)
  }
  @MainActor private func fail(
    _ descriptor: DownloadDescriptor, request: URLRequest?,
    message: String, delay: TimeInterval?, cooldown: TimeInterval = 3600,
    httpStatus: Int? = nil, transportCode: Int? = nil
  ) async {
    guard descriptor.scope == LibraryStore.shared.downloadScope else { return }
    if let delay, let request {
      var next = descriptor
      next.retryHTTPStatus = httpStatus
      next.retryTransportCode = transportCode
      next.retryAttempt = (descriptor.retryAttempt ?? 0) + 1
      await start(request, descriptor: next, delay: delay)
    } else {
      LibraryStore.shared.downloadFailed(descriptor, error: message, cooldown: cooldown)
      finish(descriptor, failed: true)
    }
  }
  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask,
    didFinishDownloadingTo location: URL
  ) {
    guard let descriptor = descriptor(for: downloadTask) else { return }
    let response = downloadTask.response as? HTTPURLResponse
    let status = response?.statusCode ?? 0
    let request = downloadTask.originalRequest
    let copy = URL.temporaryDirectory.appending(path: UUID().uuidString)
    do { try FileManager.default.moveItem(at: location, to: copy) } catch {
      handle {
        await LibraryStore.shared.load()
        await self.fail(
          descriptor, request: nil,
          message: "Could not save the download: \(error.localizedDescription)", delay: nil)
      }
      return
    }
    handle {
      await LibraryStore.shared.load()
      guard descriptor.scope == LibraryStore.shared.downloadScope else { try? FileManager.default.removeItem(at: copy); return }
      if status != 200 {
        let payload = await Task.detached(priority: .utility) {
          defer { try? FileManager.default.removeItem(at: copy) }
          return (try? Data(contentsOf: copy)).flatMap {
            try? JSONDecoder().decode(DownloadServerError.self, from: $0)
          }
        }.value
        DownloadDiagnostics.shared.transfer(descriptor.kind, "HTTP \(status)")
        if status == 413 && payload?.error == "The response is too large to save." {
          DownloadDiagnostics.shared.transfer(descriptor.kind, "publisher response exceeded server byte limit")
        }
        let delay = DownloadRetry.delay(
          attempt: descriptor.retryAttempt ?? 0, status: status,
          retryable: payload?.retryable,
          retryAfter: response?.value(forHTTPHeaderField: "Retry-After"))
        let message = payload?.error ?? "Download failed (HTTP \(status))."
        await self.fail(descriptor, request: request, message: message, delay: delay,
                  cooldown: [403, 404, 410, 422].contains(status) ? 86400 : 3600, httpStatus: status)
      } else {
        await LibraryStore.shared.receiveDownload(
          descriptor, file: copy, status: status, mime: response?.mimeType)
        let entry = LibraryStore.shared.library.entries[descriptor.story]
        self.finish(descriptor, failed: entry == nil || entry?.failures?[descriptor.failureKey] != nil)
      }
    }
  }

  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64
  ) { if totalBytesWritten > 20_000_000 { downloadTask.cancel() } }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let error, let descriptor = descriptor(for: task) else { return }
    let request = task.originalRequest
    handle {
      await LibraryStore.shared.load()
      guard descriptor.scope == LibraryStore.shared.downloadScope else { return }
      DownloadDiagnostics.shared.transfer(descriptor.kind, "transport error \((error as NSError).code)")
      let delay = DownloadRetry.delay(
        attempt: descriptor.retryAttempt ?? 0, error: error as NSError)
      // A background URLSession already waits for connectivity. Queue an eligible
      // retry immediately while offline, and let iOS start it when a route returns.
      let offline = !LibraryStore.shared.online && (descriptor.retryAttempt ?? 0) == 0
      let temporary = DownloadRetry.isTemporaryConnectionError(error as NSError)
      await self.fail(descriptor, request: request, message: error.localizedDescription,
                delay: offline ? delay.map { _ in 0 } : delay,
                cooldown: temporary ? 0 : 3600, transportCode: (error as NSError).code)
    }
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    let writes = pending
    pending = nil
    Task {
      await writes?.value
      await LibraryStore.shared.flushPersistence()
      await MainActor.run {
        DownloadDiagnostics.shared.flush()
        self.completion?()
        self.completion = nil
      }
    }
  }
}
final class AppDelegate: NSObject, UIApplicationDelegate {
  func application(
    _ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    DownloadDiagnostics.shared.conditions("Process launched")
    BackgroundRefresh.register()
    if !ProcessInfo.processInfo.arguments.contains("--ui-testing") { application.registerForRemoteNotifications() }
    return true
  }

  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
    StoryPush.shared.registered(token)
  }
  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    DownloadDiagnostics.shared.event("APNs registration failed: \((error as NSError).domain) \((error as NSError).code)")
  }
  func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                   fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
    StoryPush.shared.received(userInfo, completion: completionHandler)
  }

  @MainActor static func refreshOnBackgroundEntry() {
    let application = UIApplication.shared
    let store = LibraryStore.shared
    DownloadDiagnostics.shared.conditions("Entered background, automatic=\(store.automatic), online=\(store.online), pending articles=\(store.pendingStoryDownloads)")
    let next = BackgroundRefresh.schedule(online: store.online)
    var identifier: UIBackgroundTaskIdentifier = .invalid
    var work: Task<Void, Never>?
    func finish() {
      guard identifier != .invalid else { return }
      application.endBackgroundTask(identifier)
      identifier = .invalid
    }
    identifier = application.beginBackgroundTask(withName: "Update offline stories") {
      DownloadDiagnostics.shared.event("Background entry time expired")
      work?.cancel()
      finish()
    }
    store.persist()
    work = Task {
      if identifier != .invalid {
        let success = await store.refreshInBackground(leavingApp: true)
        DownloadDiagnostics.shared.event("Background entry check finished: success=\(success)")
      } else {
        DownloadDiagnostics.shared.event("No execution time for background entry check")
      }
      await store.flushPersistence()
      await next.value
      finish()
    }
  }
  func application(
    _ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    DownloadDiagnostics.shared.event("iOS delivered background URLSession events")
    BackgroundDownloads.shared.completion = completionHandler
    BackgroundDownloads.shared.reconnect()
  }
}
