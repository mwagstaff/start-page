import GoogleSignIn
import AuthenticationServices
import AVFoundation
import SwiftUI
import WebKit

@main struct Tab1App: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
  @State private var store = LibraryStore.shared
  @Environment(\.scenePhase) private var phase
  var body: some Scene {
    WindowGroup {
      Group {
        if store.ready { RootView() } else { ProgressView("Opening offline library…") }
      }.environment(store).onOpenURL { url in
        if !GIDSignIn.sharedInstance.handle(url), url.scheme == "tab1" { Task { await store.pair(url.absoluteString) } }
      }.onReceive(NotificationCenter.default.publisher(for: ASAuthorizationAppleIDProvider.credentialRevokedNotification)) { _ in
        Task { await store.checkAppleCredential() }
      }.task {
        await store.load()
        await store.checkAppleCredential()
        if phase != .background && store.online { await store.refresh(download: store.automatic) }
        while !Task.isCancelled {
          do { try await Task.sleep(for: .seconds(60)) } catch { break }
          if phase == .active && store.online && !store.hasScheduledRetry
            && Date.now.timeIntervalSince(store.library.updated ?? .distantPast) > 900
          {
            await store.refresh(download: store.automatic)
          }
        }
      }.onChange(of: phase) { _, value in
        if value == .active {
          DownloadDiagnostics.shared.activated()
          StoryPush.shared.activated()
          Task { await BackgroundRefresh.logForegroundRequests() }
          Task { await BackgroundDownloads.shared.logQueue("activation") }
        }
        if value == .active && store.online
          && (store.needsRefreshRetry || Date.now.timeIntervalSince(store.library.updated ?? .distantPast) > 900)
        {
          Task { await store.refresh(download: store.automatic) }
        } else if value == .active && store.ready && store.online && store.accountActive {
          Task { await store.refreshAccountPreferences() }
        }
        if value == .background {
          AppDelegate.refreshOnBackgroundEntry()
        }
      }
    }
  }
}
struct RootView: View {
  @Environment(LibraryStore.self) private var store
  @Environment(\.scenePhase) private var phase
  @State private var archiveGroup: String?
  @State private var archiveVisit = UUID()
  @State private var selected = FeedTab.latest
  @State private var archivePath = NavigationPath()
  var body: some View {
    TabView(selection: $selected) {
      Tab("Latest", systemImage: "rectangle.grid.1x2", value: FeedTab.latest) {
        HomeView { group in
          archiveGroup = group
          archiveVisit = UUID()
          archivePath = NavigationPath()
          selected = .archive
        }
      }
      Tab("All stories", systemImage: "newspaper", value: FeedTab.archive) {
        AllStoriesView(path: $archivePath, firstGroup: archiveGroup).id(archiveVisit)
      }
      Tab("Saved", systemImage: "bookmark", value: FeedTab.saved) { SavedView() }
      Tab("Settings", systemImage: "slider.horizontal.3", value: FeedTab.settings) { SettingsView() }
    }.tint(.indigo)
      .onChange(of: selected) { _, tab in store.library.beginFeedVisit(latest: tab == .latest) }
      .onChange(of: phase) { _, phase in
        if phase == .background { store.library.beginFeedVisit(latest: selected == .latest) }
      }
  }
}
private enum FeedTab { case latest, archive, saved, settings }

private struct SummaryReader: View {
  @Environment(LibraryStore.self) private var store
  @State private var summaryError: String?
  let story: Story

  var body: some View {
    let summary = store.library.entries[story.id]?.story.summary ?? story.summary
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        Text(story.title).font(.title2.bold())
        if let recap = summary?.recap {
          Text("AI story summary").font(.headline)
          Text(verbatim: recap)
        } else if summary?.unavailable == true, let excerpt = story.excerpt {
          Text("Publisher excerpt").font(.headline)
          Text(verbatim: excerpt)
        } else if summary?.unavailable == true { Text("Article text unavailable.") }
        if let thread = summary?.discussion {
          Text("AI discussion summary").font(.headline)
          ForEach(Array(thread.bullets.enumerated()), id: \.offset) { _, line in Text("• " + line) }
          Text("Based on \(thread.count) of \(thread.total) comments").font(.caption)
          if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(thread.updated) {
            Text(date.formatted()).font(.caption)
          }
        }
        if let summaryError { Text(summaryError) }
        else if summary?.pending != false { Text(store.online ? "Preparing summary…" : "Connect to check for a summary.") }
        if let url = URL(string: story.link) { Link("Open original story", destination: url) }
      }.frame(maxWidth: .infinity, alignment: .leading).padding().textSelection(.enabled)
    }.task(id: store.online) {
      summaryError = nil
      guard store.online else { return }
      do {
        while try await store.refreshSummary(story).pending {
          try await Task.sleep(for: .seconds(8))
        }
      } catch { if !Task.isCancelled && summary?.pending != false { summaryError = "Couldn’t update the summary." } }
    }
  }
}

