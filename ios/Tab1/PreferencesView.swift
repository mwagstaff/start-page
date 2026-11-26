import SwiftUI
import UniformTypeIdentifiers

struct SettingsDocument: FileDocument {
  static var readableContentTypes: [UTType] { [.json] }
  var value: JSONValue
  init(_ value: JSONValue) { self.value = value }
  init(configuration: ReadConfiguration) throws {
    value = try JSONDecoder().decode(
      JSONValue.self, from: configuration.file.regularFileContents ?? Data())
  }
  func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    return FileWrapper(regularFileWithContents: try encoder.encode(value))
  }
}
struct PreferencesView: View {
  @Environment(LibraryStore.self) private var store
  @State private var feedURL = ""
  @State private var exporting = false
  @State private var importing = false
  @State private var reset = false
  @State private var history: [JSONValue] = []
  func change(_ key: String, _ value: JSONValue) {
    history.append(store.library.settings)
    store.library.settings[key] = value
    store.saveSharedSettings()
  }
  func profileBinding(_ key: String, default fallback: Bool = true) -> Binding<Bool> {
    Binding(
      get: { store.library.settings["profile"].object[key]?.bool ?? fallback },
      set: { value in
        var p = store.library.settings["profile"]
        p[key] = .bool(value)
        change("profile", p)
      })
  }
  var body: some View {
    Form {
      Section("Synced homepage cards") {
        ForEach(store.library.cards.filter { !$0.id.hasPrefix("app-") }) { card in
          VStack(alignment: .leading) {
            Text(card.title)
            Stepper(
              "\(limit(card.id)) stories",
              value: Binding(get: { limit(card.id) }, set: { setLimit(card.id, $0) }), in: 1...15)
          }
        }.onMove { from, to in
          history.append(store.library.settings)
          var shared = store.library.cards.filter { !$0.id.hasPrefix("app-") }
          shared.move(fromOffsets: from, toOffset: to)
          store.library.cards = shared + store.library.cards.filter { $0.id.hasPrefix("app-") }
          saveLayout()
        }
      }
      Section("Display") {
        Picker(
          "Density",
          selection: Binding(
            get: {
              store.library.settings["density"].string.isEmpty
                ? "spacious" : store.library.settings["density"].string
            }, set: { change("density", .string($0)) })
        ) {
          Text("Spacious").tag("spacious")
          Text("Balanced").tag("balanced")
          Text("Compact").tag("compact")
        }
        Toggle("Story pictures", isOn: profileBinding("pictures"))
        Toggle("Weather", isOn: profileBinding("weather"))
        Toggle("Daily photograph", isOn: profileBinding("backdrop"))
        Toggle("Include subscription sources", isOn: profileBinding("paywalls"))
        Picker(
          "Group news by",
          selection: Binding(
            get: { store.library.settings["profile"]["style"].string },
            set: { value in
              var p = store.library.settings["profile"]
              p["style"] = .string(value)
              change("profile", p)
            })
        ) {
          Text("Topic").tag("topics")
          Text("Source").tag("outlets")
        }
        Picker(
          "Temperature",
          selection: Binding(
            get: {
              store.library.settings["temperature"].string.isEmpty
                ? "C" : store.library.settings["temperature"].string
            }, set: { change("temperature", .string($0)) })
        ) {
          Text("Celsius").tag("C")
          Text("Fahrenheit").tag("F")
        }
      }
      Section("Web search") {
        Picker(
          "Provider",
          selection: Binding(
            get: {
              store.library.settings["search"]["provider"].string.isEmpty
                ? "google" : store.library.settings["search"]["provider"].string
            },
            set: { value in
              var setting = store.library.settings["search"]
              setting["provider"] = .string(value)
              change("search", setting)
            })
        ) {
          ForEach(
            ["google", "bing", "duckduckgo", "yahoo", "brave", "ecosia", "custom"], id: \.self
          ) { Text($0.capitalized).tag($0) }
        }
        if store.library.settings["search"]["provider"].string == "custom" {
          ForEach(["name", "url"], id: \.self) { key in
            TextField(
              key == "name" ? "Provider name" : "Search URL containing {query}",
              text: Binding(
                get: { store.library.settings["search"]["custom"][key].string },
                set: { value in
                  var setting = store.library.settings["search"]
                  var custom = setting["custom"]
                  custom[key] = .string(value)
                  setting["custom"] = custom
                  change("search", setting)
                })
            ).textInputAutocapitalization(.never).autocorrectionDisabled()
          }
        }
      }
      Section("Custom feeds") {
        ForEach(store.library.settings["custom"].array, id: \.self) { feed in
          HStack {
            Text(feed["title"].string)
            Spacer()
            Button("Remove", role: .destructive) {
              change("custom", .array(store.library.settings["custom"].array.filter { $0 != feed }))
            }
          }
        }
        TextField("RSS or Atom URL", text: $feedURL).keyboardType(.URL).textInputAutocapitalization(
          .never
        ).autocorrectionDisabled()
        Button("Add feed") { addFeed() }.disabled(URL(string: feedURL)?.host() == nil)
      }
      Section("Settings file") {
        Button("Export settings") { exporting = true }
        Button("Import settings") { importing = true }
        Button("Undo last settings change") {
          if let previous = history.popLast() {
            store.library.settings = previous
            store.saveSharedSettings()
          }
        }.disabled(history.isEmpty)
        Button("Reset settings", role: .destructive) { reset = true }
      }
      Section {
        Button("Apply and refresh") { Task { await store.refresh(download: store.automatic) } }
      }
    }.navigationTitle("Advanced settings").toolbar { EditButton() }
      .fileExporter(
        isPresented: $exporting, document: SettingsDocument(store.library.settings),
        contentType: .json, defaultFilename: "tab1.net-settings"
      ) { result in if case .failure(let e) = result { store.lastError = e.localizedDescription } }
      .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
        do {
          let url = try result.get()
          let access = url.startAccessingSecurityScopedResource()
          defer { if access { url.stopAccessingSecurityScopedResource() } }
          let value = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
          guard value["v"].number == 1, case .object = value["tabs"] else {
            throw CocoaError(.fileReadCorruptFile)
          }
          history.append(store.library.settings)
          store.library.settings = value
          store.saveSharedSettings()
        } catch { store.lastError = error.localizedDescription }
      }
      .confirmationDialog(
        "Reset your shared settings?", isPresented: $reset, titleVisibility: .visible
      ) {
        Button("Reset settings", role: .destructive) {
          history.append(store.library.settings)
          store.library.settings = .object([
            "v": .number(1), "tabs": .object([:]), "custom": .array([]),
          ])
          store.saveSharedSettings()
        }
      }
  }
  func limit(_ id: String) -> Int {
    let layout = store.library.settings["tabs"]["home"]["cards"].array
    return Int(layout.first { $0["id"].string == id }?["limit"].number ?? 8)
  }
  func saveLayout() {
    var tabs = store.library.settings["tabs"]
    var home = tabs["home"]
    let old = home["cards"].array
    let shared = store.library.cards.filter { !$0.id.hasPrefix("app-") }
    let ids = Set(shared.map(\.id))
    let visible = shared.map { card in
      old.first { $0["id"].string == card.id } ?? .object(["id": .string(card.id)])
    }
    home["cards"] = .array(visible + old.filter { !ids.contains($0["id"].string) })
    tabs["home"] = home
    store.library.settings["tabs"] = tabs
    store.saveSharedSettings()
  }
  func setLimit(_ id: String, _ value: Int) {
    saveLayout()
    var tabs = store.library.settings["tabs"]
    var home = tabs["home"]
    home["cards"] = .array(
      home["cards"].array.map { v in
        var row = v
        if row["id"].string == id { row["limit"] = .number(Double(value)) }
        return row
      })
    tabs["home"] = home
    change("tabs", tabs)
  }
  func addFeed() {
    guard let url = URL(string: feedURL), ["http", "https"].contains(url.scheme ?? ""),
      store.library.settings["custom"].array.count < 20
    else { return }
    var hash: UInt32 = 5381
    for scalar in feedURL.unicodeScalars { hash = (hash &* 33) ^ scalar.value }
    let id = "custom-" + String(hash, radix: 36)
    var feeds = store.library.settings["custom"].array
    guard !feeds.contains(where: { $0["url"].string == feedURL }) else { return }
    feeds.append(
      .object(["id": .string(id), "url": .string(feedURL), "title": .string(url.host() ?? "Feed")]))
    change("custom", .array(feeds))
    feedURL = ""
  }
}
