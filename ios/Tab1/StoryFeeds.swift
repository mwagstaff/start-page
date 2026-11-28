import ImageIO
import SwiftUI

private struct FeedContents {
  var cards: [Card] = []
  var ids: Set<String> = []
  var remaining: [FeedGroup: [String]] = [:]
  @MainActor init(_ library: LiveLibrary, showRead: Bool) {
    let settings = library.settings["tabs"]["home"]["cards"].array
    var groupsByTitle: [String: FeedGroup] = [:]
    var groupsByID: [String: FeedGroup] = [:]
    for var card in library.cards {
      let group = FeedGroup(card: card)
      groupsByTitle[group.title.lowercased()] = group
      groupsByID[group.id] = group
      let limit = settings.first { $0["id"].string == card.id }?["limit"].number
      let count = limit.flatMap { Int(exactly: $0) }.flatMap { $0 > 0 ? $0 : nil } ?? 8
      var latest: [Story] = []
      for story in card.items where showRead || !library.excludedFromLatest.contains(story.id) {
        guard ids.insert(story.id).inserted else { continue }
        latest.append(story)
        if latest.count == count { break }
      }
      card.items = latest
      cards.append(card)
    }
    for (id, item) in library.feedItems where !ids.contains(id) {
      guard showRead || !library.hiddenThisVisit.contains(id) else { continue }
      // Pre-upgrade entries outside the current cards only have a source name.
      let group = item.group.id.hasPrefix("source:") ? groupsByTitle[item.group.title.lowercased()] ?? item.group : item.group
      let canonical = groupsByID[group.id] ?? group
      groupsByID[group.id] = canonical
      remaining[canonical, default: []].append(id)
    }
  }
}

private struct FeedCardHeader: View {
  let group: FeedGroup
  let count: Int
  var body: some View {
    HStack {
      Text(group.title).font(.title3.bold()).accessibilityAddTraits(.isHeader)
      if group.id.hasPrefix("app-") { Text("App only").font(.caption).foregroundStyle(.secondary) }
      Spacer()
      Text("\(count)").font(.caption).foregroundStyle(.secondary)
    }
  }
}

