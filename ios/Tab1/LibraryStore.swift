import BackgroundTasks
import Foundation
import Network
import OSLog
import Observation
import Security

let homeLog = Logger(subsystem: Bundle.main.bundleIdentifier ?? "tab1", category: "Home")

// Observe each collection independently so receiving an article doesn't rebuild the card list.
@MainActor @Observable final class LiveLibrary {
  var cards: [Card] = []
  var entries: [String: Entry] = [:]
  var settings: JSONValue = .object([:])
  var baseline: JSONValue = .object([:])
  var catalogue: JSONValue = .object([:])
  var weather: JSONValue = .null
  var backdrop: JSONValue?
  var backdropFile: String?
  var reading: [String: Reading] = [:]
  var pending: [String: ReadingPatch] = [:]
  var revision = 0
  var updated: Date?
  init(_ value: Library = Library()) {
    cards = value.cards
    entries = value.entries
    settings = value.settings
    baseline = value.baseline
    catalogue = value.catalogue
    weather = value.weather
    backdrop = value.backdrop
    backdropFile = value.backdropFile
    reading = value.reading
    pending = value.pending
    revision = value.revision
    updated = value.updated
  }
  var snapshot: Library {
    Library(cards: cards, entries: entries, settings: settings, baseline: baseline,
            catalogue: catalogue, weather: weather, backdrop: backdrop, backdropFile: backdropFile,
            reading: reading, pending: pending, revision: revision, updated: updated)
  }
}

@MainActor @Observable final class LibraryStore {
  static let shared = LibraryStore()
  private(set) var library = LiveLibrary()
  var appTopics: Set<String> = []
  private(set) var backdropGeneration = 0
  var busy = false
  var message = "Ready for your next journey"
  var lastError: String?
  var downloadActivity: [String: DownloadActivity] = [:]
  private struct StoryTransfers {
    var active = 0
    var retrying = 0
  }
  private var transfersByStory: [String: StoryTransfers] = [:]
  private var schedulingDepth = 0
  private(set) var finishedFiles = 0
  private(set) var failedFiles = 0
  var hasActiveDownloads: Bool { schedulingDepth > 0 || !downloadActivity.isEmpty }
  var totalFiles: Int { finishedFiles + failedFiles + downloadActivity.count }

  private func resetDownloadCountsIfIdle() {
    if !hasActiveDownloads {
      finishedFiles = 0
      failedFiles = 0
    }
  }
  private func beginScheduling() {
    resetDownloadCountsIfIdle()
    schedulingDepth += 1
  }
  func trackDownload(_ descriptor: DownloadDescriptor) {
    guard descriptor.kind != "backdrop" else { return }
    resetDownloadCountsIfIdle()
    let retrying = (descriptor.retryAttempt ?? 0) > 0
    let previous = downloadActivity[descriptor.key]
    guard previous?.retrying != retrying else { return }
    downloadActivity[descriptor.key] = DownloadActivity(story: descriptor.story, retrying: retrying)
    var counts = transfersByStory[descriptor.story] ?? StoryTransfers()
    if previous == nil { counts.active += 1 }
    if previous?.retrying == true { counts.retrying -= 1 }
    if retrying { counts.retrying += 1 }
    transfersByStory[descriptor.story] = counts
  }
  func finishDownload(_ descriptor: DownloadDescriptor, failed: Bool) {
    guard let previous = downloadActivity.removeValue(forKey: descriptor.key),
          var counts = transfersByStory[descriptor.story] else { return }
    counts.active -= 1
    if previous.retrying { counts.retrying -= 1 }
    transfersByStory[descriptor.story] = counts.active > 0 ? counts : nil
    if failed { failedFiles += 1 } else { finishedFiles += 1 }
    if downloadActivity.isEmpty {
      if pendingDownloadSave != nil { persist() }
      Task {
        await persistence.flush()
        usedBytes = await disk.usage(root)
      }
    }
  }
  private(set) var online = true
  private(set) var showOfflineBanner = false
  private var offlineNotice: Task<Void, Never>?
  private var retryTask: Task<Void, Never>?
  var hasScheduledRetry: Bool { retryTask != nil }
  private var retryDelay = 5
  private(set) var needsRefreshRetry = UserDefaults.standard.bool(forKey: "needsRefreshRetry") {
    didSet { UserDefaults.standard.set(needsRefreshRetry, forKey: "needsRefreshRetry") }
  }