struct ReaderView: View {
  @Environment(LibraryStore.self) private var store
  let story: Story
  enum Section: Hashable { case article, comments, summary }
  @AppStorage("readWhenOpened") private var readWhenOpened = true
  @State var selection = Section.article
  var discussion: Bool { selection == .comments }
  var entry: Entry? { store.library.entries[story.id] }
  var body: some View {
    VStack(spacing: 0) {
      if let status = store.downloadStatus(story.id) {
        HStack {
          ProgressView()
          Text(status).font(.callout)
        }.padding()
      }
      let summaryReady = (entry?.story.summary ?? story.summary)?.isReady == true
      HStack {
        Picker("Read", selection: $selection) {
          Text("Article").tag(Section.article)
          if story.commentsUrl != nil { Text("Comments").tag(Section.comments) }
          if summaryReady { Text("Summary").tag(Section.summary) }
        }.pickerStyle(.segmented)
        if !summaryReady { PendingSummary(story: story).font(.subheadline) }
      }
      .padding([.top, .horizontal])
      .padding(.bottom, discussion && entry?.discussion != nil ? 0 : 16)
      if selection == .summary {
        SummaryReader(story: story)
      } else if discussion {
        if let thread = entry?.discussion {
          HStack(spacing: 8) {
            Text(thread.savedSummary)
            Spacer(minLength: 0)
            if let date = thread.updatedDate {
              TimelineView(.periodic(from: date, by: 60)) { context in
                Text(Discussion.updatedLabel(since: date, at: context.date))
                  .accessibilityLabel("Updated \(date.formatted(date: .long, time: .shortened))")
              }
            }
            commentRefreshButton.labelStyle(.iconOnly).buttonStyle(.borderless)
          }
          .font(.caption)
          .foregroundStyle(.secondary)
          .padding(.horizontal)
          commentError
          if !thread.complete {
            Button("Download all comments") {
              Task { await store.downloadComments(story.id, allComments: true, refresh: true) }
            }.disabled(!store.online || fetchingComments)
          }
          List {
            ForEach(thread.ordered) { comment in
              VStack(alignment: .leading, spacing: 8) {
                Text(comment.author).font(.caption.bold()).foregroundStyle(.indigo)
                Text(comment.linkedText(relativeTo: story.commentsUrl)).textSelection(.enabled)
              }.padding(.leading, CGFloat(min(comment.depth, 5)) * 10)
            }
          }
          .contentMargins(.top, 0, for: .scrollContent)
        } else {
          ContentUnavailableView(
            "Comments not downloaded", systemImage: "text.bubble",
            description: Text("Download this discussion while connected to read it offline."))
          commentRefreshButton.padding()
          commentError
        }
      } else if let article = entry?.article {
        OfflineReader(article: article, entry: entry!, root: store.root)
      } else {
        ScrollView {
          VStack(alignment: .leading, spacing: 20) {
            Text(story.title).font(.largeTitle.bold())
            Text(entry?.error ?? "This article hasn’t been saved yet.").foregroundStyle(.secondary)
            retryButton
            if let url = URL(string: story.link) {
              Link("Open publisher website", destination: url)
            }
          }.padding()
        }
      }
    }.navigationTitle(story.source ?? "Story").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button(
            store.library.reading[story.id]?.saved == true ? "Unsave" : "Save",
            systemImage: store.library.reading[story.id]?.saved == true
              ? "bookmark.fill" : "bookmark"
          ) { store.setReading(story, saved: store.library.reading[story.id]?.saved != true) }
        }
        ToolbarItem(placement: .topBarTrailing) {
          if let url = URL(string: story.link) { ShareLink(item: url) }
        }
      }.task(id: discussion) {
        if discussion && store.online && entry?.discussion == nil {
          await store.downloadComments(story.id)
        }
      }.onChange(of: selection, initial: true) { _, section in
        if readWhenOpened && section != .comments { store.markRead([story.id]) }
      }
      .task(id: story.id) {
        if store.online && store.automatic && (entry?.article == nil || entry?.article?.needsImageUpgrade == true) {
          await store.download(story.id, automaticRetry: true)
        }
      }
  }
  private var fetchingComments: Bool {
    store.downloadActivity[DownloadDescriptor(story: story.id, kind: "comments").key] != nil
  }
  private var commentRefreshButton: some View {
    Button {
      Task { await store.downloadComments(story.id, refresh: true) }
    } label: {
      Label(fetchingComments ? "Updating comments…" : (entry?.discussion == nil ? "Download comments" : "Refresh comments"),
            systemImage: "arrow.clockwise")
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
    }
    .disabled(!store.online || fetchingComments)
  }
  @ViewBuilder private var commentError: some View {
    if let error = entry?.failures?["comments"] { Text(error).font(.caption) }
  }
  private var retryButton: some View {
    Button(
      entry?.error != nil
        ? "Retry download"
        : (story.commentsUrl == nil ? "Download article" : "Download article and comments")
    ) {
      Task { await store.download(story.id) }
    }
    .buttonStyle(.borderedProminent)
    .disabled(store.downloadStatus(story.id) != nil)
    .accessibilityIdentifier("retry-download")
  }
}
struct OfflineReader: UIViewRepresentable {
  @Environment(\.openURL) private var openURL
  let article: Article
  let entry: Entry
  let root: URL
  func makeUIView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.defaultWebpagePreferences.allowsContentJavaScript = false
    let web = WKWebView(frame: .zero, configuration: config)
    web.isOpaque = false
    web.navigationDelegate = context.coordinator
    return web
  }
  func makeCoordinator() -> Coordinator { Coordinator(open: { openURL($0) }) }
  final class Coordinator: NSObject, WKNavigationDelegate {
    struct Snapshot: Equatable {
      var title: String
      var content: String
      var assets: [String: String]
      var original: String
      var root: URL
    }
    var snapshot: Snapshot?
    var renderTask: Task<Void, Never>?
    var files: Set<URL> = []
    var restoreOffset: CGPoint?
    var open: (URL) -> Void
    init(open: @escaping (URL) -> Void) { self.open = open }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      if let offset = restoreOffset {
        restoreOffset = nil
        webView.scrollView.setContentOffset(offset, animated: false)
      }
      let current = webView.url?.deletingPathExtension().lastPathComponent
      for file in files where file.deletingPathExtension().lastPathComponent != current {
        try? FileManager.default.removeItem(at: file)
        files.remove(file)
      }
    }
    func webView(
      _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
      decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
      if let url = action.request.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
        decisionHandler(.cancel)
        if action.navigationType == .linkActivated { open(url) }
        return
      }
      decisionHandler(action.request.url?.isFileURL == true ? .allow : .cancel)
    }
  }
  func updateUIView(_ web: WKWebView, context: Context) {
    let coordinator = context.coordinator
    coordinator.open = { openURL($0) }
    let snapshot = Coordinator.Snapshot(
      title: article.title, content: article.html,
      assets: entry.assets, original: entry.story.link, root: root)
    guard coordinator.snapshot != snapshot else { return }
    coordinator.snapshot = snapshot
    coordinator.renderTask?.cancel()
    coordinator.renderTask = Task { @MainActor [weak web, weak coordinator] in
      // Coalesce arriving images, and do all HTML rewriting and file I/O away
      // from the UI thread. Each generation owns its file, so cancelled renders
      // cannot overwrite the document being displayed.
      do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
      let file = snapshot.root.appending(path: "reader-" + UUID().uuidString + ".html")
      let preparation = Task.detached(priority: .utility) {
        let html = offlineArticleHTML(
          title: snapshot.title, content: snapshot.content,
          assets: snapshot.assets, original: snapshot.original)
        try html.write(to: file, atomically: true, encoding: .utf8)
      }
      do { try await preparation.value } catch { return }
      guard !Task.isCancelled, let web, let coordinator else {
        try? FileManager.default.removeItem(at: file)
        return
      }
      // Never reload during a gesture or momentum scrolling.
      while web.scrollView.isTracking || web.scrollView.isDragging || web.scrollView.isDecelerating
      {
        do { try await Task.sleep(for: .milliseconds(150)) } catch {
          try? FileManager.default.removeItem(at: file)
          return
        }
      }
      guard !Task.isCancelled else {
        try? FileManager.default.removeItem(at: file)
        return
      }
      coordinator.restoreOffset = web.url == nil ? nil : web.scrollView.contentOffset
      coordinator.files.insert(file)
      web.loadFileURL(file, allowingReadAccessTo: snapshot.root)
    }
  }
  static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
    coordinator.renderTask?.cancel()
    web.stopLoading()
    web.navigationDelegate = nil
    for file in coordinator.files { try? FileManager.default.removeItem(at: file) }
  }

}
struct SavedView: View {
  @Environment(LibraryStore.self) private var store
  var body: some View {
    NavigationStack {
      List {
        ForEach(
          store.library.entries.values.filter { store.library.reading[$0.id]?.saved == true }.sorted
          { $0.collected > $1.collected }
        ) { entry in
          VStack(alignment: .leading) {
            NavigationLink(value: entry.story) { StoryRow(story: entry.story) }.buttonStyle(.plain)
            StoryActions(story: entry.story)
          }
        }
      }.overlay {
        if !store.library.reading.values.contains(where: { $0.saved }) {
          ContentUnavailableView(
            "Keep something good", systemImage: "bookmark",
            description: Text("Save articles to keep them beyond seven days."))
        }
      }.navigationTitle("Saved").navigationDestination(for: ReaderRoute.self) { $0.reader }.navigationDestination(for: Story.self) { ReaderView(story: $0) }
    }
  }
}
struct DownloadProgressView: View {
  @Environment(LibraryStore.self) private var store
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let compact: Bool