struct HomeView: View {
  let openArchive: (String?) -> Void
  @Environment(LibraryStore.self) private var store
  @Environment(\.openURL) private var openURL
  @State private var search = ""
  @State private var weather = false
  @State private var showingSearch = false
  @State private var showAccountSettings = false
  @State private var showingSignIn = false
  @State private var accountInitial = ""
  @FocusState private var searchFocused: Bool
  @AppStorage("showReadStories") private var showRead = false
  @State private var tracker = PassedHeadlines()
  @State private var path = NavigationPath()
  var body: some View {
    let edition = FeedContents(store.library, showRead: showRead)
    let cards = (search.isEmpty ? edition.cards : store.library.cards).map { original in
      var card = original
      card.items = card.items.filter {
        (showRead || !store.library.hiddenThisVisit.contains($0.id))
          && (search.isEmpty || $0.title.localizedCaseInsensitiveContains(search))
      }
      return card
    }
    let hasUnreadLatest = edition.ids.contains { store.library.reading[$0]?.read != true }
    NavigationStack(path: $path) {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          HomeStatus()
          if !search.isEmpty {
            Button("Search the web", systemImage: "magnifyingglass") {
              if let url = webSearchURL(store.library.settings["search"], query: search) {
                openURL(url)
              }
            }.disabled(!store.online)
          }
          if let error = store.lastError { Text(error).font(.footnote).foregroundStyle(.orange) }
          if store.library.cards.isEmpty {
            ContentUnavailableView(
              "Your day, in one place", systemImage: "newspaper",
              description: Text("Pull to refresh, or connect your website settings in Settings."))
          }
          LazyVStack(
            alignment: .leading,
            spacing: store.library.settings["density"].string == "compact" ? 12 : 22
          ) {
            ForEach(cards) { card in
              let items = card.items
              let more = edition.remaining[FeedGroup(card: card)] != nil
              if !items.isEmpty || (more && search.isEmpty) || card.failedSources?.isEmpty == false {
                VStack(alignment: .leading, spacing: 8) {
                  FeedCardHeader(group: FeedGroup(card: card), count: items.count)
                  ForEach(items) { story in
                    FeedStory(story: story, tracker: tracker)
                    if story.id != items.last?.id { Divider() }
                  }
                  if more && search.isEmpty {
                    Button("More stories", systemImage: "chevron.right") { openArchive(card.id) }
                      .frame(maxWidth: .infinity).padding(.vertical, 8)
                      .accessibilityIdentifier("more-" + card.id)
                  }
                  if let sources = card.failedSources, !sources.isEmpty {
                    let names = sources.formatted(.list(type: .and))
                    let hasOlderStories = card.items.contains { sources.contains($0.source ?? "") }
                    Text("Couldn’t update \(names)." + (hasOlderStories ? " Showing previously fetched stories." : "")).font(.caption).foregroundStyle(
                      .orange)
                  }
                }.padding(store.library.settings["density"].string == "compact" ? 10 : 16).background(
                  .regularMaterial, in: RoundedRectangle(cornerRadius: 20))
                .onAppear {
                  if card.id == store.library.cards.first?.id {
                    homeLog.notice("First Home card appeared stories=\(card.items.count)")
                  }
                }
              }
            }
            if !hasUnreadLatest && store.library.cards.contains(where: { !$0.items.isEmpty }) && search.isEmpty {
              let more = edition.remaining.values.contains { ids in ids.contains { store.library.reading[$0]?.read != true } }
              if more || !showRead {
                CaughtUpView(hasMore: more, action: { if more { openArchive(nil) } else { showRead = true } })
              }
            }
          }
        }.padding().coordinateSpace(name: tracker.space)
          .onAppear {
            homeLog.notice("Home content appeared cards=\(store.library.cards.count) cachedBackdrop=\(store.library.backdropFile != nil)")
          }
      }
      .modifier(FeedScrollTracking(tracker: tracker, enabled: path.isEmpty, ids: cards.flatMap { $0.items.map(\.id) }))
      .onChange(of: search) { tracker.reset() }
      .onChange(of: showingSearch) { tracker.reset() }
      .scrollBounceBehavior(.always, axes: .vertical)
      .refreshable {
        tracker.reset()
        store.library.beginFeedVisit(latest: true)
        store.requestHomeRefresh()
      }
      .onGeometryChange(for: CGSize.self) { $0.size } action: { size in
        homeLog.notice("Home viewport width=\(Int(size.width)) height=\(Int(size.height)) cards=\(store.library.cards.count)")
      }
      .background { HomeBackdrop().allowsHitTesting(false) }
        .navigationTitle("Latest")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .top, spacing: 0) {
          if showingSearch {
            HStack(spacing: 12) {
              HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                  .accessibilityHidden(true)
                TextField("Search downloaded headlines", text: $search)
                  .focused($searchFocused)
                  .submitLabel(.search)
                  .accessibilityIdentifier("home-search-field")
                if !search.isEmpty {
                  Button("Clear search", systemImage: "xmark.circle.fill") { search = "" }
                    .labelStyle(.iconOnly)
                }
              }
              .padding(12)
              .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
              Button("Cancel") {
                searchFocused = false
                search = ""
                showingSearch = false
              }
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
            .task { searchFocused = true }
          }
        }
        .toolbar {
          ToolbarItem(placement: .topBarLeading) { ReadFilter(showRead: $showRead) }
          ToolbarItemGroup(placement: .topBarTrailing) {
            Button("Search", systemImage: "magnifyingglass") {
              showingSearch = true
              searchFocused = true
            }
            .accessibilityIdentifier("home-search-button")
            if store.library.settings["profile"]["weather"] != .bool(false) {
              Button("Weather", systemImage: "cloud.sun") { weather = true }
            }
          }
          ToolbarItem(placement: .topBarTrailing) {
            if store.accountActive {
              Menu {
                Button("Account settings", systemImage: "person.crop.circle") { showAccountSettings = true }
                Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right") {
                  Task {
                    do { try await store.signOut() } catch { store.lastError = error.localizedDescription }
                  }
                }
              } label: {
                Group {
                  if store.signInProvider == "apple" && accountInitial.isEmpty { Image(systemName: "apple.logo").font(.headline) }
                  else if store.signInProvider == "google" { Text(accountInitial.isEmpty ? "G" : accountInitial).font(.headline) }
                  else if accountInitial.isEmpty { Image(systemName: "checkmark").font(.headline.bold()) }
                  else { Text(accountInitial).font(.headline) }
                }
                .foregroundStyle(.white)
                .frame(width: 30, height: 30)
                .background(store.signInProvider == "apple" ? Color.black : store.signInProvider == "google" ? Color.brown : Color.indigo, in: Circle())
                .overlay { Circle().strokeBorder(store.signInProvider == "google" ? Color.blue : Color.white.opacity(0.8), lineWidth: 1.5) }
              }
              .accessibilityLabel("Account menu")
              .accessibilityValue(store.signInProvider.map { "Signed in with " + $0.capitalized } ?? "Signed in")
              .id("signed-in-profile")
            } else {
              Button("Sign in or create an account", systemImage: "person.crop.circle") {
                showingSignIn = true
              }
              .popover(isPresented: $showingSignIn) { AccountView(compact: true) }
            }
          }
        }
        .task(id: store.accountActive) {
          accountInitial = ""
          guard store.accountActive else { return }
          showingSignIn = false
          let status: JSONValue? = try? await store.request("account/status")
          if !Task.isCancelled, let status, store.accountActive {
            accountInitial = status["initial"].string
            store.setSignInProvider(status["signInProvider"].string)
          }
        }
        .navigationDestination(isPresented: $showAccountSettings) { AccountView() }
        .sheet(isPresented: $weather) { ForecastScreen() }
        .navigationDestination(for: ReaderRoute.self) { $0.reader }
    }
  }
}
struct ReaderRoute: Hashable {
  let story: Story
  var section: ReaderView.Section = .article
  var reader: some View { ReaderView(story: story, selection: section) }
}