  private func connectivityChanged(connected: Bool) {
    guard online != connected else { return }
    online = connected
    offlineNotice?.cancel()
    retryTask?.cancel()
    if connected {
      showOfflineBanner = false
      retryDelay = 5
      if busy { refreshAfterCurrent = true } else { requestHomeRefresh() }
    } else {
      needsRefreshRetry = true
      BackgroundRefresh.schedule(online: online)
      offlineNotice = Task {
        do { try await Task.sleep(for: .seconds(30)) } catch { return }
        showOfflineBanner = true
      }
    }
  }

  private func retryRefreshLater() {
    needsRefreshRetry = true
    guard online else { return } // The path monitor starts the retry on reconnection.
    let delay = retryDelay
    retryDelay = min(delay * 2, 60)
    retryTask = Task {
      do { try await Task.sleep(for: .seconds(delay)) } catch { return }
      retryTask = nil
      await refresh(download: automatic)
    }
  }
  var server: String { didSet { UserDefaults.standard.set(server, forKey: "server") } }
  var budgetGB: Double { didSet { UserDefaults.standard.set(budgetGB, forKey: "budgetGB") } }
  var automatic = true { didSet { UserDefaults.standard.set(automatic, forKey: "automatic") } }
  let root: URL
  private let monitor = NWPathMonitor()
  private var connectionEpoch = 0
  private var refreshAfterCurrent = false
  @ObservationIgnored private var cachedTokens: [String: String] = [:]
  private func credential() async -> String {
    let host = server
    if let cached = cachedTokens[host] { return cached }
    let value = await disk.credential(host)
    if !value.isEmpty && cachedTokens[host] == nil { cachedTokens[host] = value }
    return cachedTokens[host] ?? value
  }
  private func saveCredential(_ value: String) async {
    let host = server
    cachedTokens[host] = value
    await disk.saveCredential(value, host: host)
  }
  private(set) var usedBytes: Int64 = 0
  private(set) var ready = false
  @ObservationIgnored private var loading: Task<Void, Never>?
  @ObservationIgnored private var fileWork: Task<Void, Never>?
  // JSON payloads live in library.json, which may still be waiting for a coalesced write.
  @ObservationIgnored private var uncheckedPayloadBytes: Int64 = 0
  private let disk = LibraryDisk()
  init() {
    server = UserDefaults.standard.string(forKey: "server") ?? "https://tab1.net"
    budgetGB = UserDefaults.standard.object(forKey: "budgetGB") as? Double ?? 1
    root = URL.applicationSupportDirectory.appending(
      path: ProcessInfo.processInfo.arguments.contains("--ui-testing")
        ? "Tab1UITest" : "Tab1Offline", directoryHint: .isDirectory)
    automatic =
      UserDefaults.standard.object(forKey: "automatic") == nil
      ? true : UserDefaults.standard.bool(forKey: "automatic")
    monitor.pathUpdateHandler = { [weak self] path in
      Task { @MainActor in
        self?.connectivityChanged(connected: path.status == .satisfied)
      }
    }
    BackgroundDownloads.shared.reconnect()
    Task { await BackgroundDownloads.shared.restoreActivity() }
    monitor.start(queue: DispatchQueue(label: "tab1.network"))
  }
  func load() async {
    if ready { return }
    if let loading { await loading.value; return }
    let reset = ProcessInfo.processInfo.arguments.contains("--ui-testing")
      && ProcessInfo.processInfo.arguments.contains("--reset-ui-library")
    let work = Task {
      let (cached, topics, bytes) = await disk.open(root, reset: reset)
      library = LiveLibrary(cached)
      appTopics = topics
      usedBytes = bytes
      ready = true
    }
    loading = work
    await work.value
    loading = nil
  }
  func setAppTopic(_ id: String, enabled: Bool) {
    if enabled { appTopics.insert(id) } else { appTopics.remove(id) }
    do {
      try JSONEncoder().encode(appTopics).write(
        to: root.appending(path: "app-topics.json"), options: .atomic)
    } catch { lastError = "Could not save app-only topics: \(error.localizedDescription)" }
  }
  func refreshAppTopics() async {
    if busy { refreshAfterCurrent = true } else { await refresh(download: automatic) }
  }
  @ObservationIgnored private let persistence = LibraryPersistence()
  @ObservationIgnored private var pendingDownloadSave: Task<Void, Never>?
  private func persistDownload() {
    guard pendingDownloadSave == nil else { return }
    pendingDownloadSave = Task {
      do { try await Task.sleep(for: .milliseconds(400)) } catch { return }
      persist()
    }
  }
  func persist() {
    pendingDownloadSave?.cancel()
    pendingDownloadSave = nil
    guard ready else { return }
    persistence.save(library.snapshot, to: root.appending(path: "library.json")) { [weak self] message in
      Task { @MainActor in self?.lastError = "Could not save the offline library: \(message)" }
    }
  }
  func flushPersistence() async {
    if pendingDownloadSave != nil { persist() }
    await persistence.flush()
  }
  func request<T: Decodable>(_ route: String, body: JSONValue? = nil) async throws -> T {
    guard let url = URL(string: server + "/api/companion/" + route) else { throw URLError(.badURL) }
    let epoch = connectionEpoch
    var req = URLRequest(url: url)
    req.timeoutInterval = ["sync", "cards", "create"].contains(route) ? 20 : 90
    req.setValue("Bearer " + (await credential()), forHTTPHeaderField: "Authorization")
    if let body {
      req.httpMethod = "POST"
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try JSONEncoder().encode(body)
    }
    let (data, response) = try await URLSession.shared.data(for: req)
    guard epoch == connectionEpoch else { throw CancellationError() }
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let value = try? JSONDecoder().decode(JSONValue.self, from: data)
      throw NSError(
        domain: "tab1", code: (response as? HTTPURLResponse)?.statusCode ?? 0,
        userInfo: [
          NSLocalizedDescriptionKey: value?["error"].string.isEmpty == false
            ? value!["error"].string : "The server could not complete this request."
        ])
    }
    let decoded = try await Task.detached { try JSONDecoder().decode(T.self, from: data) }.value
    guard epoch == connectionEpoch else { throw CancellationError() }
    return decoded
  }
  func ensureProfile() async throws {
    guard await credential().isEmpty else { return }
    let response: SyncResponse = try await request(
      "create", body: .object(["settings": library.settings]))
    await saveCredential(response.token ?? "")
    library.revision = response.revision
  }
  private var syncing: Task<Void, Error>?
  func sync() async throws {
    if let syncing { return try await syncing.value }
    let work = Task { try await performSync() }
    syncing = work
    defer { syncing = nil }
    try await work.value
  }
  private func performSync() async throws {
    try await ensureProfile()
    for _ in 0..<3 {
      let remote: SyncResponse = try await request("sync")
      let merged = mergePreferences(
        base: library.baseline, local: library.settings, remote: remote.settings ?? .object([:])
      ).object
      let localAtStart = library.settings
      let pendingAtStart = library.pending
      do {
        let result: SyncResponse
        if pendingAtStart.isEmpty, remote.settings == .object(merged) {
          result = remote
        } else {
          let reading = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(pendingAtStart))
          result = try await request(
            "sync", body: .object([
              "revision": .number(Double(remote.revision)),
              "settings": .object(merged.isEmpty ? ["v": .number(1), "tabs": .object([:]), "custom": .array([])] : merged),
              "reading": reading,
            ]))
        }
        library.settings = mergePreferences(
          base: localAtStart, local: library.settings, remote: result.settings ?? library.settings)
        library.baseline = result.settings ?? library.settings
        library.reading = result.reading
        for (id, value) in result.reading where value.saved && library.entries[id] == nil {
          if let story = value.story { library.entries[id] = Entry(story: story) }
        }
        for (key, value) in pendingAtStart {
          if library.pending[key]?.read == value.read { library.pending[key]?.read = nil }
          if library.pending[key]?.saved == value.saved { library.pending[key]?.saved = nil }
          if library.pending[key]?.read == nil && library.pending[key]?.saved == nil {
            library.pending.removeValue(forKey: key)
          }
        }
        for (key, patch) in library.pending {
          var value = library.reading[key] ?? Reading()
          if let read = patch.read { value.read = read }
          if let saved = patch.saved { value.saved = saved }
          library.reading[key] = value
        }
        library.revision = result.revision
        persist()
        return
      } catch let error as NSError where error.code == 409 { continue }
    }
    throw NSError(
      domain: "tab1", code: 409,
      userInfo: [NSLocalizedDescriptionKey: "Settings changed elsewhere. Please retry sync."])
  }
  func pair(_ value: String) async {
    await load()
    do {
      guard let url = URLComponents(string: value), url.scheme == "tab1", url.host == "pair",
        let code = url.queryItems?.first(where: { $0.name == "code" })?.value,
        let target = url.queryItems?.first(where: { $0.name == "server" })?.value,
        let targetURL = URL(string: target), ["https", "http"].contains(targetURL.scheme ?? ""),
        targetURL.user == nil, targetURL.password == nil
      else { throw URLError(.badURL) }
      connectionEpoch += 1
      let oldServer = server
      server = target.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
      do {
        let result: SyncResponse = try await request(
          "claim", body: .object(["code": .string(code)]))
        await saveCredential(result.token ?? "")
        library.settings = result.settings ?? .object([:])
        library.baseline = library.settings
        library.reading = result.reading
        for (id, value) in result.reading where value.saved && library.entries[id] == nil {
          if let story = value.story { library.entries[id] = Entry(story: story) }
        }
        library.pending = [:]
        library.revision = result.revision
        persist()
      } catch {
        server = oldServer
        throw error
      }
      if busy { refreshAfterCurrent = true } else { await refresh(download: automatic) }
    } catch { lastError = error.localizedDescription }
  }
  func setReading(_ story: Story, read: Bool? = nil, saved: Bool? = nil) {
    var value = library.reading[story.link] ?? Reading()
    if let read { value.read = read }
    if let saved { value.saved = saved }
    var metadata = story
    metadata.excerpt = nil
    metadata.summary = nil
    value.story = metadata
    library.reading[story.link] = value
    var patch = library.pending[story.link] ?? ReadingPatch()
    if let read { patch.read = read }
    if let saved { patch.saved = saved }
    patch.story = metadata
    library.pending[story.link] = patch
    persist()
    Task { try? await sync() }
  }
  func requestHomeRefresh() {
    // SwiftUI owns the gesture lifetime. Keep the library update alive across navigation.
    guard !busy else { return }
    Task { await refresh(download: automatic) }
  }
  func refresh(download: Bool = true) async {
    await load()
    guard !busy else { return }
    retryTask?.cancel()
    retryTask = nil
    busy = true
    lastError = nil
    defer {
      busy = false
      BackgroundRefresh.schedule(online: online)
      if refreshAfterCurrent {
        refreshAfterCurrent = false
        Task { await refresh(download: automatic) }
      }
    }
    var stage = "sync"
    let started = ContinuousClock.now
    homeLog.notice("Refresh started cachedCards=\(self.library.cards.count) online=\(self.online)")
    do {
      message = "Syncing your cards…"
      try await sync()
      try Task.checkCancellation()
      stage = "cards"
      message = "Updating stories…"
      let snapshot: Snapshot = try await request(
        "cards",
        body: .object([
          "settings": library.settings, "appTopics": .array(appTopics.sorted().map { .string($0) }),
        ]))
      homeLog.notice("Cards received cards=\(snapshot.cards.count) stories=\(snapshot.cards.reduce(0) { $0 + $1.items.count }) elapsed=\(String(describing: started.duration(to: .now)), privacy: .public)")
      var cards = snapshot.cards
      for index in cards.indices {
        for item in cards[index].items.indices {
          var story = cards[index].items[item]
          let existing = library.entries[story.id]
          if story.summary == nil {
            story.summary = existing?.story.summary
          }
          cards[index].items[item] = story
          if existing == nil {
            library.entries[story.id] = Entry(story: story)
          } else {
            library.entries[story.id]?.story = story
          }
        }
      }
      library.cards = cards
      library.settings = snapshot.settings
      library.catalogue = snapshot.catalogue
      let oldPhoto = library.backdrop?["url"].string
      library.backdrop = snapshot.backdrop
      if let remote = snapshot.backdrop?["url"].string,
        remote != oldPhoto || library.backdropFile == nil, let url = URL(string: remote)
      {
        await BackgroundDownloads.shared.enqueue(
          url: url, token: nil,
          descriptor: DownloadDescriptor(story: "_backdrop", kind: "backdrop", remote: remote))
      }
      if !LocalWeather.shared.enabled { library.weather = snapshot.weather ?? .null }
      needsRefreshRetry = !online
      retryDelay = 5
      library.updated = .now
      persist()
      message = "Cards updated"
      async let weather: Void = LocalWeather.shared.refresh()
      if download { await downloadEntries() }
      await weather
    } catch {
      let failure = error as NSError
      if error is CancellationError || (failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled) {
        message = library.cards.isEmpty ? "Pull to refresh" : "Showing your saved library"
        return
      }
      homeLog.error("Refresh failed stage=\(stage, privacy: .public) domain=\(failure.domain, privacy: .public) code=\(failure.code) cachedCards=\(self.library.cards.count)")
      let transientNetwork = failure.domain == NSURLErrorDomain && [
        URLError.timedOut, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost,
        .dnsLookupFailed, .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff
      ].contains { $0.rawValue == failure.code }
      if transientNetwork || (failure.domain == "tab1" && [408, 429, 500, 502, 503, 504].contains(failure.code)) {
        retryRefreshLater()
        message = online ? "Couldn’t update stories. Retrying automatically…" : "Waiting for connection"
        return
      }
      needsRefreshRetry = false
      lastError = error.localizedDescription
      message =
        library.cards.isEmpty
        ? "Connect to download your first stories" : "Showing your saved library"
    }
  }
  func downloadEntries() async {
    let current = library.cards.flatMap(\.items).map(\.id)
    let saved = library.entries.keys.filter { library.reading[$0]?.saved == true }
    let upgrades = library.entries.values.filter { $0.article?.needsImageUpgrade == true }.map(\.id)
    let cutoff = Date.now.addingTimeInterval(-7 * 86400)
    let repairs = library.entries.values.filter { $0.error != nil && $0.collected > cutoff }.map(\.id)
    let ids = Array(NSOrderedSet(array: current + saved + upgrades + repairs)) as? [String] ?? current
    beginScheduling()
    defer { schedulingDepth -= 1 }
    for id in ids {
      if Task.isCancelled { break }
      await Task.yield()
      await download(id, automaticRetry: true)
    }
    await withFileWork { await self.prune() }
    persist()
  }
  func downloadStatus(_ id: String) -> String? {
    guard let counts = transfersByStory[id] else { return nil }
    return counts.retrying > 0 ? "Retry queued automatically…" : "Downloading…"
  }
  var failedDownloadIDs: [String] {
    library.entries.values.filter { $0.error != nil }.map(\.id).sorted()
  }
  var retryableDownloadIDs: [String] {
    failedDownloadIDs.filter { downloadStatus($0) == nil }
  }
  func retryFailedDownloads() async {
    beginScheduling()
    defer { schedulingDepth -= 1 }
    for id in retryableDownloadIDs {
      guard !Task.isCancelled else { break }
      await download(id)
    }
  }
  func download(_ id: String, automaticRetry: Bool = false) async {
    guard let entry = library.entries[id] else { return }
    beginScheduling()
    defer { schedulingDepth -= 1 }
    let allowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&+#"))
    if !automaticRetry || (entry.retryAfter?["article"] ?? .distantPast) <= .now,
      entry.article == nil || entry.article?.needsImageUpgrade == true,
      let q = id.addingPercentEncoding(withAllowedCharacters: allowed),
      let url = URL(string: server + "/api/companion/article?url=" + q)
    {
      await BackgroundDownloads.shared.enqueue(
        url: url, token: await credential(), descriptor: DownloadDescriptor(story: id, kind: "article"))
    }
    if !automaticRetry || (entry.retryAfter?["comments"] ?? .distantPast) <= .now,
      entry.discussion == nil || entry.failures?["comments"] != nil {
      await downloadComments(id)
    }
    await queueImages(id, automaticRetry: automaticRetry)
    if !automaticRetry && online { _ = try? await refreshSummary(entry.story) }
  }
  func refreshSummary(_ story: Story, background: Bool = false) async throws -> StorySummary {
    guard var components = URLComponents(string: server + "/api/summary") else { throw URLError(.badURL) }
    components.queryItems = [URLQueryItem(name: "url", value: story.link)]
    if background { components.queryItems?.append(URLQueryItem(name: "background", value: "1")) }
    if let thread = story.commentsUrl { components.queryItems?.append(URLQueryItem(name: "thread", value: thread)) }
    guard let url = components.url else { throw URLError(.badURL) }
    let (data, response) = try await URLSession.shared.data(from: url)
    let summary: StorySummary
    switch (response as? HTTPURLResponse)?.statusCode {
    case 200: summary = try JSONDecoder().decode(StorySummary.self, from: data)
    case 404 where background: summary = StorySummary(unavailable: true, pending: false)
    default: throw URLError(.badServerResponse)
    }
    try Task.checkCancellation()
    if library.entries[story.id]?.story.summary != summary {
      library.entries[story.id]?.story.summary = summary
      persist()
    }
    return summary
  }
  func downloadComments(_ id: String, allComments: Bool = false, refresh: Bool = false) async {
    let allowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&+#"))
    if let entry = library.entries[id],
      let link = entry.story.commentsUrl,
      let q = link.addingPercentEncoding(withAllowedCharacters: allowed),
      let url = URL(
        string: server
          + "/api/companion/comments?url=\(q)&all=\(allComments || (entry.discussion?.comments.count ?? 0) > 500)&refresh=\(refresh)"
      )
    {
      await BackgroundDownloads.shared.enqueue(
        url: url, token: await credential(), descriptor: DownloadDescriptor(story: id, kind: "comments"))
    }
  }
  func queueImages(_ id: String, automaticRetry: Bool = true) async {
    guard let entry = library.entries[id] else { return }
    let images = (entry.article?.images ?? []) + [entry.story.image].compactMap { $0 }
    for remote in Set(images) where entry.assets[remote] == nil {
      if automaticRetry, (entry.retryAfter?["image:" + remote] ?? .distantPast) > .now { continue }
      guard let url = URL(string: remote, relativeTo: URL(string: server))?.absoluteURL,
        ["http", "https"].contains(url.scheme ?? "")
      else { continue }
      await BackgroundDownloads.shared.enqueue(
        url: url, token: nil,
        descriptor: DownloadDescriptor(story: id, kind: "image", remote: remote))
    }
  }
  func receiveDownload(_ descriptor: DownloadDescriptor, file: URL, status: Int, mime: String?)
    async
  {
    await load()
    await withFileWork {
      await self.applyDownload(descriptor, file: file, status: status, mime: mime)
      await self.disk.discard(file)
    }
  }

  // Keep quota checks, eviction and installation ordered while the UI remains interactive.
  private func withFileWork(_ operation: @escaping @MainActor () async -> Void) async {
    let previous = fileWork
    let work = Task {
      await previous?.value
      await operation()
    }
    fileWork = work
    await work.value
  }

  private func applyDownload(_ descriptor: DownloadDescriptor, file: URL, status: Int, mime: String?) async {
    let backdrop = descriptor.kind == "backdrop"
    if backdrop {
      guard descriptor.remote == library.backdrop?["url"].string else { return }
    } else if library.entries[descriptor.story] == nil { return }
    do {
      let bytes = try await disk.size(file)
      guard status == 200, bytes < 20_000_000,
            await makeRoom(bytes, protecting: descriptor.story) else {
        throw NSError(domain: "tab1", code: 507, userInfo: [
          NSLocalizedDescriptionKey: "Storage limit reached; increase the limit in Settings."])
      }
      let payload = try await disk.install(descriptor, file: file, root: root, mime: mime)
      usedBytes = await disk.usage(root)
      if backdrop {
        guard descriptor.remote == library.backdrop?["url"].string else { return }
        library.backdropFile = "backdrop.image"
        backdropGeneration += 1
        persistDownload()
        return
      }
      guard var entry = library.entries[descriptor.story] else { return }
      switch payload {
      case .article(let article):
        entry.article = article
        uncheckedPayloadBytes += bytes
      case .comments(let discussion):
        entry.discussion = discussion
        uncheckedPayloadBytes += bytes
      case .image(let name):
        if let remote = descriptor.remote { entry.assets[remote] = name }
      }
      entry.retryAfter?.removeValue(forKey: descriptor.failureKey)
      entry.failures?.removeValue(forKey: descriptor.failureKey)
      if descriptor.kind == "image" { entry.failures?.removeValue(forKey: "image") }
      entry.error = entry.failures?.values.sorted().first
      library.entries[descriptor.story] = entry
      persistDownload()
      if descriptor.kind == "article" { await queueImages(descriptor.story) }
    } catch {
      if backdrop { lastError = "Could not save the daily photograph" }
      else { downloadFailed(descriptor, error: error.localizedDescription) }
    }
  }
  func downloadFailed(_ descriptor: DownloadDescriptor, error: String, cooldown: TimeInterval = 3600) {
    var dates = library.entries[descriptor.story]?.retryAfter ?? [:]
    dates[descriptor.failureKey] = Date.now.addingTimeInterval(cooldown)
    library.entries[descriptor.story]?.retryAfter = dates
    var failures = library.entries[descriptor.story]?.failures ?? [:]
    failures[descriptor.failureKey] = error
    library.entries[descriptor.story]?.failures = failures
    library.entries[descriptor.story]?.error = error
    persistDownload()
  }
  private func makeRoom(_ bytes: Int64, protecting story: String) async -> Bool {
    usedBytes = await disk.usage(root)
    if usedBytes + uncheckedPayloadBytes + bytes < Int64(budgetGB * 1_000_000_000) { return true }
    // Settle outstanding writes before evicting anything.
    await flushPersistence()
    uncheckedPayloadBytes = 0
    usedBytes = await disk.usage(root)
    if usedBytes + bytes < Int64(budgetGB * 1_000_000_000) { return true }
    let current = Set(library.cards.flatMap(\.items).map(\.id))
    let candidates = library.entries.values.filter {
      $0.id != story && !current.contains($0.id) && library.reading[$0.id]?.saved != true
    }.sorted { $0.collected < $1.collected }
    for entry in candidates {
      guard library.reading[entry.id]?.saved != true,
            !library.cards.contains(where: { $0.items.contains(where: { $0.id == entry.id }) })
      else { continue }
      library.entries.removeValue(forKey: entry.id)
      let retained = Set(library.entries.values.flatMap { $0.assets.values })
      let files = Set(entry.assets.values).subtracting(retained).union([fileID(entry.id) + ".html"])
      await disk.remove(files, root: root)
      persist()
      await flushPersistence()
      usedBytes = await disk.usage(root)
      if usedBytes + bytes < Int64(budgetGB * 1_000_000_000) { return true }
    }
    return false
  }
  private func prune() async {
    guard online else { return }
    let current = Set(library.cards.flatMap(\.items).map(\.id))
    let cutoff = Date.now.addingTimeInterval(-7 * 86400)
    var files = Set<String>()
    for (id, entry) in library.entries
    where !current.contains(id) && library.reading[id]?.saved != true && entry.collected < cutoff {
      library.entries.removeValue(forKey: id)
      files.insert(fileID(id) + ".html")
    }
    let retained = Set(library.entries.values.flatMap { $0.assets.values })
    usedBytes = await disk.prune(root, files: files, retained: retained)
  }
  func toggleProfile(_ category: String, id: String) {
    var settings = library.settings
    var profile = settings["profile"]
    var values = profile[category].array.map(\.string)
    if values.contains(id) { values.removeAll { $0 == id } } else { values.append(id) }
    profile[category] = .array(values.map(JSONValue.string))
    settings["profile"] = profile
    settings["tabs"] = .object([:])
    library.settings = settings
    persist()
  }
}
enum Keychain {
  static func query(_ server: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "tab1.companion",
      kSecAttrAccount as String: server,
    ]
  }
  static func read(server: String) -> String {
    #if targetEnvironment(simulator)
      return UserDefaults.standard.string(forKey: "simulator-token:" + server) ?? ""
    #else
      var q = query(server)
      q[kSecReturnData as String] = true
      var result: CFTypeRef?
      guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess,
        let data = result as? Data
      else { return "" }
      return String(data: data, encoding: .utf8) ?? ""
    #endif
  }
  static func save(_ value: String, server: String) {
    #if targetEnvironment(simulator)
      UserDefaults.standard.set(value, forKey: "simulator-token:" + server)
    #else
      SecItemDelete(query(server) as CFDictionary)
      var q = query(server)
      q[kSecValueData as String] = Data(value.utf8)
      q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      SecItemAdd(q as CFDictionary, nil)
    #endif
  }
}
enum BackgroundRefresh {
  static func register() {
    BGTaskScheduler.shared.register(
      forTaskWithIdentifier: "tab1.dev.skynolimit.refresh", using: nil
    ) { task in run(task) }
    BGTaskScheduler.shared.register(
      forTaskWithIdentifier: "tab1.dev.skynolimit.processing", using: nil
    ) { task in run(task) }
  }
  static func run(_ task: BGTask) {
    let work = Task { @MainActor in
      let store = LibraryStore.shared
      if store.busy {
        // Keep the execution grant until a foreground or reconnect refresh finishes.
        while store.busy && !Task.isCancelled {
          do { try await Task.sleep(for: .milliseconds(500)) } catch { break }
        }
      } else if store.automatic || store.needsRefreshRetry {
        await store.refresh(download: store.automatic)
      }
      task.setTaskCompleted(success: !Task.isCancelled && !store.needsRefreshRetry && store.lastError == nil)
    }
    task.expirationHandler = { work.cancel() }
  }
  static func schedule(online: Bool) {
    let recovery = UserDefaults.standard.bool(forKey: "needsRefreshRetry")
    if !recovery && UserDefaults.standard.object(forKey: "automatic") as? Bool == false {
      BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: "tab1.dev.skynolimit.refresh")
      BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: "tab1.dev.skynolimit.processing")
      return
    }
    let request = BGAppRefreshTaskRequest(identifier: "tab1.dev.skynolimit.refresh")
    request.earliestBeginDate = Date(timeIntervalSinceNow: recovery ? 60 : 3600)
    try? BGTaskScheduler.shared.submit(request)
    let processing = BGProcessingTaskRequest(identifier: "tab1.dev.skynolimit.processing")
    processing.requiresNetworkConnectivity = true
    processing.earliestBeginDate = recovery && !online ? nil : request.earliestBeginDate
    try? BGTaskScheduler.shared.submit(processing)
  }
}