  private var title: String {
    if compact { return "Downloading articles" }
    if store.hasActiveDownloads {
      return store.totalFiles == 0 ? "Preparing downloads…" : "Downloading"
    }
    return store.failedFiles > 0 ? "Download pass finished" : "Downloads complete"
  }

  var body: some View {
    let saved = compact ? store.savedFirstAttemptArticles : store.finishedFiles
    let failed = compact ? 0 : store.failedFiles
    let processed = saved + failed
    let total = compact ? saved + store.firstAttemptStoryDownloads : store.totalFiles - store.queuedRetryCount
    let count = "\(saved) of \(total) downloaded"
    VStack(alignment: .leading, spacing: compact ? 3 : 8) {
      ViewThatFits(in: .horizontal) {
        HStack {
          Text(title)
          Spacer(minLength: 8)
          if total > 0 { Text(count).foregroundStyle(.secondary) }
        }
        VStack(alignment: .leading) {
          Text(title)
          if total > 0 { Text(count).foregroundStyle(.secondary) }
        }
      }
      .font(compact ? .caption : .headline)
      let fraction = total > 0 ? Double(processed) / Double(total) : 0
      ProgressView(value: fraction)
        .progressViewStyle(.linear)
        .controlSize(compact ? .small : .large)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: fraction)
      if !compact && store.failedFiles > 0 {
        Text("\(store.failedFiles) unavailable")
          .foregroundStyle(.secondary).font(.subheadline)
      }
    }
    .padding(.vertical, compact ? 0 : 6)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text(title))
    .accessibilityValue(Text(total == 0 ? "" : count + (failed > 0 ? ", \(failed) failed" : "")))
    .accessibilityIdentifier("download-progress")
  }
}