private extension Story {
  var sourceSymbol: String {
    switch source?.lowercased() {
    case "hacker news": "chevron.left.forwardslash.chevron.right"
    case "bbc", "bbc news": "antenna.radiowaves.left.and.right"
    case "lobsters": "bubble.left.and.bubble.right"
    default: "newspaper"
    }
  }
}

private struct ReadFilter: View {
  @Binding var showRead: Bool
  var body: some View {
    Menu {
      Picker("Show stories", selection: $showRead) {
        Text("Unread only").tag(false)
        Text("Read and unread").tag(true)
      }
    } label: {
      Label("Filter stories", systemImage: showRead ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
    }
    .accessibilityValue(showRead ? "Read and unread" : "Unread only")
  }
}

private struct CaughtUpView: View {
  let hasMore: Bool
  let action: () -> Void
  var body: some View {
    ContentUnavailableView {
      Label("You’re caught up", systemImage: "checkmark.circle")
    } actions: {
      Button(hasMore ? "Read more in All stories" : "Show read stories", action: action)
        .buttonStyle(.bordered)
    }
  }
}

// Row positions are in scroll-content coordinates. Layout changes alone never
// advance the reader. Only a user scroll moving a visible row past the top does.
private final class PassedHeadlines {
  let space = UUID()
  var frames: [String: CGRect] = [:]
  var order: [String] = []
  var indices: [String: Int] = [:]
  var firstVisible: Int?
  var scrolling = false
  var viewport = CGRect.zero
  func setOrder(_ ids: [String]) {
    order = ids
    indices = Dictionary(ids.enumerated().map { ($0.element, $0.offset) }, uniquingKeysWith: min)
    reset()
  }
  func first(in rect: CGRect) -> Int? {
    frames.compactMap { rect.intersects($0.value) ? indices[$0.key] : nil }.min()
  }
  func moved(to next: CGRect) -> Set<String> {
    let previous = viewport
    viewport = next
    guard scrolling, next.minY != previous.minY, let current = first(in: next) else { return [] }
    defer { firstVisible = current }
    guard next.minY > previous.minY, previous.height == next.height,
          let start = firstVisible ?? first(in: previous), start < current else { return [] }
    // A fast flick can skip rendering intermediate lazy rows entirely.
    return Set(order[start..<current])
  }
  func reset() {
    firstVisible = nil
    scrolling = false
  }
}

private struct FeedScrollTracking: ViewModifier {
  @Environment(LibraryStore.self) private var store
  @AppStorage("readWhenPassed") private var readWhenPassed = true
  let tracker: PassedHeadlines
  let enabled: Bool
  let ids: [String]

