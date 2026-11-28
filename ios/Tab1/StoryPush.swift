import UIKit

@MainActor final class StoryPush {
  static let shared = StoryPush()
  private let defaults = UserDefaults.standard
  private let batchKey = "tab1.storyPushBatches"
  private let tokenKey = "tab1.apnsToken"
  private struct Batch: Codable {
    let id: String
    let received: Date
    var pending: Set<String>
    var saved = 0
    var savedBeforeReopen = 0
    var reopened: Date?
    var awaitingReopen: Bool
  }
  private lazy var batches: [Batch] = {
    guard let data = defaults.data(forKey: batchKey),
          let stored = try? JSONDecoder().decode([Batch].self, from: data) else { return [] }
    return stored.filter { $0.received.timeIntervalSinceNow > -48 * 3600 }
  }()
  private func persist() { defaults.set(try? JSONEncoder().encode(batches), forKey: batchKey) }

  // The development-signed Release build uses sandbox. Distribution and App
  // Store builds use production, including when Apple strips the profile.
  private lazy var environment: String = {
    guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
          let data = try? Data(contentsOf: url),
          let start = data.range(of: Data("<?xml".utf8)),
          let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex),
          let plist = try? PropertyListSerialization.propertyList(from: data[start.lowerBound..<end.upperBound], format: nil) as? [String: Any],
          let entitlements = plist["Entitlements"] as? [String: Any],
          entitlements["aps-environment"] as? String == "development" else { return "production" }
    return "sandbox"
  }()

  func configuration(enabled: Bool) -> JSONValue? {
    guard let token = defaults.string(forKey: tokenKey) else { return nil }
    return .object(["token": .string(token), "environment": .string(environment), "enabled": .bool(enabled), "confirmSaves": .bool(true)])
  }

  func registered(_ data: Data) {
    let token = data.map { String(format: "%02x", $0) }.joined()
    let changed = defaults.string(forKey: tokenKey) != token
    defaults.set(token, forKey: tokenKey)
    DownloadDiagnostics.shared.event("APNs registered (\(environment)), token changed=\(changed)")
    if changed { LibraryStore.shared.pushPreferencesChanged() }
  }

  func received(_ payload: [AnyHashable: Any], completion: @escaping (UIBackgroundFetchResult) -> Void) {
    let store = LibraryStore.shared
    let callbackBatch = (payload["batch"] as? String).flatMap(UUID.init(uuidString:))?.uuidString.lowercased() ?? "unknown"
    DownloadDiagnostics.shared.event("Remote notification callback batch=\(callbackBatch)")
    guard store.automatic, store.server == "https://tab1.net", !store.switchingLibrary,
          let raw = payload["batch"] as? String, let uuid = UUID(uuidString: raw),
          let hashes = payload["stories"] as? [String], !hashes.isEmpty, hashes.count <= 100,
          hashes.allSatisfy({ $0.count == 16 && $0.allSatisfy(\.isHexDigit) }) else {
      completion(.noData)
      return
    }
    let id = uuid.uuidString.lowercased()
    guard !batches.contains(where: { $0.id == id }) else { completion(.noData); return }
    batches.removeAll { $0.received.timeIntervalSinceNow < -48 * 3600 }
    batches.append(Batch(id: id, received: .now, pending: Set(hashes),
                         awaitingReopen: UIApplication.shared.applicationState != .active))
    persist()
    DownloadDiagnostics.shared.event("Story push received batch=\(id), discovered=\(payload["discovered"] as? String ?? "?"), sent=\(payload["sent"] as? String ?? "?"), tracked=\(hashes.count), total=\(payload["total"] as? Int ?? hashes.count)")
    let scope = store.downloadScope
    var completed = false
    func finish(_ result: UIBackgroundFetchResult) {
      guard !completed else { return }
      completed = true
      completion(result)
    }
    var timeout: Task<Void, Never>?
    let work = Task {
      await store.load()
      guard !Task.isCancelled, store.automatic, scope == store.downloadScope else {
        timeout?.cancel(); finish(.noData); return
      }
      let previous = store.library.updated
      let ok = await store.refreshInBackground()
      await store.flushPersistence()
      timeout?.cancel()
      DownloadDiagnostics.shared.event("Story push check ended batch=\(id), success=\(ok)")
      finish(ok ? (previous != store.library.updated ? .newData : .noData) : .failed)
    }
    timeout = Task {
      do { try await Task.sleep(for: .seconds(25)) } catch { return }
      work.cancel()
      DownloadDiagnostics.shared.event("Story push time budget reached batch=\(id)")
      finish(.failed)
    }
  }

  private var candidateLinks: Set<String> = []

  func installed(_ link: String) {
    guard !batches.isEmpty else { return }
    let hash = String(fileID(link).prefix(16))
    if batches.contains(where: { $0.pending.contains(hash) }) { candidateLinks.insert(link) }
  }

  func saveObserver(entries: [String: Entry]) -> (@Sendable (Date) -> Void)? {
    let included = candidateLinks.union(pendingLinks).filter { entries[$0]?.article != nil }
    guard !included.isEmpty else { return nil }
    let scope = LibraryStore.shared.downloadScope
    return { at in Task { @MainActor in
      guard LibraryStore.shared.downloadScope == scope else { return }
      self.confirm(included, at: at)
      self.enqueueAcknowledgements(included.intersection(self.pendingLinks), scope: scope)
    } }
  }

  var pendingLinks: Set<String> = []
  private var savedLinks: Set<String> = []
  private var acknowledgement: Task<Void, Never>?

  private func enqueueAcknowledgements(_ links: Set<String>, scope: String?) {
    savedLinks.formUnion(links)
    guard !savedLinks.isEmpty, acknowledgement == nil else { return }
    acknowledgement = Task {
      let store = LibraryStore.shared
      defer { if scope == store.downloadScope { acknowledgement = nil } }
      while !Task.isCancelled, scope == store.downloadScope, store.automatic,
            store.server == "https://tab1.net", !savedLinks.isEmpty {
        let group = Set(savedLinks.prefix(500))
        let hashes = group.map { JSONValue.string(String(fileID($0).prefix(16))) }
        do {
          let _: JSONValue = try await store.request("story-ack", body: .object(["saved": .array(hashes)]))
          guard scope == store.downloadScope else { return }
          savedLinks.subtract(group)
          pendingLinks.subtract(group)
          DownloadDiagnostics.shared.event("Server acknowledged saved articles=\(group.count)")
        } catch {
          DownloadDiagnostics.shared.event("Saved article acknowledgements deferred until next library save")
          return
        }
      }
    }
  }

  private func confirm(_ links: Set<String>, at: Date) {
    candidateLinks.subtract(links)
    let hashes = Set(links.map { String(fileID($0).prefix(16)) })
    for i in batches.indices {
      let newlySaved = hashes.intersection(batches[i].pending)
      guard !newlySaved.isEmpty else { continue }
      batches[i].pending.subtract(newlySaved)
      batches[i].saved += newlySaved.count
      let beforeReopen = batches[i].awaitingReopen || (batches[i].reopened.map { at < $0 } ?? false)
      if beforeReopen { batches[i].savedBeforeReopen += newlySaved.count }
      DownloadDiagnostics.shared.event("Article library written at \(at.ISO8601Format()), batch=\(batches[i].id), newly saved=\(newlySaved.count), saved before reopen=\(batches[i].savedBeforeReopen)")
      persist()
    }
  }

  func activated() {
    for i in batches.indices where batches[i].awaitingReopen {
      DownloadDiagnostics.shared.event("Story push batch=\(batches[i].id), saved before reopen=\(batches[i].savedBeforeReopen), tracked=\(batches[i].saved + batches[i].pending.count)")
      batches[i].reopened = .now
      batches[i].awaitingReopen = false
    }
    persist()
  }

  func accountChanged() {
    acknowledgement?.cancel()
    acknowledgement = nil
    pendingLinks = []
    savedLinks = []
    batches = []
    candidateLinks = []
    persist()
  }
}