struct DownloadDetails: View {
  @Environment(LibraryStore.self) private var store
  var body: some View {
    List {
        Section {
          if store.showsDownloadProgress || (!store.hasActiveDownloads && store.totalFiles > 0 && !store.busy) {
            DownloadProgressView(compact: false)
          } else {
            CardRefreshMessage()
          }
          let images = store.pendingImages
          if images > 0 {
            Text(images == 1 ? "1 image pending" : "\(images) images pending")
              .font(.subheadline).foregroundStyle(.secondary)
              .accessibilityIdentifier("pending-images")
          }
          let retries = store.queuedRetryCount
          if retries > 0 {
            Text(retries == 1 ? "1 file queued for automatic retry" : "\(retries) files queued for automatic retry")
              .font(.subheadline).foregroundStyle(.secondary)
              .accessibilityIdentifier("queued-retries")
          } else if !store.online && store.hasActiveDownloads {
            Text("Waiting for connection").foregroundStyle(.secondary)
          }
          Button(
            store.busy ? "Downloading…" : "Download for offline", systemImage: "arrow.down.circle"
          ) { Task { await store.refresh() } }.disabled(store.busy || store.hasActiveDownloads)
          if !store.failedDownloadIDs.isEmpty {
            DisclosureGroup("Download failures") {
              if store.automatic {
                Text("Recent and saved stories are checked again automatically.")
                  .font(.footnote).foregroundStyle(.secondary)
              }
              Button("Retry now", systemImage: "arrow.clockwise") {
                Task { await store.retryFailedDownloads() }
              }
              .disabled(store.retryableDownloadIDs.isEmpty)
              .accessibilityIdentifier("retry-failed-downloads")
              ForEach(store.failedDownloadIDs, id: \.self) { id in
                if let entry = store.library.entries[id] {
                  VStack(alignment: .leading) {
                    Text(entry.story.title)
                    if let failures = entry.failures, !failures.isEmpty {
                      ForEach(failures.keys.sorted(), id: \.self) { key in
                        let kind = key.hasPrefix("image") ? "Image" : key.capitalized
                        Text("\(kind) · \(failures[key] ?? "")").font(.caption).foregroundStyle(.secondary)
                      }
                    } else { Text(entry.status).font(.caption) }
                  }
                }
              }
            }
          }
          if let error = store.lastError { Text(error).foregroundStyle(.orange) }
        }
        Section("On this device") {
          LabeledContent(
            "Articles", value: "\(store.downloadedStoryCount)")
          LabeledContent(
            "Discussions",
            value: "\(store.library.entries.values.filter{$0.discussion != nil}.count)")
          LabeledContent(
            "Storage",
            value: ByteCountFormatter.string(fromByteCount: store.usedBytes, countStyle: .file))
          Text(
            "Current cards and seven days of stories. Saved favourites are retained. Background updates run when iOS permits."
          ).font(.footnote).foregroundStyle(.secondary)
        }
        Section {
          NavigationLink("Background download log") { DownloadLogView() }
        }
    }.navigationTitle("Download details")
  }
}
private struct DownloadLogView: View {
  @State private var report = ""
  var body: some View {
    ScrollView {
      Text(verbatim: report)
        .font(.system(.footnote, design: .monospaced))
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled).padding()
    }
    .navigationTitle("Background download log")
    .navigationBarTitleDisplayMode(.inline)
    .onAppear { report = DownloadDiagnostics.shared.report() }
    .toolbar { ShareLink(item: report) { Label("Share log", systemImage: "square.and.arrow.up") } }
  }
}