  func body(content: Content) -> some View {
    content.onScrollGeometryChange(for: CGRect.self) { $0.visibleRect } action: { _, rect in
      let passed = tracker.moved(to: rect)
      if !passed.isEmpty { store.markScrolledRead(passed) }
    }
    .onScrollPhaseChange { _, phase, context in
      if enabled && readWhenPassed && (phase == .interacting || phase == .decelerating) {
        if !tracker.scrolling { tracker.firstVisible = tracker.first(in: context.geometry.visibleRect) }
        tracker.scrolling = true
      } else {
        tracker.reset()
      }
    }
    .onChange(of: ids, initial: true) { _, order in tracker.setOrder(order) }
    .onDisappear { tracker.reset() }
    .onChange(of: enabled) { tracker.reset() }
  }
}

private struct FeedStory: View {
  @Environment(LibraryStore.self) private var store
  let story: Story
  let tracker: PassedHeadlines
  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      NavigationLink(value: ReaderRoute(story: story)) { StoryRow(story: story) }
        .buttonStyle(.plain)
        .accessibilityValue(store.library.reading[story.id]?.read == true ? "Read" : "Unread")
        .contextMenu {
          let state = store.library.reading[story.id]
          Button(state?.read == true ? "Mark unread" : "Mark read") { store.setReading(story, read: state?.read != true) }
          Button(state?.saved == true ? "Unsave" : "Save") { store.setReading(story, saved: state?.saved != true) }
          Button("Download for offline") { Task { await store.download(story.id) } }
        }
      StoryActions(story: story)
        .tint(store.library.reading[story.id]?.read == true ? Color.secondary : Color.indigo)
    }
    .id(story.id)
    .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(tracker.space)) } action: { frame in
      tracker.frames[story.id] = frame
    }
    .onDisappear { tracker.frames.removeValue(forKey: story.id) }
  }
}

struct AllStoriesView: View {
  @Environment(LibraryStore.self) private var store
  @Binding var path: NavigationPath
  let firstGroup: String?
  @AppStorage("showReadStories") private var showRead = false
  @State private var tracker = PassedHeadlines()
  var body: some View {
    let edition = FeedContents(store.library, showRead: showRead)
    let positions = Dictionary(edition.cards.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: min)
    let sections = edition.remaining.keys.sorted {
      let left = $0.id == firstGroup ? -1 : positions[$0.id] ?? Int.max
      let right = $1.id == firstGroup ? -1 : positions[$1.id] ?? Int.max
      return left == right ? ($0.title, $0.id) < ($1.title, $1.id) : left < right
    }
    let items = edition.remaining.mapValues { ids in
      ids.sorted {
        let left = store.library.feedItems[$0]?.date ?? .distantPast
        let right = store.library.feedItems[$1]?.date ?? .distantPast
        return left == right ? $0 < $1 : left > right
      }
    }
    NavigationStack(path: $path) {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(sections) { group in
            let stories = items[group, default: []]
            Section {
              ForEach(stories, id: \.self) { id in
                ArchiveRow(id: id, last: id == stories.last, tracker: tracker)
              }
            } header: {
              FeedCardHeader(group: group, count: stories.count)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding([.horizontal, .top], 16).padding(.bottom, 6)
              .background(.regularMaterial, in: UnevenRoundedRectangle(topLeadingRadius: 20, topTrailingRadius: 20))
              .padding(.top, 12)
            }
          }
        }.padding().coordinateSpace(name: tracker.space)
      }
      .modifier(FeedScrollTracking(tracker: tracker, enabled: path.isEmpty, ids: sections.flatMap { items[$0, default: []] }))
      .scrollBounceBehavior(.always, axes: .vertical)
      .refreshable {
        tracker.reset()
        store.library.beginFeedVisit(latest: false)
        store.requestHomeRefresh()
      }
      .overlay {
        if sections.isEmpty {
          if !showRead && store.library.feedItems.keys.contains(where: { !edition.ids.contains($0) }) {
            CaughtUpView(hasMore: false, action: { showRead = true })
          } else {
            ContentUnavailableView("No more stories yet", systemImage: "newspaper",
              description: Text("Additional stories from your feeds appear here."))
          }
        }
      }
      .background { HomeBackdrop().allowsHitTesting(false) }
      .navigationTitle("All stories")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { ReadFilter(showRead: $showRead) }
        ToolbarItem(placement: .topBarTrailing) {
          NavigationLink(value: "downloads") { Label("Download details", systemImage: "info.circle") }
        }
      }
      .navigationDestination(for: String.self) { _ in DownloadDetails() }
      .navigationDestination(for: ReaderRoute.self) { $0.reader }
    }
  }
}

