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
    config.timeoutIntervalForResource = 240
    return URLSession(configuration: config, delegate: self, delegateQueue: nil)
  }()
  func reconnect() { _ = session }
  // Register surviving system tasks before creating new ones, once per process.
  @MainActor private lazy var restoration = Task { @MainActor in
    await restoreSessionTasks()
  }
  @MainActor func restoreActivity() async { await restoration.value }
  @MainActor private func restoreSessionTasks() async {
    for task in await session.allTasks where task.state != .completed && task.state != .canceling {
      guard let descriptor = descriptor(for: task) else { continue }
      activeKeys.insert(descriptor.key)
      LibraryStore.shared.trackDownload(descriptor)
    }
  }
  private func descriptor(for task: URLSessionTask) -> DownloadDescriptor? {
    guard let text = task.taskDescription, let data = text.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(DownloadDescriptor.self, from: data)
  }
  @MainActor func enqueue(url: URL, token: String?, descriptor: DownloadDescriptor) async {
    await restoreActivity()
    guard activeKeys.insert(descriptor.key).inserted else { return }
    var request = URLRequest(url: url)
    request.timeoutInterval = descriptor.kind == "comments" ? 90 : 45
    if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
    await start(request, descriptor: descriptor)
  }
  @MainActor private func start(
    _ request: URLRequest, descriptor: DownloadDescriptor, delay: TimeInterval? = nil
  ) async {
    activeKeys.insert(descriptor.key)
    LibraryStore.shared.trackDownload(descriptor)
    await submit(request, descriptor: descriptor, delay: delay)
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
    activeKeys.remove(descriptor.key)
    LibraryStore.shared.finishDownload(descriptor, failed: failed)
  }
  @MainActor private func fail(
    _ descriptor: DownloadDescriptor, request: URLRequest?,
    message: String, delay: TimeInterval?, cooldown: TimeInterval = 3600
  ) async {
    if let delay, let request {
      var next = descriptor
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
      if status != 200 {
        let payload = await Task.detached(priority: .utility) {
          defer { try? FileManager.default.removeItem(at: copy) }
          return (try? Data(contentsOf: copy)).flatMap {
            try? JSONDecoder().decode(DownloadServerError.self, from: $0)
          }
        }.value
        let delay = DownloadRetry.delay(
          attempt: descriptor.retryAttempt ?? 0, status: status,
          retryable: payload?.retryable,
          retryAfter: response?.value(forHTTPHeaderField: "Retry-After"))
        let message = payload?.error ?? "Download failed (HTTP \(status))."
        await self.fail(descriptor, request: request, message: message, delay: delay,
                  cooldown: [403, 404, 410, 422].contains(status) ? 86400 : 3600)
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
      let delay = DownloadRetry.delay(
        attempt: descriptor.retryAttempt ?? 0, error: error as NSError)
      // A background URLSession already waits for connectivity. Queue an eligible
      // retry immediately while offline, and let iOS start it when a route returns.
      let offline = !LibraryStore.shared.online
      let temporary = DownloadRetry.isTemporaryConnectionError(error as NSError)
      await self.fail(descriptor, request: request, message: error.localizedDescription,
                delay: offline ? delay.map { _ in 0 } : delay,
                cooldown: temporary ? 0 : 3600)
    }
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    let writes = pending
    pending = nil
    Task {
      await writes?.value
      await LibraryStore.shared.flushPersistence()
      await MainActor.run {
        self.completion?()
        self.completion = nil
      }
    }
  }
}
final class AppDelegate: NSObject, UIApplicationDelegate {
  @MainActor static func saveForBackground() {
    let application = UIApplication.shared
    var identifier: UIBackgroundTaskIdentifier = .invalid
    identifier = application.beginBackgroundTask(withName: "Save offline library") {
      if identifier != .invalid {
        application.endBackgroundTask(identifier)
        identifier = .invalid
      }
    }
    Task { @MainActor in
      LibraryStore.shared.persist()
      await LibraryStore.shared.flushPersistence()
      if identifier != .invalid {
        application.endBackgroundTask(identifier)
        identifier = .invalid
      }
    }
  }
  func application(
    _ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    BackgroundDownloads.shared.completion = completionHandler
    BackgroundDownloads.shared.reconnect()
  }
}