struct SettingsView: View {
  @Environment(LibraryStore.self) private var store
  @AppStorage("readWhenOpened") private var readWhenOpened = true
  @AppStorage("readWhenPassed") private var readWhenPassed = true
  @State private var scan = false
  @State private var pairing = ""
  @State private var showAdvanced = false
  var body: some View {
    @Bindable var store = store
    NavigationStack {
      Form {
        Section {
          NavigationLink("App-only topics") { AppTopicsView() }
          Text("Add more reading on this iPhone without changing your website homepage.")
            .font(.footnote).foregroundStyle(.secondary)
        }
        Section { NavigationLink("Account") { AccountView() } }
        Section("Your website") {
          Button("Connect website", systemImage: "qrcode.viewfinder") { scan = true }
          TextField("Paste a pairing link", text: $pairing).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          if !pairing.isEmpty {
            Button("Connect") {
              Task {
                await store.pair(pairing)
                pairing = ""
              }
            }
          }
          Text(
            "On tab1.net, choose Connect iPhone. Scan its QR code to sync settings, favourites and reading status."
          ).font(.footnote).foregroundStyle(.secondary)
        }
        .disabled(store.accountActive)
        Section("Synced homepage topics") {
          ForEach(store.library.catalogue["topics"].object.keys.sorted(), id: \.self) { id in
            Toggle(
              store.library.catalogue["topics"][id]["label"].string,
              isOn: Binding(
                get: { store.library.settings["profile"]["topics"].array.contains(.string(id)) },
                set: { _ in store.toggleProfile("topics", id: id) }))
          }
        }
        Section("Synced homepage sources") {
          ForEach(store.library.catalogue["outlets"].object.keys.sorted(), id: \.self) { id in
            Toggle(
              store.library.catalogue["outlets"][id]["name"].string,
              isOn: Binding(
                get: { store.library.settings["profile"]["outlets"].array.contains(.string(id)) },
                set: { _ in store.toggleProfile("outlets", id: id) }))
          }
        }
        Section { NavigationLink("Cards, display and custom feeds") { PreferencesView() } }
        Section("Reading") {
          Toggle("Mark as read when opened", isOn: $readWhenOpened)
          Toggle("Scroll to mark as read", isOn: $readWhenPassed)
        }
        Section("Offline reading") {
          Toggle("Automatic downloads", isOn: $store.automatic)
          Picker("Storage limit", selection: $store.budgetGB) {
            Text("1 GB").tag(1.0)
            Text("2 GB").tag(2.0)
            Text("5 GB").tag(5.0)
          }
          Text(
            "Downloads use Wi-Fi and cellular. Up to 500 comments per discussion are saved automatically."
          ).font(.footnote).foregroundStyle(.secondary)
        }
        Section {
          Button("Apply and refresh") { Task { await store.refresh(download: store.automatic) } }
          Button("Advanced settings") { showAdvanced.toggle() }
          if showAdvanced {
            TextField("Server URL", text: $store.server).disabled(store.accountActive).textInputAutocapitalization(.never)
              .autocorrectionDisabled()
            Text("For local testing, use your Mac’s network address and the website server port.")
              .font(.caption)
          }
        }
      }.navigationTitle("Settings").sheet(isPresented: $scan) {
        ScannerView { value in
          scan = false
          Task { await store.pair(value) }
        }.ignoresSafeArea().overlay(alignment: .topTrailing) {
          Button("Cancel") { scan = false }.padding().buttonStyle(.borderedProminent)
        }
      }
    }
  }
}
struct WeatherView: View {
  @Environment(LibraryStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          Text(store.library.weather["name"].string).font(.title)
          Text("\(Int(store.library.weather["temperature"].number))°").font(
            .system(size: 72, weight: .light))
          Text(store.library.weather["label"].string)
          if let updated = store.library.updated {
            Text("Forecast saved \(updated.formatted())").foregroundStyle(.secondary)
          }
          Text("The last downloaded forecast remains available offline.").font(.footnote)
        }.padding()
      }.navigationTitle("Weather").toolbar { Button("Done") { dismiss() } }
    }
  }
}
struct ScannerView: UIViewControllerRepresentable {
  let found: (String) -> Void
  func makeUIViewController(context: Context) -> ScannerController {
    let controller = ScannerController()
    controller.found = found
    return controller
  }
  func updateUIViewController(_ controller: ScannerController, context: Context) {}
  static func dismantleUIViewController(_ controller: ScannerController, coordinator: ()) {
    controller.stop()
  }
}
final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  let session = AVCaptureSession()
  let queue = DispatchQueue(label: "tab1.camera")
  var found: ((String) -> Void)?
  var finished = false
  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    AVCaptureDevice.requestAccess(for: .video) { allowed in
      guard allowed else {
        DispatchQueue.main.async {
          let label = UILabel()
          label.text = "Camera access is needed to scan. You can paste a pairing link instead."
          label.textColor = .white
          label.numberOfLines = 0
          label.frame = self.view.bounds.insetBy(dx: 30, dy: 100)
          self.view.addSubview(label)
        }
        return
      }
      self.queue.async { self.configure() }
    }
  }
  func configure() {
    guard let device = AVCaptureDevice.default(for: .video),
      let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input)
    else { return }
    session.addInput(input)
    let output = AVCaptureMetadataOutput()
    guard session.canAddOutput(output) else { return }
    session.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: .main)
    output.metadataObjectTypes = [.qr]
    DispatchQueue.main.async {
      let preview = AVCaptureVideoPreviewLayer(session: self.session)
      preview.videoGravity = .resizeAspectFill
      preview.frame = self.view.bounds
      self.view.layer.insertSublayer(preview, at: 0)
    }
    session.startRunning()
  }
  func metadataOutput(
    _ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard !finished,
      let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue,
      value.hasPrefix("tab1://pair")
    else { return }
    finished = true
    stop()
    found?(value)
  }
  func stop() { queue.async { self.session.stopRunning() } }
}