private struct ArchiveRow: View {
  @Environment(LibraryStore.self) private var store
  let id: String
  let last: Bool
  let tracker: PassedHeadlines
  var body: some View {
    if let story = store.library.entries[id]?.story {
      VStack(alignment: .leading, spacing: 8) {
        FeedStory(story: story, tracker: tracker)
        if !last { Divider() }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 16).padding(.vertical, last ? 12 : 4)
      .background(.regularMaterial, in: UnevenRoundedRectangle(bottomLeadingRadius: last ? 20 : 0, bottomTrailingRadius: last ? 20 : 0))
    }
  }
}

private struct HomeStatus: View {
  @Environment(LibraryStore.self) private var store
  var body: some View {
    if store.showOfflineBanner {
      Label("Offline mode", systemImage: "wifi.slash").font(.caption).foregroundStyle(.secondary)
    } else {
      let showProgress = store.online && store.firstAttemptStoryDownloads > 0
      if store.message == "Cards updated" || !showProgress {
        Label {
          CardRefreshMessage()
        } icon: {
          Image(systemName: store.needsRefreshRetry ? "arrow.clockwise" : "checkmark.circle")
        }.font(.caption).foregroundStyle(.secondary)
      }
      if showProgress { DownloadProgressView(compact: true) }
    }
  }
}

struct CardRefreshMessage: View {
  @Environment(LibraryStore.self) private var store

  var body: some View {
    if store.message == "Cards updated" {
      let pending = store.firstAttemptStoryDownloads
      let counts = "Cards updated · \(store.downloadedStoryCount) downloaded"
        + (pending > 0 ? " · \(pending) pending" : "")
      TimelineView(.everyMinute) { clock in
        if let last = store.library.lastArticleDownload {
          let age = clock.date.timeIntervalSince(last) < 60
            ? "just now" : last.formatted(.relative(presentation: .numeric, unitsStyle: .abbreviated))
          Text("\(counts) · last \(age)")
        } else {
          Text(counts)
        }
      }
      .accessibilityIdentifier("cards-updated")
    } else {
      Text(store.message)
    }
  }
}

private actor StoryThumbnails {
  static let shared = StoryThumbnails()
  private let cache = NSCache<NSURL, UIImage>()
  init() { cache.totalCostLimit = 16 * 1024 * 1024 }

  func image(at url: URL) -> UIImage? {
    guard !Task.isCancelled else { return nil }
    if let image = cache.object(forKey: url as NSURL) { return image }
    guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
          let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: 216,
          ] as CFDictionary) else { return nil }
    let image = UIImage(cgImage: thumbnail)
    cache.setObject(image, forKey: url as NSURL, cost: thumbnail.bytesPerRow * thumbnail.height)
    return image
  }
}