// Serializes filesystem work off the main actor. Only library.json changes size with
// each persistence write, so quota checks need one stat between inventory scans.
private actor LibraryDisk {
  enum Payload {
    case article(Article), comments(Discussion), image(String)
  }
  private var otherBytes: Int64 = 0

  func credential(_ host: String) -> String { Keychain.read(server: host) }
  func saveCredential(_ value: String, host: String) { Keychain.save(value, server: host) }

  func size(_ file: URL) throws -> Int64 {
    Int64(try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0)
  }

  func open(_ directory: URL, reset: Bool) -> (Library, Set<String>, Int64) {
    var root = directory
    if reset { discard(root) }
    try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? root.setResourceValues(values)
    let library: Library
    do {
      library = try JSONDecoder().decode(Library.self, from: Data(contentsOf: root.appending(path: "library.json")))
    } catch {
      homeLog.notice("Offline library load: \(error.localizedDescription, privacy: .public)")
      library = Library()
    }
    let topics = (try? JSONDecoder().decode(Set<String>.self, from: Data(contentsOf: root.appending(path: "app-topics.json")))) ?? []
    inventory(root)
    return (library, topics, usage(root))
  }

  func usage(_ root: URL) -> Int64 {
    otherBytes + ((try? size(root.appending(path: "library.json"))) ?? 0)
  }
  func discard(_ file: URL) { try? FileManager.default.removeItem(at: file) }
  func remove(_ names: Set<String>, root: URL) {
    for name in names {
      let file = root.appending(path: name)
      let bytes = (try? size(file)) ?? 0
      if (try? FileManager.default.removeItem(at: file)) != nil { otherBytes -= bytes }
    }
  }
  private func inventory(_ root: URL) {
    let files = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.fileSizeKey])) ?? []
    otherBytes = files.reduce(0) { total, file in
      total + (file.lastPathComponent == "library.json" ? 0 : ((try? size(file)) ?? 0))
    }
  }
  func prune(_ root: URL, files: Set<String>, retained: Set<String>) -> Int64 {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
    let unused = names.filter { $0.hasSuffix(".image") && $0 != "backdrop.image" && !retained.contains($0) }
    remove(files.union(unused), root: root)
    inventory(root)
    return usage(root)
  }
  func install(_ descriptor: DownloadDescriptor, file: URL, root: URL, mime: String?) throws -> Payload {
    switch descriptor.kind {
    case "article": return .article(try JSONDecoder().decode(Article.self, from: Data(contentsOf: file)))
    case "comments": return .comments(try JSONDecoder().decode(Discussion.self, from: Data(contentsOf: file)))
    default:
      guard let remote = descriptor.remote, mime?.hasPrefix("image/") == true else {
        throw URLError(.cannotDecodeContentData)
      }
      let backdrop = descriptor.kind == "backdrop"
      let name = backdrop ? "backdrop.image" : fileID(remote) + ".image"
      let destination = root.appending(path: name)
      if backdrop {
        let previous = (try? size(destination)) ?? 0
        let data = try Data(contentsOf: file)
        try data.write(to: destination, options: .atomic)
        otherBytes += Int64(data.count) - previous
      } else if !FileManager.default.fileExists(atPath: destination.path) {
        try FileManager.default.copyItem(at: file, to: destination)
        otherBytes += try size(destination)
      }
      return .image(name)
    }
  }
}