func webSearchURL(_ settings: JSONValue, query: String) -> URL? {
  let providers = [
    "google": "https://www.google.com/search?q={query}",
    "bing": "https://www.bing.com/search?q={query}",
    "duckduckgo": "https://duckduckgo.com/?q={query}",
    "yahoo": "https://search.yahoo.com/search?p={query}",
    "brave": "https://search.brave.com/search?q={query}",
    "ecosia": "https://www.ecosia.org/search?q={query}",
  ]
  let template =
    settings["provider"].string == "custom"
    ? settings["custom"]["url"].string
    : providers[settings["provider"].string] ?? providers["google"]!
  let encoded = query.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics) ?? ""
  guard let url = URL(string: template.replacingOccurrences(of: "{query}", with: encoded)),
    ["http", "https"].contains(url.scheme ?? "")
  else { return nil }
  return url
}

struct HomeBackdrop: View {
  @Environment(LibraryStore.self) private var store
  @State private var image: UIImage?
  private struct Photo: Hashable {
    let url: URL?
    let generation: Int
  }
  var body: some View {
    let enabled = store.library.settings["profile"]["backdrop"] != .bool(false)
    let photo = Photo(
      url: enabled ? store.library.backdropFile.map { store.root.appending(path: $0) } : nil,
      generation: store.backdropGeneration)
    GeometryReader { proxy in
      if enabled, let image {
        Image(uiImage: image).resizable().scaledToFill().frame(
          width: proxy.size.width, height: proxy.size.height
        ).clipped().overlay(Color(.systemBackground).opacity(0.35))
      } else {
        Color.indigo.opacity(0.05)
      }
    }.ignoresSafeArea().accessibilityHidden(true)
      .task(id: photo) {
        guard let url = photo.url else { image = nil; return }
        let loaded = await Task.detached(priority: .utility) {
          UIImage(contentsOfFile: url.path)
        }.value
        guard !Task.isCancelled else { return }
        image = loaded
        if loaded == nil { homeLog.error("Cached backdrop could not be loaded") }
      }
  }
}