private struct StoryThumbnail: View {
  let url: URL
  @State private var image: UIImage?
  var body: some View {
    Color.clear.overlay {
      if let image { Image(uiImage: image).resizable().scaledToFill() }
    }.frame(width: 72, height: 56).clipShape(RoundedRectangle(cornerRadius: 8))
      .accessibilityHidden(true)
      .task(id: url) {
        let result = await StoryThumbnails.shared.image(at: url)
        if !Task.isCancelled { image = result }
      }
  }
}
struct StoryRow: View {
  @Environment(LibraryStore.self) private var store
  @Environment(\.dynamicTypeSize) private var typeSize
  @ScaledMetric(relativeTo: .caption) private var downloadIconSize = 12.0 * 1.15
  let story: Story
  var body: some View {
    let layout = typeSize.isAccessibilitySize
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
      : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
    let metadata = typeSize.isAccessibilitySize
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
      : AnyLayout(HStackLayout(spacing: 8))
    layout {
      if store.library.settings["profile"]["pictures"] != .bool(false), let remote = story.image,
        let file = store.library.entries[story.id]?.assets[remote]
      {
        StoryThumbnail(url: store.root.appending(path: file))
          .grayscale(store.library.reading[story.id]?.read == true ? 1 : 0)
      }
      VStack(alignment: .leading, spacing: 5) {
        Text(story.title).font(
          .body.weight(store.library.reading[story.id]?.read == true ? .regular : .semibold)
        ).foregroundStyle(store.library.reading[story.id]?.read == true ? .secondary : .primary)
          .fixedSize(horizontal: false, vertical: true)
        metadata {
          Label(story.source ?? URL(string: story.link)?.host() ?? "Unknown source", systemImage: story.sourceSymbol)
            .fixedSize(horizontal: false, vertical: true)
          HStack(spacing: 6) {
            if let date = story.published { StoryAge(date: date) }
            Spacer()
            if store.library.entries[story.id]?.article != nil {
              Image(systemName: "arrow.down.circle.fill")
                .font(.system(size: downloadIconSize))
                .accessibilityLabel("Downloaded")
            }
            if store.library.reading[story.id]?.saved == true { Image(systemName: "bookmark.fill") }
          }
        }
        .font(.caption).foregroundStyle(.secondary)
      }
    }.padding(.vertical, 7).contentShape(Rectangle())
  }
}
private struct StoryAge: View {
  let date: Date
  var body: some View {
    TimelineView(.everyMinute) { context in
      Text(label(at: context.date))
        .accessibilityIdentifier("story-age-" + label(at: context.date))
        .accessibilityLabel(Text("Published \(date.formatted(date: .long, time: .shortened))"))
    }
  }
  private func label(at now: Date) -> String {
    let minutes = Int((now.timeIntervalSince(date) / 60).rounded())
    if minutes < 1 { return "now" }
    if minutes < 60 { return "\(minutes)m" }
    let hours = Int((Double(minutes) / 60).rounded())
    if hours < 24 { return "\(hours)h" }
    let days = Int((Double(hours) / 24).rounded())
    if days < 7 { return "\(days)d" }
    return date.formatted(.dateTime.day().month(.abbreviated))
  }
}

struct PendingSummary: View {
  @Environment(LibraryStore.self) private var store
  @Environment(\.scenePhase) private var phase
  let story: Story
  var body: some View {
    let summary = store.library.entries[story.id]?.story.summary ?? story.summary
    let pending = summary?.pending != false && store.online
    Button {} label: {
      HStack(spacing: 4) {
        Text("Summary")
        if pending { ProgressView().controlSize(.mini).accessibilityHidden(true) }
      }
    }
    .disabled(true)
    .accessibilityValue(pending ? "Preparing automatically" : "Unavailable")
    .task(id: pending && phase == .active) {
      guard pending && phase == .active else { return }
      while !Task.isCancelled {
        do { try await Task.sleep(for: .seconds(15)) } catch { return }
        if let latest = try? await store.refreshSummary(story, background: true),
          latest.isReady || !latest.pending { return }
      }
    }
  }
}
struct StoryActions: View {
  @Environment(LibraryStore.self) private var store
  let story: Story
  var body: some View {
    HStack {
      if story.commentsUrl != nil { CommentsLink(story: story) }
      if (store.library.entries[story.id]?.story.summary ?? story.summary)?.isReady == true {
        NavigationLink(value: ReaderRoute(story: story, section: .summary)) {
          Label("Summary", systemImage: "text.alignleft").font(.caption)
        }.buttonStyle(.borderless).accessibilityHint("Open summary for " + story.title)
      } else { PendingSummary(story: story).font(.caption).buttonStyle(.borderless) }
    }
  }
}
private struct CommentsLink: View {
  let story: Story
  var body: some View {
    NavigationLink(value: ReaderRoute(story: story, section: .comments)) {
      Label(story.comments.map { $0 == 1 ? "1 comment" : "\($0) comments" } ?? "Comments",
            systemImage: "bubble.left")
        .font(.caption)
    }
    .buttonStyle(.borderless)
    .accessibilityHint(Text("Open discussion for \(story.title)"))
  }
}