struct AppTopicsView: View {
  @Environment(LibraryStore.self) private var store
  @State private var search = ""
  var body: some View {
    List {
      Section {
        Text(
          "These extra topics stay on this iPhone. Their stories are included in automatic downloads and use the same storage budget. Your website selections stay unchanged."
        )
        .font(.footnote).foregroundStyle(.secondary)
      }
      Section("Extra reading") {
        ForEach(
          store.library.catalogue["topics"].object.keys.sorted().filter {
            search.isEmpty
              || store.library.catalogue["topics"][$0]["label"].string
                .localizedCaseInsensitiveContains(search)
          }, id: \.self
        ) { id in
          Toggle(
            store.library.catalogue["topics"][id]["label"].string,
            isOn: Binding(
              get: { store.appTopics.contains(id) }, set: { store.setAppTopic(id, enabled: $0) })
          )
          .accessibilityIdentifier("app-topic-" + id)
        }
      }
      Section {
        Text(
          "Topics already shown on your homepage are not duplicated. Removing an extra topic stops collecting it; previously downloaded stories remain in Downloads until their normal expiry."
        )
        .font(.footnote).foregroundStyle(.secondary)
      }
    }.navigationTitle("App-only topics").searchable(text: $search, prompt: "Find a topic")
      .onDisappear { Task { await store.refreshAppTopics() } }
  }
}
